import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The bar button. Its icon is the layout itself rather than a generic glyph:
// whatever shape the focused workspace is tiling with is drawn at 16px, so the
// bar answers "how is this workspace split?" without being clicked.
BarWidget {
  id: root
  moduleName: "bjarneo.workspace-layout"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property var focusedLayout: panelLoader.item ? panelLoader.item.focusedLayout : null
  readonly property string focusedLayoutId: panelLoader.item ? panelLoader.item.focusedLayoutId : "dwindle"
  readonly property bool managing: panelLoader.item ? panelLoader.item.managingFocused === true : false
  readonly property string activeProfileName: panelLoader.item ? panelLoader.item.activeProfileName : ""
  readonly property int focusedWorkspaceId: panelLoader.item ? panelLoader.item.focusedWorkspaceId : 1

  // A workspace left on a Hyprland built-in still gets a picture, drawn faint,
  // so the button never goes blank and the difference stays legible.
  readonly property var iconLayout: focusedLayout
    ? focusedLayout
    : ({ weights: [50, 50], overflow: "last" })

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  // Loaded eagerly, not on first click: the panel owns the config document, and
  // the button's icon is drawn from it.
  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: {
      var where = "Workspace " + root.focusedWorkspaceId
      var what = root.focusedLayout
        ? root.focusedLayout.name + " · " + Model.describeLayout(root.focusedLayout)
        : "Hyprland " + root.focusedLayoutId
      var who = root.activeProfileName !== "" ? " · " + root.activeProfileName : ""
      return where + " · " + what + who
    }

    iconComponent: Component {
      Item {
        LayoutThumb {
          anchors.centerIn: parent
          width: Math.round(parent.width)
          height: Math.round(parent.width * 0.68)
          layout: root.iconLayout
          stroke: button.foreground
          strength: root.managing ? 1.0 : 0.45
        }
      }
    }

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.LeftButton) root.togglePanel()
    }
  }
}
