/* eslint max-nested-callbacks: 0 */
/* eslint no-sync: 0 */
/* eslint max-statements: 0 */
'use strict';

describe('Factory', function () {
  this.timeout(5E4);
  const browserifyworker = require('../workers/browserify');
  const webpackworker = require('../workers/webpack');
  const Factory = require('../factory');
  const exec = require('child_process').exec;
  const map = require('./fixtures/map');
  const assume = require('assume');
  const async = require('async');
  const path = require('path');
  const zlib = require('zlib');
  const toml = require('toml');
  const fs = require('fs');
  const os = require('os');
  const mkdirp = require('mkdirp');
  const rmrf = require('../rmrf');

  const assign = Object.assign;

  const destDir =  path.join(os.tmpdir(), 'makeitwork');

  let factory;

  //
  // Define common specifications for build.
  //
  function config(name) {
    return {
      source: path.join(__dirname, 'fixtures'),
      destDir,
      target: '/tmp',
      clean: false,
      minify: true,
      env: 'test',
      name: name,
      id: name, // normally an uuid.
      npm: {
        registry: 'https://registry.npmjs.org',
        loglevel: 'silent'
      }
    };
  }

  //
  // Install both fixture packages. Can't be done in main process due to
  // npm's horrible design, execute some silly commands.
  //
  before(function (done) {
    const base = path.join(__dirname, '..');
    const locations = ['webpack', 'browserify', 'other'];

    this.timeout(6E5);

    async.each(locations, (name, next) =>
      exec([
        'cd',
        path.join(base, 'test', 'fixtures', name),
        '&&',
        path.join(base, 'node_modules', '.bin', 'npm'),
        'install .'
      ].join(' '), next), function (error) {
      if (error) return done(error);
      done();
    }
    );
  });

  beforeEach(function () {
    factory = new Factory(config('webpack'), webpackworker.run);
  });

  afterEach(function () {
    factory.removeAllListeners();
    factory = null;
  });

  it('is exposed as constructor', function () {
    assume(Factory).is.an('function');
    assume(factory).to.be.instanceof(Factory);
  });

  it('stores some required values on its instance', function () {
    assume(factory).to.have.property('data');
    assume(factory).to.have.property('output');
    assume(factory).to.have.property('base', path.join(__dirname, 'fixtures', 'webpack'));
  });

  describe('#init', function () {
    it('is a function', function () {
      assume(factory.init).to.be.a('function');
      assume(factory.init).to.have.length(1);
    });

    it('safely reads the package.json and entry file', function (done) {
      factory.data.entry = 'sum.js';

      factory.init(function () {
        assume(factory.pkg).to.be.an('object');
        assume(factory.pkg).to.have.property('name', 'test');
        assume(factory.pkg).to.have.property('description', 'ES6 React Test module');
        assume(factory.pkg.dependencies).to.have.property('react', '~0.13.3');

        assume(factory.entry).to.be.a('string');
        assume(factory.entry).to.include('test/fixtures/webpack/sum.js');

        done();
      });
    });

    it('defaults to the `main` property of the package.json as entry file', function (done) {
      factory.init(function () {
        assume(factory.entry).to.be.a('string');
        assume(factory.entry).to.include('test/fixtures/webpack/index.js');

        done();
      });
    });
  });

  describe('#exists', function () {
    it('is a function', function () {
      assume(factory.exists).to.be.a('function');
      assume(factory.exists).to.have.length(1);
    });

    it('checks if the entry file exists', function (done) {
      factory.init(function () {
        factory.exists(function (error, stat) {
          assume(error).to.equal(null);
          assume(stat.size).to.be.above(0);
          done();
        });
      });
    });
  });

  describe('#read', function () {
    it('is a function', function () {
      assume(factory.read).to.be.a('function');
      assume(factory.read).to.have.length(1);
    });

    it('reads the entry file as utf-8', function (done) {
      factory.init(function () {
        factory.read(function (error) {
          assume(error).is.falsey();
          assume(factory.source).to.be.a('string');
          assume(factory.source).to.include('return <p>Webpack an ES6 React component.</p>;');
          done();
        });
      });
    });
  });

  describe('#filter', function () {
    it('is a function', function () {
      assume(factory.filter).is.a('function');
      assume(factory.filter).to.have.length(1);
    });

    it('runs the default filter for .min files and returns false when it exists', function () {
      assume(factory.filter('something.min.js')).equals(false);
    });

    it('runs other filter functions that are configured with the instance', function () {
      const fact = new Factory(assign({},
        config('webpack'), { filter: (file) => path.extname(file) === '.css' }), webpackworker.run);

      assume(fact.filter('something.js')).equals(false);
      assume(fact.filter('something.css')).equals(true);
    });
  });

  describe('#assemble', function () {

    beforeEach(function (next) {
      mkdirp(destDir, next);
    });

    afterEach(function (next) {
      rmrf(destDir, next);
    });

    function run(local, done) {
      async.series([local.init, local.read, local.assemble, local.pack].map(f => f.bind(local)), function (error) {
        assume(error).to.equal(null);

        assume(local.output).to.be.an('object');
        assume(local.compressed).to.be.an('object');

        done(error, local);
      });
    }

    it('is a function', function () {
      assume(factory.assemble).to.be.a('function');
      assume(factory.assemble).to.have.length(1);
    });

    it('runs a webpack build and gzips the data', function (done) {
      const data = config('webpack');

      this.timeout(5000);
      data.entry = 'webpack.config.js';

      run(new Factory(data, webpackworker.run), function (error, build) {
        if (error) return done(error);

        const output = build.output['bundle.js'].toString('utf-8');
        const compressed = build.compressed['bundle.js'];

        assume(build.base).to.include('webpack');
        assume(output).to.include('Webpack an ES6 React component');
        assume(output).to.include('return _react.React.createElement(');
        assume(output).to.include('_inherits(Test, _React$Component);');

        // test for gzip header magic numbers and deflate compression
        assume(compressed[0]).to.equal(31);
        assume(compressed[1]).to.equal(139);
        assume(compressed[2]).to.equal(8);

        assume(zlib.gunzipSync(compressed).toString('utf-8')).to.equal(output);

        done();
      });
    });

    it('can run browserify builds', function (done) {
      this.timeout(5000);

      run(new Factory(config('browserify'), browserifyworker.run), function (error, build) {
        if (error) return done(error);

        const output = build.output['index.js'].toString('utf-8');
        const compressed = build.compressed['index.js'];

        assume(build.base).to.include('browserify');
        assume(output).to.include('Browserify an ES6 React component');
        assume(output).to.include('return _react.React.createElement(');
        assume(output).to.include('_inherits(Test, _React$Component);');
        assume(output).to.include('typeof require&&require');

        // test for gzip header magic numbers and deflate compression
        assume(compressed[0]).to.equal(31);
        assume(compressed[1]).to.equal(139);
        assume(compressed[2]).to.equal(8);

        assume(zlib.gunzipSync(compressed).toString('utf-8')).to.equal(output);

        done();
      });
    });

    it('can run more complicated webpack builds with multiple output files, minify and write to disk', function (done) {
      const data = config('other');

      this.timeout(5000);
      data.entry = 'webpack.config.js';
      run(new Factory(data, webpackworker.run), function (error, fact) {
        if (error) return done(error);

        assume(Object.keys(fact.output)).to.have.length(4);
        assume(Object.keys(fact.compressed)).to.have.length(4);

        //
        // This tests the last bits where we minify as well as write to disk
        //
        fact.minify((err) => {
          assume(err).is.falsey();
          // adds 4 map files and 4 minified files
          assume(Object.keys(fact.output)).to.have.length(12);
          fact.files((e, res) => {
            assume(e).is.falsey();
            assume(res.files).to.have.length(Object.keys(fact.output).length);
            done();
          });
        });
      });
    });
  });

  describe('#stock', function () {
    it('is a function', function () {
      assume(factory.stock).to.be.a('function');
      assume(factory.stock).to.have.length(3);
    });

    it('stores content as Buffer on the output collection', function () {
      factory.stock('test.js', 'some content');

      assume(Object.keys(factory.output).length).to.equal(1);
      assume(factory.output['test.js']).to.be.instanceof(Buffer);
      assume(factory.output['test.js'].toString()).to.equal('some content');
    });
  });

  describe('#minify', function () {
    beforeEach(function () {
      factory.data.env = 'prod';
    });

    it('is a function', function () {
      assume(factory.minify).to.be.a('function');
      assume(factory.minify).to.have.length(1);
    });

    it('will skip minify if `env` is prod or the `minify` flag is false', function (done) {
      factory.data.env = 'staging';

      factory.minify(function () {
        assume(Object.keys(factory.output).length).to.equal(0);

        factory.data.minify = false;
        factory.minify(function () {
          assume(Object.keys(factory.output).length).to.equal(0);

          done();
        });
      });
    });

    it('will skip minification of unknown files', function (done) {
      factory.data.env = 'prod';
      factory.output = {
        'index.unknown': 'var test = true; function boolier(change) { test = !!change; }'
      };

      factory.minify(function (error) {
        assume(error).to.be.falsey();
        assume(factory.output).to.be.an('object');
        assume(factory.output['index.unknown']).to.be.instanceof(Buffer);
        assume(factory.output['index.unknown'].toString()).to.equal(factory.output['index.unknown'].toString());
        done();
      });
    });

    it('can minify JS', function (done) {
      factory.data.env = 'prod';
      factory.output = {
        'index.js.map': JSON.stringify(map),
        'index.js': 'var test = true; function boolier(change) { test = !!change; }'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        const sourceMap = JSON.parse(factory.output['index.min.js.map'].content);
        assume(factory.output).to.be.an('object');
        assume(factory.output['index.min.js'].content).to.be.instanceof(Buffer);
        assume(factory.output['index.min.js'].content.toString()).to.include('var test=!0;function boolier(t){test=!!t}');
        assume(factory.output['index.min.js'].content.toString()).to.include('\n//# sourceMappingURL=index.min.js.map');
        assume(factory.output['index.min.js'].fingerprint).to.equal('8fbdebb353a0952379baef3ec769bd9d');
        assume(factory.output['index.min.js.map'].content).to.be.instanceof(Buffer);

        assume(sourceMap).to.be.an('object');
        assume(sourceMap).to.have.property('version', 3);
        assume(sourceMap).to.have.property('file', 'index.min.js');
        assume(sourceMap).to.have.property('sourcesContent');
        assume(sourceMap).to.have.property('mappings', 'AAA0B,IAAAA,MAAA,EAAA,SAATC,QAAAA,GACVA,OAAOC');
        done();
      });
    });

    it('can minify JS with Terser', function (done) {
      factory.data.env = 'prod';
      factory.output = {
        'index.js.map': JSON.stringify(map),
        'index.js': 'const change = false; class Boolier { get flip() { return !change; }}; const flipped = new Boolier().flip;'
      };

      // Explicit request Terser for ES6 code.
      factory.config = toml.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', 'wrhs-es6.toml'))
      );

      factory.minify(function (error) {
        if (error) return done(error);

        const sourceMap = JSON.parse(factory.output['index.min.js.map'].content);
        assume(factory.output).to.be.an('object');
        assume(factory.output['index.min.js'].content).to.be.instanceof(Buffer);
        assume(factory.output['index.min.js'].content.toString()).to.include('(new class{get flip(){return!0}}).flip;');
        assume(factory.output['index.min.js'].content.toString()).to.include('\n//# sourceMappingURL=index.min.js.map');
        assume(factory.output['index.min.js'].fingerprint).to.equal('5ce45600fc05b0ea8994bd5c4bc6438d');
        assume(factory.output['index.min.js.map'].content).to.be.instanceof(Buffer);

        assume(sourceMap).to.be.an('object');
        assume(sourceMap).to.have.property('version', 3);
        assume(sourceMap).to.have.property('file', 'index.min.js');
        // This property no longer being included by Terser@5 in this particularly configuration
        // assume(sourceMap).to.have.property('sourcesContent');
        assume(sourceMap).to.have.property('mappings', 'CACc,IADJA,MACHC,WAAO,YAAAC');
        done();
      });
    });

    it('can minify with additional `wrhs.toml` options', function (done) {
      factory.data.env = 'prod';

      factory.config = toml.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', 'wrhs.toml'))
      );

      factory.output = {
        'index.js.map': JSON.stringify(map),
        'index.js': 'var test = true; function boolier(change) { test = !!change; }'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        assume(factory.output).to.be.an('object');
        assume(factory.output['index.min.js'].content).to.be.instanceof(Buffer);
        assume(factory.output['index.min.js'].content.toString()).to.include('var a=!0;function n(n){a=!!n}');
        assume(factory.output['index.min.js'].fingerprint).to.equal('d785c6497c26dd2a184f149a47243ceb');
        done();
      });

    });

    it('can minify CSS', function (done) {
      factory.output = {
        'base.css': 'span { margin: 0px; font-size: 12px; color: #FFFFFF; }'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        assume(factory.output).to.be.an('object');
        assume(factory.output['base.min.css'].content).to.be.instanceof(Buffer);
        assume(factory.output['base.min.css'].content.toString()).to.include('span{margin:0;font-size:12px;color:#fff}');
        assume(factory.output['base.min.css'].content.toString()).to.include('/*# sourceMappingURL=base.min.css.map */');
        assume(factory.output['base.min.css'].fingerprint).to.equal('6b06b97e3d44e5578ef46d04c8bb86cc');
        assume(factory.output['base.min.css.map'].content).to.be.instanceof(Buffer);
        done();
      });
    });

    it('can minify HTML', function (done) {
      factory.output = {
        'view.html': '<h1 class=""  draggable="true">some additional cleaning</h1>\n\n   <span>\ntest</span>'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        assume(factory.output).to.be.an('object');
        assume(factory.output['view.html']).to.be.instanceof(Buffer);
        assume(factory.output['view.html'].toString()).to.equal(
          '<h1 draggable>some additional cleaning</h1><span>test</span>'
        );

        done();
      });
    });
  });

  describe('#line', function () {
    this.timeout(3E4);
    it('is a function', function () {
      assume(factory.line).to.be.a('function');
      assume(factory.line).to.have.length(2);
    });

    it('runs the stack in the scope of factory and emits messages', function (done) {
      factory.on('task', (data) => {
        assume(data).to.have.property('message');
        assume(data).to.have.property('progress');
        assume(data.progress).to.be.between(0, 100);
      });

      factory.on('store', (data) => {
        assume(data.files).is.an('array');
      });

      factory.init(function (error) {
        if (error) return done(error);

        factory.line([
          function method1(next) {
            assume(this).to.equal(factory);
            assume(next).to.be.a('function');
            next();
          },
          function method2(next) {
            assume(this).to.equal(factory);
            assume(next).to.be.a('function');
            next();
          }
        ], done);
      });
    });
  });

  describe('#scrap', function () {
    it('is a function', function () {
      assume(factory.scrap).to.be.a('function');
      assume(factory.scrap).to.have.length(2);
    });

    it('sends the error to the main process and exits', function (done) {

      function next(error) {
        assume(error).to.be.instanceof(Error);
        assume(error.message).to.equal('test');

        done();
      }

      factory.scrap(new Error('test'), next);
    });
  });
});
