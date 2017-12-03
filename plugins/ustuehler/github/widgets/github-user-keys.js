/*\
title: $:/plugins/ustuehler/github/widgets/github-user-keys.js
type: application/javascript
module-type: widget
caption: github-user-keys

Widget that renders the public keys for a given GitHub user

\*/
(function (global) {
  'use strict'
  /*jslint node: true, browser: true */
  /*global $tw: false */

  var Widget = require('$:/core/modules/widgets/widget.js').widget

  var GitHubUserKeysWidget = function (parseTreeNode, options) {
    this.initialise(parseTreeNode, options)
  }

  /*
Inherit from the base widget class
*/
  GitHubUserKeysWidget.prototype = new Widget()

  /*
Render this widget into the DOM
*/
  GitHubUserKeysWidget.prototype.render = function (parent, nextSibling) {
    var self = this

    this.computeAttributes()
    this.execute()

    // Create the DOM node for this widget
    var domNode = this.document.createElement('div')
    this.domNode = domNode

    // Fetch and render the user keys using the supplied template
    $tw.utils.github.getUserKeys(this.user).then(function (keys) {
      var domNode = self.domNode

      // Clear our DOM node
      while (domNode.firstChild) {
        domNode.removeChild(domNode.firstChild)
      }

      /*
		 * Render each key into our DOM node using the specifed template tiddler.
     * Properties of the key are made available as temporary local variables.
     */
      var lastChild = null
      keys.forEach(function (key) {
        lastChild = renderUserKey(self.document, domNode, lastChild, key)
      })

      $tw.utils.showSnackbar('Retrieved ' + keys.length + ' keys for ' + self.user + '.')
    }).catch(function (err) {
      console.log('getUserKeys: ' + err)
      $tw.utils.showSnackbar('Failed to retrieve SSH public keys for ' + self.user + '.')
    })

    parent.insertBefore(domNode, nextSibling)
    this.renderChildren(domNode, null)
    this.domNodes.push(domNode)
  }

  function renderUserKey (document, parent, nextSibling, key) {
    var domNode = document.createElement('p')
    domNode.innerHTML = key.key
    parent.insertBefore(domNode, nextSibling)
    return domNode
  }

  /*
Compute the internal state of the widget
*/
  GitHubUserKeysWidget.prototype.execute = function () {
    var defaultUser = this.getTemporarySetting('UserName', this.getSetting('username'))

    this.user = this.getAttribute('user', defaultUser)

    // Compute the internal state of child widgets.
    this.makeChildWidgets()
  }

  /*
Selectively refreshes the widget if needed. Returns true if the widget or any of its children needed re-rendering
*/
  GitHubUserKeysWidget.prototype.refresh = function (changedTiddlers) {
    var changedAttributes = this.computeAttributes()

    if (changedAttributes.user) {
      this.refreshSelf()
      return true
    }

    return this.refreshChildren(changedTiddlers)
  }

  // TODO: move getTemporarySetting and getSetting to $tw.utils.github

  GitHubUserKeysWidget.prototype.getTemporarySetting = function (name, fallback) {
    return $tw.wiki.getTiddlerText('$:/temp/GitHub/' + name) || fallback
  }

  GitHubUserKeysWidget.prototype.getSetting = function (name, fallback) {
    return $tw.wiki.getTiddlerText('$:/plugins/ustuehler/github/settings/' + name) || fallback
  }

  exports['github-user-keys'] = GitHubUserKeysWidget
})(this)
