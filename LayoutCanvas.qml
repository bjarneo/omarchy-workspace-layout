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
  property color foreground: Color.popups.text
  property color accent: Color.accent
  property real aspect: 16 / 9

  // Dragging a divider mutates the layout continuously; `committed` fires once
  // on release, which is when the change is worth writing to disk.
  signal weightsChanged(var weights)
  signal committed()

  readonly property var spec: Model.normalizeLayout(root.layout)
  readonly property bool isRatio: spec.kind !== "grid"
  readonly property bool horizontal: spec.orientation !== "rows"
  readonly property int slotCount: spec.weights.length

  // Ask for whichever is larger: with fewer windows than slots this draws the
  // whole shape, and with more it draws the stacking the overflow rule creates.
  readonly property int drawnCount: Math.max(1, Math.max(root.windowCount, root.isRatio ? root.slotCount : 1))
  readonly property var rects: Model.slotRects(root.spec, root.drawnCount)
  readonly property var dividers: root.isRatio ? Model.dividerPositions(root.spec.weights) : []

  property int activeDivider: -1
  readonly property bool dragging: activeDivider >= 0

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

    Repeater {
      model: root.rects

      Item {
        id: tile
        required property var modelData
        required property int index

        readonly property bool occupied: index < root.windowCount

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
          color: tile.occupied ? Util.alpha(root.accent, 0.16) : "transparent"
          border.width: 1
          border.color: tile.occupied
            ? Util.alpha(root.accent, 0.75)
            : Util.alpha(root.foreground, 0.22)

          // The percentage is the number the user is actually steering, so it
          // sits in the tile rather than in a legend somewhere else.
          Text {
            anchors.centerIn: parent
            visible: root.isRatio && parent.width > Style.space(26)
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
      model: root.isRatio ? root.dividers : []

      Item {
        id: handle
        required property var modelData
        required property int index

        readonly property real fraction: modelData / 100
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

          onPressed: root.activeDivider = handle.index

          onPositionChanged: function(mouse) {
            if (root.activeDivider !== handle.index) return
            var point = mapToItem(stage, mouse.x, mouse.y)
            var position = root.horizontal
              ? point.x / Math.max(1, stage.width) * 100
              : point.y / Math.max(1, stage.height) * 100
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
  }
}
