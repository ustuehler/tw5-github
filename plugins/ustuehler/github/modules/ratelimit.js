/*\
title: $:/plugins/ustuehler/github/ratelimit.js
type: application/javascript
module-type: library

Rate limit computation and request rate tracking logic

\*/
(function () {
  var HOURS = 60 * 60 * 1000 // one hour

  var SPEEDUP = 8 // remaining requests get multiplied by this factor

  var RateLimit = function () {
    this.setRemaining(0)
    this.windowInterval = HOURS
    this.windowEnd = this.windowStart + this.windowInterval
    this.speedup = SPEEDUP
  }

  /*
   * getRemaining returns the assumed remaining requests in our budget.  The
   * caller should query the rate limit API and call setRemaining when this
   * value reaches 0.
   */
  RateLimit.prototype.getRemaining = function () {
    return this.remaining
  }

  /*
   * setRemaining sets the assumed number of requests remaining until the time
   * the limit gets reset. This should be the value returned by the reate limit
   * API.
   */
  RateLimit.prototype.setRemaining = function (remaining) {
    // Allow for x times more requests than the limit would actually allow, at the risk of running out, but to allow for bursts
    remaining = remaining * this.speedup

    this.windowStart = new Date()
    this.remaining = remaining
    this.windowStartRemaining = remaining
  }

  /*
   * decreaseRemaining should be called whenever we kow that we have consumed
   * one request out of the current rate limit budget. It is okay to miss some
   * requests, because once we run out of requests, the current request limits
   * will be queried again from the API (at no cost against the limit).
   */
  RateLimit.prototype.decreaseRemaining = function () {
    if (this.remaining > 0) {
      this.remaining -= 1
    }
  }

  /*
   * getResetDate returns the Date when the current request limit will expire
   */
  RateLimit.prototype.getResetDate = function () {
    return this.windowEnd
  }

  /*
   * setResetDate remembers the Date when the current request limit will expire
   * and is reset to the default limit for the next interval, as reported by
   * the rate limit API
   */
  RateLimit.prototype.setResetDate = function (resetDate) {
    this.windowEnd = resetDate
  }

  /*
   * getInternalResetDate returns the computed date when the internal rate
   * limiting allows more requests to occur
   */
  RateLimit.prototype.getInternalResetDate = function () {
    var now = new Date()

    if (now >= this.windowEnd) {
      // More requests available immediately, since the window has expired
      return now
    }

    if (this.remaining < 1) {
      // We've used up all requests and now we really need to wait
      return this.windowEnd
    }

    /*
     * Compute the start of the time slot for the next request, so that the
     * remaining requests will happen all a the same rate
     */
    var timeRemaining = this.windowEnd - now // milliseconds
    return new Date(now.getTime() + (timeRemaining / this.remaining))
  }

  exports.RateLimit = RateLimit
})()
