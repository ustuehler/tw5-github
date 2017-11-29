/*\
title: $:/plugins/ustuehler/github/skinnytiddlers.js
type: application/javascript
module-type: library

A skinny tiddler cache for use in a syncadaptor module

\*/
(function () {
  /* global $tw */

  /*
   * SkinnyTiddlers constructs a copy of the skinny tiddler list stored remotely
   */
  var SkinnyTiddlers = function (options) {
    options = options || {}
    // Array of field names to exclude in addition to 'text'
    this.excludeFields = options.excludeFields || []
    // The cache is indexed by tiddler title and contains hashmaps of skinny tiddler fields
    this.cache = {}
  }

  SkinnyTiddlers.prototype.clear = function () {
    this.cache = {}
  }

  /*
   * getTiddlers returns the skinny tiddler array to be used by the syncer
   */
  SkinnyTiddlers.prototype.getTiddlers = function () {
    var tiddlers = []
    for (var title in this.cache) {
      var tiddlerFields = this.cache[title]
      tiddlers.push(tiddlerFields)
    }
    return tiddlers
  }

  /*
   * isEmpty returns true if the cache is currently empty
   */
  SkinnyTiddlers.prototype.isEmpty = function () {
    return Object.keys(this.cache).length === 0
  }

  /*
   * setTiddlers loads the cache with the given skinny tiddler array. The
   * `tiddlers` argument can be either an array of Tiddler objects, or an
   * array of tiddler fields (an actual skinny tiddler list).
   */
  SkinnyTiddlers.prototype.setTiddlers = function (tiddlers) {
    this.clear()
    this.addTiddlers(tiddlers)
  }

  /*
   * addTiddlers adds multiple skinny tiddlers to the cache. The tiddlers
   * argument can be either an array of $tw.Tiddler objects, or an array of
   * tiddler fields (an actual skinny tiddler list).
   */
  SkinnyTiddlers.prototype.addTiddlers = function (tiddlers) {
    var self = this
    $tw.utils.each(tiddlers, function (tiddler) {
      self.addTiddler(tiddler)
    })
  }

  /*
   * addTiddler adds the given skinny tiddler to the cache, or updates an
   * existing one. The tiddler argument can be either a $tw.Tiddler, or a
   * hashmap of tiddler fields.
   */
  SkinnyTiddlers.prototype.addTiddler = function (tiddler) {
    var fields = isTiddler(tiddler) ? tiddler.fields : tiddler
    var title = fields.title
    this.cache[title] = {}
    Object.assign(this.cache[title], fields)
    delete(this.cache[title]['text'])
    for (var name in this.excludeFields) {
      delete(this.cache[title][name])
    }
  }

  function isTiddler(tiddler) {
    return (tiddler instanceof $tw.Tiddler)
  }

  /*
   * getRevision returns the current revision of the tiddler in the skinny
   * tiddler list
   */
  SkinnyTiddlers.prototype.getRevision = function (title) {
    var fields = this.cache[title]
    return fields ? fields.revision : undefined
  }

  /*
   * deleteTiddler removes a tiddler from the cache
   */
  SkinnyTiddlers.prototype.deleteTiddler = function (title) {
    delete(this.cache[title])
  }

  exports.SkinnyTiddlers = SkinnyTiddlers
})()
