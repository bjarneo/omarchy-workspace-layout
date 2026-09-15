import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "Model.js" as Model

// Keep full syncs, one-shot actions, and swaps in order. Preview has a separate latest-wins queue.
Item {
  id: root

  property var config: null
  property bool active: true
  property var workspaceIds: []
  property var workspaceMonitors: ({})
  property bool manageLoader: false
  property string sourceToken: ""

  readonly property string home: Quickshell.env("HOME")
  readonly property string configDir: Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")
  readonly property string luaPath: configDir + "/hypr/omarchy-workspace-layout.lua"
  readonly property string hyprlandLuaPath: configDir + "/hypr/hyprland.lua"
  readonly property string documentPath: configDir + "/omarchy/workspace-layout.json"

  property bool loaderInstalled: false
  property bool loaderChecked: false
  property string lastError: ""
  property bool applied: false
  property bool workspacesReady: false
  property var liveWorkspaceMonitors: ({})
  property var liveWorkspaceLayouts: ({})
  property var previousWorkspaceNames: null
  property bool syncWanted: false
  property string pendingSync: ""
  property string currentSync: ""
  property string pendingToken: ""
  property string currentToken: ""
  property string lastLuaWritten: ""
  property var pendingGathers: []
  property string pendingPreview: ""

  property bool swapping: false
  property bool swapInFlight: false
  property string pendingSwap: ""
  property string swapFrom: ""
  property string swapTo: ""
  property string swapProfile: ""

  signal synced()
  signal workspacesRead(var workspaces)
  signal workspacesRenamed(var renames)
  signal swapped(string from, string to, string profile)
  signal swapFailed(string from, string to, string message)

  function sync() {
    if (!active || !config) return
    syncWanted = true
    pendingSync = ""
    drive()
  }

  function abortPendingSwap(message) {
    if (!swapping || swapInFlight) return
    pendingSwap = ""
    swapping = false
    swapFailed(swapFrom, swapTo, message)
  }

  function acceptWorkspaces(text) {
    var workspaces = JSON.parse(text)
    if (!(workspaces instanceof Array)) throw new Error("Invalid workspace reply")
    var live = Model.workspaceSnapshot(workspaces)
    var renames = Model.workspaceRenames(previousWorkspaceNames, live.names)
    if (Model.uniqueWorkspaceNames(live.names)) previousWorkspaceNames = live.names
    liveWorkspaceMonitors = live.monitors
    liveWorkspaceLayouts = live.layouts
    workspacesReady = true
    if (Object.keys(renames).length > 0) workspacesRenamed(renames)
    workspacesRead(workspaces)
    if (!syncWanted) {
      pendingSync = Model.generateLua(config, live.ids, live.monitors)
      pendingToken = sourceToken
    }
  }

  // Each full sync reads the real monitor map. QML's cache can lag behind a workspace swap.
  function drive() {
    if (!active || !config || swapInFlight || workspaceRead.running || syncProcess.running
      || gatherProcess.running || previewProcess.running) return
    if (syncWanted) {
      syncWanted = false
      workspaceRead.running = true
    } else if (pendingSync !== "") {
      currentSync = pendingSync
      currentToken = pendingToken
      pendingSync = ""
      syncProcess.command = Model.hyprctlEvalArgs(Model.guardConfigLua(currentSync, documentPath, currentToken))
      syncProcess.running = true
    } else if (pendingGathers.length > 0) {
      var next = pendingGathers[0]
      pendingGathers = pendingGathers.slice(1)
      gatherProcess.command = Model.hyprctlEvalArgs(next)
      gatherProcess.running = true
    } else if (pendingSwap !== "") {
      swapProcess.command = Model.hyprctlEvalArgs(pendingSwap)
      pendingSwap = ""
      swapInFlight = true
      workspacesReady = false
      swapProcess.running = true
    }
  }

  Process {
    id: workspaceRead
    command: ["hyprctl", "-j", "workspaces"]
    stdout: StdioCollector { id: workspaceReply; waitForEnd: true }
    onExited: function(exitCode, exitStatus) {
      try {
        if (exitCode !== 0 || exitStatus !== 0) throw new Error("hyprctl exits " + exitCode)
        root.acceptWorkspaces(workspaceReply.text)
        root.drive()
      } catch (error) {
        root.lastError = "Cannot read Hyprland workspaces: " + error
        root.abortPendingSwap(root.lastError)
        root.syncWanted = true
        retrySync.restart()
      }
    }
  }

  Process {
    id: syncProcess
    stdout: StdioCollector { id: syncReply; waitForEnd: true }
    stderr: StdioCollector { id: syncError; waitForEnd: true }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0 || exitStatus !== 0) {
        root.lastError = root.processError(syncReply.text || syncError.text, exitCode)
        root.abortPendingSwap(root.lastError)
        root.syncWanted = true
        retrySync.restart()
        return
      }
      root.lastError = ""
      root.applied = true
      if (root.currentSync !== root.lastLuaWritten) {
        root.lastLuaWritten = root.currentSync
        luaFile.setText(root.currentSync)
      }
      root.synced()
      root.drive()
    }
  }

  function processError(reply, exitCode) {
    var message = String(reply || "").trim().replace(/^error:\s*/, "")
    return message || "hyprctl exits " + exitCode
  }

  Timer {
    id: retrySync
    interval: 1000
    onTriggered: root.drive()
  }

  function preview(layout) {
    if (!active || swapping || !layout) return
    pendingPreview = Model.livePreviewLua(layout)
    flushPreview()
  }

  function flushPreview() {
    if (!active || swapping || previewProcess.running || pendingPreview === "") return
    previewProcess.command = Model.hyprctlEvalArgs(pendingPreview)
    pendingPreview = ""
    previewProcess.running = true
  }

  Process {
    id: previewProcess
    onExited: {
      root.flushPreview()
      root.drive()
    }
  }

  function gather(match, workspaceId) {
    if (!active || swapping) return
    var lua = Model.gatherAppLua(match, workspaceId)
    if (lua === "") return
    pendingGathers = pendingGathers.concat([lua])
    drive()
  }

  function launch(command, workspaceId, follow) {
    if (!active || swapping) return
    var lua = Model.launchAppLua(command, workspaceId, follow)
    if (lua === "") return
    pendingGathers = pendingGathers.concat([lua])
    drive()
  }

  function ungroup(match, workspaceId) {
    if (!active || swapping) return
    var lua = Model.ungroupAppLua(match, workspaceId)
    if (lua === "") return
    pendingGathers = pendingGathers.concat([lua])
    drive()
  }

  Process {
    id: gatherProcess
    stdout: StdioCollector { id: gatherReply; waitForEnd: true }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0 || exitStatus !== 0) root.lastError = root.processError(gatherReply.text, exitCode)
      root.drive()
    }
  }

  function swap(from, to) {
    var lua = Model.swapWorkspacesLua(from, to)
    if (!active || lua === "" || swapping) return false
    swapFrom = String(from)
    swapTo = String(to)
    swapProfile = Model.activeProfile(config).name
    pendingSwap = Model.guardConfigLua(lua, documentPath, sourceToken)
    pendingPreview = ""
    swapping = true
    drive()
    return true
  }

  Process {
    id: swapProcess
    stdout: StdioCollector { id: swapReply; waitForEnd: true }
    onExited: function(exitCode, exitStatus) {
      if (exitCode === 0 && exitStatus === 0) {
        root.swapped(root.swapFrom, root.swapTo, root.swapProfile)
      } else {
        root.lastError = root.processError(swapReply.text, exitCode)
        root.swapFailed(root.swapFrom, root.swapTo, root.lastError)
      }
      root.swapping = false
      root.swapInFlight = false
      root.sync()
    }
  }

  FileView {
    id: luaFile
    path: root.luaPath
    atomicWrites: true
    watchChanges: false
    printErrors: false
    onLoaded: root.lastLuaWritten = text()
    onSaveFailed: {
      root.lastLuaWritten = ""
      root.lastError = "Cannot save the generated layouts: " + root.luaPath
    }
  }

  FileView {
    id: hyprlandLuaFile
    path: root.hyprlandLuaPath
    atomicWrites: true
    watchChanges: false
    printErrors: false
    onLoaded: {
      var current = text()
      root.loaderChecked = true
      if (!root.manageLoader) {
        root.loaderInstalled = !Model.needsLoader(current)
        return
      }
      if (Model.needsLoader(current)) setText(Model.withLoader(current))
      root.loaderInstalled = true
    }
    onLoadFailed: {
      root.loaderChecked = true
      root.loaderInstalled = false
    }
    onSaveFailed: root.lastError = "Cannot install the layout loader: " + root.hyprlandLuaPath
  }

  function ensureLoader() {
    hyprlandLuaFile.reload()
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (event.name === "destroyworkspacev2" && root.previousWorkspaceNames) {
        var names = root.previousWorkspaceNames
        delete names[String(event.data).split(",")[0]]
        root.previousWorkspaceNames = names
      }
      if (["configreloaded", "renameworkspace", "createworkspacev2", "destroyworkspacev2",
        "moveworkspacev2", "monitoraddedv2", "monitorremoved"].indexOf(event.name) !== -1) {
        eventSync.restart()
      }
    }
  }

  Timer {
    id: eventSync
    interval: 180
    onTriggered: root.sync()
  }
}
