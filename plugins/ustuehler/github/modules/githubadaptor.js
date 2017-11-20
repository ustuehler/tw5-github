/*\
title: $:/plugins/ustuehler/github/githubadaptor.js
type: application/javascript
module-type: syncadaptor

A sync adaptor module for synchronising with GitHub

\*/
(function () {
  /* global $tw */

  const SKINNY_TIDDLERS_FILE = 'tiddlers.json'

  var Client = require('$:/plugins/ustuehler/github/client').Client
  var SyncAdaptor = require('$:/plugins/ustuehler/core').SyncAdaptor
  var Tiddlers = require('$:/plugins/ustuehler/core').Tiddlers

  /*
   * GitHubAdaptor is a syncadaptor and expects to be used together with a
   * syncer. The options are as follows:
   *
   * - user: Organisation name or username on GitHub
   * - repo: Repository name
   * - branch: Branch within the repository
   * - path: Where tiddlers are stored relative to the repository root
   *
   * Defaults are read from configuration tiddlers whose title starts with
   * $:/config/GitHub/, e.g., $:/config/GitHub/User.
   */
  function GitHubAdaptor (options) {
    // Helper object to read configuration tiddlers
    this.tiddlers = new Tiddlers('GitHub')

    // The runtime configuration for this syncadaptor
    this.config = {
      user: options['user'] || this.tiddlers.getConfigText('User'),
      repo: options['repo'] || this.tiddlers.getConfigText('Repo'),
      branch: options['branch'] || this.tiddlers.getConfigText('Branch'),
      path: options['path'] || this.tiddlers.getConfigText('Path'),
      committer: {
        name: this.tiddlers.getConfigField('User', 'fullname'),
        email: this.tiddlers.getConfigField('User', 'email')
      }
    }

    // The client exists only while the synchronisation is running
    this.client = null

    var self = this
    SyncAdaptor.call(this, 'GitHubAdaptor', 'github', options)
      .then(function () {
        self.status.update(stoppedStatus())
      })
  }

  // Inherit from SyncAdaptor
  GitHubAdaptor.prototype = Object.create(SyncAdaptor.prototype)
  GitHubAdaptor.prototype.constructor = GitHubAdaptor

  SyncAdaptor.prototype.isReady = function () {
    console.debug('isReady:', this.status.fields.synchronising)
    return this.status.fields.synchronising
  }

  /*
   * getClientStatus resolves to a (isLoggedIn, username) tuple, where username
   * may be null
   */
  GitHubAdaptor.prototype.getClientStatus = function () {
    var self = this

    // Attempt to sign in and start the synchronisation automatically
    return this.start()
      .then(function (client) {
        // The user is signed in
        return Promise.resolve([true, client.username])
      })
      .catch(function (err) {
        console.log(err)

        // Not signed in, whatever the error was
        return Promise.resolve([false, null])
      })
  }

  /*
   * start returns a promise that resolves to a signed-in GitHub client,
   * after the background synchronisation has been started.
   */
  GitHubAdaptor.prototype.start = function () {
    if (this.client) {
      return Promise.resolve(this.client)
    }

    var client = new Client()
    var self = this

    return client.signIn()
      .then(function (userInfo) {
        // TODO: anything to do to start the synchronisation?

        self.client = client
        self.status.update(startedStatus())

        return self.client
      })
      .catch(function (err) {
        self.status.update(stoppedStatus())
        throw err
      })
  }

  /*
   * stop resolves after gracefully stopping the background synchrosation, if
   * it is still running
   */
  GitHubAdaptor.prototype.stop = function () {
    // TODO: anything to do to stop the synchronisation?

    this.status.update(stoppedStatus())
    this.client = null

    return Promise.resolve()
  }

  /*
   * getSkinnyTiddlersFromStore retrieves a list of skinny tiddlers from the
   * configured GitHub repository. A skinny tiddler is just the fields of the
   * tiddler, except for the "text" field.
   *
   * For a GitHub tiddler that means that a skinny tiddler is the head section
   * of a tiddler file, without the body, however it is not possible to fetch a
   * limited amount of content from files in a GitHub repository.
   */
  GitHubAdaptor.prototype.getSkinnyTiddlersFromStore = function () {
    var repo = this.config.repo
    var ref = 'heads/' + this.config.branch
    var path = this.config.path + '/' + SKINNY_TIDDLERS_FILE

    // Attempt to sign in and start the synchronisation, automatically
    return this.start().then(function (client) {
      // Fetch the skinny tiddlers file
      return client.getFileContent(repo, ref, path)
    }).then(function (content) {
      // Assume empty array if the skinny tiddlers file doesn't exist
      content = content || '[]'

      // Parse the retrieved skinny tiddlers file content
      var tiddlers = JSON.parse(content)
      if (!$tw.utils.isArray(tiddlers)) {
        throw new Error('The skinny tiddlers file should contain an array of tiddler fields: ' + path)
      }

      // The skinny tiddlers
      return tiddlers
    })
  }

  /*
   * getTiddlerInfoFromStore returns internal metadata about the tiddler, i.e.,
   * its location reference on GitHub
   */
  GitHubAdaptor.prototype.getTiddlerInfoFromStore = function (tiddler) {
    return {
      // TODO: separate information about user, branch, repo, path
    }
  }

  /*
   * saveTiddlerInStore attempts to store the given tiddler in the configured
   * GitHub repository locaation
   */
  GitHubAdaptor.prototype.saveTiddlerInStore = function (tiddler) {
    var user = this.config.user
    var repo = this.config.repo
    var branch = this.config.branch
    var title = tiddler.fields.title
    var path = this.config.path + '/' + tiddlerPathFromTitle(title)
    var content = tiddlerFileContent(this.wiki, tiddler)
    var message = null
    var options = {
      committer: this.config.committer
    }

    return this.start().then(function (client) {
      return client.writeFile(user, repo, branch, path, content, message, options)
    })
  }

  /*
   * deleteTiddlerFromStore deletes the tiddler with the given title from the
   * configured GitHub repository location
   */
  GitHubAdaptor.prototype.deleteTiddlerFromStore = function (title, adapterInfo) {
    var user = this.config.user
    var repo = this.config.repo
    var branch = this.config.branch
    var path = this.config.path + '/' + tiddlerPathFromTitle(title)

    return this.start().then(function (client) {
      return client.deleteFile(user, repo, branch, path)
    })
  }

  function tiddlerFileContent (wiki, tiddler) {
    // ref: FileSystemAdaptor.prototype.saveTiddler
    var content = wiki.renderTiddler('text/plain', '$:/core/templates/tid-tiddler', {variables: {currentTiddler: tiddler.fields.title}})
    return content
  }

  function tiddlerPathFromTitle (title) {
    // TODO: look up the exact regular expression in tw5 core
    var re = /[^'"!?$A-Za-z0-9_ -]/g

    return title.replace(re, '_') + '.tid'
  }

  function stoppedStatus () {
    return {
      synchronising: false
    }
  }

  function startedStatus () {
    return {
      synchronising: true
    }
  }

  const ICON_UPLOADING = 'cloud_upload'
  const ICON_UPLOADED = 'cloud_done'

  function uploadingStatus () {
    return {
      writing: true,
      icon: ICON_UPLOADING
    }
  }

  function uploadedStatus () {
    return {
      writing: false,
      icon: ICON_UPLOADED
    }
  }

  exports.GitHubAdaptor = GitHubAdaptor

  if ($tw.browser) {
    exports.adaptorClass = GitHubAdaptor
  }
})()
