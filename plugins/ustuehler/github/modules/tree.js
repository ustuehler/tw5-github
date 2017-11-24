/*\
title: $:/plugins/ustuehler/github/tree.js
type: application/javascript
module-type: library

Rate limit computation and request rate tracking logic

\*/
(function () {
  /* global $tw, Promise */

  /*
   * Tree constructs a new TiddlyWiki-specific GitHub repository tree (or a
   * subtree). The `sha` argument is optional. If it is missing, then the `ref`
   * is used to look up the current `sha` for the tree specified by `path`;
   * otherwise, if `sha` is given, then the `ref` and `path` arguments are
   * purely informational.
   */
  var Tree = function (client, user, repo, ref, path, sha) {
    this.client = client
    this.user = user
    this.repo = repo
    this.ref = ref
    this.branch = ref.startsWith('heads/') ? ref.replace('heads/', '') : null
    this.path = path
    this.sha = sha
  }

  Tree.prototype.getNodes = function () {
    return this.client.getTreeNodes(this.user, this.repo, this.ref, this.path, this.sha)
  }

  Tree.prototype.getTree = function (path, treeSHA) {
    return new Tree(this.client, this.user, this.repo, this.ref, this.path + '/' + path, treeSHA)
  }

  Tree.prototype.getFileContent = function (path) {
    return this.client.getFileContent(this.user, this.repo, this.ref, this.path + '/' + path)
  }

  Tree.prototype.writeFile = function (path, content) {
    return this.client.writeFile(this.user, this.repo, this.branch, this.path + '/' + path, content)
  }

  /*
   * walk calls `visit(node)` for each child node in in this tree. If the
   * `visit` function returns truthy, then subdirectry recursion is enabled for
   * this child node; otherwise, children of the subtree for that node will not
   * be visited.
   */
  Tree.prototype.walk = function (visit) {
    var self = this
    return this.getNodes().then(function (nodes) {
      var subtrees = []

      $tw.utils.each(nodes, function (node) {
        var recurse = visit(node)

        if (recurse && node.type === 'dir') {
          subtrees.push(self.getTree(node.name, node.sha).walk(visit))
        }
      })

      return Promise.all(subtrees)
    })
  }

  /*
   * Loads one or more tiddlers from the named child node (a tiddler file) and
   * resolves to an array of tiddlers
   */
  Tree.prototype.loadTiddlersFromFile = function (name, fields) {
    // Check if the name ends with a supported tiddler file extension
    var ext
    var extensions = ['.tid', '.meta', '.json']
    $tw.utils.each(extensions, function (e) {
      if (name.endsWith(e)) {
        ext = e
      }
    })
    if (!ext) {
      throw new Error('Unsupported tiddler file name: ' + name + ' (must end with: ' + extensions.join(', ') + ')')
    }

    var extensionInfo = $tw.utils.getFileExtensionInfo(ext)
    var type = extensionInfo ? extensionInfo.type : null
    var typeInfo = type ? $tw.config.contentTypeInfo[type] : null
    var encoding = typeInfo ? typeInfo.encoding : 'utf8'

    if (encoding !== 'utf8') {
      throw new Error('Unsupported non-utf8 tiddler encoding: ' + encoding)
    }

    return this.getFileContent(name)
      .then(function (data) {
        var tiddlers
        if (data) {
          tiddlers = $tw.wiki.deserializeTiddlers(ext, data, fields)
        } else {
          tiddlers = []
        }
        return tiddlers
      })
  }

  exports.Tree = Tree
})()
