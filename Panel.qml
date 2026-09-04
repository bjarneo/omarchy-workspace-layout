import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "bjarneo.workspace-layout"
  ipcTarget: "workspace-layout"
  // One IpcHandler for the target, routed through the bar so a hotkey opens the
  // copy on the focused monitor rather than an arbitrary one.
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // ------------------------------------------------------------------ state

  // Which workspace the canvas is editing. Follows the focused workspace until
  // the user picks another chip, and re-follows whenever the panel reopens —
  // "the workspace I am looking at" is right far more often than not.
  property int selectedWorkspace: 1
  property bool workspacePinned: false

  // Live tiled-window counts per workspace, so the canvas can say which slots
  // are actually occupied. Only polled while the panel is open.
  property var tiledCounts: ({})

  property int focusedDivider: 0
  property bool showKeys: false

  // Whether picking a layout claims one workspace or becomes the default every
  // workspace falls back to. "All workspaces" is the setting most people want
  // first — one shape everywhere — and per-workspace is the exception.
  property string assignTarget: "workspace"

  // Two-step destructive actions: the first press arms, the second commits.
  property string armedDelete: ""
  readonly property bool armedRestore: armedDelete === "restore"

  property string newProfileDraft: ""
  property bool creatingProfile: false

  readonly property var config: store.config
  readonly property var profile: Model.activeProfile(config)
  readonly property var layouts: config && config.layouts instanceof Array ? config.layouts : []

  readonly property bool assigningAll: assignTarget === "all"

  // The canvas edits whatever the current target resolves to, so the shape on
  // screen is always the one a click in the library would replace.
  readonly property string selectedLayoutId: assigningAll
    ? (profile ? profile.fallback : "dwindle")
    : Model.layoutIdForWorkspace(config, selectedWorkspace)
  readonly property var selectedLayout: Model.findLayout(config, selectedLayoutId)
  readonly property bool editingBuiltin: Model.isBuiltin(selectedLayoutId)

  readonly property int selectedWindowCount: {
    var value = tiledCounts[String(selectedWorkspace)]
    return value === undefined ? 0 : value
  }

  // Exposed to the bar widget so its icon can be a picture of the layout the
  // focused workspace is running.
  readonly property int focusedWorkspaceId: Hyprland.focusedWorkspace ? Hyprland.focusedWorkspace.id : 1
  readonly property string focusedLayoutId: Model.layoutIdForWorkspace(config, focusedWorkspaceId)
  readonly property var focusedLayout: Model.findLayout(config, focusedLayoutId)
  readonly property string activeProfileName: profile ? profile.name : ""
  readonly property bool managingFocused: !Model.isBuiltin(focusedLayoutId)

  readonly property real screenAspect: {
    var screen = panel.screen
    if (screen && screen.width > 0 && screen.height > 0) return screen.width / screen.height
    return 16 / 9
  }

  // Workspaces 1-10 are Omarchy's default set; anything else the user has
  // created joins the row so it can be assigned too.
  readonly property var workspaceRow: {
    var ids = []
    var i
    for (i = 1; i <= 10; i++) ids.push(i)
    var values = Hyprland.workspaces ? Hyprland.workspaces.values : []
    for (i = 0; i < values.length; i++) {
      var id = values[i].id
      if (id > 10 && ids.indexOf(id) === -1) ids.push(id)
    }
    ids.sort(function(a, b) { return a - b })
    return ids
  }

  readonly property var library: {
    var out = [
      { id: "dwindle", name: "Dwindle", builtin: true, thumb: { weights: [50, 50], overflow: "last" } },
      { id: "master", name: "Master", builtin: true, thumb: { weights: [62, 38], overflow: "last" } },
      { id: "scrolling", name: "Scroll", builtin: true, thumb: { weights: [40, 40, 20], overflow: "extend" } }
    ]
    for (var i = 0; i < layouts.length; i++) {
      out.push({ id: layouts[i].id, name: layouts[i].name, builtin: false, thumb: layouts[i] })
    }
    return out
  }

  // -------------------------------------------------------------- lifecycle

  function openFromHotkey() { open() }

  onOpenedChanged: {
    armedDelete = ""
    creatingProfile = false
    if (opened) {
      if (!workspacePinned) selectedWorkspace = focusedWorkspaceId
      focusedDivider = 0
      refreshCounts()
    }
  }

  onFocusedWorkspaceIdChanged: if (!workspacePinned && !opened) selectedWorkspace = focusedWorkspaceId

  function selectWorkspace(id) {
    selectedWorkspace = id
    workspacePinned = id !== focusedWorkspaceId
    focusedDivider = 0
    armedDelete = ""
  }

  // ------------------------------------------------------------- edit paths

  // A drag: update in memory, push the spec to Hyprland, write nothing. The
  // canvas and the real windows move together and the disk stays quiet.
  function stageWeights(weights) {
    if (!selectedLayout) return
    var id = selectedLayout.id
    store.stage(function(draft) {
      for (var i = 0; i < draft.layouts.length; i++) {
        if (draft.layouts[i].id === id) draft.layouts[i].weights = weights
      }
    })
    sync.preview(Model.findLayout(store.config, id))
  }

  // Release: persist. The service picks the file change up and re-emits the
  // full runtime, which is also what rewrites the Lua on disk.
  function commitLayout() {
    if (!selectedLayout) return
    store.save(store.config)
    sync.sync()
  }

  function editSelectedLayout(change) {
    if (!selectedLayout) return
    var id = selectedLayout.id
    store.mutate(function(draft) {
      for (var i = 0; i < draft.layouts.length; i++) {
        if (draft.layouts[i].id === id) change(draft.layouts[i])
      }
    })
    sync.sync()
  }

  function assignLayout(layoutId) {
    var workspace = String(selectedWorkspace)
    var all = assigningAll
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target) return
      if (all) {
        // "All workspaces" has to mean all of them, so the per-workspace
        // exceptions go with it — otherwise the ones already claimed would
        // quietly ignore the choice.
        target.fallback = layoutId
        target.assignments = {}
      } else {
        target.assignments[workspace] = layoutId
      }
    })
    focusedDivider = 0
    sync.sync()
  }

  function addSlot() {
    editSelectedLayout(function(layout) { layout.weights = Model.addSlot(layout.weights) })
  }

  function removeSlot() {
    editSelectedLayout(function(layout) {
      layout.weights = Model.removeSlot(layout.weights, layout.weights.length - 1)
    })
  }

  function toggleOrientation() {
    editSelectedLayout(function(layout) {
      layout.orientation = layout.orientation === "rows" ? "columns" : "rows"
    })
  }

  function toggleUnderfill() {
    editSelectedLayout(function(layout) {
      layout.underfill = layout.underfill === "hold" ? "rescale" : "hold"
    })
  }

  function cycleOverflow() {
    var order = ["last", "first", "extend"]
    editSelectedLayout(function(layout) {
      layout.overflow = order[(order.indexOf(layout.overflow) + 1) % order.length]
    })
  }

  function resetWeights() {
    editSelectedLayout(function(layout) {
      layout.weights = Model.evenWeights(layout.weights.length)
    })
  }

  function nudgeDivider(delta) {
    if (!selectedLayout || selectedLayout.kind === "grid") return
    var edges = Model.dividerPositions(selectedLayout.weights)
    if (edges.length === 0) return
    var index = Math.max(0, Math.min(focusedDivider, edges.length - 1))
    focusedDivider = index
    var weights = Model.setDivider(selectedLayout.weights, index, edges[index] + delta, { snap: false })
    stageWeights(weights)
    commitTimer.restart()
  }

  // A held key produces a stream of nudges; write once when it stops.
  Timer {
    id: commitTimer
    interval: 260
    repeat: false
    onTriggered: root.commitLayout()
  }

  // ---------------------------------------------------------------- library

  function newLayout() {
    var id = Model.uniqueLayoutId(config, "custom")
    store.mutate(function(draft) {
      draft.layouts.push({
        id: id, name: "Custom", kind: "ratio", orientation: "columns",
        overflow: "last", weights: [50, 50]
      })
      root.claim(draft, id)
    })
    sync.sync()
  }

  function duplicateLayout() {
    if (!selectedLayout) return
    var source = selectedLayout
    var id = Model.uniqueLayoutId(config, source.id)
    store.mutate(function(draft) {
      var copy = JSON.parse(JSON.stringify(source))
      copy.id = id
      copy.name = Model.sanitizeName(source.name + " copy", "Copy")
      draft.layouts.push(copy)
      root.claim(draft, id)
    })
    sync.sync()
  }

  // Point the current target at a layout inside a draft document.
  function claim(draft, id) {
    var target = Model.findProfile(draft, draft.activeProfile)
    if (!target) return
    if (root.assigningAll) {
      target.fallback = id
      target.assignments = {}
    } else {
      target.assignments[String(root.selectedWorkspace)] = id
    }
  }

  function deleteLayout(id) {
    if (Model.isBuiltin(id) || layouts.length <= 1) return
    store.mutate(function(draft) {
      for (var i = draft.layouts.length - 1; i >= 0; i--) {
        if (draft.layouts[i].id === id) draft.layouts.splice(i, 1)
      }
      // normalizeConfig drops the now-dangling assignments, which is what sends
      // those workspaces back to the profile's fallback.
    })
    armedDelete = ""
    sync.sync()
  }

  function renameLayout(name) {
    editSelectedLayout(function(layout) { layout.name = name })
  }

  // --------------------------------------------------------------- profiles

  function selectProfile(name) {
    store.mutate(function(draft) { draft.activeProfile = name })
    armedDelete = ""
    sync.sync()
  }

  // A new profile starts as a copy of the current one, so it is a place to
  // diverge from rather than an empty room to furnish.
  function createProfile(name) {
    var clean = Model.sanitizeName(name, "")
    if (clean === "") return
    var unique = Model.uniqueProfileName(config, clean)
    store.mutate(function(draft) {
      var source = Model.findProfile(draft, draft.activeProfile)
      draft.profiles.push({
        name: unique,
        fallback: source ? source.fallback : "dwindle",
        assignments: source ? JSON.parse(JSON.stringify(source.assignments)) : {}
      })
      draft.activeProfile = unique
    })
    creatingProfile = false
    newProfileDraft = ""
    sync.sync()
  }

  function deleteProfile(name) {
    if (!config || config.profiles.length <= 1) return
    store.mutate(function(draft) {
      for (var i = draft.profiles.length - 1; i >= 0; i--) {
        if (draft.profiles[i].name === name) draft.profiles.splice(i, 1)
      }
      if (draft.activeProfile === name) draft.activeProfile = draft.profiles[0].name
    })
    armedDelete = ""
    sync.sync()
  }

  // The way back from an experiment that went sideways: the shipped preset
  // library, one profile, every workspace handed back to Hyprland. It resets
  // the plugin's own document only — the generated Lua and the loader line stay
  // put, so this is a reset rather than a half-uninstall.
  function restoreDefaults() {
    store.save(Model.defaultConfig())
    assignTarget = "workspace"
    focusedDivider = 0
    armedDelete = ""
    creatingProfile = false
    sync.sync()
  }

  function armDelete(key) {
    if (armedDelete === key) return true
    armedDelete = key
    disarmTimer.restart()
    return false
  }

  Timer {
    id: disarmTimer
    interval: 3000
    repeat: false
    onTriggered: root.armedDelete = ""
  }

  // ----------------------------------------------------------- window counts

  function refreshCounts() {
    if (!countProcess.running) countProcess.running = true
  }

  Process {
    id: countProcess
    command: ["hyprctl", "-j", "clients"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var clients = JSON.parse(text)
          var counts = {}
          for (var i = 0; i < clients.length; i++) {
            var client = clients[i]
            // The layout only ever sees tiled, mapped windows, so anything else
            // would make the canvas claim slots that are not really filled.
            if (client.floating || client.mapped === false) continue
            var key = String(client.workspace ? client.workspace.id : 0)
            counts[key] = (counts[key] || 0) + 1
          }
          root.tiledCounts = counts
        } catch (error) {
          root.tiledCounts = ({})
        }
      }
    }
  }

  Timer {
    running: root.opened
    interval: 700
    repeat: true
    onTriggered: root.refreshCounts()
  }

  // ------------------------------------------------------------------ model

  ConfigStore {
    id: store
    // A hand-edit of the JSON, or a profile switch from another monitor's copy
    // of this panel, arrives here as a revision bump.
    onRevisionChanged: syncTimer.restart()
  }

  HyprlandSync {
    id: sync
    config: store.config
    workspaceIds: root.workspaceRow
    manageLoader: true
  }

  // Coalesce: a save writes the file, the watcher re-reads it, and the revision
  // bumps twice for one edit. Waiting a beat collapses that into one round-trip.
  Timer {
    id: syncTimer
    interval: 180
    repeat: false
    onTriggered: if (store.ready) sync.sync()
  }

  Component.onCompleted: sync.ensureLoader()

  IpcHandler {
    target: "workspace-layout"

    function open(): void { root.summon() }
    function close(): void { root.close() }
    function show(): void { root.summon() }
    function hide(): void { root.close() }
    function toggle(): void { root.opened ? root.close() : root.summon() }
  }

  function summon() {
    if (bar && typeof bar.summonBarWidget === "function" && bar.summonBarWidget(moduleName)) return
    open()
  }

  // ------------------------------------------------------------------- view

  readonly property color fg: Color.popups.text
  readonly property color accent: Color.accent

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: profileInput.activeFocus || nameInput.activeFocus

      onMoveRequested: function(dx, dy) {
        if (dx !== 0) {
          var ids = root.workspaceRow
          var at = ids.indexOf(root.selectedWorkspace)
          root.selectWorkspace(ids[Math.max(0, Math.min(ids.length - 1, at + dx))])
        } else if (dy !== 0) {
          var entries = root.library
          var index = 0
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].id === root.selectedLayoutId) index = i
          }
          root.assignLayout(entries[Math.max(0, Math.min(entries.length - 1, index + dy))].id)
        }
      }

      onCloseRequested: {
        if (root.armedDelete !== "") root.armedDelete = ""
        else if (root.creatingProfile) root.creatingProfile = false
        else if (root.showKeys) root.showKeys = false
        else root.close()
      }

      onTabRequested: function(direction) { root.switchPanel(direction) }

      onTextKey: function(key) {
        if (key === "[") root.nudgeDivider(-2)
        else if (key === "]") root.nudgeDivider(2)
        else if (key === "{") root.nudgeDivider(-0.5)
        else if (key === "}") root.nudgeDivider(0.5)
        else if (key === "+" || key === "=") root.addSlot()
        else if (key === "-" || key === "_") root.removeSlot()
        else if (key === "r") root.toggleOrientation()
        else if (key === "o") root.cycleOverflow()
        else if (key === "f") root.toggleUnderfill()
        else if (key === "0") root.resetWeights()
        else if (key === "?") root.showKeys = !root.showKeys
        else if (key === "R") { if (root.armDelete("restore")) root.restoreDefaults() }
        else if (key >= "1" && key <= "8") root.focusedDivider = parseInt(key, 10) - 1
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.spacing.xxl

        // ------------------------------------------------------- header

        Item {
          width: parent.width
          height: title.implicitHeight

          Text {
            id: title
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "Workspace Layout"
            color: root.fg
            font.family: Style.font.family
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Text {
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.activeProfileName
            color: Util.alpha(root.fg, 0.55)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }

        // --------------------------------------------------- workspaces

        Flow {
          width: parent.width
          spacing: Style.spacing.xs

          Repeater {
            model: root.workspaceRow

            Rectangle {
              id: chip
              required property int modelData

              readonly property bool selected: modelData === root.selectedWorkspace
              readonly property bool focused: modelData === root.focusedWorkspaceId
              readonly property string layoutId: Model.layoutIdForWorkspace(root.config, modelData)
              readonly property var layout: Model.findLayout(root.config, layoutId)
              readonly property int windows: {
                var value = root.tiledCounts[String(modelData)]
                return value === undefined ? 0 : value
              }

              width: Style.space(34)
              height: Style.space(40)
              radius: Style.cornerRadius
              color: selected ? Util.alpha(root.accent, 0.18) : Util.alpha(root.fg, 0.04)
              border.width: 1
              border.color: selected
                ? Util.alpha(root.accent, 0.9)
                : Util.alpha(root.fg, chipHover.hovered ? 0.4 : 0.12)

              Behavior on color { ColorAnimation { duration: 90 } }

              Column {
                anchors.centerIn: parent
                spacing: Style.spacing.xxs

                LayoutThumb {
                  anchors.horizontalCenter: parent.horizontalCenter
                  width: Style.space(22)
                  height: Style.space(14)
                  layout: chip.layout
                  stroke: chip.selected ? root.accent : root.fg
                  // An unmanaged workspace still shows a shape, just a quiet
                  // one — it is running a Hyprland built-in, not nothing.
                  strength: chip.layout ? 1.0 : 0.35
                  filled: chip.windows > 0
                }

                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  textFormat: Text.PlainText
                  text: chip.modelData === 10 ? "0" : String(chip.modelData)
                  color: chip.selected ? root.fg : Util.alpha(root.fg, chip.focused ? 0.85 : 0.5)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  font.bold: chip.focused
                }
              }

              HoverHandler { id: chipHover }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.selectWorkspace(chip.modelData)
                // Double-click jumps there, so the panel doubles as a way to
                // check a layout on the workspace it belongs to.
                onDoubleClicked: {
                  if (root.bar) root.bar.run(Model.focusWorkspaceCommand(chip.modelData))
                  root.workspacePinned = false
                }
              }
            }
          }
        }

        // ------------------------------------------------------- canvas

        Column {
          width: parent.width
          spacing: Style.spacing.sm

          LayoutCanvas {
            id: canvas
            width: parent.width
            height: Math.min(Style.space(200), Math.round(width / root.screenAspect))
            layout: root.selectedLayout
            windowCount: root.selectedWindowCount
            editable: root.selectedLayout !== null && root.selectedLayout.kind !== "grid"
            foreground: root.fg
            accent: root.accent
            aspect: root.screenAspect
            visible: root.selectedLayout !== null

            onWeightsChanged: function(weights) { root.stageWeights(weights) }
            onCommitted: root.commitLayout()
          }

          // A workspace on a Hyprland built-in has nothing to edit, so say what
          // is running and how to take it over rather than showing a dead canvas.
          Rectangle {
            width: parent.width
            height: Math.min(Style.space(200), Math.round(width / root.screenAspect))
            visible: root.selectedLayout === null
            radius: Style.cornerRadius
            color: Util.alpha(root.fg, 0.04)
            border.width: 1
            border.color: Util.alpha(root.fg, 0.12)

            Column {
              anchors.centerIn: parent
              spacing: Style.spacing.sm

              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                textFormat: Text.PlainText
                text: (root.assigningAll ? "Workspaces default to" : "Workspace " + root.selectedWorkspace + " uses")
                  + " Hyprland's " + root.selectedLayoutId
                color: Util.alpha(root.fg, 0.7)
                font.family: Style.font.family
                font.pixelSize: Style.font.body
              }

              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                textFormat: Text.PlainText
                text: "Pick a layout below to take it over"
                color: Util.alpha(root.fg, 0.45)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: {
              if (!root.selectedLayout) return "Press ? for keys"
              var windows = root.selectedWindowCount
              var parts = [
                Model.describeLayout(root.selectedLayout),
                root.assigningAll
                  ? "default everywhere"
                  : (windows === 1 ? "1 window" : windows + " windows")
              ]
              if (canvas.dragging) parts.push("hold Shift for free drag")
              else parts.push("drag a divider · ? for keys")
              return parts.join("  ·  ")
            }
            color: Util.alpha(root.fg, 0.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        // ------------------------------------------------- shape controls

        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.selectedLayout !== null

          Row {
            spacing: Style.spacing.sm
            height: Style.spacing.controlHeight

            PanelActionButton {
              anchors.verticalCenter: parent.verticalCenter
              enabled: root.selectedLayout !== null && root.selectedLayout.weights.length > 1
              foreground: root.fg
              iconText: "\u2212"
              tooltipText: "Remove a slot"
              onClicked: root.removeSlot()
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              width: Style.space(58)
              horizontalAlignment: Text.AlignHCenter
              text: root.selectedLayout
                ? root.selectedLayout.weights.length + (root.selectedLayout.orientation === "rows" ? " rows" : " cols")
                : ""
              color: root.fg
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            PanelActionButton {
              anchors.verticalCenter: parent.verticalCenter
              enabled: root.selectedLayout !== null
                && root.selectedLayout.weights.length < Model.MAX_SLOTS
              foreground: root.fg
              iconText: "+"
              tooltipText: "Add a slot"
              onClicked: root.addSlot()
            }

            PanelActionButton {
              anchors.verticalCenter: parent.verticalCenter
              foreground: root.fg
              iconText: "\u21c4"
              tooltipText: "Columns or rows  (r)"
              onClicked: root.toggleOrientation()
            }

            PanelActionButton {
              anchors.verticalCenter: parent.verticalCenter
              foreground: root.fg
              iconText: "\u21ba"
              tooltipText: "Split evenly  (0)"
              onClicked: root.resetWeights()
            }
          }

          // Two settings that only bite at particular window counts, so they
          // say what they do in words and wrap rather than crowd the row above.
          Flow {
            width: parent.width
            spacing: Style.spacing.sm

            Button {
              foreground: root.fg
              accent: root.accent
              bordered: true
              fontSize: Style.font.caption
              verticalPadding: Style.spacing.xs
              text: {
                if (!root.selectedLayout) return ""
                if (root.selectedLayout.overflow === "extend") return "extra \u2192 new slots"
                if (root.selectedLayout.overflow === "first") return "extra \u2192 stack first"
                return "extra \u2192 stack last"
              }
              tooltipText: "Where windows past the last slot go  (o)"
              onClicked: root.cycleOverflow()
            }

            Button {
              foreground: root.fg
              accent: root.accent
              bordered: true
              fontSize: Style.font.caption
              verticalPadding: Style.spacing.xs
              text: root.selectedLayout && root.selectedLayout.underfill === "hold"
                ? "fewer \u2192 keep place" : "fewer \u2192 rescale"
              tooltipText: "With fewer windows than slots: keep the shape, or grow to fill  (f)"
              onClicked: root.toggleUnderfill()
            }
          }
        }

        // ------------------------------------------------------ library

        PanelSeparator { foreground: root.fg }

        Item {
          width: parent.width
          height: libraryHeader.implicitHeight

          PanelSectionHeader {
            id: libraryHeader
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            foreground: root.fg
            text: "Layouts"
          }

          Row {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.xs

            PanelActionButton {
              foreground: root.fg
              iconText: "＋"
              tooltipText: "New layout on this workspace"
              onClicked: root.newLayout()
            }

            PanelActionButton {
              enabled: root.selectedLayout !== null
              foreground: root.fg
              iconText: "󰆏"
              tooltipText: "Duplicate this layout"
              onClicked: root.duplicateLayout()
            }

            PanelActionButton {
              enabled: root.selectedLayout !== null && root.layouts.length > 1
              foreground: root.fg
              hoverColor: Color.urgent
              iconText: root.armedDelete === ("layout:" + root.selectedLayoutId) ? "!" : "󰩹"
              tooltipText: root.armedDelete === ("layout:" + root.selectedLayoutId)
                ? "Click again to delete " + (root.selectedLayout ? root.selectedLayout.name : "")
                : "Delete this layout"
              onClicked: {
                if (root.armDelete("layout:" + root.selectedLayoutId)) root.deleteLayout(root.selectedLayoutId)
              }
            }
          }
        }

        Row {
          width: parent.width
          spacing: Style.spacing.xs

          Text {
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: "Give it to"
            color: Util.alpha(root.fg, 0.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }

          Button {
            foreground: root.fg
            accent: root.accent
            bordered: true
            fontSize: Style.font.caption
            verticalPadding: Style.spacing.xs
            text: "Workspace " + root.selectedWorkspace
            selected: !root.assigningAll
            tooltipText: "Only this workspace uses the layout you pick"
            onClicked: root.assignTarget = "workspace"
          }

          Button {
            foreground: root.fg
            accent: root.accent
            bordered: true
            fontSize: Style.font.caption
            verticalPadding: Style.spacing.xs
            text: "All workspaces"
            selected: root.assigningAll
            tooltipText: "Every workspace uses it, clearing per-workspace choices"
            onClicked: root.assignTarget = "all"
          }
        }

        Flow {
          width: parent.width
          spacing: Style.spacing.xs

          Repeater {
            model: root.library

            Rectangle {
              id: card
              required property var modelData

              readonly property bool selected: modelData.id === root.selectedLayoutId

              width: Style.space(62)
              height: Style.space(46)
              radius: Style.cornerRadius
              color: selected ? Util.alpha(root.accent, 0.16) : Util.alpha(root.fg, 0.04)
              border.width: 1
              border.color: selected
                ? Util.alpha(root.accent, 0.9)
                : Util.alpha(root.fg, cardHover.hovered ? 0.4 : 0.12)

              Behavior on color { ColorAnimation { duration: 90 } }

              Column {
                anchors.centerIn: parent
                spacing: Style.spacing.xxs

                LayoutThumb {
                  anchors.horizontalCenter: parent.horizontalCenter
                  width: Style.space(40)
                  height: Style.space(22)
                  layout: card.modelData.thumb
                  stroke: card.selected ? root.accent : root.fg
                  strength: card.modelData.builtin ? 0.5 : 1.0
                }

                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  textFormat: Text.PlainText
                  width: Style.space(56)
                  horizontalAlignment: Text.AlignHCenter
                  text: card.modelData.name
                  color: card.selected ? root.fg : Util.alpha(root.fg, 0.6)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              HoverHandler { id: cardHover }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.assignLayout(card.modelData.id)
              }
            }
          }
        }

        // Renaming lives next to the library because the name is what makes a
        // layout reusable across workspaces and profiles.
        TextField {
          id: nameInput
          width: parent.width
          foreground: root.fg
          accent: root.accent
          visible: root.selectedLayout !== null
          placeholderText: "Layout name"
          text: root.selectedLayout ? root.selectedLayout.name : ""
          onAccepted: {
            root.renameLayout(text)
            focus = false
          }
          onActiveFocusChanged: if (!activeFocus && root.selectedLayout) text = root.selectedLayout.name
        }

        // ------------------------------------------------------ profiles

        PanelSeparator { foreground: root.fg }

        Item {
          width: parent.width
          height: profileHeader.implicitHeight

          PanelSectionHeader {
            id: profileHeader
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            foreground: root.fg
            text: "Profiles"
          }

          Row {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.xs

            PanelActionButton {
              foreground: root.fg
              iconText: "＋"
              tooltipText: "New profile from this one"
              onClicked: {
                root.newProfileDraft = Model.uniqueProfileName(root.config, "profile")
                root.creatingProfile = true
                profileInput.forceActiveFocus()
              }
            }

            PanelActionButton {
              enabled: root.config && root.config.profiles.length > 1
              foreground: root.fg
              hoverColor: Color.urgent
              iconText: root.armedDelete === ("profile:" + root.activeProfileName) ? "!" : "󰩹"
              tooltipText: root.armedDelete === ("profile:" + root.activeProfileName)
                ? "Click again to delete " + root.activeProfileName
                : "Delete this profile"
              onClicked: {
                if (root.armDelete("profile:" + root.activeProfileName)) root.deleteProfile(root.activeProfileName)
              }
            }
          }
        }

        Flow {
          width: parent.width
          spacing: Style.spacing.xs
          visible: !root.creatingProfile

          Repeater {
            model: root.config ? root.config.profiles : []

            Button {
              required property var modelData

              foreground: root.fg
              accent: root.accent
              bordered: true
              fontSize: Style.font.bodySmall
              verticalPadding: Style.spacing.xs
              text: modelData.name
              selected: modelData.name === root.activeProfileName
              onClicked: root.selectProfile(modelData.name)
            }
          }
        }

        TextField {
          id: profileInput
          width: parent.width
          foreground: root.fg
          accent: root.accent
          visible: root.creatingProfile
          placeholderText: "Profile name"
          text: root.newProfileDraft
          onAccepted: root.createProfile(text)
        }

        // -------------------------------------------------------- footer

        PanelSeparator { foreground: root.fg }

        Item {
          width: parent.width
          height: restoreButton.implicitHeight

          // Right-aligned and quiet: it undoes everything in the panel above
          // it, so it should be findable without inviting a stray click. Two
          // presses to fire, like the delete buttons.
          Button {
            id: restoreButton
            anchors.right: parent.right
            foreground: root.armedRestore ? Color.urgent : Util.alpha(root.fg, 0.55)
            accent: root.armedRestore ? Color.urgent : root.accent
            bordered: root.armedRestore
            fontSize: Style.font.caption
            verticalPadding: Style.spacing.xs
            text: root.armedRestore
              ? "Discard all layouts and profiles?"
              : "Restore defaults"
            tooltipText: "Back to the shipped layouts, one profile, every workspace on Hyprland's own tiling"
            onClicked: {
              if (root.armDelete("restore")) root.restoreDefaults()
            }
          }
        }

        // ---------------------------------------------------------- keys

        Rectangle {
          width: parent.width
          visible: root.showKeys
          height: keyList.implicitHeight + Style.spacing.lg * 2
          radius: Style.cornerRadius
          color: Util.alpha(root.fg, 0.05)
          border.width: 1
          border.color: Util.alpha(root.fg, 0.12)

          Column {
            id: keyList
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.margins: Style.spacing.lg
            spacing: Style.spacing.xxs

            Repeater {
              model: [
                "←  →      select workspace",
                "↑  ↓      change its layout",
                "[  ]      move the divider    ({ } finer)",
                "1 … 8    pick which divider",
                "+  −      add or remove a slot",
                "r         columns ⇄ rows",
                "o         where extra windows go",
                "f         with fewer windows: keep place or rescale",
                "0         split evenly",
                "R  R      restore defaults (press twice)"
              ]

              Text {
                required property string modelData
                textFormat: Text.PlainText
                text: modelData
                color: Util.alpha(root.fg, 0.6)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }
    }
  }
}
