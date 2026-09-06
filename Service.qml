import QtQuick
import Quickshell
import Quickshell.Hyprland
import "Model.js" as Model

// Optional background sync, for running the plugin without its bar widget.
//
// `omarchy plugin enable` places a bar widget in the bar; mounting a service
// means an entry in shell.json's top-level `plugins[]`. A plugin that declares
// both, enabled the usual way, gets the widget and not the service — so the
// panel does its own syncing and never depends on this file existing.
//
// Adding "bjarneo.workspace-layout" to `plugins[]` mounts this instead, which
// keeps layouts applied for someone who drives the plugin purely by editing
// ~/.config/omarchy/workspace-layout.json and never puts it in their bar.
Item {
  id: root

  // Workspace rules are emitted for every workspace that exists, so a
  // workspace created after startup still gets claimed by the active profile.
  readonly property var workspaceIds: {
    var ids = []
    var values = Hyprland.workspaces ? Hyprland.workspaces.values : []
    for (var i = 0; i < values.length; i++) {
      var key = Model.workspaceKey(values[i])
      if (key !== null) ids.push(key)
    }
    return ids
  }

  // A monitor default resolves per workspace, so the sync needs to know where
  // each workspace currently lives.
  readonly property var workspaceMonitors: {
    var out = ({})
    var values = Hyprland.workspaces ? Hyprland.workspaces.values : []
    for (var i = 0; i < values.length; i++) {
      var monitor = values[i].monitor
      var key = Model.workspaceKey(values[i])
      if (key !== null && monitor) out[key] = String(monitor.name || "")
    }
    return out
  }

  ConfigStore {
    id: store
    onRevisionChanged: syncTimer.restart()
  }

  HyprlandSync {
    id: sync
    config: store.config
    workspaceIds: root.workspaceIds
    workspaceMonitors: root.workspaceMonitors
    manageLoader: true
  }

  // Coalesce: a save writes the file, which fires the watcher, which bumps the
  // revision. Waiting a beat collapses that into one hyprctl round-trip, and
  // gives an editor writing the file in pieces time to finish.
  Timer {
    id: syncTimer
    interval: 180
    repeat: false
    onTriggered: if (store.ready) sync.sync()
  }

  onWorkspaceIdsChanged: if (store.ready) syncTimer.restart()
  onWorkspaceMonitorsChanged: if (store.ready) syncTimer.restart()

  Component.onCompleted: sync.ensureLoader()
}
