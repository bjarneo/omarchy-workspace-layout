import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

Column {
  id: root

  property var config: null
  property color foreground: Commons.Color.popups.text
  property color accent: Commons.Color.accent
  property bool opened: false
  property string original: ""
  property string workspace: ""
  property string error: ""
  readonly property bool editing: classInput.activeFocus || nameInput.activeFocus
    || commandInput.activeFocus || slotsInput.activeFocus || groupInput.activeFocus
    || saveButton.activeFocus || cancelButton.activeFocus

  signal saved(string original, string match, string workspace, string slots, string command, string name, string group)
  signal cancelled()

  visible: opened
  spacing: Style.spacing.sm

  function edit(match, pin, target, slot) {
    original = match || ""
    workspace = target
    classInput.text = match || ""
    nameInput.text = pin && pin.name ? pin.name : ""
    commandInput.text = pin && pin.command ? pin.command : ""
    slotsInput.text = pin ? (pin.slots || []).join(", ") : (slot > 0 ? String(slot) : "")
    groupInput.text = String(pin && pin.group ? pin.group : 0)
    error = ""
    opened = true
    classInput.forceActiveFocus()
  }

  function submit() {
    error = Model.pinEditorError(config, original, classInput.text, commandInput.text, slotsInput.text, groupInput.text)
    if (error !== "") return
    saved(original, classInput.text.trim(), workspace, slotsInput.text, commandInput.text, nameInput.text, groupInput.text)
  }

  function close() {
    opened = false
    cancelled()
  }

  Keys.onEscapePressed: root.close()

  Text {
    text: "App on workspace " + Model.workspaceLabel(root.workspace)
    textFormat: Text.PlainText
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.bodySmall
  }

  Text {
    text: "Window class"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
  TextField {
    id: classInput
    width: parent.width
    foreground: root.foreground
    accent: root.accent
    placeholderText: "brave-work"
    Accessible.name: "Window class"
    onAccepted: root.submit()
  }

  Text {
    text: "Display name"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
  TextField {
    id: nameInput
    maximumLength: 60
    width: parent.width
    foreground: root.foreground
    accent: root.accent
    placeholderText: "Optional"
    Accessible.name: "Display name"
    onAccepted: root.submit()
  }

  Text {
    text: "Launch command"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
  TextField {
    id: commandInput
    width: parent.width
    foreground: root.foreground
    accent: root.accent
    placeholderText: "Use the flag that sets this window class"
    Accessible.name: "Launch command"
    onAccepted: root.submit()
  }

  Text {
    text: "Slots"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
  TextField {
    id: slotsInput
    width: parent.width
    foreground: root.foreground
    accent: root.accent
    placeholderText: "Any slot, or a list such as 1, 3"
    Accessible.name: "Slots"
    onAccepted: root.submit()
  }

  Text {
    width: parent.width
    text: "Windows to restore in one tab group"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
  TextField {
    id: groupInput
    width: parent.width
    foreground: root.foreground
    accent: root.accent
    validator: IntValidator { bottom: 0; top: Model.MAX_GROUP_WINDOWS }
    inputMethodHints: Qt.ImhDigitsOnly
    Accessible.name: "Windows in one tab group"
    onAccepted: root.submit()
  }

  Text {
    width: parent.width
    text: "Zero disables tab restoration. A group uses the first slot. An empty command uses the installed app's launcher."
    color: Util.alpha(root.foreground, 0.75)
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  Text {
    width: parent.width
    visible: root.error !== ""
    text: root.error
    textFormat: Text.PlainText
    color: Commons.Color.urgent
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  Flow {
    width: parent.width
    spacing: Style.spacing.sm
    Button {
      id: saveButton
      focusable: true
      text: "Save pin"
      foreground: root.foreground
      accent: root.accent
      bordered: true
      onClicked: root.submit()
    }
    Button {
      id: cancelButton
      focusable: true
      text: "Cancel"
      foreground: root.foreground
      accent: root.accent
      onClicked: root.close()
    }
  }
}
