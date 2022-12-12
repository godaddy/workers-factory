'use strict';

const fingerprinter = require('fingerprinting');
const Config = require('./config.js');
const Terser = require('terser');

/**
 * Minify JS using Terser.
 *
 * @param {Object} options Content (compiled JS) and filepath.
 * @param {Function} done Completion callback.
 * @returns {Undefined} Return early on minification error.
 * @public
 */
module.exports = function terser(options, done) {
  const config = new Config({
    minify: options.minify,
    sourceMapContent: options.map,
    filename: options.file
  });

  Terser
    .minify(options.content.toString('utf-8'), config.terser)
    //
    // Return on a minification error.
    //
    .catch(e => done(String(e)))
    .then(results => {
      //
      // Get hash for content.
      //
      const fingerprint = fingerprinter(options.file, { content: results.code, map: true });

      done(null, {
        content: results.code,
        fingerprint: fingerprint.id,
        filename: config.filename
      }, {
        [config.map]: {
          content: results.map,
          fingerprint: fingerprint.id
        }
      });
    });
};
