import QtQuick
import qs.Commons
import "Model.js" as Model

// The layout, drawn at the workspace's own aspect ratio, with the dividers
// between slots as draggable handles.
//
// It draws the *shape* — one tile per slot the layout defines — rather than one
// tile per window that happens to be open. Editing a shape you cannot see would
// be guesswork, so slots without a window in them are drawn hollow and the ones
// that are occupied are filled and numbered.
Item {
  id: root

  property var layout: null
  property int windowCount: 0
  property bool editable: true

  // Which numbered slot the panel is pointing at, 1-based, or 0 for none.
  // Clicking a tile is how an app gets sent to a particular place in the
  // split, so the tiles are targets as well as a drawing.
  property int selectedSlot: 0

  // Per slot, the apps pinned to it — element 0 is slot 1. Drawn inside the
  // tile, because "which app lives here" is a property of the place.
  property var slotApps: []
  property color foreground: Color.popups.text
  property color accent: Color.accent
  property real aspect: 16 / 9

  // Dragging a divider mutates the layout continuously; `committed` fires once
  // on release, which is when the change is worth writing to disk.
  signal weightsChanged(var weights)
  signal committed()
  signal slotClicked(int slot)
  // Right-click carries the point it happened at, in this item's coordinates,
  // so the panel can put its menu where the cursor is.
  signal slotMenuRequested(int slot, real x, real y)
  // A drag of a cross-grain divider: the slot, by position, and the parts it
  // should be cut into now.
  signal cellWeightsChanged(int slot, var parts)
  // A drag of the divider inside a divided part: which slot, which part, and
  // the pieces it should be cut into now.
  signal pieceWeightsChanged(int slot, int part, var pieces)
  // Hold a tile and drop it on another: the two places exchange their apps.
  signal placesSwapped(int from, int to)
  // The two ways to cut the place under the cursor, without going through a
  // menu: "along" is another slot beside it, "across" is another part of it.
  signal splitRequested(int slot, string direction)
  // Carried onto the edge of another place and held there: the place under the
  // cursor is cut in two and the carried apps land in the half by the edge.
  signal placeDropped(int from, int to, string edge)

  readonly property var spec: Model.normalizeLayout(root.layout)
  readonly property bool isRatio: spec.kind !== "grid"
  readonly property bool horizontal: spec.orientation !== "rows"
  readonly property int slotCount: spec.weights.length

  // Places, not slots: a slot cut across the grain holds two windows, and the
  // canvas has to draw both halves or splitting one appears to do nothing
  // until enough windows are open to fill it.
  readonly property int placeCount: Model.totalCells(spec.cells)

  // Ask for whichever is larger: with fewer windows than places this draws the
  // whole shape, and with more it draws the stacking the overflow rule creates.
  readonly property int drawnCount: Math.max(1, Math.max(root.windowCount, root.isRatio ? root.placeCount : 1))
  readonly property var rects: Model.slotRects(root.spec, root.drawnCount)
  readonly property var dividers: root.isRatio ? Model.dividerPositions(root.spec.weights) : []

  // Drawn and stored are the same until "extra → new slots" appends places,
  // which moves every stored edge on screen. Handles are placed through this
  // and drags are converted back through it, so a handle is always on the seam
  // it moves.
  readonly property real dividerScale: Model.dividerScale(root.spec, root.drawnCount)

  // Which slot of the layout each drawn tile belongs to, by position.
  readonly property var rectSlots: Model.rectSlotPositions(root.spec, root.drawnCount)

  // What each drawn place is — slot, part, piece — so a handle knows what it
  // would be moving.
  readonly property var rectAddresses: Model.placeAddresses(root.spec, root.drawnCount)

  // The dividers *inside* a divided part, running back along the grain. The
  // third level: a stacked half cut into two columns has one of these.
  readonly property var pieceHandles: {
    var out = []
    if (!root.isRatio) return out
    var runs = {}
    var i
    for (i = 0; i < root.rectAddresses.length; i++) {
      var at = root.rectAddresses[i]
      if (!at) continue
      var key = at.slot + ":" + at.part
      if (!runs[key]) runs[key] = []
      runs[key].push(i)
    }
    for (var group in runs) {
      var indices = runs[group]
      if (indices.length < 2) continue
      var owner = root.rectAddresses[indices[0]]
      for (var j = 0; j < indices.length - 1; j++) {
        var rect = root.rects[indices[j]]
        if (!rect) continue
        out.push(root.horizontal
          ? { slot: owner.slot, part: owner.part, index: j, count: indices.length,
              main: rect.x + rect.w, start: rect.y, span: rect.h }
          : { slot: owner.slot, part: owner.part, index: j, count: indices.length,
              main: rect.y + rect.h, start: rect.x, span: rect.w })
      }
    }
    return out
  }

  // The dividers *inside* a split slot, running across the grain. Derived from
  // the tiles actually drawn rather than from the weights, so they land on the
  // seam the user can see.
  //
  // Offered wherever a slot is showing more than one part — including a slot
  // that only has parts because overflow stacked windows into it. There is no
  // stored ratio behind those, so dragging one writes the parts down: the
  // stack becomes a split the layout remembers.
  readonly property var crossHandles: {
    var out = []
    if (!root.isRatio) return out
    var runs = {}
    var i
    for (i = 0; i < root.rectSlots.length; i++) {
      var at = root.rectSlots[i]
      if (!runs[at]) runs[at] = []
      runs[at].push(i)
    }
    for (var key in runs) {
      var slot = Number(key)
      var indices = []
      // One entry per part of the slot: the seam between parts, not between
      // the pieces inside one of them, which has its own handle.
      var seenParts = {}
      for (var r = 0; r < runs[key].length; r++) {
        var addr = root.rectAddresses[runs[key][r]]
        if (!addr || seenParts[addr.part]) continue
        seenParts[addr.part] = true
        indices.push(runs[key][r])
      }
      if (indices.length < 2) continue
      // The handle spans the slot, not the first piece of it: a part that is
      // divided again is only one column wide at its first rect.
      var lowest = 1
      var highest = 0
      for (var e = 0; e < runs[key].length; e++) {
        var edge = root.rects[runs[key][e]]
        if (!edge) continue
        var from = root.horizontal ? edge.x : edge.y
        var to = root.horizontal ? edge.x + edge.w : edge.y + edge.h
        if (from < lowest) lowest = from
        if (to > highest) highest = to
      }
      for (var j = 0; j < indices.length - 1; j++) {
        var rect = root.rects[indices[j]]
        if (!rect) continue
        out.push(root.horizontal
          ? { slot: slot, index: j, count: indices.length,
              cross: rect.y + rect.h, start: lowest, span: highest - lowest }
          : { slot: slot, index: j, count: indices.length,
              cross: rect.x + rect.w, start: lowest, span: highest - lowest })
      }
    }
    return out
  }

  // The tile being carried, and the one under the cursor, both 1-based place
  // numbers. Zero for neither.
  property int carrying: 0
  property int carryOver: 0
  // Where the cursor is during a carry, in stage coordinates, so the thing
  // being carried can be drawn under it.
  property real carryX: 0
  property real carryY: 0

  // Hold a carried tile over another for a moment and the edges wake up: drop
  // on one and the target splits, drop in the middle and the two swap. Held
  // rather than immediate, so a tile carried *across* another on its way
  // somewhere else does not offer to cut it up.
  property bool carryZones: false
  property string carryEdge: ""

  readonly property var carryAllowed: root.carryOver > 0
    ? Model.dropDirections(root.spec, root.carryOver) : ({})

  Timer {
    id: dwell
    interval: 400
    repeat: false
    onTriggered: root.carryZones = root.carrying > 0 && root.carryOver > 0
  }

  onCarryOverChanged: {
    root.carryZones = false
    root.carryEdge = ""
    if (root.carrying > 0 && root.carryOver > 0 && root.carryOver !== root.carrying) dwell.restart()
    else dwell.stop()
  }

  // Which edge of the place under the cursor is being aimed at, or "" for the
  // middle. A third of the way in on either side counts as the edge.
  function edgeAt(place, x, y) {
    var rect = root.rects[place - 1]
    if (!rect) return ""
    var width = Math.max(1, stage.width)
    var height = Math.max(1, stage.height)
    var fx = (x - rect.x * width) / Math.max(1, rect.w * width)
    var fy = (y - rect.y * height) / Math.max(1, rect.h * height)
    var allowed = root.carryAllowed
    if (fx < 0.33 && allowed.left) return "left"
    if (fx > 0.67 && allowed.right) return "right"
    if (fy < 0.33 && allowed.top) return "top"
    if (fy > 0.67 && allowed.bottom) return "bottom"
    return ""
  }

  // What the carried place holds, for the label that follows the cursor.
  readonly property var carryApps: {
    var list = root.slotApps
    var at = root.carrying - 1
    return (root.carrying > 0 && list instanceof Array && list.length > at && list[at] instanceof Array)
      ? list[at] : []
  }

  // Which place a point in stage coordinates is over, 1-based, or 0.
  function placeAt(x, y) {
    var width = Math.max(1, stage.width)
    var height = Math.max(1, stage.height)
    for (var i = 0; i < root.rects.length; i++) {
      var rect = root.rects[i]
      if (x >= rect.x * width && x <= (rect.x + rect.w) * width
        && y >= rect.y * height && y <= (rect.y + rect.h) * height) return i + 1
    }
    return 0
  }

  property int activeDivider: -1
  property int activeCross: -1
  property int activePiece: -1
  readonly property bool dragging: activeDivider >= 0 || activeCross >= 0 || activePiece >= 0

  implicitHeight: Style.space(140)

  // The stage keeps the monitor's proportions so a 25% column looks like 25% of
  // the actual screen, not 25% of a box the panel happened to be.
  Item {
    id: stage
    anchors.centerIn: parent
    width: Math.min(parent.width, parent.height * root.aspect)
    height: Math.min(parent.height, parent.width / root.aspect)

    Rectangle {
      anchors.fill: parent
      color: Util.alpha(root.foreground, 0.05)
      radius: Style.cornerRadius
      border.width: 1
      border.color: Util.alpha(root.foreground, 0.15)
    }

    // Counts, not arrays, as the models below. A Repeater fed a JavaScript
    // array rebuilds every delegate whenever that array is replaced — and a
    // drag replaces it on every frame, which destroyed the very handle holding
    // the mouse grab: the divider moved once and the drag died. Given a number
    // the Repeater keeps its items, and each one reads its own geometry out of
    // the array by index.
    Repeater {
      model: root.rects.length

      Item {
        id: tile
        required property int index

        readonly property var modelData: root.rects[tile.index] || { x: 0, y: 0, w: 0, h: 0 }
        readonly property bool occupied: index < root.windowCount
        readonly property bool targeted: root.selectedSlot === tile.index + 1
        readonly property bool carried: root.carrying === tile.index + 1
        readonly property bool dropTarget: root.carryOver === tile.index + 1 && !tile.carried
        readonly property var apps: {
          var list = root.slotApps
          return (list instanceof Array && list.length > tile.index && list[tile.index] instanceof Array)
            ? list[tile.index] : []
        }

        x: modelData.x * stage.width
        y: modelData.y * stage.height
        width: modelData.w * stage.width
        height: modelData.h * stage.height

        Behavior on x { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on y { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on width { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on height { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }

        Rectangle {
          anchors.fill: parent
          anchors.margins: Math.max(1, Style.space(2))
          radius: Style.cornerRadius
          opacity: tile.carried ? 0.45 : 1
          color: tile.dropTarget
            ? Util.alpha(root.accent, 0.4)
            : (tile.targeted
              ? Util.alpha(root.accent, 0.3)
              : (tile.occupied ? Util.alpha(root.accent, 0.16)
                : (tileHover.hovered ? Util.alpha(root.foreground, 0.07) : "transparent")))
          border.width: (tile.targeted || tile.dropTarget) ? 2 : 1
          border.color: (tile.targeted || tile.dropTarget || tile.occupied)
            ? Util.alpha(root.accent, (tile.targeted || tile.dropTarget) ? 1 : 0.75)
            : Util.alpha(root.foreground, tileHover.hovered ? 0.4 : 0.22)

          Behavior on color { ColorAnimation { duration: 90 } }

          HoverHandler { id: tileHover }

          // Declared before the labels so a click anywhere on the tile picks
          // the slot; the divider handles are drawn after the tiles and keep
          // their own grab area, so dragging is untouched.
          MouseArea {
            id: tileMouse
            anchors.fill: parent
            cursorShape: root.carrying > 0 ? Qt.ClosedHandCursor : Qt.PointingHandCursor
            acceptedButtons: Qt.LeftButton | Qt.RightButton
            preventStealing: true

            // Where the press landed, so a click can be told from a drag.
            property real pressX: 0
            property real pressY: 0

            onPressed: function(mouse) {
              tileMouse.pressX = mouse.x
              tileMouse.pressY = mouse.y
            }

            onPositionChanged: function(mouse) {
              if (!(mouse.buttons & Qt.LeftButton)) return
              var moved = Math.abs(mouse.x - tileMouse.pressX) + Math.abs(mouse.y - tileMouse.pressY)
              // A few pixels of wobble is a click, not a drag.
              if (root.carrying === 0 && moved < Style.space(6)) return
              root.carrying = tile.index + 1
              var point = mapToItem(stage, mouse.x, mouse.y)
              root.carryX = point.x
              root.carryY = point.y
              var over = root.placeAt(point.x, point.y)
              if (over !== root.carryOver) root.carryOver = over
              root.carryEdge = root.carryZones ? root.edgeAt(over, point.x, point.y) : ""
            }

            onReleased: function(mouse) {
              var from = root.carrying
              var to = root.carryOver
              var edge = root.carryEdge
              root.carrying = 0
              root.carryOver = 0
              root.carryZones = false
              root.carryEdge = ""
              if (from > 0) {
                // Dropped on an edge, the target splits and the carried apps
                // take the new half; dropped in the middle, the two places
                // exchange. Ending where it started is neither — the user
                // changed their mind, and it is not a click either.
                if (to > 0 && to !== from) {
                  if (edge !== "") root.placeDropped(from, to, edge)
                  else root.placesSwapped(from, to)
                }
                return
              }
              if (mouse.button === Qt.RightButton) {
                var point = mapToItem(root, mouse.x, mouse.y)
                root.slotMenuRequested(tile.index + 1, point.x, point.y)
              } else {
                root.slotClicked(tile.index + 1)
              }
            }

            onCanceled: {
              root.carrying = 0
              root.carryOver = 0
              root.carryZones = false
              root.carryEdge = ""
            }
          }

          // Where the carried apps would land: the half by the edge under the
          // cursor, or the whole tile when the middle means "swap these two".
          Rectangle {
            visible: tile.dropTarget
            color: Util.alpha(root.accent, 0.55)
            radius: Style.cornerRadius
            x: root.carryEdge === "right" ? parent.width / 2 : 0
            y: root.carryEdge === "bottom" ? parent.height / 2 : 0
            width: (root.carryEdge === "left" || root.carryEdge === "right")
              ? parent.width / 2 : parent.width
            height: (root.carryEdge === "top" || root.carryEdge === "bottom")
              ? parent.height / 2 : parent.height

            Behavior on x { NumberAnimation { duration: 80 } }
            Behavior on y { NumberAnimation { duration: 80 } }
            Behavior on width { NumberAnimation { duration: 80 } }
            Behavior on height { NumberAnimation { duration: 80 } }
          }

          // The two cuts, on the tile itself. The menu has them too, but a
          // shape is fiddled with far more often than it is configured, and
          // right-clicking for every split is a lot of right-clicking.
          Row {
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.margins: Style.spacing.xxs
            spacing: Style.spacing.xxs
            visible: root.editable && tileHover.hovered && root.carrying === 0
              && tile.width > Style.space(52) && tile.height > Style.space(34)

            Repeater {
              model: [
                { key: "along", glyph: root.horizontal ? "\u2194" : "\u2195" },
                { key: "across", glyph: root.horizontal ? "\u2195" : "\u2194" }
              ]

              Rectangle {
                id: cutButton
                required property var modelData

                width: Style.space(18)
                height: Style.space(18)
                radius: Style.cornerRadius
                color: cutHover.hovered
                  ? Util.alpha(root.accent, 0.85)
                  : Util.alpha(root.foreground, 0.18)

                Text {
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: cutButton.modelData.glyph
                  color: cutHover.hovered ? Color.popups.background : root.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                }

                HoverHandler { id: cutHover }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.splitRequested(tile.index + 1, cutButton.modelData.key)
                }
              }
            }
          }

          // The percentage is the number the user is actually steering, so it
          // sits in the tile rather than in a legend somewhere else. Names of
          // the apps that live here go under it: the tile is the answer to
          // both "how wide" and "what goes here".
          Column {
            anchors.centerIn: parent
            width: parent.width - Style.spacing.sm * 2
            spacing: Style.spacing.xxs

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              visible: root.isRatio && tile.width > Style.space(26)
              textFormat: Text.PlainText
              text: {
                var value = root.horizontal
                  ? tile.modelData.w * 100
                  : tile.modelData.h * 100
                return Model.formatWeight(value)
              }
              color: tile.occupied ? root.foreground : Util.alpha(root.foreground, 0.45)
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              font.bold: tile.occupied
            }

            // A place can hold several apps — whichever is open takes it — but
            // a tile is a few characters tall, so the rest are counted.
            Repeater {
              model: Math.min(tile.apps.length, 2)

              Text {
                required property int index
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                visible: tile.width > Style.space(34) && tile.height > Style.space(30)
                textFormat: Text.PlainText
                text: tile.apps[index]
                color: Util.alpha(root.accent, 0.95)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              visible: tile.apps.length > 2
                && tile.width > Style.space(34) && tile.height > Style.space(30)
              textFormat: Text.PlainText
              text: "+" + (tile.apps.length - 2)
              color: Util.alpha(root.accent, 0.7)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          Text {
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.leftMargin: Style.spacing.xs
            anchors.topMargin: Style.spacing.xxs
            visible: tile.occupied && parent.width > Style.space(30) && parent.height > Style.space(24)
            textFormat: Text.PlainText
            text: String(tile.index + 1)
            color: Util.alpha(root.foreground, 0.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }
      }
    }

    // ------------------------------------------------------------- dividers

    Repeater {
      model: root.isRatio ? root.dividers.length : 0

      Item {
        id: handle
        required property int index

        readonly property real fraction:
          (root.dividers[handle.index] || 0) * root.dividerScale / 100
        readonly property bool hot: hover.hovered || root.activeDivider === handle.index

        // The grab area is deliberately wider than the line it draws: a 1px
        // target is unusable, and this is the control the whole panel is for.
        readonly property int grab: Style.space(11)

        x: root.horizontal ? fraction * stage.width - grab / 2 : 0
        y: root.horizontal ? 0 : fraction * stage.height - grab / 2
        width: root.horizontal ? grab : stage.width
        height: root.horizontal ? stage.height : grab

        Behavior on x { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on y { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }

        Rectangle {
          anchors.centerIn: parent
          width: root.horizontal ? Math.max(2, Style.space(3)) : parent.width * 0.5
          height: root.horizontal ? parent.height * 0.5 : Math.max(2, Style.space(3))
          radius: width < height ? width / 2 : height / 2
          color: handle.hot ? root.accent : Util.alpha(root.foreground, 0.35)
          opacity: root.editable ? 1 : 0.3

          Behavior on color { ColorAnimation { duration: 90 } }
        }

        HoverHandler {
          id: hover
          enabled: root.editable
          cursorShape: root.horizontal ? Qt.SizeHorCursor : Qt.SizeVerCursor
        }

        MouseArea {
          anchors.fill: parent
          enabled: root.editable
          cursorShape: root.horizontal ? Qt.SizeHorCursor : Qt.SizeVerCursor
          acceptedButtons: Qt.LeftButton
          // The panel scrolls, and a Flickable steals a drag as soon as it
          // crosses the threshold. Without this, aiming a divider with any
          // vertical wobble in it hands the grab to the scroll view mid-drag.
          preventStealing: true

          onPressed: root.activeDivider = handle.index

          onPositionChanged: function(mouse) {
            if (root.activeDivider !== handle.index) return
            var point = mapToItem(stage, mouse.x, mouse.y)
            var drawn = root.horizontal
              ? point.x / Math.max(1, stage.width) * 100
              : point.y / Math.max(1, stage.height) * 100
            // Back into the space the weights are written in, so the seam
            // lands under the cursor whatever the overflow rule is doing.
            var position = drawn / Math.max(0.01, root.dividerScale)
            // Holding Shift turns snapping off for the rare layout that wants
            // 47% and means it.
            var snap = !(mouse.modifiers & Qt.ShiftModifier)
            root.weightsChanged(
              Model.setDivider(root.spec.weights, handle.index, position, { snap: snap }))
          }

          onReleased: {
            root.activeDivider = -1
            root.committed()
          }

          // A divider that has drifted somewhere useless is faster to reset
          // than to drag back.
          onDoubleClicked: {
            root.weightsChanged(Model.evenWeights(root.slotCount))
            root.committed()
          }
        }
      }
    }

    // ------------------------------------------------------- cross dividers

    Repeater {
      model: root.crossHandles.length

      Item {
        id: crossHandle
        required property int index

        readonly property var spec: root.crossHandles[crossHandle.index]
        readonly property bool hot: crossHover.hovered || root.activeCross === crossHandle.index
        readonly property int grab: Style.space(11)

        x: root.horizontal ? spec.start * stage.width : spec.cross * stage.width - grab / 2
        y: root.horizontal ? spec.cross * stage.height - grab / 2 : spec.start * stage.height
        width: root.horizontal ? spec.span * stage.width : grab
        height: root.horizontal ? grab : spec.span * stage.height

        Behavior on x { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on y { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }

        Rectangle {
          anchors.centerIn: parent
          width: root.horizontal ? parent.width * 0.5 : Math.max(2, Style.space(3))
          height: root.horizontal ? Math.max(2, Style.space(3)) : parent.height * 0.5
          radius: width < height ? width / 2 : height / 2
          color: crossHandle.hot ? root.accent : Util.alpha(root.foreground, 0.35)
          opacity: root.editable ? 1 : 0.3

          Behavior on color { ColorAnimation { duration: 90 } }
        }

        HoverHandler {
          id: crossHover
          enabled: root.editable
          cursorShape: root.horizontal ? Qt.SizeVerCursor : Qt.SizeHorCursor
        }

        MouseArea {
          anchors.fill: parent
          enabled: root.editable
          cursorShape: root.horizontal ? Qt.SizeVerCursor : Qt.SizeHorCursor
          acceptedButtons: Qt.LeftButton
          preventStealing: true

          // What the slot's parts are right now: the ratio it was drawn with,
          // or equal shares when the parts came from a stack and there is
          // nothing stored yet.
          function partsNow() {
            var stored = root.spec.cells[crossHandle.spec.slot]
            if (!stored || stored.length !== crossHandle.spec.count) {
              return Model.evenWeights(crossHandle.spec.count)
            }
            // The bands themselves, not the parts: a part may be an object
            // saying how it is divided again, and a divider moves its width.
            var bands = []
            for (var i = 0; i < stored.length; i++) bands.push(Model.partWeight(stored[i]))
            return bands
          }

          onPressed: root.activeCross = crossHandle.index

          onPositionChanged: function(mouse) {
            if (root.activeCross !== crossHandle.index) return
            // A slot's parts divide the whole cross extent, so the pointer's
            // fraction of the stage *is* the divider position — the same maths
            // the main axis uses, on the other axis.
            var point = mapToItem(stage, mouse.x, mouse.y)
            var position = root.horizontal
              ? point.y / Math.max(1, stage.height) * 100
              : point.x / Math.max(1, stage.width) * 100
            var snap = !(mouse.modifiers & Qt.ShiftModifier)
            root.cellWeightsChanged(crossHandle.spec.slot,
              Model.setDivider(partsNow(), crossHandle.spec.index, position, { snap: snap }))
          }

          onReleased: {
            root.activeCross = -1
            root.committed()
          }

          onDoubleClicked: {
            root.cellWeightsChanged(crossHandle.spec.slot,
              Model.evenWeights(crossHandle.spec.count))
            root.committed()
          }
        }
      }
    }

    // ------------------------------------------------------- piece dividers

    Repeater {
      model: root.pieceHandles.length

      Item {
        id: pieceHandle
        required property int index

        readonly property var spec: root.pieceHandles[pieceHandle.index]
        readonly property bool hot: pieceHover.hovered || root.activePiece === pieceHandle.index
        readonly property int grab: Style.space(11)

        x: root.horizontal ? spec.main * stage.width - grab / 2 : spec.start * stage.width
        y: root.horizontal ? spec.start * stage.height : spec.main * stage.height - grab / 2
        width: root.horizontal ? grab : spec.span * stage.width
        height: root.horizontal ? spec.span * stage.height : grab

        Behavior on x { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on y { enabled: !root.dragging; NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }

        Rectangle {
          anchors.centerIn: parent
          width: root.horizontal ? Math.max(2, Style.space(3)) : parent.width * 0.5
          height: root.horizontal ? parent.height * 0.5 : Math.max(2, Style.space(3))
          radius: width < height ? width / 2 : height / 2
          color: pieceHandle.hot ? root.accent : Util.alpha(root.foreground, 0.35)
          opacity: root.editable ? 1 : 0.3

          Behavior on color { ColorAnimation { duration: 90 } }
        }

        HoverHandler {
          id: pieceHover
          enabled: root.editable
          cursorShape: root.horizontal ? Qt.SizeHorCursor : Qt.SizeVerCursor
        }

        MouseArea {
          anchors.fill: parent
          enabled: root.editable
          cursorShape: root.horizontal ? Qt.SizeHorCursor : Qt.SizeVerCursor
          acceptedButtons: Qt.LeftButton
          preventStealing: true

          // The pieces divide the slot's own extent, so the drag is measured
          // inside that band rather than across the whole stage.
          function bounds() {
            var lowest = 1
            var highest = 0
            for (var i = 0; i < root.rectAddresses.length; i++) {
              var at = root.rectAddresses[i]
              if (!at || at.slot !== pieceHandle.spec.slot) continue
              var rect = root.rects[i]
              var from = root.horizontal ? rect.x : rect.y
              var to = root.horizontal ? rect.x + rect.w : rect.y + rect.h
              if (from < lowest) lowest = from
              if (to > highest) highest = to
            }
            return { from: lowest, span: Math.max(0.01, highest - lowest) }
          }

          function piecesNow() {
            var part = root.spec.cells[pieceHandle.spec.slot][pieceHandle.spec.part]
            var split = Model.partSplit(part)
            return split.length === pieceHandle.spec.count
              ? split : Model.evenWeights(pieceHandle.spec.count)
          }

          onPressed: root.activePiece = pieceHandle.index

          onPositionChanged: function(mouse) {
            if (root.activePiece !== pieceHandle.index) return
            var point = mapToItem(stage, mouse.x, mouse.y)
            var band = bounds()
            var along = root.horizontal
              ? point.x / Math.max(1, stage.width)
              : point.y / Math.max(1, stage.height)
            var position = (along - band.from) / band.span * 100
            var snap = !(mouse.modifiers & Qt.ShiftModifier)
            root.pieceWeightsChanged(pieceHandle.spec.slot, pieceHandle.spec.part,
              Model.setDivider(piecesNow(), pieceHandle.spec.index, position, { snap: snap }))
          }

          onReleased: {
            root.activePiece = -1
            root.committed()
          }

          onDoubleClicked: {
            root.pieceWeightsChanged(pieceHandle.spec.slot, pieceHandle.spec.part,
              Model.evenWeights(pieceHandle.spec.count))
            root.committed()
          }
        }
      }
    }

    // ---------------------------------------------------------- carried tile

    // What you are holding, drawn under the cursor: without it a drag is two
    // tiles changing colour and no sense of carrying anything between them.
    Rectangle {
      id: ghost
      visible: root.carrying > 0
      z: 20
      width: Math.min(stage.width, ghostLabel.implicitWidth + Style.spacing.md * 2)
      height: ghostLabel.implicitHeight + Style.spacing.xs * 2
      radius: Style.cornerRadius
      color: Util.alpha(root.accent, 0.92)
      // Offset from the cursor so it is not under the pointer, and kept inside
      // the stage so it never hangs off the edge of the drawing.
      x: Math.max(0, Math.min(root.carryX + Style.space(12), stage.width - width))
      y: Math.max(0, Math.min(root.carryY - height / 2, stage.height - height))

      Text {
        id: ghostLabel
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: {
          var label = root.carryApps.length > 0
            ? root.carryApps.join(", ")
            : "place " + root.carrying
          return root.carryOver > 0 && root.carryOver !== root.carrying
            ? label + "  \u21c4  " + root.carryOver
            : label
        }
        color: Color.popups.background
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.bold: true
      }
    }
  }
}
