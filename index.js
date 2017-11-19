#!/usr/bin/env node
// This is invoked as a shell script by NPM

var plugin = require('./node_modules/tw5-plugin/plugins/ustuehler/core/modules/plugin.js').plugin
var $tw = require('tiddlywiki/boot/boot.js').TiddlyWiki()

// Resolve missing plugins and themes to node modules
plugin.setPluginsEnv('TIDDLYWIKI_PLUGIN_PATH')
plugin.setThemesEnv('TIDDLYWIKI_THEME_PATH')

// Pass the command line arguments to the boot kernel
$tw.boot.argv = ['editions/github'].concat(process.argv.slice(2))

// Boot the TW5 app
$tw.boot.boot()
