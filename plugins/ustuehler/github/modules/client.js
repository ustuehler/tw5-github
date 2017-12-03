/*\
title: $:/plugins/ustuehler/github/client.js
type: application/javascript
module-type: library

TiddlyWiki-specific GitHub API client that can configure itself from tiddlers
and respects rate-limits as reported by GitHub's Rate Limiting API

\*/
(function () {
  /* global Promise */

  var getWindowProperty = require('$:/plugins/ustuehler/core/utils').getWindowProperty
  var Observable = require('$:/plugins/ustuehler/core').Observable
  var Tiddlers = require('$:/plugins/ustuehler/core').Tiddlers

  var RateLimit = require('$:/plugins/ustuehler/github/ratelimit').RateLimit
  var Tree = require('$:/plugins/ustuehler/github/tree').Tree

  // Access token or password to use when no credentials are specified (read-only)
  var TEMP_TOKEN = 'AccessToken' // $:/temp/GitHub/AccessToken

  // Username to use with the password when no credentials are specified (read-only)
  var STATUS_USER_NAME = 'UserName' // $:/status/GitHub/UserName

  // Tracks the global internal rate limit for all Client objects
  var rateLimit = new RateLimit()

  /*
   * Client constructs a TiddlyWiki-specific GitHub API client that wraps the
   * real GitHub API client. It can be called in one of three ways:
   *
   * - ()
   * - (token)
   * - (username, password)
   *
   * In the first form, the client will use the current access token, or the
   * current username and password (stored in the access token tiddler).  If
   * there is no access token (and no username and password), then a public
   * client is created, which means that it can read public information, but
   * it doesn't have write access to repositories.
   *
   * The same is true if in the other two forms either token or password
   * is null.
   */
  var Client = function (username, token) {
    // Resolves config, status and temp tiddlers for this client
    this.tiddlers = new Tiddlers('GitHub')

    if (arguments.length < 2) {
      // username is actually the token, or null
      this.setToken(token)
    } else {
      // token may be a password, if username is non-empty
      this.setUsernameAndPassword(username, token)
    }

    this.waitingQueue = []

    return Observable.call(this)
  }

  // Inerhit from Observable
  Client.prototype = Object.create(Observable.prototype)
  Client.prototype.constructor = Client

  Client.prototype.setToken = function (token) {
    this.username = null
    this.token = token
    this.setDefaultCredentials()
  }

  Client.prototype.setUsernameAndPassword = function (username, password) {
    this.username = username
    this.token = password
    this.setDefaultCredentials()
  }

  Client.prototype.setDefaultCredentials = function () {
    this.username = this.username || this.tiddlers.getStatusText(STATUS_USER_NAME)
    this.token = this.token || this.tiddlers.getTempText(TEMP_TOKEN)
  }

  /*
   * initialise guarantees the proper sequence during initialisation, i.e.,
   * that the GitHub window property is available before we reference its value
   * to instantiate the API client object. The promise resolves to the real
   * GitHub API client (https://github.com/github-tools/github).  initialise
   * will reuse a pre-existing client.  To switch access credentials later,
   * use the signIn method.
   *
   * initialise should only be called by other methods on this object, because
   * it exposes the real GitHub API client.
   */
  Client.prototype.initialise = function () {
    var self = this

    if (this.github) {
      return Promise.resolve(this.github)
    }

    return getWindowProperty('GitHub').then(function (GitHub) {
      self.github = new GitHub({
        username: self.username,
        token: self.token
      })
      return self.github
    })
  }

  // getSignedInUser should only be called internally
  Client.prototype.getSignedInUser = function () {
    return this.user
  }

  // setSignedInUser should only be called internally
  Client.prototype.setSignedInUser = function (user) {
    this.user = user
  }

  /*
   * isUserSignedIn returns true if the user has signed in successfully;
   * otherwise, returns false
   */
  Client.prototype.isUserSignedIn = function () {
    return this.user ? true : false
  }

  /*
   * signIn signs the user in with the given token. If the username is not
   * null, then the token may be a password. Password-based sign-in will only
   * succeed if the user account does not have Two-Factor Authentication
   * enabled. The token or password is left unchanged if it is not given now,
   * but has been given before.
   *
   * There is no need to call the signIn method, unless you want to change
   * credentials from the ones which were used in the construction of this
   * client, or if you want to validate the credentials given at construction
   * time.
   *
   * The Promise returned by signIn resolves to an object that describes the
   * user. The object has at least a "login" field containing the GitHub
   * username corresponding to the access credentials.
   */
  Client.prototype.signIn = function (username, token) {
    var self = this
    return this.signOut().then(function () {
      /*
       * Same logic as in the constructor, except that the username and token are
       * not reset to current defaults, but left untouched if they were not given
       * now.
       */
      if (arguments.length < 2) {
        self.setToken(username)
      } else {
        self.setUsernameAndPassword(username, token)
      }

      /*
       * Try to get the user profile for this token. The API call requires
       * authorisation, and so should be useful in determining if the accsess
       * token is valid.
       */
      return self.initialise().then(function (github) {
        return github.getUser().getProfile()
          .then(function (response) {
            return response.data
          })
          .then(function (profile) {
            self.setSignedInUser({ login: profile.login })
            return self.user
          })
      })
    })
  }

  /*
   * Forgets the current GitHub client and useri, and resolves immediately
   */
  Client.prototype.signOut = function () {
    this.setSignedInUser(null)
    this.client = null
    return Promise.resolve()
  }

  /*
   * autoSignIn calls client.signIn, but will silently ignore any 4xx errors
   * returned by the GitHub API and resolve to null, instead. This means that
   * authorisation failures (401) will not result in an error. If the user is
   * currently signed in, autoSignIn resolves immediately.
   */
  Client.prototype.autoSignIn = function () {
    if (this.isUserSignedIn()) {
      return Promise.resolve(this.getSignedInUser())
    }

    // Avoid an unnecessary 401 response, because this is neither a valid token nor a valid username/password combination
    if (!this.token) {
      return Promise.resolve(null)
    }

    var self = this
    return this.initialise().then(function () {
      return self.signIn()
        .catch(function (err) {
          if (err.response && (err.response.status >= 400 && err.response.status <= 499)) {
            // Ignore non-fatal errors, such as "Unauthorized" (401)
            return null
          }
          // Fatal error, such as 5xx
          throw err
        })
    })
  }

  /*
   * getRepo should only be called from other methods, because it exposes the
   * the real GitHub Repository API client object
   */
  Client.prototype.getRepo = function (user, repo) {
    return this.initialise()
      .then(function (github) {
        return github.getRepo(user, repo)
      })
  }

  Client.prototype._getGitHubRateLimit = function (github, cb) {
    github.getRateLimit().getRateLimit(function (err, limit) {
      var reset = new Date(limit.resources.core.reset * 1000)

      rateLimit.setRemaining(limit.resources.core.remaining)
      rateLimit.setResetDate(reset)

      cb(err, limit)
    })
  }

  Client.prototype.shutdown = function () {
    var self = this
    return new Promise(function (resolve/*, reject*/) {
      while (self.waitingQueue.length > 0) {
        var waiter = self.waitingQueue.pop()

        clearTimeout(waiter.timeout)

        // FIXME: resolve the promise instead of rejecting it, because some operations could even succeed, others will fail anyway
        if (waiter.promise.resolve) {
          waiter.promise.resolve()
        }
        if (waiter.promise.reject) {
          waiter.promise.reject(new Error('GitHub client was shut down'))
        }
      }

      // Force querying the rate limit API the next time slowDown is called
      rateLimit.setRemaining(0)
      rateLimit.setResetDate(new Date())

      resolve()
    })
  }

  Client.prototype._waitUntil = function (date) {
    var self = this
    return new Promise(function (resolve, reject) {
      var now = new Date()

      if (now >= date) {
        // Target date is already in the past
        return resolve(self)
      }

      var timeout = setTimeout(function () { resolve(self) }, date - now)
      var waiter = {
        timeout: timeout,
        promise: {
          resolve: function () { resolve(self) },
          reject: reject
        }
      }

      self.waitingQueue.push(waiter)
    })
  }

  Client.prototype._waitUntilNextRequest = function () {
    var now = new Date()
    var reset = rateLimit.getInternalResetDate()
    var seconds = (reset.getTime() - now.getTime()) / 1000
    console.debug('Waiting for ' + seconds + ' seconds until rate limit resets at ' + reset + ' with ' + rateLimit.getRemaining() + ' out of ' + rateLimit.windowStartRemaining + ' requests remaining')

    this.dispatchEvent('ratelimit', {until: reset})
    return this._waitUntil(reset)
      .then(function (self) {
        self.dispatchEvent('ratelimit', null)
        return self
      })
  }

  /*
   * slowDown resolves to this client when there are enough requests in our
   * rate-limiting budget
   */
  Client.prototype.slowDown = function () {
    var self = this
    return this.initialise().then(function (github) {
      return new Promise(function (resolve, reject) {
        if (rateLimit.getRemaining() > 0) {
          // Consider our global request rate and slow down a bit, if needed
          return self._waitUntilNextRequest().then(resolve).catch(reject)
        }

        // Kindly ask GitHub how many requests we have left and when they will reset our limits
        self._getGitHubRateLimit(github, function (err, limit) {
          if (err) {
            // Reject the slowDown promise if there was an error getting the limits
            return reject(err)
          }

          // Wait until the internal rate limit expires
          console.debug('Got rate limit from GitHub:', limit)
          console.debug('The rate limit window expires at ' + rateLimit.getResetDate())
          self._waitUntilNextRequest().then(resolve).catch(reject)
        })
      })
    })
  }

  /*
   * getSha resolves to the blob SHA for the specified path
   */
  Client.prototype.getSha = function (user, repo, branch, path) {
    var self = this
    return this.slowDown()
      .then(function () {
        return self.getRepo(user, repo)
      })
      .then(function (r) {
        rateLimit.decreaseRemaining()
        return r.getSha(branch, path)
      })
      .then(function (response) {
        return response.data.sha
      })
  }

  /*
   * getBlob resolves to the response for the specified blob SHA
   */
  Client.prototype.getBlob = function (user, repo, sha) {
    var self = this
    return this.slowDown()
      .then(function (/*self*/) {
        return self.getRepo(user, repo)
      })
      .then(function (r) {
        rateLimit.decreaseRemaining()
        return r.getBlob(sha)
      })
  }

  /*
   * getCommitSHA resolves to the commit SHA for the specified ref
   */
  /*
  Client.prototype.getCommitSHA = function (user, repo, ref) {
    var self = this
    return this.slowDown()
      .then(function () {
        return self.getRepo(user, repo)
      })
      .then(function (r) {
        // TODO: Use Blob API for large files up to 100 megabytes
        rateLimit.decreaseRemaining()
        return r.getRef(ref)
      })
      .then(function (response) {
        return response.data.sha
      })
  }
  */

  /*
   * getContents
   */
  Client.prototype.getContents = function (user, repo, ref, path) {
    var self = this
    return this.slowDown()
      .then(function (/*self*/) {
        return self.getRepo(user, repo)
      })
      .then(function (r) {
        // TODO: Use Blob API for large files up to 100 megabytes
        rateLimit.decreaseRemaining()
        return r.getContents(ref, path, true)
      })
  }

  /*
   * getFileContent resolves to the full content of the specified file.  It
   * will currently fail if the content is close to, or exceeds 1 metabyte.
   */
  Client.prototype.getFileContent = function (user, repo, ref, path) {
    return this.getContents(user, repo, ref, path)
      .then(function (response) {
        return response.data
      })
  }

  // ref: https://developer.mozilla.org/en-US/docs/Web/API/WindowBase64/Base64_encoding_and_decoding
  /*
  function b64DecodeUnicode(str) {
    // Going backwards: from bytestream, to percent-encoding, to original string.
    return decodeURIComponent(atob(str).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
    }).join(''))
  }
  */

  /*
   * getTreeNodes resolves to a tree node as returned by the GitHub API's
   * getTree method. If the tree does not exist, the promise resolves to null
   * instead of throwing an error.
   */
  Client.prototype.getTreeNodes = function (user, repo, ref, path, treeSHA) {
    console.debug('Client.getTreeNodes', 'user:', user, 'ref:', ref, 'path:', path, 'treeSHA', treeSHA)
    // TODO: handle treeSHA or drop the argument
    return this.getFileContent(user, repo, ref, path)
  }

  /*
   * writeFile resolves when the specified file content has been written
   * successfully. The options hash must specify a committer.
   */
  Client.prototype.writeFile = function (user, repo, branch, path, content, message, options) {
    var committer = {}

    message = message || 'Update ' + path
    options = options || {}

    if (options.committer) {
      Object.assign(committer, options.committer)
    }

    if (!committer.name) {
      committer.name = 'TiddlyWiki'
    }

    if (!committer.email) {
      committer.email = 'tiddlywiki'
    }

    return this.getRepo(user, repo)
      .then(function (r) {
        rateLimit.decreaseRemaining()
        return r.writeFile(branch, path, content, message, {
          committer: committer,
          encode: true
        })
      })
      .catch(function (err) {
        if (err.response.status === 409) {
          // Not an error; 409 means that the content is up-to-date
          return null
        }
        throw err
      })
  }

  /*
   * deleteFile resolves when the specified file content has been deleted
   * successfully
   */
  Client.prototype.deleteFile = function (user, repo, branch, path) {
    return this.getRepo(user, repo)
      .then(function (r) {
        rateLimit.decreaseRemaining()
        return r.deleteFile(branch, path)
      })
      .catch(function (err) {
        if (err.response.status === 409) {
          // Not an error, just means that the file does not exist
          return null
        }
        throw err
      })
  }

  /*
   * getTree returns the tree represented by the given `treeSHA`. If `treeSHA`
   * is not given, then the tree at the given `path` for the top commit on
   * `ref` is returned, instead.
   */
  Client.prototype.getTree = function (user, repo, ref, path, treeSHA) {
    return new Tree(this, user, repo, ref, path, treeSHA)
  }

  /**
   * List a user's public keys
   *
   * @see https://developer.github.com/v3/users/keys/#list-public-keys-for-a-user
   * @param {String} [username] - the username whose keys should be listed
   * @return {Promise} - the promise for the user keys
   *
   * A function like this is missing in the official API client for JavaScript.
   * Check https://github.com/github-tools/github/blob/master/lib/User.js to see
   * if that was changed in the meantime.
   */
  Client.prototype.getUserKeys = function (username) {
    return this.initialise().then(function (github) {
      return new Promise(function (resolve, reject) {
        var u = github.getUser(username)

        rateLimit.decreaseRemaining()

        u._request('GET', u.__getScopedUrl('keys'), null, function (err, data/*, response*/) {
          if (err) {
            reject(err)
          } else {
            resolve(data)
          }
        })
      })
    })
  }

  // Returns the global rate limit tracker
  Client.prototype.getRateLimit = function () {
    return rateLimit
  }

  exports.Client = Client
})()
