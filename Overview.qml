import QtQuick
import QtQuick.Shapes
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// The workspace overview: one card per workspace in use, drawn as the shape
// it tiles with, plus the apps open on it. It is a fullscreen overlay rather
// than a panel off the bar, because it is about every workspace at once.
// Panel.qml owns it: that copy holds the window reads, the document and the
// command line. It is built the way the shell builds its own overlays, from
// OverlayWindow, the menu palette and a BorderSurface card, so a theme that
// restyles the app grid restyles this too.
Item {
  id: root

  property bool opened: false
  // Panel.overviewRow: { workspace, label, layoutName, focused, layout,
  // builtin, windows, apps, aspect } per workspace, in strip order.
  property var workspaces: []
  // The number the "new workspace" card goes to. Empty hides the card.
  property string freeWorkspace: ""

  signal closeRequested()
  signal workspaceActivated(string workspace)
  signal newWorkspaceRequested(string workspace)

  property int selectedIndex: 0

  readonly property bool hasNewCard: freeWorkspace !== ""
  readonly property int count: workspaces.length + (hasNewCard ? 1 : 0)

  readonly property int borderWidth: Math.max(1, Style.space(2))
  readonly property int tileBorderWidth: Math.max(1, Style.normalBorderWidth)
  readonly property int contentMargin: Style.spacing.panelPadding
  readonly property int inset: contentMargin + borderWidth
  readonly property int screenMargin: Style.space(40)
  readonly property int gap: Style.spacing.xxxl
  readonly property int framePadding: Style.spacing.lg
  readonly property int captionGap: Style.spacing.md
  readonly property int captionHeight: captionGap + Math.ceil(labelMetrics.height)
    + Style.spacing.xxs + Math.ceil(appsMetrics.height)

  readonly property real screenAspect: window.width > 0 && window.height > 0
    ? window.width / window.height
    : 16 / 9

  // Cards keep their real size and the column count changes to fit. Scaling
  // the whole grid instead would shrink the text below what the theme set.
  readonly property var grid: Model.overviewGrid(root.count,
    window.width - root.screenMargin * 2 - root.inset * 2,
    window.height - root.screenMargin * 2 - root.inset * 2, {
      aspect: root.screenAspect,
      gap: root.gap,
      caption: root.captionHeight,
      maxWidth: Style.space(300),
      maxColumns: 5
    })

  function focusedIndex() {
    for (var i = 0; i < workspaces.length; i++) {
      if (workspaces[i].focused) return i
    }
    return 0
  }

  // The card for the workspace in view starts selected, so Enter on an
  // overview opened by mistake goes nowhere.
  onOpenedChanged: {
    if (!opened) return
    selectedIndex = focusedIndex()
    pointerGate.reset()
    Qt.callLater(function() {
      if (root.opened) keyCatcher.forceActiveFocus()
    })
  }

  onCountChanged: selectedIndex = Math.max(0, Math.min(selectedIndex, count - 1))

  function select(delta) {
    if (count === 0) return
    pointerGate.reset()
    selectedIndex = Math.max(0, Math.min(count - 1, selectedIndex + delta))
  }

  function selectFromPointer(index, item, mouse) {
    if (pointerGate.moved(item, mouse)) selectedIndex = index
  }

  function activate(index) {
    if (index >= 0 && index < workspaces.length) {
      workspaceActivated(workspaces[index].workspace)
    } else if (index === workspaces.length && hasNewCard) {
      newWorkspaceRequested(freeWorkspace)
    }
  }

  FontMetrics {
    id: labelMetrics
    font.family: Style.font.menuFamily
    font.pixelSize: Style.font.body
  }

  FontMetrics {
    id: appsMetrics
    font.family: Style.font.menuFamily
    font.pixelSize: Style.font.caption
  }

  // A pointer resting where a card opens does not take the selection. Only a
  // pointer that moves does. Measured against the window, not the card: the
  // card resizes once the screen's size arrives, and that is not a move.
  PointerMoveGate {
    id: pointerGate
    referenceItem: window.contentItem
  }

  OverlayWindow {
    id: window
    shown: root.opened
    WlrLayershell.namespace: "omarchy-workspace-layout-overview"

    // The window maps after `opened` turns true. Focus goes to the keys
    // again once it does, or Escape reaches nothing.
    onVisibleChanged: if (visible && root.opened) keyCatcher.forceActiveFocus()

    Rectangle {
      anchors.fill: parent
      color: Commons.Color.menu.scrim
    }

    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      onClicked: root.closeRequested()
    }

    BorderSurface {
      id: card
      anchors.centerIn: parent
      width: root.grid.columns * root.grid.cardWidth + (root.grid.columns - 1) * root.gap
        + contentLeftInset + contentRightInset
      height: root.grid.rows * (root.grid.frameHeight + root.captionHeight) + (root.grid.rows - 1) * root.gap
        + contentTopInset + contentBottomInset
      radius: Style.cornerRadius
      color: Commons.Color.menu.background
      borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, root.borderWidth)
      padding: root.contentMargin

      // A click on the card between two workspaces is a near miss, not a
      // request to close.
      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
      }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          var key = Util.readingKey(event)
          var digit = event.key >= Qt.Key_0 && event.key <= Qt.Key_9
            && !(event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier))
          if (event.key === Qt.Key_Escape) {
            root.closeRequested()
          } else if (key === Qt.Key_Left) {
            root.select(-1)
          } else if (key === Qt.Key_Right) {
            root.select(1)
          } else if (event.key === Qt.Key_Up) {
            root.select(-root.grid.columns)
          } else if (event.key === Qt.Key_Down) {
            root.select(root.grid.columns)
          } else if (event.key === Qt.Key_Tab) {
            root.select(root.selectedIndex === root.count - 1 ? -root.selectedIndex : 1)
          } else if (event.key === Qt.Key_Backtab) {
            root.select(root.selectedIndex === 0 ? root.count - 1 : -1)
          } else if (event.key === Qt.Key_Home) {
            root.select(-root.selectedIndex)
          } else if (event.key === Qt.Key_End) {
            root.select(root.count - 1 - root.selectedIndex)
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space) {
            root.activate(root.selectedIndex)
          } else if (digit) {
            // The same numbers as Super+1 to Super+0, with 0 for workspace 10,
            // whether or not anything is open there.
            var n = event.key === Qt.Key_0 ? 10 : event.key - Qt.Key_0
            root.workspaceActivated(String(n))
          } else {
            return
          }
          event.accepted = true
        }
      }

      Grid {
        x: card.contentLeftInset
        y: card.contentTopInset
        columns: root.grid.columns
        spacing: root.gap

        Repeater {
          // A count, not the array: the rows are replaced on every window
          // event, and an array model would rebuild every card with them.
          model: root.count

          Item {
            id: tile
            required property int index

            readonly property bool isNew: tile.index >= root.workspaces.length
            readonly property var modelData: tile.isNew ? null : root.workspaces[tile.index]
            readonly property bool selected: tile.index === root.selectedIndex
            readonly property bool focused: !!tile.modelData && tile.modelData.focused === true
            readonly property real aspect: tile.modelData && tile.modelData.aspect > 0
              ? tile.modelData.aspect
              : root.screenAspect

            width: root.grid.cardWidth
            height: root.grid.frameHeight + root.captionHeight

            Rectangle {
              id: frame
              width: parent.width
              height: root.grid.frameHeight
              radius: Style.cornerRadius
              color: tile.selected
                ? Commons.Color.menu.selectedBackground
                : Util.alpha(Commons.Color.menu.text, 0.04)
              border.width: tile.isNew ? 0 : root.tileBorderWidth
              border.color: tile.focused
                ? Commons.Color.accent
                : Util.alpha(Commons.Color.menu.text, tile.selected ? 0.7 : 0.14)

              // The workspace's own aspect, centered in the frame, so a
              // portrait monitor's workspace reads as portrait.
              LayoutThumb {
                visible: !tile.isNew
                readonly property real boxWidth: frame.width - root.framePadding * 2
                readonly property real boxHeight: frame.height - root.framePadding * 2
                width: Math.max(1, Math.min(boxWidth, boxHeight * tile.aspect))
                height: Math.max(1, width / tile.aspect)
                anchors.centerIn: parent
                layout: tile.modelData ? tile.modelData.layout : null
                stroke: tile.focused ? Commons.Color.accent : Commons.Color.menu.text
                strength: tile.modelData && tile.modelData.builtin ? 0.45 : 1.0
                // The windows are on the workspace, so the picture is of the
                // real thing: a place with two windows in it shows the stack.
                filled: !!tile.modelData && tile.modelData.windows > 0
                windowCount: tile.modelData ? tile.modelData.windows : 0
              }

              // The card that is not a workspace yet: a dashed outline.
              Shape {
                id: newFrame
                visible: tile.isNew
                anchors.fill: parent

                ShapePath {
                  strokeColor: Util.alpha(Commons.Color.menu.text, tile.selected ? 0.6 : 0.3)
                  strokeWidth: root.tileBorderWidth
                  strokeStyle: ShapePath.DashLine
                  dashPattern: [4, 4]
                  fillColor: "transparent"
                  capStyle: ShapePath.FlatCap

                  PathRectangle {
                    x: root.tileBorderWidth / 2
                    y: root.tileBorderWidth / 2
                    width: newFrame.width - root.tileBorderWidth
                    height: newFrame.height - root.tileBorderWidth
                    radius: Style.cornerRadius
                  }
                }
              }

              Text {
                visible: tile.isNew
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: "+"
                color: tile.selected ? Commons.Color.menu.selectedText : Util.alpha(Commons.Color.menu.text, 0.5)
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.heading * 2
              }
            }

            Column {
              anchors.top: frame.bottom
              anchors.topMargin: root.captionGap
              width: parent.width
              spacing: Style.spacing.xxs

              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: tile.isNew
                  ? root.freeWorkspace + " · New workspace"
                  : tile.modelData.label + " · " + tile.modelData.layoutName
                elide: Text.ElideRight
                color: tile.selected ? Commons.Color.menu.selectedText : Commons.Color.menu.text
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.body
                font.bold: tile.focused
              }

              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: tile.isNew ? "Opens the panel to pick a layout"
                  : (tile.modelData.apps !== "" ? tile.modelData.apps : "Empty")
                elide: Text.ElideRight
                color: Commons.Color.menu.text
                opacity: 0.58
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.caption
              }
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onPositionChanged: function(mouse) { root.selectFromPointer(tile.index, tile, mouse) }
              onClicked: root.activate(tile.index)
            }
          }
        }
      }
    }
  }
}
