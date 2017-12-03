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

  // TODO: move to core plugin
  var SkinnyTiddlers = require('$:/plugins/ustuehler/github/skinnytiddlers').SkinnyTiddlers

  var SKINNY_TIDDLER_FILE = '.json'

  var FIELD_GITHUB_PATH = 'x-github-path'

  /*
   * GitHubAdaptor is a syncadaptor and expects to be used together with a
   * syncer. The options are as follows:
   *
   * - user: Organisation name or username on GitHub
   * - repo: Repository name
   * - branch: Branch within the repository
   * - path: Where tiddlers are stored relative to the repository root. This
   *   should later become the path to an edition (a directory containing a
   *   tiddlywiki.info file).
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

    // Exclude adaptorInfo fields
    this.excludeFields = [FIELD_GITHUB_PATH]

    // Local cache of the skinny tiddler list, because reading and writing it can be slow
    this.skinnyTiddlersPromise = null // non-null when getSkinnyTiddlersFromStore is pending
    this.skinnyTiddlers = new SkinnyTiddlers({
      /*
       * Do not exclude the adaptorInfo fields, because we need hints in the
       * skinny tiddler list to know in which file each tiddler is stored
       */
      excludeFields: []
    })

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

      // Force querying the rate limit API the next time slowDown is called
      this.client.getRateLimit().setRemaining(0)
      this.client.getRateLimit().setResetDate(new Date())
      this.status.update(this.notRateLimitedStatus())

      // Reflect GitHub's rate-limiting in our status
      var self = this
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
   * tiddler, except for the "text" field.  This function will always return a
   * cached result (and an empty list initially), but starts an asynchronous
   * Promise to update the cache, if none is currently pending.
   *
   * Returning this list within a fixed time is important, because the syncer
   * polls the skinny tiddler list at fixed time intervals (every minute), so
   * it implicitly expects a result before the next interval starts.  However,
   * due to rate limiting it can take significantly longer than a minute to
   * load or compute the skinny tiddler list.  The syncer will get the updated
   * result during its next update interval, after the asynchronous Promise has
   * resolved, and after the skinny tildler file has optionally been created,
   * which happens only if the user has signed in in the meantime.
   */
  GitHubAdaptor.prototype.getSkinnyTiddlersFromStore = function () {
    // Maintain an asynchronous Promise to keep the cache up-to-date
    if (!this.skinnyTiddlersPromise) {
      var self = this
      var isComputed = false
      this.skinnyTiddlersPromise = this.getTree()
        .then(function (tree) {
          console.debug('Getting skinny tiddler file:', SKINNY_TIDDLER_FILE)
          return tree.getFileContent(SKINNY_TIDDLER_FILE)
        })
        .catch(function (err) {
          if (!err.response || err.response.status !== 404) {
            // Failed to load skinny tiddlers, but not because the file doesn't exist
            console.debug('Failed to load the skinny tiddler file')
            throw err
          }
          // Compute a new skinny tiddler list from the repository
          isComputed = true
          return self.getSkinnyTiddlersFromRepo()
        })
        .then(function (tiddlers) {
          // Set the cache to the loaded or computed skinny tiddlers
          console.debug('Setting skinny tiddlers cache:', tiddlers)
          self.skinnyTiddlers.setTiddlers(tiddlers)
          if (isComputed && self.isSignedIn()) {
            // Store skinny tiddlers, so that no other client has to compute them again
            return self.writeSkinnyTiddlerFile(tiddlers)
          }
          // Otherwise, load or compute them again the next time
          return null
        })
        .then(function () {
          // Loaded or computed, and optionally stored skinny tiddlers in the repository
          self.skinnyTiddlersPromise = null
          return null
        })
        .catch(function (err) {
          // Failed to load, compute, or store the skinny tiddler list
          self.skinnyTiddlersPromise = null
          throw err
        })
    }
    // This is a Promise which resolves immediately, not the pending one
    return Promise.resolve(this.skinnyTiddlers.getTiddlers())
  }

  /*
   * getSkinnyTiddlersFromRepo retrieves all tiddlers from the repository once
   * to build up a new skinny tiddler list. This is an expensive operation and
   * likely to run into API rate limiting issues, which must be resolevd here.
   * Returns the same pending Promise until the previous one is either resolved
   * or rejected.
	 */
  GitHubAdaptor.prototype.getSkinnyTiddlersFromRepo = function () {
    if (!this._computeSkinnyTiddlers) {
      var path = this.config.path
      var self = this
      this._computeSkinnyTiddlers = new Promise(function (resolve, reject) {
        var getTiddlersFromFiles = [] // Promise list
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
                    var p = tree.loadTiddlersFromFile(node.name, fields)
                    getTiddlersFromFiles.push(p)
                  }
                })
              }
              return true // recurse, if the node is a directory
            })
          })
          .then(function () {
            // tree.walk has finished, now wait for all tiddlers to be loaded
            return Promise.all(getTiddlersFromFiles)
          })
          .then(function (tiddlersFromFiles) {
            // tiddlersFromFiles contains an array of tiddlers per file
            var tiddlers = flatten(tiddlersFromFiles)
            // Strip the "text" field to make them skinny
            $tw.utils.each(tiddlers, function (fields) {
              delete(fields['text'])
            })
            self._computeSkinnyTiddlers = null
            resolve(tiddlers)
          })
          .catch(function (err) {
            self._computeSkinnyTiddlers = null
            reject(err)
          })
      })
    }
    return this._computeSkinnyTiddlers
  }

  /*
   * createSkinnyTiddlerFile creates a new skinny tiddler file from scratch
   */
  /*
  GitHubAdaptor.prototype.createSkinnyTiddlerFile = function () {
    // Compute the expected JSON content of the skinny tiddler file
    var self = this
    return this.computeSkinnyTiddlers()
      .then(function (tiddlers) {
        if (!self.isSignedIn()) {
          return tiddlers
        }

        // Try to create the skinny tiddler file
        var content = JSON.stringify(tiddlers, null, '  ')
        return self.writeSkinnyTiddlerFile(content)
          .then(function () {
            // Return the computed skinny tiddlers array
            return tiddlers
          })
          .catch(function (err) {
            // Return the computed skinny tiddlers array, anyway
            console.debug('Ignored error creating the skinny tiddler file: ' + err)
            return tiddlers
          })
      })
  }

  GitHubAdaptor.prototype.updateSkinnyTiddlerFile = function () {
    if (!this.isSignedIn()) {
      // Unauthenticated users cannot write the skinny tiddler file
      return Promise.resolve()
    }

    var tiddlers = this.skinnyTiddlers.getTiddlers()
    var content = JSON.stringify(tiddlers, null, '  ')
    return this.writeSkinnyTiddlerFile(content)
  }
  */
  // TODO: remove dead code

  /*
   * getSkinnyTiddlersFromWiki resolves to a skinny tiddler list that is
   * constructed only from the local wiki.  The list would be suitable to write
   * to the skinny tiddler file on GitHub, if one does not yet exist, and if we
   * have already computed the skinny tiddler list from the repository before,
   * so that the local wiki is actually up-to-date.
   */
  /*
  GitHubAdaptor.prototype.getSkinnyTiddlersFromWiki = function () {
    var skinnyTiddlers = []
    $tw.wiki.forEachTiddler({includeSystem: true}, function (title, tiddler) {
      // FIXME: remove this filter when the "includedWikis" property in tiddlywiki.info files is supported
      if (!tiddler.hasField(FIELD_GITHUB_PATH)) {
        return
      }
      var tiddlerFields = {}
      for (var f in tiddler.fields) {
        if (f !== 'text') {
          tiddlerFields[f] = tiddler.getFieldString(f)
        }
      }
      skinnyTiddlers.push(tiddlerFields)
    })
    return Promise.resolve(skinnyTiddlers)
  }
  */
  // TODO: remove dead code

  /*
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
  */

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

    var self = this
    return this.getTree().then(function (tree) {
      var fields = {title: title}
      return tree.loadTiddlersFromFile(path, fields)
        .then(function (tiddlers) {
          console.debug('loadTiddlerFromStore: tiddlers:', tiddlers)
          if (tiddlers.length !== 1) {
            throw new Error('Expected file to contain a single tiddler: ' + path)
          }

          var result = tiddlers[0]
          result[FIELD_GITHUB_PATH] = path
          self.skinnyTiddlers.addTiddler(result)
          return result
        })
    })
  }

  /*
   * saveTiddlerInStore attempts to store the given tiddler in the configured
   * GitHub repository locaation
   */
  GitHubAdaptor.prototype.saveTiddlerInStore = function (tiddler) {
    var fields = tiddler.fields
    var title = fields.title
    var path

    if (fields[FIELD_GITHUB_PATH]) {
      path = fields[FIELD_GITHUB_PATH]
    } else {
      path = tiddlerPathFromTitle(title)
    }

    if (fields.revision === this.skinnyTiddlers.getRevision(title)) {
      // Current revision is alredy saved, no need to save it again
      return Promise.resolve()
    }

    var self = this
    return this.getTree().then(function (tree) {
      var content = tiddlerFileContent($tw.wiki, tiddler)
      return tree.writeFile(path, content)
        .then(function (response) {
          var sha = response.data.content.sha
          $tw.wiki.setField(tiddler, 'revision', null, sha)
          self.skinnyTiddlers.addTiddler(tiddler)
        })
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

    var self = this
    return this.start().then(function (client) {
      self.skinnyTiddlers.deleteTiddler(title)
      return client.deleteFile(user, repo, branch, path)
    })
  }

  function tiddlerFileContent (wiki, tiddler) {
    // ref: FileSystemAdaptor.prototype.saveTiddler
    return wiki.renderTiddler('text/plain', '$:/core/templates/tid-tiddler', {variables: {currentTiddler: tiddler.fields.title}})
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
