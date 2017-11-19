/*\
title: $:/plugins/ustuehler/github/widgets/action-githubwritefile.js
type: application/javascript
module-type: widget
caption: action-githubwritefile

Action widget that toggles the visibility of the first drawer found in the document

\*/
(function () {
  /* global $tw */

  var Widget = require('$:/core/modules/widgets/widget.js').widget
  var Tiddlers = require('$:/plugins/ustuehler/core').Tiddlers
  var Client = require('$:/plugins/ustuehler/github/client').Client

  var GitHubWriteFileWidget = function (parseTreeNode, options) {
    this.config = new Tiddlers('GitHub')
    this.initialise(parseTreeNode, options)
  }

  // Inherit from the base widget class
  GitHubWriteFileWidget.prototype = new Widget()

  // Render this widget into the DOM
  GitHubWriteFileWidget.prototype.render = function (parent, nextSibling) {
    this.computeAttributes()
    this.execute()
  }

  /*
   * Compute the internal state of the widget
   */
  GitHubWriteFileWidget.prototype.execute = function () {
    this.template = this.getAttribute('template')
    this.owner = this.getAttribute('owner')
    this.repo = this.getAttribute('repo')
    this.branch = this.getAttribute('branch')
    this.path = this.getAttribute('path')
    this.message = this.getAttribute('message')

    // TODO: Make committer info configurable
    this.committerName = this.getAttribute('name', 'Uwe Stuehler')
    this.committerEmail = this.getAttribute('email', 'ustuehler@growit.io')

    // Compute the internal state of child widgets.
    this.makeChildWidgets()
  }

  /*
   * Selectively refreshes the widget if needed. Returns true if the widget or any of its children needed re-rendering
   */
  GitHubWriteFileWidget.prototype.refresh = function (changedTiddlers) {
    var changedAttributes = this.computeAttributes()

    if (changedAttributes.template ||
      changedAttributes.owner ||
      changedAttributes.repo ||
      changedAttributes.branch ||
      changedAttributes.path ||
      changedAttributes.message ||
      changedAttributes.committerName ||
      changedAttributes.committerEmail) {
      this.refreshSelf()
      return true
    }

    return this.refreshChildren(changedTiddlers)
  }

  /*
   * Invoke the action associated with this widget
   */
  GitHubWriteFileWidget.prototype.invokeAction = function (triggeringWidget, event) {
    var currentTiddler = this.getVariable('currentTiddler')
    var tiddler = $tw.wiki.getTiddler(currentTiddler)
    var client = new Client()

    var owner = this.owner || this.config.getConfigText('User') || this.config.getStatusText('UserName')
    var repo = this.repo || this.config.getConfigText('Repo') || (owner + '.github.io')
    var branch = this.branch || this.config.getConfigText('Branch') || 'master'
    var path = this.path || this.getPathFromTitle(currentTiddler)

    var fields = tiddler ? tiddler.fields : {title: currentTiddler}
    var content = this.renderTemplate(this.template) || ('title: ' + currentTiddler + '\n\n')
    var message = this.message || ('Update ' + fields.title)

    var options = {
      committer: {
        name: this.committerName,
        email: this.committerEmail
      }
    }

    client.initialise().then(function (github) {
      var repository = github.getRepo(owner, repo)

      console.log('branch', branch, 'path', path, 'content', content, 'message', message, 'options', options)

      repository.writeFile(branch, path, content, message, options, function (err) {
        if (err) {
          $tw.utils.showSnackbar('Error from GitHub: ' + err)
        } else {
          $tw.utils.showSnackbar('File uploaded: ' + path)
        }
      })
    })

    return true // Action was invoked
  }

  GitHubWriteFileWidget.prototype.renderTemplate = function (template) {
    var contentType = 'text/plain'
    var options = {}

    return this.wiki.renderTiddler(contentType, template, options)
  }

  GitHubWriteFileWidget.prototype.getTemporarySetting = function (name, fallback) {
    return $tw.wiki.getTiddlerText('$:/temp/GitHub/' + name) || fallback
  }

  GitHubWriteFileWidget.prototype.getSetting = function (name, fallback) {
    return $tw.wiki.getTiddlerText('$:/plugins/ustuehler/github/settings/' + name) || fallback
  }

  GitHubWriteFileWidget.prototype.getPathFromTitle = function (title) {
    var re = /[^$A-Za-z0-9_ -]/g

    return (this.config.getConfigText('Path') || '') + '/' +
      title.replace(re, '_') + '.tid'
  }

  GitHubWriteFileWidget.prototype.tiddlerContent = function (tiddler) {
    var fields = tiddler.fields
    var content = ''

    // https://stackoverflow.com/questions/921789/how-to-loop-through-plain-javascript-object-with-objects-as-members
    for (var field in fields) {
      // skip loop if the property is from prototype
      //if (!fields.hasOwnProperty(field)) continue;

      if (field !== 'text' && field !== 'created' && field !== 'modified' && field !== 'bag' && field !== 'revision') {
        content += field + ': ' + tiddler.fields[field] + '\n'
      }
    }

    content += '\n' + tiddler.fields.text

    return content
  }

  /*
 * Don't allow actions to propagate, because we invoke actions ourself
 */
  GitHubWriteFileWidget.prototype.allowActionPropagation = function () {
    return false
  }

  exports['action-githubwritefile'] = GitHubWriteFileWidget
})()
