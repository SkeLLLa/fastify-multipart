'use strict'

const fp = require('fastify-plugin')
const Busboy = require('busboy')
const kMultipart = Symbol('multipart')
const eos = require('end-of-stream')
const deepmerge = require('deepmerge')

function setMultipart (req, done) {
  // nothing to do, it will be done by the Request.multipart object
  req[kMultipart] = true
  done()
}

function attachToBody (options, req, reply, next) {
  if (req.raw[kMultipart] !== true) {
    next()
    return
  }

  const consumerStream = options.onFile || defaultConsumer
  const body = { }
  const fileCount = { }
  const mp = req.multipart((field, file, filename, encoding, mimetype) => {
    fileCount[field] = fileCount[field] || 0
    body[field] = body[field] || []
    body[field][fileCount[field]] = {
      data: [],
      filename,
      encoding,
      mimetype,
      limit: false
    }

    const result = consumerStream(field, file, filename, encoding, mimetype, body, fileCount[field])
    fileCount[field]++
    if (result && typeof result.then === 'function') {
      result.catch((err) => {
        // continue with the workflow
        err.statusCode = 500
        file.destroy(err)
      })
    }
  }, function (err) {
    if (!err) {
      req.body = body
    }
    next(err)
  }, options)

  mp.on('field', (key, value) => {
    body[key] = value
  })
}

function defaultConsumer (field, file, filename, encoding, mimetype, body, fileCount) {
  const fileData = []
  file.on('data', data => { fileData.push(data) })
  file.on('limit', () => { body[field][fileCount].limit = true })
  file.on('end', () => {
    body[field][fileCount].data = Buffer.concat(fileData)
  })
}

function fastifyMultipart (fastify, options, done) {
  if (options.addToBody === true) {
    if (typeof options.sharedSchemaId === 'string') {
      fastify.addSchema({
        $id: options.sharedSchemaId,
        type: 'object',
        properties: {
          encoding: { type: 'string' },
          filename: { type: 'string' },
          limit: { type: 'boolean' },
          mimetype: { type: 'string' }
        }
      })
    }

    fastify.addHook('preValidation', function (req, reply, next) {
      attachToBody(options, req, reply, next)
    })
  }
  fastify.addContentTypeParser('multipart', setMultipart)

  fastify.decorateRequest('multipart', multipart)
  fastify.decorateRequest('isMultipart', isMultipart)

  done()

  // handler definition is in multipart-readstream
  // handler(field, file, filename, encoding, mimetype)
  // opts is a per-request override for the options object
  function multipart (handler, done, opts) {
    if (typeof handler !== 'function') {
      throw new Error('handler must be a function')
    }

    if (typeof done !== 'function') {
      throw new Error('the callback must be a function')
    }

    if (!this.isMultipart()) {
      done(new Error('the request is not multipart'))
      return
    }

    const log = this.log

    log.debug('starting multipart parsing')

    const req = this.req

    const busboyOptions = deepmerge.all([{ headers: req.headers }, options || {}, opts || {}])
    const stream = new Busboy(busboyOptions)
    var completed = false
    var files = 0
    var count = 0
    var callDoneOnNextEos = false

    req.on('error', function (err) {
      stream.destroy()
      if (!completed) {
        completed = true
        done(err)
      }
    })

    stream.on('finish', function () {
      log.debug('finished multipart parsing')
      if (!completed && count === files) {
        completed = true
        setImmediate(done)
      } else {
        callDoneOnNextEos = true
      }
    })

    stream.on('file', wrap)

    req.pipe(stream)

    function wrap (field, file, filename, encoding, mimetype) {
      log.debug({ field, filename, encoding, mimetype }, 'parsing part')
      files++
      eos(file, waitForFiles)
      handler(field, file, filename, encoding, mimetype)
    }

    function waitForFiles (err) {
      if (err) {
        completed = true
        done(err)
        return
      }

      if (completed) {
        return
      }

      ++count
      if (callDoneOnNextEos && count === files) {
        completed = true
        done()
      }
    }

    return stream
  }

  function isMultipart () {
    return this.req[kMultipart] || false
  }
}

module.exports = fp(fastifyMultipart, {
  fastify: '>= 0.39.0',
  name: 'fastify-multipart'
})
