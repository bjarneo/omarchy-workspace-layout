import QtQuick
import qs.Commons
import "Model.js" as Model

// A layout at chip size: no labels, no handles, just the shape. Used in the
// layout library, on the workspace chips, and as the bar icon — so a glance at
// the bar is enough to know how the current workspace is split.
Item {
  id: root

  property var layout: null
  property color stroke: Color.popups.text
  property real strength: 1.0
  property bool filled: false

  // How many windows to imagine. Defaults to the layout's own slot count so a
  // 25/50/25 chip shows three tiles rather than one.
  property int windowCount: 0

  readonly property var spec: Model.normalizeLayout(root.layout)
  readonly property int drawnCount: root.windowCount > 0
    ? root.windowCount
    : (root.spec.kind === "grid" ? 4 : root.spec.weights.length)
  readonly property var rects: Model.slotRects(root.spec, Math.max(1, root.drawnCount))

  // A hairline reads as grey rather than as a line once it is this small, so
  // never let the border round down to nothing.
  readonly property int hairline: Math.max(1, Math.round(Style.space(1)))

  Repeater {
    model: root.rects

    Rectangle {
      required property var modelData

      x: Math.round(modelData.x * root.width)
      y: Math.round(modelData.y * root.height)
      // Round the far edge rather than the size: at 16px wide, independently
      // rounded widths leave visible seams between tiles.
      width: Math.max(1, Math.round((modelData.x + modelData.w) * root.width) - Math.round(modelData.x * root.width) - root.hairline)
      height: Math.max(1, Math.round((modelData.y + modelData.h) * root.height) - Math.round(modelData.y * root.height) - root.hairline)

      radius: 0
      color: root.filled ? Util.alpha(root.stroke, 0.45 * root.strength) : "transparent"
      border.width: root.hairline
      border.color: Util.alpha(root.stroke, (root.filled ? 0.9 : 0.8) * root.strength)
    }
  }
}
