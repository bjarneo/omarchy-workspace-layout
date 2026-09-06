import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Keeps this plugin's document in step with Omarchy's SUPER+L toggle.
//
// SUPER+L writes ~/.local/state/omarchy/workspace-layouts/<id>.lua and applies
// the rule immediately. This plugin used to ignore those files, so the bar
// stayed on dwindle after Hyprland had already moved — and the next sync
// wrote dwindle back over the toggle. Watching the directory and adopting
// builtins is what makes the two agree.
Item {
  id: root

  property var config: null
  property bool active: true

  // First scan is a catch-up for files already on disk. A leftover Super+L
  // file must not steal a workspace later given to one of this plugin's
  // layouts; a write that arrives afterwards is the key just pressed.
  property bool startupImport: true

  signal followed(var document)

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")
  readonly property string dir: stateHome + "/omarchy/workspace-layouts"

  function ingest(text, onlyBuiltins) {
    if (!root.active || !root.config) return
    var assignments = Model.parseOmarchyToggleFiles(text)
    var next = Model.followOmarchyToggles(root.config, assignments, { onlyBuiltins: onlyBuiltins })
    if (next) root.followed(next)
  }

  function scan() {
    if (!root.active) return
    if (!scanProcess.running) scanProcess.running = true
  }

  // mkdir and the JSON load race: if the first scan ran while the store was
  // still empty it returned without reading, and nothing else would try again.
  onActiveChanged: if (root.active) scanTimer.restart()

  Process {
    id: ensureDir
    running: true
    command: ["mkdir", "-p", root.dir]
    onExited: function() {
      dirWatch.reload()
      watchProcess.running = true
      scanTimer.restart()
    }
  }

  FileView {
    id: dirWatch
    path: root.dir
    watchChanges: true
    printErrors: false
    onFileChanged: scanTimer.restart()
  }

  // close_write is Super+L overwriting an existing file; create is the first
  // toggle on a workspace that had no file yet. FileView on the directory
  // catches structure changes, this catches the overwrite.
  Process {
    id: watchProcess
    command: ["inotifywait", "-m", "-q",
      "-e", "close_write", "-e", "create", "-e", "moved_to",
      "--format", "%f", root.dir]
    stdout: SplitParser {
      onRead: function(line) { scanTimer.restart() }
    }
    onExited: function() { pollTimer.running = true }
  }

  Process {
    id: scanProcess
    command: ["sh", "-c", "cat -- \"" + root.dir + "\"/*.lua 2>/dev/null"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var onlyBuiltins = root.startupImport
        root.startupImport = false
        root.ingest(String(text || ""), onlyBuiltins)
      }
    }
  }

  Timer {
    id: scanTimer
    interval: 80
    repeat: false
    onTriggered: root.scan()
  }

  Timer {
    id: pollTimer
    interval: 800
    repeat: true
    running: false
    onTriggered: scanTimer.restart()
  }
}
