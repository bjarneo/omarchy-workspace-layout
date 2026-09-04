import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Turns a config document into live Hyprland state.
//
// Two paths out of here, and they exist for different reasons:
//
//   sync()    writes the generated Lua and evaluates it. Registers layouts,
//             replaces every workspace rule, and survives a restart because
//             the file is on disk where Hyprland's config loads it.
//
//   preview() pushes one layout's spec and asks the active workspace to
//             re-tile. No file write, no re-registration — cheap enough to
//             fire on every frame of a drag, which is what makes the real
//             windows track the cursor.
//
// Both are safe to call when Hyprland is not running: hyprctl simply fails and
// the config on disk stays correct for next time.
Item {
  id: root

  property var config: null
  property var workspaceIds: []

  // Both the panel and the optional service mount one of these. If both are
  // live they each read hyprland.lua and append to the text they read, so the
  // worst a race produces is the same single line written twice over.
  property bool manageLoader: false

  readonly property string home: Quickshell.env("HOME")
  readonly property string configDir: Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")
  readonly property string luaPath: configDir + "/hypr/omarchy-workspace-layout.lua"
  readonly property string hyprlandLuaPath: configDir + "/hypr/hyprland.lua"

  property bool loaderInstalled: false
  property bool loaderChecked: false
  property string lastError: ""

  signal synced()

  // ------------------------------------------------------------------- sync

  function sync() {
    if (!config) return
    var lua = Model.generateLua(config, root.workspaceIds)
    luaFile.setText(lua)
    evaluate(lua)
    synced()
  }

  function evaluate(lua) {
    // A sync that lands while the previous one is still running would be lost,
    // so it queues instead. Only the newest matters: each payload is the whole
    // truth, not a delta.
    pendingSync = lua
    if (!syncProcess.running) flushSync()
  }

  property string pendingSync: ""

  function flushSync() {
    if (pendingSync === "") return
    syncProcess.command = Model.hyprctlEvalArgs(pendingSync)
    pendingSync = ""
    syncProcess.running = true
  }

  Process {
    id: syncProcess
    stderr: StdioCollector {
      onStreamFinished: {
        var message = String(text || "").trim()
        // "ok" is hyprctl's success reply; anything else is worth surfacing.
        root.lastError = (message.length > 0 && message !== "ok") ? message : ""
      }
    }
    onExited: root.flushSync()
  }

  // ---------------------------------------------------------------- preview

  function preview(layout) {
    if (!layout) return
    pendingPreview = Model.livePreviewLua(layout)
    if (!previewProcess.running) flushPreview()
  }

  property string pendingPreview: ""

  function flushPreview() {
    if (pendingPreview === "") return
    previewProcess.command = Model.hyprctlEvalArgs(pendingPreview)
    pendingPreview = ""
    previewProcess.running = true
  }

  Process {
    id: previewProcess
    // Latest-wins: a drag produces frames faster than hyprctl round-trips, and
    // every intermediate position is already stale by the time it would run.
    onExited: root.flushPreview()
  }

  // ------------------------------------------------------------------ files

  FileView {
    id: luaFile
    path: root.luaPath
    atomicWrites: true
    watchChanges: false
    printErrors: false
  }

  // ----------------------------------------------------------------- loader
  //
  // Hyprland only reads what its config asks for, so the generated file needs
  // one `dofile` line in hyprland.lua. Appending it is a one-time edit to a
  // file the user owns; the line is guarded by an existence check, so deleting
  // the plugin's generated file can never break their config.

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
      if (Model.needsLoader(current)) {
        setText(Model.withLoader(current))
      }
      root.loaderInstalled = true
    }

    onLoadFailed: {
      // No hyprland.lua means this is not an Omarchy Hyprland session; leave it
      // alone rather than creating a config file out of nowhere.
      root.loaderChecked = true
      root.loaderInstalled = false
    }
  }

  function ensureLoader() {
    hyprlandLuaFile.reload()
  }
}
