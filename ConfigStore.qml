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
    apply(document)
    file.setText(JSON.stringify(config, null, 2) + "\n")
  }

  // Edit through a callback that mutates a private copy. Saves callers from
  // hand-rolling a deep clone every time they change one weight.
  function mutate(change) {
    var draft = JSON.parse(JSON.stringify(config))
    change(draft)
    save(draft)
  }

  // The in-memory equivalent of mutate(), for a drag in flight: the document
  // updates and the canvas follows, but nothing is written until release.
  function stage(change) {
    var draft = JSON.parse(JSON.stringify(config))
    change(draft)
    apply(draft)
  }

  FileView {
    id: file
    path: root.path
    watchChanges: true
    atomicWrites: true
    printErrors: false

    onLoaded: {
      try {
        root.apply(JSON.parse(text()))
      } catch (error) {
        // Malformed JSON keeps the last good document rather than resetting the
        // user's layouts to defaults behind their back.
        console.warn("workspace-layout: config is not valid JSON, keeping the loaded document:", error)
      }
      root.ready = true
      root.loaded(true)
    }

    onLoadFailed: {
      // First run: adopt the presets in memory. Nothing is written until the
      // user makes their first change, so an uninstalled plugin leaves no trace.
      root.apply(Model.defaultConfig())
      root.ready = true
      root.loaded(false)
    }

    // text() is stale inside the change signal, so re-read and let onLoaded
    // parse fresh content. This is the path a hand-edit arrives on.
    onFileChanged: reload()
  }

  // On a first run there is no file to load, and a FileView watching a path
  // that does not exist yet can stay silent — no onLoaded, no onLoadFailed.
  // Without this the store would never become ready and nothing downstream
  // would ever run, so adopt the presets once the read has had its chance.
  Timer {
    interval: 500
    running: !root.ready
    repeat: false
    onTriggered: {
      if (root.ready) return
      root.apply(Model.defaultConfig())
      root.ready = true
      root.loaded(false)
    }
  }

  Component.onCompleted: file.reload()
}
