/*\
title: $:/plugins/ustuehler/github/githubadaptor.js
type: application/javascript
module-type: syncadaptor

A sync adaptor module for synchronising tiddlers with GitHub

\*/
(function () {
  /* global $tw, Promise */

  var Client = require('$:/plugins/ustuehler/github/client').Client
  var SyncAdaptor = require('$:/plugins/ustuehler/core').SyncAdaptor
  var Tiddlers = require('$:/plugins/ustuehler/core').Tiddlers

  var SKINNY_TIDDLER_FILE = '.json'

  var FIELD_GITHUB_PATH = 'x-github-path'

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
   *
   * The githubadaptor immediately attempts to sign the user in, and to start
   * the synchronisation. If the user cannot be signed in for any non-fatal
   * reason, then the synchronisation runs in read-only mode, where changes are
   * only synchronised from the server to the client, but the client cannot
   * write changes back.  Invalid credentials count as non-fatal errors.
   *
   * In case of a fatal error, such as the GitHub API being unavailable, the
   * initialisation still completes successfully, but this syncadaptor will not
   * report itself as ready until the user tries restarting the synchronisation
   * later with the start method.
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

    // The GitHub client is lazily constructed by getClient
    this.client = null

    var self = this
    SyncAdaptor.call(this, 'GitHubAdaptor', 'github', options)
      .then(function () {
        /*
         * The initial status is stopped, however the syncer will cause getUser
         * to be invoked very soon, which then attempts to sign the user in and
         * starts the synchronisation no matter what, execept if there was a
         * totally unexpected error
         */
        self.status.update(stoppedStatus())
      })
  }

  // Inherit from SyncAdaptor
  GitHubAdaptor.prototype = Object.create(SyncAdaptor.prototype)
  GitHubAdaptor.prototype.constructor = GitHubAdaptor

  /*
   * getClient returns a newly constructed GitHub client, or an existing one.
   * The client will use the current global credentials if needed.
   */
  GitHubAdaptor.prototype.getClient = function () {
    if (!this.client) {
      this.client = new Client()

      // Reflect GitHub's rate-limiting in our status
      var self = this
      this.status.update(this.notRateLimitedStatus())
      this.client.addEventListener('ratelimit', function (limited) {
        if (limited) {
          self.status.update(self.rateLimitedStatus())
        } else {
          self.status.update(self.notRateLimitedStatus())
        }
      })
    }
    return this.client
  }

  GitHubAdaptor.prototype.isSignedIn = function () {
    return this.getClient().isUserSignedIn()
  }

  /*
   * isReady returns true when the githubadaptor is ready to synchronise
   * tiddlers with GitHub; otherwise, returns false. It is called directly by
   * the syncer.
   */
  GitHubAdaptor.prototype.isReady = function () {
    return this.status.fields.synchronising ? true : false
  }

  /*
   * start resolves to a TiddlyWiki-specific GitHub client after attempting to
   * sign the user in automatically, and starting the synchronisation.  The
   * synchronisation won't be restarted, nor will the user be signed in, if it
   * is already running.  You should call the restart method in that case.
   *
   * As long as the synchronisation is running, tiddlers present on the server
   * will become available locally (first as skinny tiddlers and then with text
   * field, as they get lazy-loaded by the syncer). Changed tiddlers will be
   * synchronised in both directions as long as the user is signed in;
   * otherwise, changes may only be synchronised from the server to the client.
   */
  GitHubAdaptor.prototype.start = function () {
    var client = this.getClient()

    if (this.isSynchronising()) {
      return Promise.resolve(client)
    }

    var self = this
    return client.autoSignIn()
      .then(function (/*user*/) {
        self.status.update(startedStatus())
        return client
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

    if (this.client) {
      this.client.shutdown()
    }
    this.client = null

    return Promise.resolve()
  }

  /*
   * restart restarts the synchronisation, and more importantly, attempts to
   * sign the user in again. It resolves the same way as the start promise,
   * otherwise.
   */
  GitHubAdaptor.prototype.restart = function () {
    return this.stop().then(function () {
      return this.start()
    })
  }

  /*
   * getUser resolves to a (isLoggedIn, username) tuple, where username
   * may be null. It is called internally by SyncAdaptor.getStatus.
   */
  GitHubAdaptor.prototype.getUser = function () {
    // Attempt to sign in and start the synchronisation automatically
    return this.start()
      .then(function (client) {
        // The user is signed in
        return Promise.resolve([true, client.username])
      })
      .catch(function (err) {
        // Not signed in, whatever the error was
        console.debug('Ignored error validating the user credentials: ' + err)
        return Promise.resolve([false, null])
      })
  }

  /*
   * getTree resolves to the tiddler content Tree in the GitHub repository
   */
  GitHubAdaptor.prototype.getTree = function () {
    var user = this.config.user
    var repo = this.config.repo
    var branch = this.config.branch
    var ref = 'heads/' + branch
    var path = this.config.path

    return this.start().then(function (client) {
      return client.getTree(user, repo, ref, path)
    })
  }

  /*
   * getSkinnyTiddlersFromStore retrieves a list of skinny tiddlers from the
   * configured GitHub repository. A skinny tiddler is just the fields of the
   * tiddler, except for the "text" field.
   *
   * For a GitHub tiddler that means that a skinny tiddler is the head section
   * of a tiddler file, without the body, however it is not possible to fetch a
   * limited amount of content from files in a GitHub repository. This is not
   * true for tiddlers which are split into a text and a ".meta" tiddler, but
   * they are not supported yet.
   */
  GitHubAdaptor.prototype.getSkinnyTiddlersFromStore = function () {
    var self = this
    return this.getTree()
      .then(function (tree) {
        console.debug('Getting skinny tiddler file')
        return tree.getFileContent(SKINNY_TIDDLER_FILE)
      })
      .catch(function (err) {
        // Create the file if it doen't exist
        if (err.response && err.response.status == 404) {
          console.debug('Creating skinny tiddler file')
          return self.createSkinnyTiddlerFile()
        }
        throw err
      })
  }

  GitHubAdaptor.prototype.createSkinnyTiddlerFile = function () {
    // Compute the expected JSON content of the skinny tiddler file
    var self = this
    return this.computeSkinnyTiddlers()
      .then(function (tiddlers) {
        var content = JSON.stringify(tiddlers, null, '  ')

        if (!self.isSignedIn()) {
          console.debug('Unauthenticated users cannot write the skinny tiddler file')
          return tiddlers
        }

        // Try to create the skinny tiddler file
        return self.writeSkinnyTiddlerFile(content)
          .then(function () {
            // Return the computed skinny tiddlers array
            return tiddlers
          })
          .catch(function (err) {
            // Return the computed skinny tiddlers array, anyway
            console.debug('Ignored error writing skinny tiddler file: ' + err)
            return tiddlers
          })
      })
  }

  /*
   * computeSkinnyTiddlers reads all existing tiddlers once to build an initial
   * skinny tiddler list. This is an expensive operation and likely to run into
   * API rate limiting issues, which must be resolevd here.
	 */
  GitHubAdaptor.prototype.computeSkinnyTiddlers = function () {
    if (!this._computeSkinnyTiddlers) {
      var path = this.config.path
      var self = this

      this._computeSkinnyTiddlers = new Promise(function (resolve, reject) {
        var loadedTiddlers = []
        console.debug('GitHubAdaptor.computeSkinnyTiddlers: calling getTree')
        self.getTree()
          .then(function (tree) {
            console.debug('GitHubAdaptor.computeSkinnyTiddlers: getTree resolved to', tree)
            console.debug('GitHubAdaptor.computeSkinnyTiddlers: walking tree', tree)
            return tree.walk(function (node) {
              if (node.type === 'file') {
                var suffixes = ['.tid', '.meta']
                $tw.utils.each(suffixes, function (suffix) {
                  if (node.name.endsWith(suffix)) {
                    var relpath = node.path.slice(path.length + 1)
                    var fields = {title: relpath}
                    var loadTiddlers = tree.loadTiddlersFromFile(node.name, fields)
                    loadedTiddlers.push(loadTiddlers)
                  }
                })
              }
              return false // recurse, if the node is a directory
            })
          })
          .then(function () {
            return Promise.all(loadedTiddlers)
          })
          .then(function (tiddlersPerDir) {
            self._computeSkinnyTiddlers = null
            resolve(flatten(tiddlersPerDir))
          })
          .catch(function (err) {
            console.debug('GitHubAdaptor.computeSkinnyTiddlers: err:', err)
            self._computeSkinnyTiddlers = null
            reject(err)
          })
      })
    }
    return this._computeSkinnyTiddlers
  }

  GitHubAdaptor.prototype.writeSkinnyTiddlerFile = function (content) {
    return this.getTree()
      .then(function (tree) {
        return tree.writeFile(SKINNY_TIDDLER_FILE, content)
          .catch(function (err) {
            if (err.response && err.response.status >= 400 && err.response.status <= 499) {
              // Ignore client-side errors, such as authorisation failures
              console.debug('GitHubAdaptor.writeSkinnyTiddlerFile: Ignored 4xx error: ' + err)
              return null
            }
            throw err
          })
      })
  }

  /*
   * getTiddlerInfoFromStore returns internal metadata about the tiddler, i.e.,
   * its location reference on GitHub
   */
  GitHubAdaptor.prototype.getTiddlerInfoFromStore = function (/*tiddler*/) {
    return {
      // TODO: separate information about user, branch, repo, path
    }
  }

  /*
   * loadTiddlerFromStore loads the fields of a single tiddler from the GitHub
   * repository. It will read the same file that the tiddler was loaded from,
   * or compute a default path for the tiddler file based on the given title.
   */
  GitHubAdaptor.prototype.loadTiddlerFromStore = function (title) {
    var tiddler = $tw.wiki.getTiddler(title)
    var path

    if (tiddler.fields[FIELD_GITHUB_PATH]) {
      path = tiddler.fields[FIELD_GITHUB_PATH]
    } else {
      path = tiddlerPathFromTitle(title)
    }

    return this.getTree().then(function (tree) {
      return tree.loadTiddlersFromFile(path)
        .then(function (tiddlers) {
          console.debug('loadTiddlerFromStore: tiddlers:', tiddlers)
          if (tiddlers.length !== 1) {
            throw new Error('Expected file to contain a single tiddler: ' + path)
          }

          var result = tiddlers[0]
          result[FIELD_GITHUB_PATH] = path
          return result
        })
    })
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
  GitHubAdaptor.prototype.deleteTiddlerFromStore = function (title/*, adapterInfo*/) {
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

  GitHubAdaptor.prototype.isSynchronising = function () {
    return this.status.fields.synchronising
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

  GitHubAdaptor.prototype.rateLimitedStatus = function () {
    return {
      ratelimited: true
    }
  }

  GitHubAdaptor.prototype.notRateLimitedStatus = function () {
    return {
      ratelimited: false
    }
  }

  // ref: https://stackoverflow.com/questions/10865025/merge-flatten-an-array-of-arrays-in-javascript
  function flatten(arr) {
    return arr.reduce(function (flat, toFlatten) {
      return flat.concat(Array.isArray(toFlatten) ? flatten(toFlatten) : toFlatten)
    }, [])
  }


  exports.GitHubAdaptor = GitHubAdaptor

  if ($tw.browser) {
    exports.adaptorClass = GitHubAdaptor
  }
})()
