import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The layouts-and-profiles document, on disk and in memory.
//
// Lives at ~/.config/omarchy/workspace-layout.json: plain JSON the user can
// read, diff, and keep in their dotfiles. Every read goes through
// Model.normalizeConfig, so a hand-edit that gets something wrong is repaired
// rather than refused — there is no state in which this plugin has no layouts.
Item {
  id: root

  readonly property string home: Quickshell.env("HOME")
  readonly property string configDir: Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")
  readonly property string path: configDir + "/omarchy/workspace-layout.json"

  property var config: Model.defaultConfig()
  property bool ready: false
  property bool fromDisk: false
  property string lastError: ""
  property int missingReads: 0
  property bool retryRead: false
  property string sourceToken: "missing"

  // Bumped on every load and every save, so consumers can react to "the
  // document changed" without deep-comparing it.
  property int revision: 0

  signal loaded(bool existed)

  function apply(document) {
    config = Model.normalizeConfig(document)
    revision++
  }

  // Persist and adopt in one step. Writes the normalized form, so what lands on
  // disk is exactly what the plugin is running.
  function save(document) {
    if (!ready) return false
    apply(document)
    var text = JSON.stringify(config, null, 2) + "\n"
    sourceToken = Model.contentToken(text)
    file.setText(text)
    return true
  }

  // Edit through a callback that mutates a private copy. Saves callers from
  // hand-rolling a deep clone every time they change one weight.
  function mutate(change) {
    if (!ready) return false
    var draft = JSON.parse(JSON.stringify(config))
    change(draft)
    return save(draft)
  }

  // The in-memory equivalent of mutate(), for a drag in flight: the document
  // updates and the canvas follows, but nothing is written until release.
  function stage(change) {
    if (!ready) return false
    var draft = JSON.parse(JSON.stringify(config))
    change(draft)
    apply(draft)
    return true
  }

  function adopt(text) {
    try {
      var document = JSON.parse(text)
      if (!document || typeof document !== "object" || document instanceof Array) {
        throw new Error("The config must contain a JSON object")
      }
      fromDisk = true
      sourceToken = Model.contentToken(text)
      missingReads = 0
      lastError = ""
      retryRead = false
      ready = true
      apply(document)
      loaded(true)
    } catch (error) {
      lastError = "Cannot read the layout config. Correct the JSON in " + path
      retryRead = true
      console.warn("workspace-layout:", lastError, error)
    }
  }

  function readFailed(error) {
    retryRead = true
    lastError = error === FileViewError.FileNotFound
      ? "The layout config is missing: " + path
      : "Cannot read the layout config: " + path
  }

  function finishPresence(exitCode, exitStatus) {
    if (ready) return
    if (exitStatus !== 0 || exitCode !== 0) {
      missingReads = 0
      if (exitCode === 1 && retryRead) {
        retryRead = false
        file.reload()
      }
      return
    }
    missingReads++
    if (missingReads < 2) return
    lastError = ""
    retryRead = false
    ready = true
    revision++
    loaded(false)
  }

  FileView {
    id: file
    path: root.path
    watchChanges: true
    atomicWrites: true
    printErrors: false

    onLoaded: root.adopt(text())

    onLoadFailed: function(error) { root.readFailed(error) }
    onSaveFailed: root.lastError = "Cannot save the layout config: " + root.path
    onSaved: root.lastError = ""

    // text() is stale inside the change signal, so re-read and let onLoaded
    // parse fresh content. This is the path a hand-edit arrives on.
    onFileChanged: reload()
  }

  // FileView can remain silent for a missing path. Confirm absence twice.
  // An existing file, a broken symlink, and an inaccessible parent are not first runs.
  Process {
    id: presenceProbe
    command: ["sh", "-c",
      "if [ -e \"$1\" ] || [ -L \"$1\" ]; then exit 1; fi; " +
      "p=${1%/*}; while [ ! -e \"$p\" ] && [ \"$p\" != / ]; do p=${p%/*}; done; " +
      "[ -d \"$p\" ] && [ -r \"$p\" ] && [ -x \"$p\" ] || exit 2; exit 0",
      "workspace-layout-config", root.path]
    onExited: function(exitCode, exitStatus) { root.finishPresence(exitCode, exitStatus) }
  }

  Timer {
    interval: 500
    running: !root.ready || root.retryRead
    repeat: true
    onTriggered: {
      if (root.ready && root.retryRead) {
        root.retryRead = false
        file.reload()
      }
      else if (!root.ready && !presenceProbe.running) presenceProbe.running = true
    }
  }

  Component.onCompleted: file.reload()
}
