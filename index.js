'use strict'

const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const vision = require('@google-cloud/vision')
const natural = require('natural')
const redis = require('redis')
const colors = require('colors/safe')
const cliProgress = require('cli-progress')
// create a new progress bar instance and use shades_classic theme
const bar1 = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic)
const wifi = require('node-wifi')
const download = require('download-file')
const url = 'http://10.10.1.1/:sda1/DCIM/100MEDIA'
const Crawler = require('crawler')
const urlmodule = require('url')
const http = require('http')
const gm = require('gm')
const sizeOf = require('image-size')

var crawl = new Crawler({
  maxConnections: 20,
  // This will be called for each crawled page
  callback: function(error, res, done) {
    if (error) {
      console.log(error)
      wifi.connect({ ssid: 'SFR_C4A0', password: 'r5antrymaggiumbutrid' }, (err) => {
        if (err) {
          console.log(err)
        }
        console.log(colors.cyan('Error: Re-Synchronize with Local Wifi...')) // outputs green text
      })
    } else {
      var $ = res.$
      // $ is Cheerio by default
      //a lean implementation of core jQuery designed specifically for the server
    }
    done()
  },
})
const readFile = promisify(fs.readFile)
const stat = promisify(fs.stat)
const readdir = promisify(fs.readdir)

// By default, the client will authenticate using the service account file
// specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable and use
// the project specified by the GCLOUD_PROJECT environment variable. See
// https://cloud.google.com/docs/authentication/getting-started#setting_the_environment_variable

// Instantiate a vision client
const client = new vision.ImageAnnotatorClient()

/**
 * State manager for text processing.  Stores and reads results from Redis.
 */
class Index {
  /**
   * Create a new Index object.
   */
  constructor() {
    // Connect to a redis server.
    const TOKEN_DB = 0
    const DOCS_DB = 1
    const PORT = process.env.REDIS_PORT || '6379'
    const HOST = process.env.REDIS_HOST || '127.0.0.1'

    this.tokenClient = redis
      .createClient(PORT, HOST, {
        db: TOKEN_DB,
      })
      .on('error', (err) => {
        console.error('ERR:REDIS: ' + err)
        throw err
      })
    this.docsClient = redis
      .createClient(PORT, HOST, {
        db: DOCS_DB,
      })
      .on('error', (err) => {
        console.error('ERR:REDIS: ' + err)
        throw err
      })
  }

  /**
   * Close all active redis server connections.
   */
  quit() {
    this.tokenClient.quit()
    this.docsClient.quit()
  }

  /**
   * Tokenize the given document.
   * @param {string} filename - key for the storage in redis
   * @param {string} document - Collection of words to be tokenized
   * @returns {Promise<void>}
   */
  async add(filename, document) {
    const PUNCTUATION = ['.', ',', ':', '']
    const tokenizer = new natural.WordTokenizer()
    const tokens = tokenizer.tokenize(document)
    // filter out punctuation, then add all tokens to a redis set.
    await Promise.all(
      tokens
        .filter((token) => PUNCTUATION.indexOf(token) === -1)
        .map((token) => {
          const sadd = promisify(this.tokenClient.sadd).bind(this.tokenClient)
          return sadd(token, filename)
        }),
    )
    const set = promisify(this.docsClient.set).bind(this.docsClient)
    await set(filename, document)
  }

  /**
   * Lookup files that contain a given set of words in redis
   * @param {string[]} words An array of words to lookup
   * @returns {Promise<string[][]>} Words and their arrays of matching filenames
   */
  async lookup(words) {
    return Promise.all(
      words
        .map((word) => word.toLowerCase())
        .map((word) => {
          const smembers = promisify(this.tokenClient.smembers).bind(this.tokenClient)
          return smembers(word)
        }),
    )
  }

  /**
   * Check to see if a Document is already stored in redis.
   * @param {string} filename
   * @returns {Promise<boolean>}
   */
  async documentIsProcessed(filename) {
    const get = promisify(this.docsClient.get).bind(this.docsClient)
    const value = await get(filename)
    if (value) {
      console.log(`${filename} already added to index.`)
      return true
    }
    if (value === '') {
      console.log(`${filename} was already checked, and contains no text.`)
      return true
    }
    return false
  }

  /**
   * Updates a given doc to have no text in redis.
   * @param {string} filename
   */
  async setContainsNoText(filename) {
    const set = promisify(this.docsClient.set).bind(this.docsClient)
    await set(filename, '')
  }
}

/**
 * Given a list of words, lookup any matches in the database.
 * @param {string[]} words
 * @returns {Promise<string[][]>}
 */
async function lookup(words) {
  const index = new Index()
  const hits = await index.lookup(words)
  index.quit()
  words.forEach((word, i) => {
    console.log(`hits for "${word}":`, hits[i].join(', '))
  })
  return hits
}

/**
 * Provide a joined string with all descriptions from the response data
 * @param {TextAnnotation[]} texts Response data from the Vision API
 * @returns {string} A joined string containing al descriptions
 */
function extractDescription(texts) {
  let document = ''
  texts.forEach((text) => {
    document += text.description || ''
  })
  return document.toLowerCase()
}

/**
 * Grab the description, and push it into redis.
 * @param {string} filename Name of the file being processed
 * @param {Index} index The Index object that wraps Redis
 * @param {*} response Individual response from the Cloud Vision API
 * @returns {Promise<void>}
 */
async function extractDescriptions(filename, index, response) {
  if (response.textAnnotations.length) {
    const words = extractDescription(response.textAnnotations)
    await index.add(filename, words)
  } else {
    console.log(`${filename} had no discernable text.`)
    await index.setContainsNoText(filename)
  }
}

