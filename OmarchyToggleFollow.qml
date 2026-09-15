import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Follow changed Super+L files. A directory rescan is not a new layout choice.
Item {
  id: root

  property var config: null
  property var workspaceMonitors: ({})
  property bool active: true
  property var snapshot: null
  property var pendingLive: ({})
  property var scanLive: ({})
  property bool scanAgain: false

  signal followed(var document)

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")
  readonly property string dir: stateHome + "/omarchy/workspace-layouts"

  function scan() {
    if (!root.active || !root.config) return
    if (scanProcess.running) {
      scanAgain = true
      return
    }
    scanAgain = false
    scanLive = pendingLive
    pendingLive = ({})
    scanProcess.running = true
  }

  function ingest(text) {
    if (!active || !config) {
      var pending = pendingLive
      for (var key in scanLive) pending[key] = true
      pendingLive = pending
      return
    }
    var current = Model.parseOmarchyToggleSnapshot(text)
    var changes = Model.omarchyToggleChanges(snapshot, current, scanLive)
    snapshot = current
    var next = Model.followOmarchyToggles(config, changes, { workspaceMonitors: workspaceMonitors })
    if (next) followed(next)
  }

  onActiveChanged: if (active) scanTimer.restart()

  Process {
    id: ensureDir
    running: true
    command: ["mkdir", "-p", root.dir]
    onExited: function(exitCode) {
      if (exitCode !== 0) return
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

  Process {
    id: watchProcess
    command: ["inotifywait", "-m", "-q",
      "-e", "close_write", "-e", "create", "-e", "moved_to", "--format", "%f", root.dir]
    stdout: SplitParser {
      onRead: function(line) {
        var match = /^(\d+)\.lua$/.exec(String(line))
        var key = match ? Model.normalizeWorkspaceId(match[1]) : null
        if (key === null) return
        var pending = root.pendingLive
        pending[key] = true
        root.pendingLive = pending
        scanTimer.restart()
      }
    }
  }

  Process {
    id: scanProcess
    // The fingerprint includes nanoseconds. Polls also detect a rewrite with identical content.
    command: ["sh", "-c",
      "[ -d \"$1\" ] && [ -r \"$1\" ] || exit 1; " +
      "for file in \"$1\"/*.lua; do [ -f \"$file\" ] || continue; " +
      "name=${file##*/}; id=${name%.lua}; case $id in ''|*[!0-9]*) continue;; esac; " +
      "stamp=$(stat -Lc '%i:%y:%z:%s' -- \"$file\") || continue; " +
      "content=$(cat -- \"$file\") || continue; " +
      "printf '\\036%s\\037%s\\037%s\\n' \"$id\" \"$stamp\" \"$content\"; done",
      "workspace-layout-toggles", root.dir]
    stdout: StdioCollector { id: scanReply; waitForEnd: true }
    onExited: function(exitCode, exitStatus) {
      if (exitCode === 0 && exitStatus === 0) root.ingest(String(scanReply.text || ""))
      else {
        var pending = root.pendingLive
        for (var key in root.scanLive) pending[key] = true
        root.pendingLive = pending
      }
      if (root.scanAgain) scanTimer.restart()
    }
  }

  function forget(ids) {
    var command = ["rm", "-f", "--"]
    for (var i = 0; i < ids.length; i++) {
      var key = Model.normalizeWorkspaceId(ids[i])
      if (key !== null) command.push(dir + "/" + key + ".lua")
    }
    if (command.length === 3) return
    forgetProcess.command = command
    forgetProcess.running = true
  }

  Process { id: forgetProcess }

  Timer {
    id: scanTimer
    interval: 80
    onTriggered: root.scan()
  }

  Timer {
    interval: 2000
    repeat: true
    running: root.active
    onTriggered: scanTimer.restart()
  }
}
