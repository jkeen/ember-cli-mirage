'use strict';
const path = require('path');
const mergeTrees = require('broccoli-merge-trees');
const Funnel = require('broccoli-funnel');
const map = require('broccoli-stew').map;
const rm = require('broccoli-stew').rm;
const replace = require('broccoli-string-replace');

function toNodeJSBuilder(projectRoot, mirageDirectory) {
  var esTranspiler = require('broccoli-babel-transpiler');
  var broccoli = require('broccoli-builder');

  var appEnvPath = path.join(projectRoot, 'config', 'environment.js');
  var appEnv = require(appEnvPath);

  var emberCliMiragePath = __dirname;
  var mirageAddon = new Funnel(emberCliMiragePath, {srcDir: 'addon', destDir: 'ember-cli-mirage'});
  var appMirageSrc = new Funnel(mirageDirectory, {srcDir:'.', destDir: 'mirage'});
  var nodejsSrc = new Funnel(emberCliMiragePath, {srcDir:'nodejs', destDir: 'nodejs'});
  var combinedSrcTree = mergeTrees([mirageAddon, nodejsSrc, appMirageSrc]);
  var transpiledTree = esTranspiler(combinedSrcTree, {
    browserPolyfill: true,
    resolveModuleSource: function(source, filename) {
      var result = source;
      var result_abs;

      var dirname = path.dirname(path.join(transpiledTree.outputPath,filename));
      if (source === 'ember') {
        result_abs = path.join(transpiledTree.outputPath,'nodejs/ember-compat');
      } else if (source === 'pretender') {
        result_abs = path.join(transpiledTree.outputPath,'nodejs/no-pretender');
      } else if (source.startsWith('ember-cli-mirage/')) {
        result_abs = path.join(transpiledTree.outputPath,source);
      } else if (source.startsWith('../mirage/')) {
        result_abs = path.join(transpiledTree.outputPath,'na',source);
      } else if (source === '../config/environment') {
        result = appEnvPath;
      }
      if (result_abs) {
        result = path.relative(dirname, result_abs);
        if (!(result.startsWith('../') || result.startsWith('./'))) {
          result = './' + result;
        }
      }
      return result;
    }
  });
  var builder = new broccoli.Builder(transpiledTree);
  return { builder, appEnv };
}