/**
 * Given a set of image file paths, extract the text and run them through the
 * Cloud Vision API.
 * @param {Index} index The stateful `Index` Object.
 * @param {string[]} inputFiles The list of files to process.
 * @returns {Promise<void>}
 */
async function getTextFromFiles(index, inputFiles) {
  // Read all of the given files and provide request objects that will be
  // passed to the Cloud Vision API in a batch request.
  const requests = await Promise.all(
    inputFiles.map(async (filename) => {
      const content = await readFile(filename)
      console.log(` 👉 ${filename}`)
      return {
        image: {
          content: content.toString('base64'),
        },
        features: [{ type: 'TEXT_DETECTION' }],
      }
    }),
  )

  // Make a call to the Vision API to detect text
  const results = await client.batchAnnotateImages({ requests })
  const detections = results[0].responses
  await Promise.all(
    inputFiles.map(async (filename, i) => {
      const response = detections[i]
      if (response.error) {
        console.info(`API Error for ${filename}`, response.error)
        return
      }
      await extractDescriptions(filename, index, response)
    }),
  )
}

/**
 * Main entry point for the program.
 * @param {string} inputDir The directory in which to run the sample.
 * @returns {Promise<void>}
 */
async function main(inputDir) {
  const index = new Index()
  try {
    const files = await readdir(inputDir)

    // Get a list of all files in the directory (filter out other directories)
    const allImageFiles = (
      await Promise.all(
        files.map(async (file) => {
          const filename = path.join(inputDir, file)
          const stats = await stat(filename)
          if (!stats.isDirectory()) {
            return filename
          }
        }),
      )
    ).filter((f) => !!f)

    // Figure out which files have already been processed
    let imageFilesToProcess = (
      await Promise.all(
        allImageFiles.map(async (filename) => {
          const processed = await index.documentIsProcessed(filename)
          if (!processed) {
            // Forward this filename on for further processing
            return filename
          }
        }),
      )
    ).filter((file) => !!file)

    // The batch endpoint won't handle
    if (imageFilesToProcess.length > 15) {
      console.log('Maximum of 15 images allowed. Analyzing the first 15 found.')
      imageFilesToProcess = imageFilesToProcess.slice(0, 15)
    }

    // Analyze any remaining unprocessed files
    if (imageFilesToProcess.length > 0) {
      console.log('Files to process: ')
      let res = await getTextFromFiles(index, imageFilesToProcess)
    }
    console.log('All files processed!')
  } catch (e) {
    console.error(e)
  }
  index.quit()
}

/**
 *
 * Go Detect Console
 *
 */
const usage = 'Usage: node textDetection <command> <arg> ... \n\n  Commands: analyze, lookup'
if (process.argv.length < 3) {
  throw new Error(usage)
}
const args = process.argv.slice(2)
const command = args.shift()
if (command === 'analyze') {
  if (!args.length) {
    throw new Error('Usage: node textDetection analyze <dir>')
  }
  main(args[0]).catch(console.error)
} else if (command === 'synchronize') {
  wifi.init({
    iface: null, // network interface, choose a random wifi interface if set to null
  })
  console.log(colors.white('Go Synchronize...')) // outputs green text

  wifi.connect({ ssid: 'IRIScanBook-5300b539', password: '12345678' }, (err) => {
    if (err) {
      console.log(err)
    }
    console.log(colors.yellow('Synchronize with IrisScan...')) // outputs green text

    crawl.queue([
      {
        uri: `http://10.10.1.1/:sda1/DCIM/100MEDIA`,
        jQuery: true,
        // The global callback won't be called
        callback: function(error, res, done) {
          if (error) {
            console.log(error)
          } else {
            var $ = res.$
            console.log('Grabbed', res.body.length, 'bytes')
            // console.log('Body Crawled', res.body)
            let links = $('table#middle tr td:contains(IMA)')
            let list = []
            links.find('a').each((index, element) => {
              list.push($(element).attr('href'))
            })
            console.dir(list)

            list.forEach((link) => {
              var parsed = urlmodule.parse(link)
              const file = fs.createWriteStream(`images/${path.basename(parsed.pathname)}`)
              console.log(`${url}${link}`)
              //10.10.1.1/sda1/DCIM/100MEDIA/IMAG0002.JPG

              http: http.get(`http://10.10.1.1${link}`, (response) => {
                var chunks = []

                response.pipe(file)
                response
                  .on('data', function(chunk) {
                    chunks.push(chunk)
                  })
                  .on('end', function() {
                    //response.pipe(file)
                  })

                file.on('finish', function() {
                  var buffer = Buffer.concat(chunks)
                  let sizes = sizeOf(buffer)
                  console.log(sizes)
                  if (sizes.width > 1000 && sizes.height > 1000) {
                    //response.pipe(file)
                    console.log('laaa')
                  }

                  file.close()
                })
              })
            })
          }
          wifi.connect({ ssid: 'SFR_C4A0', password: 'r5antrymaggiumbutrid' }, (err) => {
            if (err) {
              console.log(err)
            }
            console.log(colors.cyan('Re-Synchronize with Local Wifi...')) // outputs green text
          })

          done()
        },
      },
    ])
  })

  //   let progress = 0
  //   // start the progress bar with a total value of 200 and start value of 0
  //   bar1.start(200, progress)

  //   let refreshIntervalId = setInterval(() => {
  //     if (progress < 200) {
  //       progress += 10
  //       bar1.update(progress)
  //     } else {
  //       bar1.stop()
  //       clearInterval(refreshIntervalId)
  //     }
  //   }, 100)
} else if (command === 'lookup') {
  if (!args.length) {
    throw new Error('Usage: node textDetection lookup <word> ...')
  }
  lookup(args).catch(console.error)
} else {
  throw new Error(usage)
}
