import QtQuick
import QtQuick.Controls as QQC
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

  // The window classes open right now, from the same poll. Pinning an app is
  // then a click on something visible on screen rather than a class name the
  // user has to know how to spell.
  property var runningApps: []


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
  readonly property bool assigningMonitor: assignTarget === "monitor"

  // Which monitor each workspace is on, and the one behind the workspace being
  // edited. A monitor default is a property of where a workspace is, so this
  // comes from Hyprland rather than from the document.
  readonly property var workspaceMonitors: {
    var out = ({})
    var values = Hyprland.workspaces ? Hyprland.workspaces.values : []
    for (var i = 0; i < values.length; i++) {
      var monitor = values[i].monitor
      if (values[i].id > 0 && monitor) out[String(values[i].id)] = String(monitor.name || "")
    }
    return out
  }

  readonly property string selectedMonitor: workspaceMonitors[String(selectedWorkspace)] || ""

  // The canvas edits whatever the current target resolves to, so the shape on
  // screen is always the one a click in the library would replace.
  readonly property string selectedLayoutId: {
    if (assigningAll) return profile ? profile.fallback : "dwindle"
    if (assigningMonitor) {
      var monitors = profile ? profile.monitors : null
      if (monitors && monitors[selectedMonitor]) return monitors[selectedMonitor]
      return profile ? profile.fallback : "dwindle"
    }
    return Model.layoutIdForWorkspace(config, selectedWorkspace, selectedMonitor)
  }
  readonly property var selectedLayout: Model.findLayout(config, selectedLayoutId)

  readonly property int selectedWindowCount: {
    var value = tiledCounts[String(selectedWorkspace)]
    return value === undefined ? 0 : value
  }

  // The Apps search. Empty, the list is just what is pinned to this workspace;
  // typing searches everything running and offers the query itself as a row,
  // which is how an app that is not open yet gets pinned.
  property string appQuery: ""

  // Which slot of the canvas is being aimed at, 1-based, 0 for the workspace
  // as a whole. Clicking a tile sets it; the next app pinned goes there.
  property int selectedSlot: 0

  // The right-click menu on a tile: which slot it belongs to and where to draw
  // it. Zero means closed.
  property int menuSlot: 0
  // The same overlay, opened on a workspace chip instead of a tile. Only one
  // of the two is ever set.
  property int menuWorkspace: 0
  property real menuX: 0
  property real menuY: 0

  readonly property bool menuOpen: menuSlot > 0 || menuWorkspace > 0

  // What that menu offers for the slot it was opened on. Actions that cannot
  // apply are left out rather than shown greyed: the list is short enough to
  // read at a glance and that keeps it that way.
  readonly property var menuItems: {
    var out = []
    if (menuWorkspace > 0) {
      var key = String(menuWorkspace)
      var assigned = profile && profile.assignments ? profile.assignments[key] : ""
      var resolved = Model.layoutIdForWorkspace(config, menuWorkspace, workspaceMonitors[key])
      if (assigned || !Model.isBuiltin(resolved)) {
        out.push({ key: "handback", label: "Hand back to Hyprland" })
      }
      out.push({ key: "capture", label: "Capture the windows here" })
      var entries = Model.pinsForWorkspace(config, menuWorkspace)
      if (entries.length > 0) out.push({ key: "clearapps", label: "Clear this workspace's apps" })
      return out
    }
    if (menuSlot < 1) return out
    var layout = selectedLayout
    if (layout && layout.kind !== "grid") {
      var at = slotPosition(menuSlot)
      var room = Model.totalCells(layout.cells) < Model.MAX_SLOTS
      // Named by what the user will see rather than by the layout's grain: in
      // a rows layout the two axes swap, and "split top and bottom" is true
      // either way.
      var sideways = layout.orientation === "rows"
      var alongLabel = sideways ? "Split top and bottom" : "Split side by side"
      var acrossLabel = sideways ? "Split side by side" : "Split top and bottom"
      if (room) out.push({ key: "along", label: alongLabel })
      if (room) out.push({ key: "across", label: acrossLabel })
      if (at >= 0 && layout.cells[at] > 1) out.push({ key: "merge", label: "Merge back into one" })
      if (layout.weights.length > 1) out.push({ key: "remove", label: "Remove this slot" })
      out.push({ key: "even", label: "Even out the split" })
    }
    out.push({ key: "add", label: "Put an app here" })
    for (var i = 0; i < pinnedHere.length; i++) {
      if (pinnedHere[i].slots.indexOf(menuSlot) !== -1) {
        out.push({ key: "clear", label: "Clear the apps here" })
        break
      }
    }
    return out
  }

  // Recomputed on purpose rather than bound to `config`: a drag rewrites the
  // document on every frame, and a bound list would rebuild all of these rows
  // sixty times a second while the user is trying to aim a divider.
  property var pinnedHere: []
  property var slotApps: []
  property var appRows: ({ rows: [], hidden: 0 })
  property var missingApps: []

  // Launches whose window has not turned up yet, and the classes that were
  // already on screen when they started. A desktop entry cannot always say
  // what its windows will be called, so the pin learns it from what opens.
  // Windows per class per workspace, from the same poll: a pin asking for
  // three terminals is only satisfied once three are actually here.
  property var windowsByWorkspace: ({})

  // Which terminal to wrap a `Terminal=true` app in. Detected once: the user's
  // xdg preference if we know it, otherwise the first one installed.
  property string terminalId: ""

  property var pendingLaunches: []
  property var launchBaseline: ({})

  // Everything the search can find: the apps installed on the machine, plus
  // whatever has a window open. Desktop entries come first so an app the
  // machine knows keeps its readable name and its launch command, and a bare
  // window class is only used for something with no entry at all.
  property var appCatalog: []
  property var appNames: ({})

  function rebuildCatalog() {
    var out = []
    var names = {}
    var entries = DesktopEntries.applications ? DesktopEntries.applications.values : []
    var i
    for (i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (!entry || entry.noDisplay) continue
      // StartupWMClass is the class the window will actually have; the entry
      // id is the best guess when the file does not say. Some packaged entries
      // ship the substitution token instead of a class (Chromium's reads
      // `@@startup_wm_class`), which would pin a class no window ever has.
      var match = String(entry.startupClass || "")
      if (match.length === 0 || match.indexOf("@@") !== -1) match = String(entry.id || "")
      if (match.length === 0) continue
      var command = (entry.command instanceof Array) ? entry.command.join(" ") : String(entry.execString || "")
      out.push({
        match: match, name: String(entry.name || match), command: command,
        terminal: entry.runInTerminal === true, running: false
      })
      names[match] = String(entry.name || match)
    }
    // Mark the entries whose app is open rather than appending a duplicate:
    // the search keeps the first entry per class, and a running app should
    // still rank above one that is merely installed.
    var open = {}
    for (i = 0; i < runningApps.length; i++) open[runningApps[i]] = true
    for (i = 0; i < out.length; i++) {
      if (open[out[i].match]) {
        out[i].running = true
        delete open[out[i].match]
      }
    }
    for (var cls in open) {
      out.push({ match: cls, name: cls, command: "", terminal: false, running: true })
    }
    appCatalog = out
    appNames = names
  }

  // What to call an app on screen: what the pin remembers, then the machine's
  // own name for it, then the raw class.
  property var pinNames: ({})

  function appNameFor(match) {
    return pinNames[match] || appNames[match] || match
  }

  function refreshAppState() {
    var named = {}
    var all = Model.pinEntries(config)
    for (var p = 0; p < all.length; p++) {
      if (all[p].name !== "") named[all[p].match] = all[p].name
    }
    pinNames = named

    pinnedHere = Model.pinsForWorkspace(config, selectedWorkspace)
    var slots = Model.slotApps(config, selectedWorkspace)
    var labelled = []
    for (var i = 0; i < slots.length; i++) {
      var names = []
      for (var j = 0; j < slots[i].length; j++) names.push(appNameFor(slots[i][j]))
      labelled.push(names)
    }
    slotApps = labelled
    appRows = Model.searchApps(config, selectedWorkspace, appCatalog, appQuery, 6)
    missingApps = Model.missingApps(config, selectedWorkspace, appCatalog,
      windowsByWorkspace[String(selectedWorkspace)])
  }

  onAppQueryChanged: refreshAppState()
  onSelectedWorkspaceChanged: refreshAppState()
  onRunningAppsChanged: {
    rebuildCatalog()
    refreshAppState()
  }

  Connections {
    target: store
    function onRevisionChanged() {
      if (!canvas.dragging) root.refreshAppState()
    }
  }

  // Exposed to the bar widget so its icon can be a picture of the layout the
  // focused workspace is running.
  readonly property int focusedWorkspaceId: Hyprland.focusedWorkspace ? Hyprland.focusedWorkspace.id : 1
  readonly property string focusedLayoutId: Model.layoutIdForWorkspace(config, focusedWorkspaceId,
    workspaceMonitors[String(focusedWorkspaceId)])
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
    // A search, an aimed slot and an open menu are all about the moment they
    // were made in. Reopening the panel should not resume someone else's
    // half-finished sentence.
    menuSlot = 0
    selectedSlot = 0
    appQuery = ""
    appSearch.text = ""
    if (opened) {
      if (!workspacePinned) selectedWorkspace = focusedWorkspaceId
      refreshCounts()
      refreshAppState()
    }
  }

  onFocusedWorkspaceIdChanged: if (!workspacePinned && !opened) selectedWorkspace = focusedWorkspaceId

  function selectWorkspace(id) {
    selectedWorkspace = id
    workspacePinned = id !== focusedWorkspaceId
    selectedSlot = 0
    menuSlot = 0
    armedDelete = ""
  }

  // ------------------------------------------------------------- edit paths

  // Editing one of the shipped layouts starts a copy instead of rewriting it.
  // The presets are a library to reach for, and quietly changing "Focus" the
  // first time a divider moves takes that away — on every workspace using it,
  // at that. Once a layout has been changed it is yours, and further edits go
  // straight to it rather than spawning a copy per drag.
  //
  // Returns the id to edit, having pushed the copy into `draft` and pointed
  // the current target at it.
  function forkPreset(draft, sourceId) {
    var source = Model.findLayout(draft, sourceId)
    if (!source || !Model.isPreset(source.id)) return sourceId
    var id = Model.customLayoutId(draft)
    var copy = JSON.parse(JSON.stringify(source))
    copy.id = id
    // Named plainly rather than after what it was forked from: it is your
    // layout now, and the field under the library is there to rename it.
    copy.name = Model.uniqueLayoutName(draft, "Custom")
    draft.layouts.push(copy)
    root.claim(draft, id)
    return id
  }

  // A drag: update in memory, push the spec to Hyprland, write nothing. The
  // canvas and the real windows move together and the disk stays quiet.
  function stageWeights(weights) {
    if (!selectedLayout) return
    var sourceId = selectedLayout.id
    var edited = sourceId
    store.stage(function(draft) {
      edited = root.forkPreset(draft, sourceId)
      for (var i = 0; i < draft.layouts.length; i++) {
        if (draft.layouts[i].id === edited) draft.layouts[i].weights = weights
      }
    })
    sync.preview(Model.findLayout(store.config, edited))
  }

  // The same path for a cross-grain drag: one slot's parts, staged in memory
  // and pushed to Hyprland, written on release like any other drag.
  function stageCells(slot, parts) {
    if (!selectedLayout) return
    var sourceId = selectedLayout.id
    var edited = sourceId
    store.stage(function(draft) {
      edited = root.forkPreset(draft, sourceId)
      for (var i = 0; i < draft.layouts.length; i++) {
        if (draft.layouts[i].id !== edited) continue
        var shape = Model.shapeSetCell(draft.layouts[i].weights, draft.layouts[i].cells, slot, parts)
        draft.layouts[i].cells = shape.cells
      }
    })
    sync.preview(Model.findLayout(store.config, edited))
  }

  // Release: persist. The service picks the file change up and re-emits the
  // full runtime, which is also what rewrites the Lua on disk.
  function commitLayout() {
    // The document may have grown a forked copy mid-drag, so what is saved is
    // whatever is in memory now rather than the layout the drag started on.
    if (!selectedLayout) return
    store.save(store.config)
    sync.sync()
  }

  function editSelectedLayout(change) {
    if (!selectedLayout) return
    var sourceId = selectedLayout.id
    store.mutate(function(draft) {
      var id = root.forkPreset(draft, sourceId)
      for (var i = 0; i < draft.layouts.length; i++) {
        if (draft.layouts[i].id === id) change(draft.layouts[i])
      }
    })
    refreshAppState()
    sync.sync()
  }

  // Assign a layout to one workspace by id, without going through the panel's
  // current target. What `set` on the command line does.
  function assignWorkspaceLayout(workspace, layoutId) {
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target) return
      target.assignments[String(workspace)] = layoutId
    })
    refreshAppState()
    sync.sync()
  }

  // The one place a pin is written. Everything a pin remembers that the caller
  // did not mention is carried over — the readable name, and the command that
  // produced its window. Losing the command silently unlaunches the app: no
  // desktop entry mentions `omarchy.wsl.nvim`, so nothing else knows how to
  // start it, and the workspace quietly has nothing to open.
  function writePin(draft, match, changes) {
    var target = Model.findProfile(draft, draft.activeProfile)
    if (!target) return
    if (!target.pins) target.pins = ({})
    var previous = target.pins[match] || {}
    var pin = {
      workspace: changes.workspace !== undefined ? changes.workspace : previous.workspace,
      slots: changes.slots !== undefined ? changes.slots : (previous.slots || [])
    }
    var name = changes.name || previous.name || ""
    var command = changes.command || previous.command || ""
    if (name !== "") pin.name = name
    if (command !== "") pin.command = command
    target.pins[match] = pin
  }

  // Pin an app to a workspace and a set of places, without the aiming the
  // panel does. What `pin` on the command line does.
  function setPin(match, workspace, slots) {
    store.mutate(function(draft) {
      root.writePin(draft, match, { workspace: String(workspace), slots: slots })
    })
    refreshAppState()
    sync.sync()
    sync.gather(match, String(workspace))
  }

  function assignLayout(layoutId) {
    store.mutate(function(draft) { root.claim(draft, layoutId) })
    sync.sync()
  }

  // ------------------------------------------------------------------- pins

  // Pinning is a workspace property, not a layout one: it works the same on a
  // workspace running Dwindle, and it survives every layout change made after.
  function pinApp(match, name) {
    var clean = Model.normalizeAppMatch(match)
    if (clean === null) return
    var workspace = String(selectedWorkspace)
    var slot = selectedSlot
    // Kept only when the class cannot say it: an app pinned from its launcher
    // may open windows under a class nobody would recognise.
    var label = Model.normalizeAppMatch(name)
    if (label === clean) label = null
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target) return
      if (!target.pins) target.pins = ({})
      var previous = target.pins[clean]
      // A pin moving between workspaces keeps the slots it was given: an app
      // that belongs on the right belongs on the right here too.
      var next = (previous && previous.slots instanceof Array) ? previous.slots.slice() : []
      if (slot > 0) {
        // An app is not one window. Aiming at a second tile gives it a second
        // place — two terminals can hold the left and right thirds — and
        // clicking a tile it already holds takes that one back.
        var at = next.indexOf(slot)
        if (at === -1) next.push(slot)
        else next.splice(at, 1)
      }
      root.writePin(draft, clean, { workspace: workspace, slots: next, name: label || "" })
    })
    appQuery = ""
    appSearch.text = ""
    refreshAppState()
    sync.sync()
    // The rule only catches windows that open from here on, so collect the
    // ones already running. Only on the click that made the pin — a plain
    // sync must never yank a window the user has since moved on purpose.
    sync.gather(clean, workspace)
  }

  function unpinApp(match) {
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (target && target.pins) delete target.pins[match]
    })
    refreshAppState()
    sync.sync()
  }

  // What actually gets run for an app. A `Terminal=true` entry is a command,
  // not a window: it needs a terminal wrapped around it, and that terminal has
  // to be told to call its window by the class the pin was written against, or
  // the window arrives as the terminal and the pin never matches it.
  function launchCommandFor(app) {
    if (!app.terminal) return app.command
    // Not the class the pin asks for: GTK refuses an app id without a dot, so
    // the terminal is given a name of ours, and the pin learns it from the
    // window that appears — along with this command, which is the only record
    // of how such a window is made.
    return Model.terminalLaunch(terminalId,
      Model.terminalClassFor(app.match, app.workspace), app.command)
  }

  // Start the workspace, rather than starting apps one at a time: everything
  // pinned here that is not already on screen, in one press. Hyprland's own
  // exec takes the workspace as a rule, so each one lands in its place without
  // the view following it.
  function launchMissing(workspace, list) {
    if (list.length === 0) return

    var baseline = {}
    for (var j = 0; j < runningApps.length; j++) baseline[runningApps[j]] = true
    var waiting = []
    for (var i = 0; i < list.length; i++) {
      // One window per place the app was given: an app pinned to three slots
      // wants three windows, and one press should furnish the workspace.
      var wanted = Math.max(1, Number(list[i].count) || 1)
      var command = root.launchCommandFor(list[i])
      if (command === "") continue
      waiting.push({
        match: list[i].match, name: list[i].name,
        workspace: workspace, command: command
      })
      for (var c = 0; c < wanted; c++) sync.launch(command, workspace)
    }
    launchBaseline = baseline
    pendingLaunches = waiting
    launchWatch.restart()
  }

  // What actually opened. A pin whose class was a guess from a desktop entry
  // gets corrected here, which is what makes it work the second time — and,
  // because the window is gathered straight after, the first time too.
  function adoptLaunched(classes) {
    if (pendingLaunches.length === 0) return
    var i

    var open = {}
    for (i = 0; i < classes.length; i++) open[classes[i]] = true

    // Anything whose guess was right needs no correcting.
    var waiting = []
    for (i = 0; i < pendingLaunches.length; i++) {
      if (!open[pendingLaunches[i].match]) waiting.push(pendingLaunches[i])
    }

    var pinned = {}
    var entries = Model.pinEntries(config)
    for (i = 0; i < entries.length; i++) pinned[entries[i].match] = true

    var fresh = []
    for (i = 0; i < classes.length; i++) {
      if (!launchBaseline[classes[i]] && !pinned[classes[i]]) fresh.push(classes[i])
    }

    var pairs = Model.matchLaunchedWindows(waiting, fresh)
    for (i = 0; i < pairs.length; i++) {
      var launched = ""
      for (var w = 0; w < waiting.length; w++) {
        if (waiting[w].match === pairs[i].match) launched = waiting[w].command || ""
      }
      root.rewritePin(pairs[i].match, pairs[i].become, launched)
    }

    var settled = {}
    for (i = 0; i < pairs.length; i++) settled[pairs[i].match] = true
    var rest = []
    for (i = 0; i < waiting.length; i++) {
      if (!settled[waiting[i].match]) rest.push(waiting[i])
    }
    pendingLaunches = rest
  }

  // Move a pin onto the class its windows really carry, keeping everything
  // else about it — including the readable name, which is all that would be
  // left of "Discord" once the class becomes a Chromium app id.
  function rewritePin(from, to, command) {
    if (from === to) return
    var workspace = ""
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target || !target.pins || !target.pins[from]) return
      var pin = target.pins[from]
      workspace = pin.workspace
      // The command goes with the class it produced: for a terminal app that
      // is the only record of how to make such a window again.
      var next = {
        workspace: pin.workspace,
        slots: pin.slots,
        name: pin.name || from,
        command: command || pin.command || ""
      }
      delete target.pins[from]
      root.writePin(draft, to, next)
    })
    if (workspace === "") return
    refreshAppState()
    sync.sync()
    // The rule was installed too late for the window that taught us the class,
    // so bring that one over by hand.
    sync.gather(to, workspace)
  }

  // A tile is numbered by the order it fills, which is not where it sits: in a
  // 25/50/25 the centre fills first. Editing the shape means editing the slot
  // at that *position*, so the two have to be mapped.
  function slotPosition(slot) {
    var positions = Model.rectSlotPositions(selectedLayout, canvas.drawnCount)
    var at = positions[slot - 1]
    return at === undefined ? -1 : at
  }

  function openSlotMenu(slot, x, y) {
    var point = canvas.mapToItem(keyCatcher, x, y)
    menuX = point.x
    menuY = point.y
    menuWorkspace = 0
    menuSlot = slot
  }

  function openWorkspaceMenu(workspace, item, x, y) {
    var point = item.mapToItem(keyCatcher, x, y)
    menuX = point.x
    menuY = point.y
    menuSlot = 0
    menuWorkspace = workspace
  }

  function closeSlotMenu() {
    menuSlot = 0
    menuWorkspace = 0
  }

  function runWorkspaceMenu(key) {
    var workspace = menuWorkspace
    closeSlotMenu()
    if (workspace < 1) return
    if (key === "handback") resetWorkspace(workspace)
    else if (key === "capture") captureWorkspace(workspace)
    else if (key === "clearapps") clearWorkspaceApps(workspace)
  }

  // One workspace back to Hyprland's own tiling, without touching the rest:
  // the layout goes, and so do the apps that were sent here, because a pin
  // pointing at a slot of a layout that is gone is just a surprise waiting.
  function resetWorkspace(workspace) {
    var key = String(workspace)
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target) return
      target.assignments[key] = "dwindle"
      if (target.pins) {
        for (var match in target.pins) {
          if (target.pins[match].workspace === key) delete target.pins[match]
        }
      }
    })
    if (String(selectedWorkspace) === key) selectedSlot = 0
    refreshAppState()
    sync.sync()
  }

  function clearWorkspaceApps(workspace) {
    var key = String(workspace)
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target || !target.pins) return
      for (var match in target.pins) {
        if (target.pins[match].workspace === key) delete target.pins[match]
      }
    })
    refreshAppState()
    sync.sync()
  }

  // ---------------------------------------------------------------- capture

  // Read the workspace back into a layout: the shape the windows are already
  // in, plus a pin for every app saying which place it was in.
  property int captureFor: 0

  function captureWorkspace(workspace) {
    captureFor = workspace
    if (!captureProcess.running) captureProcess.running = true
  }

  function applyCapture(shot, workspace) {
    if (!shot) return
    var key = String(workspace)
    var id = Model.uniqueLayoutId(config, "workspace-" + key)
    store.mutate(function(draft) {
      var layout = JSON.parse(JSON.stringify(shot.layout))
      layout.id = id
      layout.name = "Workspace " + key
      draft.layouts.push(layout)
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target) return
      target.assignments[key] = id
      if (!target.pins) target.pins = ({})
      // Keep whatever a learned pin was carrying: its name, and the command
      // that is the only record of how to open it.
      for (var match in shot.pins) {
        root.writePin(draft, match, { workspace: key, slots: shot.pins[match] })
      }
    })
    if (String(selectedWorkspace) === key) assignTarget = "workspace"
    refreshAppState()
    sync.sync()
  }

  function runSlotMenu(key) {
    var slot = menuSlot
    var at = slotPosition(slot)
    closeSlotMenu()
    if (key === "add") {
      selectedSlot = slot
      appSearch.forceActiveFocus()
      return
    }
    if (key === "clear") {
      store.mutate(function(draft) {
        var target = Model.findProfile(draft, draft.activeProfile)
        if (!target || !target.pins) return
        for (var match in target.pins) {
          var pin = target.pins[match]
          var index = pin.slots.indexOf(slot)
          if (index !== -1) pin.slots.splice(index, 1)
        }
      })
      refreshAppState()
      sync.sync()
      return
    }
    if (at < 0) return
    editSelectedLayout(function(layout) {
      var shape = null
      if (key === "along") shape = Model.shapeSplitAlong(layout.weights, layout.cells, at, 2)
      else if (key === "across") shape = Model.shapeSplitAcross(layout.weights, layout.cells, at, 2)
      else if (key === "merge") shape = Model.shapeMerge(layout.weights, layout.cells, at)
      else if (key === "remove") shape = Model.shapeRemoveSlot(layout.weights, layout.cells, at)
      else if (key === "even") shape = { weights: Model.evenWeights(layout.weights.length), cells: layout.cells }
      if (!shape) return
      layout.weights = shape.weights
      layout.cells = shape.cells
    })

    // A split is usually the first half of a thought: the place is new and
    // empty, so aim at it and take the search focus. The app that belongs
    // there is the next thing on the user's mind.
    if (key === "along" || key === "across") aimNewPlace(key, at)
  }

  // Which tile the split just created. Splitting along the grain puts a new
  // slot after the one that was cut, so it is the first tile at that position;
  // splitting across leaves the slot where it is and adds a part at its end,
  // so it is the last tile at the old position.
  function aimNewPlace(key, at) {
    var positions = Model.rectSlotPositions(selectedLayout, canvas.drawnCount)
    var wanted = key === "along" ? at + 1 : at
    var found = -1
    for (var i = 0; i < positions.length; i++) {
      if (positions[i] !== wanted) continue
      found = i
      if (key === "along") break
    }
    if (found < 0) return
    selectedSlot = found + 1
    appSearch.forceActiveFocus()
  }

  // Cut the place under the cursor, from the buttons on the tile itself. The
  // menu runs the same two operations; this is the shortcut for the edit that
  // gets made most.
  function splitPlace(slot, direction) {
    var at = slotPosition(slot)
    if (at < 0) return
    editSelectedLayout(function(layout) {
      var shape = direction === "across"
        ? Model.shapeSplitAcross(layout.weights, layout.cells, at, 2)
        : Model.shapeSplitAlong(layout.weights, layout.cells, at, 2)
      layout.weights = shape.weights
      layout.cells = shape.cells
    })
    aimNewPlace(direction, at)
  }

  // Carry one tile onto another and the two places exchange their apps. The
  // windows follow on the next re-tile of that workspace, which is immediate
  // when you are looking at it.
  function swapPlaces(from, to) {
    var workspace = String(selectedWorkspace)
    store.mutate(function(draft) {
      var target = Model.findProfile(draft, draft.activeProfile)
      if (!target) return
      target.pins = Model.swappedPins(target.pins, workspace, from, to)
    })
    if (selectedSlot === from) selectedSlot = to
    else if (selectedSlot === to) selectedSlot = from
    refreshAppState()
    sync.sync()
  }

  // Clicking a tile aims at that slot; clicking it again stops aiming. The
  // search takes focus with it, so picking a place and naming an app is one
  // gesture rather than two.
  function selectSlot(slot) {
    selectedSlot = (selectedSlot === slot) ? 0 : Math.min(slot, Model.MAX_SLOTS)
    if (selectedSlot > 0) appSearch.forceActiveFocus()
  }

  // Enter in the search field takes the first row that is not already pinned
  // here — the app you were typing towards, or the query itself.
  function acceptAppSearch() {
    var rows = appRows.rows
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].pinned) {
        pinApp(rows[i].match, rows[i].name)
        return
      }
    }
  }

  function addSlot() {
    editSelectedLayout(function(layout) {
      var shape = Model.shapeAddSlot(layout.weights, layout.cells)
      layout.weights = shape.weights
      layout.cells = shape.cells
    })
  }

  function removeSlot() {
    editSelectedLayout(function(layout) {
      var shape = Model.shapeRemoveSlot(layout.weights, layout.cells, layout.weights.length - 1)
      layout.weights = shape.weights
      layout.cells = shape.cells
    })
  }

  function toggleOrientation() {
    editSelectedLayout(function(layout) {
      layout.orientation = layout.orientation === "rows" ? "columns" : "rows"
    })
  }

  function toggleUnderfill() {
    // A split slot has no sensible way to grow, so the layout holds whatever
    // this says. The button is hidden in that case; the key follows it rather
    // than quietly writing a setting with no effect.
    if (!selectedLayout || Model.totalCells(selectedLayout.cells) > selectedLayout.weights.length) return
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

  // ---------------------------------------------------------------- library

  function newLayout() {
    store.mutate(function(draft) {
      var id = Model.customLayoutId(draft)
      draft.layouts.push({
        id: id, name: Model.uniqueLayoutName(draft, "Custom"), kind: "ratio",
        orientation: "columns", overflow: "last", weights: [50, 50]
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

  // Point the current target at a layout inside a draft document. The three
  // targets are three answers to the same question — this workspace, this
  // screen, everywhere — so claiming one clears the more specific ones under
  // it, which would otherwise overrule the choice and make it look inert.
  function claim(draft, id) {
    var target = Model.findProfile(draft, draft.activeProfile)
    if (!target) return
    if (root.assigningAll) {
      target.fallback = id
      target.assignments = {}
      target.monitors = {}
      return
    }
    if (root.assigningMonitor) {
      var monitor = root.selectedMonitor
      if (monitor === "") return
      if (!target.monitors) target.monitors = ({})
      target.monitors[monitor] = id
      for (var workspace in root.workspaceMonitors) {
        if (root.workspaceMonitors[workspace] === monitor) delete target.assignments[workspace]
      }
      return
    }
    target.assignments[String(root.selectedWorkspace)] = id
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
        assignments: source ? JSON.parse(JSON.stringify(source.assignments)) : {},
        pins: source && source.pins ? JSON.parse(JSON.stringify(source.pins)) : {}
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
          var apps = {}
          // How many windows of each class each workspace holds, which is what
          // says whether a pin asking for three of something has them.
          var here = {}
          for (var i = 0; i < clients.length; i++) {
            var client = clients[i]
            if (client.mapped === false) continue
            // Floating windows are pinnable even though they never occupy a
            // slot, so the app list is gathered before the tiling filter.
            var appClass = String(client.class || "").trim()
            var where = String(client.workspace ? client.workspace.id : 0)
            if (appClass.length > 0) {
              apps[appClass] = true
              if (!here[where]) here[where] = ({})
              here[where][appClass] = (here[where][appClass] || 0) + 1
            }
            // The layout only ever sees tiled, mapped windows, so anything else
            // would make the canvas claim slots that are not really filled.
            if (client.floating) continue
            var key = String(client.workspace ? client.workspace.id : 0)
            counts[key] = (counts[key] || 0) + 1
          }
          root.tiledCounts = counts
          root.windowsByWorkspace = here
          // Assigned only when the set actually changed: this runs every 700ms
          // while the panel is open, and a fresh array each time would rebuild
          // the catalogue and every row in the Apps section with it.
          var list = Object.keys(apps).sort()
          if (list.join("\u0000") !== root.runningApps.join("\u0000")) root.runningApps = list
          root.adoptLaunched(list)
          // Opening or closing a window changes what the workspace is short
          // of. Never while a divider is moving: rebuilding the rows under a
          // drag is what made dragging feel broken.
          if (!canvas.dragging) root.refreshAppState()
        } catch (error) {
          root.tiledCounts = ({})
          root.runningApps = []
        }
      }
    }
  }

  Timer {
    // Keeps running past a close while a launch is still being waited on: the
    // app the user just asked for may take a few seconds to show a window.
    running: root.opened || root.pendingLaunches.length > 0
    interval: 700
    repeat: true
    onTriggered: root.refreshCounts()
  }

  // Ask the machine which terminal it prefers: the first entry of the xdg
  // list, if it names one we know how to give a window class to, and failing
  // that the first of ours that is installed.
  Process {
    id: terminalProbe
    running: true
    command: ["sh", "-c",
      "known='ghostty foot alacritty kitty wezterm'; " +
      "first=$(grep -m1 -v '^#' \"${XDG_CONFIG_HOME:-$HOME/.config}/xdg-terminals.list\" 2>/dev/null); " +
      "first=${first%.desktop}; first=${first##*.}; " +
      "for t in $known; do [ \"$t\" = \"$first\" ] && { echo $t; exit 0; }; done; " +
      "for t in $known; do command -v $t >/dev/null 2>&1 && { echo $t; exit 0; }; done"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.terminalId = String(text || "").trim()
    }
  }

  Process {
    id: captureProcess
    command: ["hyprctl", "-j", "clients"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var workspace = root.captureFor
        root.captureFor = 0
        if (workspace < 1) return
        try {
          var clients = JSON.parse(text)
          var windows = []
          for (var i = 0; i < clients.length; i++) {
            var client = clients[i]
            if (!client || client.mapped === false || client.floating) continue
            if (!client.workspace || client.workspace.id !== workspace) continue
            windows.push({
              class: client.class,
              x: client.at[0], y: client.at[1],
              w: client.size[0], h: client.size[1]
            })
          }
          root.applyCapture(Model.captureLayout(windows), workspace)
        } catch (error) {
          // A workspace with nothing tiled on it has nothing to capture.
        }
      }
    }
  }

  Timer {
    id: launchWatch
    interval: 20000
    repeat: false
    onTriggered: root.pendingLaunches = []
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
    workspaceMonitors: root.workspaceMonitors
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

  // A workspace moved to another screen may resolve to a different layout.
  onWorkspaceMonitorsChanged: if (store.ready) syncTimer.restart()

  Component.onCompleted: {
    sync.ensureLoader()
    rebuildCatalog()
    refreshAppState()
  }

  // Installing or removing an app changes what the search can find. The first
  // scan arrives one entry at a time — a few hundred signals in a row on a
  // full machine — so the rebuild waits for the stream to settle.
  Connections {
    target: DesktopEntries.applications
    function onValuesChanged() { catalogTimer.restart() }
  }

  Timer {
    id: catalogTimer
    interval: 200
    repeat: false
    onTriggered: {
      root.rebuildCatalog()
      root.refreshAppState()
    }
  }

  // --------------------------------------------------------------------- ipc
  //
  // The panel is the only copy of the document that is always loaded, so the
  // command line lives here rather than in the optional service. Every
  // function takes what it acts on: nothing reads the panel's selection, so a
  // script does the same thing whether the panel is open or not.
  IpcHandler {
    target: "workspace-layout"

    function open(): void { root.summon() }
    function close(): void { root.close() }
    function show(): void { root.summon() }
    function hide(): void { root.close() }
    function toggle(): void { root.opened ? root.close() : root.summon() }

    // Every workspace worth a line — one the plugin is tiling, one with apps
    // pinned to it, or the one you are looking at — because a command line
    // cannot be asked "which workspace did you mean?" and arguments are not
    // optional here.
    function status(): string {
      var out = []
      var ids = root.workspaceRow
      for (var i = 0; i < ids.length; i++) {
        var key = String(ids[i])
        var id = Model.layoutIdForWorkspace(root.config, ids[i], root.workspaceMonitors[key])
        var focused = ids[i] === root.focusedWorkspaceId
        if (Model.isBuiltin(id) && Model.pinsForWorkspace(root.config, ids[i]).length === 0 && !focused) {
          continue
        }
        out.push((focused ? "* " : "  ") +
          Model.statusLine(root.config, ids[i], root.workspaceMonitors[key]))
      }
      return out.join("\n")
    }

    function workspace(id: string): string {
      var key = Model.normalizeWorkspaceId(id)
      if (key === null) return "workspace " + id + " is out of range"
      return Model.statusLine(root.config, key, root.workspaceMonitors[key])
    }

    function json(): string {
      return JSON.stringify(
        Model.stateJson(root.config, root.workspaceMonitors, root.workspaceRow), null, 2)
    }

    function profiles(): string {
      var out = []
      var list = root.config ? root.config.profiles : []
      for (var i = 0; i < list.length; i++) {
        out.push((list[i].name === root.activeProfileName ? "* " : "  ") + list[i].name)
      }
      return out.join("\n")
    }

    function apply(name: string): string {
      if (!Model.findProfile(root.config, name)) return "no profile called " + name
      root.selectProfile(name)
      return "profile " + name
    }

    function layouts(): string {
      var out = []
      for (var i = 0; i < root.library.length; i++) {
        var entry = root.library[i]
        var layout = Model.findLayout(root.config, entry.id)
        out.push(entry.id + "\t" + entry.name +
          (layout ? "\t" + Model.describeLayout(layout) : "\tHyprland"))
      }
      return out.join("\n")
    }

    function set(workspace: string, layout: string): string {
      var id = Model.normalizeWorkspaceId(workspace)
      if (id === null) return "workspace " + workspace + " is out of range"
      if (!Model.findLayout(root.config, layout) && !Model.isBuiltin(layout)) {
        return "no layout called " + layout
      }
      root.assignWorkspaceLayout(id, layout)
      return "workspace " + id + " uses " + layout
    }

    function reset(workspace: string): string {
      var id = Model.normalizeWorkspaceId(workspace)
      if (id === null) return "workspace " + workspace + " is out of range"
      root.resetWorkspace(Number(id))
      return "workspace " + id + " handed back to Hyprland"
    }

    function pin(app: string, workspace: string, slots: string): string {
      var match = Model.normalizeAppMatch(app)
      var id = Model.normalizeWorkspaceId(workspace)
      if (match === null) return "no app given"
      if (id === null) return "workspace " + workspace + " is out of range"
      var places = Model.parseSlots(slots)
      root.setPin(match, id, places)
      return match + " opens on workspace " + id +
        (places.length > 0 ? " in slot " + places.join(",") : "")
    }

    function unpin(app: string): string {
      var match = Model.normalizeAppMatch(app)
      if (match === null) return "no app given"
      root.unpinApp(match)
      return match + " released"
    }

    function capture(workspace: string): string {
      var id = Model.normalizeWorkspaceId(workspace)
      if (id === null) return "workspace " + workspace + " is out of range"
      root.captureWorkspace(Number(id))
      return "captured workspace " + id
    }

    function launch(workspace: string): string {
      var id = Model.normalizeWorkspaceId(workspace)
      if (id === null) return "workspace " + workspace + " is out of range"
      var missing = Model.missingApps(root.config, id, root.appCatalog,
        root.windowsByWorkspace[String(id)])
      if (missing.length === 0) return "nothing to open on workspace " + id
      root.launchMissing(id, missing)
      var names = []
      for (var i = 0; i < missing.length; i++) {
        names.push(missing[i].count > 1 ? missing[i].name + " \u00d7" + missing[i].count : missing[i].name)
      }
      return "opening " + names.join(", ") + " on workspace " + id
    }
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
      blocked: profileInput.activeFocus || nameInput.activeFocus || appSearch.activeFocus

      // Escape and Tab only. The panel is a drawing you point at: single-key
      // shortcuts for the same edits were a second, invisible interface that
      // had to be kept in step with the visible one, and they never reached a
      // layer-shell surface reliably anyway.
      onCloseRequested: {
        if (root.menuOpen) root.closeSlotMenu()
        else if (root.selectedSlot > 0) root.selectedSlot = 0
        else if (root.armedDelete !== "") root.armedDelete = ""
        else if (root.creatingProfile) root.creatingProfile = false
        else root.close()
      }

      onTabRequested: function(direction) { root.switchPanel(direction) }

      // The panel is taller than a laptop screen once a workspace has a few
      // apps pinned to it, and KeyboardPanel clamps the card to what fits, so
      // the overflow has to be scrollable rather than simply cut off.
      // The slot menu lives outside the scroll view, above it, so it is not
      // clipped by the content and does not slide away under the cursor.
      MouseArea {
        anchors.fill: parent
        visible: root.menuOpen
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        onPressed: root.closeSlotMenu()
        z: 10
      }

      Rectangle {
        id: slotMenu
        visible: root.menuOpen
        z: 11
        // Kept inside the panel: a menu opened near the right edge would
        // otherwise hang off it.
        x: Math.max(0, Math.min(root.menuX, parent.width - width))
        y: Math.max(0, Math.min(root.menuY, parent.height - height))
        width: Style.space(160)
        height: menuColumn.implicitHeight + Style.spacing.xs * 2
        radius: Style.cornerRadius
        color: Color.popups.background
        border.width: 1
        border.color: Util.alpha(root.fg, 0.25)

        Column {
          id: menuColumn
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.topMargin: Style.spacing.xs

          Text {
            width: parent.width
            visible: root.menuItems.length === 0
            horizontalAlignment: Text.AlignHCenter
            textFormat: Text.PlainText
            text: "Nothing to do here"
            color: Util.alpha(root.fg, 0.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }

          Repeater {
            model: root.menuItems.length

            Rectangle {
              id: menuRow
              required property int index

              readonly property var modelData: root.menuItems[menuRow.index]

              width: parent.width
              height: Style.space(26)
              color: menuHover.hovered ? Util.alpha(root.accent, 0.18) : "transparent"

              Text {
                anchors.left: parent.left
                anchors.leftMargin: Style.spacing.sm
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: menuRow.modelData.label
                color: root.fg
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              HoverHandler { id: menuHover }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.menuWorkspace > 0
                  ? root.runWorkspaceMenu(menuRow.modelData.key)
                  : root.runSlotMenu(menuRow.modelData.key)
              }
            }
          }
        }
      }

      QQC.ScrollView {
        id: scroller
        anchors.fill: parent
        clip: true
        QQC.ScrollBar.horizontal.policy: QQC.ScrollBar.AlwaysOff
        QQC.ScrollBar.vertical.policy: content.implicitHeight > scroller.height
          ? QQC.ScrollBar.AsNeeded : QQC.ScrollBar.AlwaysOff

        // Only grab flicks when there is something to scroll; otherwise a
        // stray drag inside the canvas would rubber-band the whole panel.
        Binding {
          target: scroller.contentItem
          property: "interactive"
          value: content.implicitHeight > scroller.height
        }

        Column {
          id: content
          width: scroller.availableWidth
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
                readonly property string layoutId: Model.layoutIdForWorkspace(root.config, modelData,
                  root.workspaceMonitors[String(modelData)])
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
                  // Picking a workspace goes there. Editing a layout you cannot
                  // see is guesswork, and the windows move under the cursor as
                  // you drag — which is only worth anything if you are looking
                  // at them.
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  onClicked: function(mouse) {
                    root.selectWorkspace(chip.modelData)
                    // Right-click is about the workspace itself: hand it back,
                    // capture it, clear its apps.
                    if (mouse.button === Qt.RightButton) {
                      root.openWorkspaceMenu(chip.modelData, chip, mouse.x, mouse.y)
                      return
                    }
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
              selectedSlot: root.selectedSlot
              slotApps: root.slotApps
              foreground: root.fg
              accent: root.accent
              aspect: root.screenAspect
              visible: root.selectedLayout !== null

              onWeightsChanged: function(weights) { root.stageWeights(weights) }
              onCommitted: root.commitLayout()
              onSlotClicked: function(slot) { root.selectSlot(slot) }
            onSlotMenuRequested: function(slot, x, y) { root.openSlotMenu(slot, x, y) }
            onCellWeightsChanged: function(slot, parts) { root.stageCells(slot, parts) }
            onPlacesSwapped: function(from, to) { root.swapPlaces(from, to) }
            onSplitRequested: function(slot, direction) { root.splitPlace(slot, direction) }
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
                  text: {
                    var who = root.assigningAll
                      ? "Workspaces default to"
                      : (root.assigningMonitor
                        ? root.selectedMonitor + " defaults to"
                        : "Workspace " + root.selectedWorkspace + " uses")
                    return who + " Hyprland's " + root.selectedLayoutId
                  }
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
              // Nothing to say about a workspace running one of Hyprland's own
              // layouts, and an empty line is still a line.
              visible: text !== ""
              textFormat: Text.PlainText
              text: {
                if (!root.selectedLayout) return ""
                var windows = root.selectedWindowCount
                var parts = [
                  Model.describeLayout(root.selectedLayout),
                  root.assigningAll
                    ? "default everywhere"
                    : (windows === 1 ? "1 window" : windows + " windows")
                ]
                if (canvas.dragging) parts.push("hold Shift for free drag")
                else parts.push("drag a divider, or carry a tile onto another")
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
                text: {
                  if (!root.selectedLayout) return ""
                  var slots = root.selectedLayout.weights.length
                  var label = slots + (root.selectedLayout.orientation === "rows" ? " rows" : " cols")
                  var places = Model.totalCells(root.selectedLayout.cells)
                  return places > slots ? label + " \u00b7 " + places + " places" : label
                }
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
                // A split slot has no sensible way to grow — which half would
                // take the missing window? — so the choice goes away rather
                // than sitting there doing nothing.
                visible: root.selectedLayout !== null
                  && Model.totalCells(root.selectedLayout.cells) === root.selectedLayout.weights.length
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

              Text {
                visible: root.selectedLayout !== null
                  && Model.totalCells(root.selectedLayout.cells) > root.selectedLayout.weights.length
                textFormat: Text.PlainText
                text: "split slots keep their places"
                color: Util.alpha(root.fg, 0.5)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }
          }

          // --------------------------------------------------------- apps

          PanelSeparator { foreground: root.fg }

          Item {
            width: parent.width
            height: appsHeader.implicitHeight

            PanelSectionHeader {
              id: appsHeader
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              foreground: root.fg
              text: root.selectedSlot > 0 ? "Apps \u2192 slot " + root.selectedSlot : "Apps"
            }

            Text {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: root.selectedSlot > 0
                ? "click the slot again to stop aiming"
                : (root.pinnedHere.length > 0
                  ? root.pinnedHere.length + " pinned to workspace " + root.selectedWorkspace
                  : "click a slot above, or search")
              color: Util.alpha(root.fg, 0.55)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          // One field for both jobs: it searches what is running, and whatever
          // you type is offered as a pin of its own, so an app you have not
          // launched yet — or a matcher written by hand — needs no second input.
          TextField {
            id: appSearch
            width: parent.width
            foreground: root.fg
            accent: root.accent
            placeholderText: root.selectedSlot > 0
              ? "Add an app to slot " + root.selectedSlot
              : "Search apps, or type a window class"
            onTextChanged: root.appQuery = text
            onAccepted: root.acceptAppSearch()
            Keys.onEscapePressed: {
              text = ""
              focus = false
            }
          }

          Column {
            width: parent.width
            spacing: Style.spacing.xxs

            Repeater {
              model: root.appRows.rows.length

              Rectangle {
                id: appRow
                required property int index

                readonly property var modelData: root.appRows.rows[appRow.index]

                readonly property bool aimed: root.selectedSlot > 0
                  && appRow.modelData.slots.indexOf(root.selectedSlot) !== -1

                width: parent.width
                height: Style.space(28)
                radius: Style.cornerRadius
                color: appRow.aimed
                  ? Util.alpha(root.accent, 0.16)
                  : (rowHover.hovered ? Util.alpha(root.fg, 0.07) : "transparent")

                HoverHandler { id: rowHover }

                // Declared before the release button, which comes after it and
                // so takes its own clicks.
                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.pinApp(appRow.modelData.match, appRow.modelData.name)
                }

                Text {
                  anchors.left: parent.left
                  anchors.leftMargin: Style.spacing.xs
                  anchors.right: appTail.left
                  anchors.rightMargin: Style.spacing.xs
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: appRow.modelData.literal
                    ? "Pin \u201c" + appRow.modelData.match + "\u201d"
                    : appRow.modelData.name
                  color: appRow.modelData.pinned ? root.fg : Util.alpha(root.fg, 0.75)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  elide: Text.ElideRight
                }

                Row {
                  id: appTail
                  anchors.right: parent.right
                  anchors.rightMargin: Style.spacing.xs
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.spacing.xs

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: {
                      if (appRow.modelData.pinned) {
                        var slots = appRow.modelData.slots
                        if (slots.length === 0) return "any slot"
                        return (slots.length === 1 ? "slot " : "slots ") + slots.join(", ")
                      }
                      if (appRow.modelData.elsewhere !== "") return "on " + appRow.modelData.elsewhere
                      if (appRow.modelData.literal) return "as typed"
                      return appRow.modelData.running ? "open" : "installed"
                    }
                    color: Util.alpha(root.fg, 0.5)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }

                  // Releasing is its own target rather than a second meaning for
                  // clicking the row: one click should not sometimes add and
                  // sometimes remove.
                  Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    visible: appRow.modelData.pinned
                    width: Style.space(18)
                    height: Style.space(18)
                    radius: Style.cornerRadius
                    color: releaseHover.hovered ? Util.alpha(Color.urgent, 0.25) : "transparent"

                    Text {
                      anchors.centerIn: parent
                      textFormat: Text.PlainText
                      text: "\u2715"
                      color: releaseHover.hovered ? Color.urgent : Util.alpha(root.fg, 0.5)
                      font.family: Style.font.family
                      font.pixelSize: Style.font.caption
                    }

                    HoverHandler { id: releaseHover }

                    MouseArea {
                      anchors.fill: parent
                      cursorShape: Qt.PointingHandCursor
                      onClicked: root.unpinApp(appRow.modelData.match)
                    }
                  }
                }
              }
            }
          }

          // One press starts the workspace: everything pinned here that has
          // nothing on screen yet, each landing in its own place.
          Button {
            visible: root.missingApps.length > 0
            foreground: root.fg
            accent: root.accent
            bordered: true
            fontSize: Style.font.caption
            verticalPadding: Style.spacing.xs
            text: {
              var total = Model.missingCount(root.missingApps)
              if (root.missingApps.length === 1 && total === 1) {
                return "\u25b8  Open " + root.missingApps[0].name
              }
              return "\u25b8  Open " + total + " windows"
            }
            tooltipText: {
              var names = []
              for (var i = 0; i < root.missingApps.length; i++) {
                var app = root.missingApps[i]
                names.push(app.count > 1 ? app.name + " \u00d7" + app.count : app.name)
              }
              return "Open on workspace " + root.selectedWorkspace + ": " + names.join(", ")
            }
            onClicked: root.launchMissing(String(root.selectedWorkspace), root.missingApps)
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: {
              if (root.appRows.hidden > 0) return root.appRows.hidden + " more — keep typing"
              if (root.selectedSlot > 0) {
                return "Click an app to give it slot " + root.selectedSlot +
                  "; an app can hold several, and clicking one it holds takes it back"
              }
              if (root.pinnedHere.length === 0) return "Search for a running app, or type a class you have not launched yet"
              return "Click a slot in the canvas to give one of these a place in the split"
            }
            color: Util.alpha(root.fg, 0.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
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
                iconText: "󰄀"
                tooltipText: "Build a layout from the windows on workspace " + root.selectedWorkspace
                onClicked: root.captureWorkspace(root.selectedWorkspace)
              }

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
              selected: !root.assigningAll && !root.assigningMonitor
              tooltipText: "Only this workspace uses the layout you pick"
              onClicked: root.assignTarget = "workspace"
            }

            Button {
              visible: root.selectedMonitor !== ""
              foreground: root.fg
              accent: root.accent
              bordered: true
              fontSize: Style.font.caption
              verticalPadding: Style.spacing.xs
              text: root.selectedMonitor
              selected: root.assigningMonitor
              tooltipText: "Every workspace on " + root.selectedMonitor +
                " uses the layout you pick, unless it has one of its own"
              onClicked: root.assignTarget = "monitor"
            }

            Button {
              foreground: root.fg
              accent: root.accent
              bordered: true
              fontSize: Style.font.caption
              verticalPadding: Style.spacing.xs
              text: "All workspaces"
              selected: root.assigningAll
              tooltipText: "Every workspace uses it, clearing per-workspace and per-monitor choices"
              onClicked: root.assignTarget = "all"
            }
          }

          Flow {
            width: parent.width
            spacing: Style.spacing.xs

            Repeater {
              // A count, not the array: a drag replaces `library` on every
              // frame, and an array model rebuilds every card with it. The
              // thumbnails still track the drag — their bindings update — but
              // the items survive it.
              model: root.library.length

              Rectangle {
                id: card
                required property int index

                readonly property var modelData: root.library[card.index]

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
              model: root.config && root.config.profiles ? root.config.profiles.length : 0

              Button {
                required property int index

                readonly property var modelData: root.config.profiles[index]

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
        }
      }
    }
  }
}