module.exports = {
  name: 'ember-cli-mirage',

  options: {
    nodeAssets: {
      '@xg-wang/whatwg-fetch': npmAsset({
        import: ['dist/fetch.umd.js']
      }),
      'route-recognizer': npmAsset({
        srcDir: 'dist',
        import: ['route-recognizer.js'],
        vendor: ['route-recognizer.js.map']
      }),
      'fake-xml-http-request': npmAsset({
        import: ['fake_xml_http_request.js']
      }),
      'pretender': npmAsset({
        import: ['pretender.js']
      }),
      'faker': npmAsset({
        import: ['build/build/faker.js']
      })
    }
  },

  loadMirageToNode: function(router) {
    var { builder, appEnv } = toNodeJSBuilder(this.app.project.root, this.mirageDirectory);
    builder.build().then(function(output) {
      var startExpressServer = require(path.join(output.directory,'nodejs/start-express-server.js'));
      var res = startExpressServer(router, appEnv);
    }).catch(function(err) {
      console.log('Error during build for node.js:', err);
    }).finally(function() {
      console.log('Build for node.js finished!');
    });
  },

  serverMiddleware: function(options) {
    if (this.addonConfig.useExpress) {
      this.expressRouter = require('express').Router();
      var router = this.expressRouter;
      var app = options.app;
      app.use(router);
    }
  },

  postBuild: function(result) {
    if (this.expressRouter) {
      this.expressRouter.stack = [];
      this.loadMirageToNode(this.expressRouter);
    }
  },

  included: function included() {
    var app;

    // If the addon has the _findHost() method (in ember-cli >= 2.7.0), we'll just
    // use that.
    if (typeof this._findHost === 'function') {
      app = this._findHost();
    } else {
      // Otherwise, we'll use this implementation borrowed from the _findHost()
      // method in ember-cli.
      let current = this;
      do {
        app = current.app || app;
      } while (current.parent.parent && (current = current.parent));
    }

    this.app = app;
    this.addonConfig = this.app.project.config(app.env)['ember-cli-mirage'] || {};
    this.addonBuildConfig = this.app.options['ember-cli-mirage'] || {};

    // Call super after initializing config so we can use _shouldIncludeFiles for the node assets
    this._super.included.apply(this, arguments);

    if (this.addonBuildConfig.directory) {
      this.mirageDirectory = this.addonBuildConfig.directory;
    } else if (this.addonConfig.directory) {
      this.mirageDirectory = this.addonConfig.directory;
    } else if (app.project.pkg['ember-addon'] && app.project.pkg['ember-addon'].configPath) {
      this.mirageDirectory = path.resolve(app.project.root, path.join('tests', 'dummy', 'mirage'));
    } else {
      this.mirageDirectory = path.join(this.app.project.root, '/mirage');
    }

    if (this._shouldIncludeFiles()) {
      app.import('vendor/ember-cli-mirage/pretender-shim.js', {
        type: 'vendor',
        exports: { 'pretender': ['default'] }
      });
    }
  },

  blueprintsPath() {
    return path.join(__dirname, 'blueprints');
  },

  treeFor(name) {
    if (!this._shouldIncludeFiles()) {
      if (name === 'app' || name === 'addon') {
        // include a noop initializer even when mirage is excluded from the build
        let initializerFileName = 'initializers/ember-cli-mirage.js';
        let tree = rm(this._super.treeFor.apply(this, arguments), (path) => path !== initializerFileName);

        return replace(tree, {
          files: [initializerFileName],
          patterns: [{
            match: /[\S\s]*/m,
            replacement: 'export default {name: \'ember-cli-mirage\',initialize() {}};'
          }]
        });
      }

      return;
    }

    return this._super.treeFor.apply(this, arguments);
  },

  _lintMirageTree(mirageTree) {
    let lintedMirageTrees;
    // _eachProjectAddonInvoke was added in ember-cli@2.5.0
    // this conditional can be removed when we no longer support
    // versions older than 2.5.0
    if (this._eachProjectAddonInvoke) {
      lintedMirageTrees = this._eachProjectAddonInvoke('lintTree', ['mirage', mirageTree]);
    } else {
      lintedMirageTrees = this.project.addons.map(function(addon) {
        if (addon.lintTree) {
          return addon.lintTree('mirage', mirageTree);
        }
      }).filter(Boolean);
    }

    let lintedMirage = mergeTrees(lintedMirageTrees, {
      overwrite: true,
      annotation: 'TreeMerger (mirage-lint)'
    });

    return new Funnel(lintedMirage, {
      destDir: 'tests/mirage/'
    });
  },

  treeForApp(appTree) {
    let trees = [ appTree ];
    let mirageFilesTree = new Funnel(this.mirageDirectory, {
      destDir: 'mirage'
    });
    trees.push(mirageFilesTree);

    if (this.hintingEnabled()) {
      trees.push(this._lintMirageTree(mirageFilesTree));
    }

    return mergeTrees(trees);
  },

  _shouldIncludeFiles() {
    if (process.env.EMBER_CLI_FASTBOOT) {
      return false;
    }

    let environment = this.app.env;
    let enabledInProd = environment === 'production' && this.addonConfig.enabled;
    let explicitExcludeFiles = this.addonConfig.excludeFilesFromBuild;
    if (enabledInProd && explicitExcludeFiles) {
      throw new Error('Mirage was explicitly enabled in production, but its files were excluded '
                      + 'from the build. Please, use only ENV[\'ember-cli-mirage\'].enabled in '
                      + 'production environment.');
    }
    return enabledInProd || (environment && environment !== 'production' && explicitExcludeFiles !== true);
  }
};

function npmAsset(options = {}) {
  let defaultOptions = {
    // guard against usage in FastBoot 1.0, where process.env.EMBER_CLI_FASTBOOT is not available
    _processTree(input) {
      return map(input, content => `if (typeof FastBoot !== 'undefined') { ${content} }`);
    }
  };

  let assetOptions = Object.assign(defaultOptions, options);

  return function() {
    let finalOptions = Object.assign(
      assetOptions,
      {
        enabled: this._shouldIncludeFiles()
      }
    );

    return finalOptions;
  };
}
