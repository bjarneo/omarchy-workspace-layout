# Repository guidance

## What lives where

| File | Role |
| --- | --- |
| `Model.js` | All logic: geometry, config document, Lua generation. No QML — `node --test` runs it directly. |
| `LayoutCanvas.qml` | The drag-to-resize editor. |
| `LayoutThumb.qml` | Non-interactive miniature, used by the bar icon and the chips. |
| `ConfigStore.qml` | The JSON document on disk, normalized on every read. |
| `HyprlandSync.qml` | Config document → live Hyprland, via the generated Lua and `hyprctl eval`. Also the one-shot app gather, which needs its own process: the sync queue is latest-wins and a pin fires both. |
| `Panel.qml` | The UI. Owns its own store and sync — see below. |
| `Service.qml` | Optional background sync for a bar-less install. |

## Two things that will bite you

**Three separate decisions, easy to conflate.** `fill` is *which slot* a window
goes to (widest first). `underfill` is *what happens to the slots* when there
are fewer windows than slots — `rescale` grows them, `hold` freezes them and
leaves gaps. `overflow` is where windows past the last slot go. `underfill`
defaults from the shape via `defaultUnderfill`: a layout whose widest slots are
all interior holds, everything else rescales. Deriving it rather than storing it
means a config written before the setting existed behaves correctly with no
migration.

**A Repeater fed a JavaScript array rebuilds every delegate when that array is
replaced.** A drag replaces `rects` and `dividers` on every frame, which
destroyed the very handle holding the mouse grab — the divider moved once and
the drag died. Every Repeater whose model changes during a drag takes a *count*
as its model and reads its own item out of the array by index. Watch for this
in anything new that binds a list to `config`.

**Slot numbers are fill order, and a pin's slot is the same number.** The canvas
labels each tile with its index in `slotRects()`, which is fill order, not
position — in a `25/50/25` the centre is 1. A pin's `slot` is an index into that
same list, so the number the user clicks in the canvas and the number the Lua
uses are the same thing, and neither side has to map between position and order.
Editing the *shape* is the exception: splitting or removing the slot behind a
tile means editing `weights` by position, which is what `rectSlotPositions`
maps back to.

**A drop rebuilds the shape from a tree, not by patching indices.**
`placeTree` turns weights, cells and pins into slots-of-parts-carrying-apps;
`movePlaceInto` edits that; `placeTreeToShape` turns it back and renumbers every
pin from the new fill order. Patching place numbers in place is the version of
this that looks simpler and silently scrambles the pins, because removing one
place renumbers all the others.

**Overflow is a drawing rule, and the panel writes it down.**
`growSelectedForWindows` grows the *edited* workspace's layout to hold the
windows actually open, following that layout's own overflow rule so the picture
does not jump (it shifts by less than the two decimals the document stores).
Only the selected workspace, never mid-drag, and through `editSelectedLayout`
so a preset forks first. It cannot loop: after growing, places equals windows.

**Dragging a stacked divider materialises the stack.** A slot showing three
windows because overflow put them there has no stored ratio, so the drag writes
one: `shapeSetCell` deliberately accepts a part count that differs from what is
stored. That is also why it cannot be used to validate a stale drag — the cap on
total places is the only guard left.

**A layout is three levels, and no more.** `weights` runs along the main axis;
`cells[i]` is that slot's parts, running across it; and a part may itself be
`{ weight, parts: [...] }`, divided back along the main axis. Slots → parts →
pieces, and nothing below that: a fourth level would make the panel a tree
editor, and `dropDirections` only says yes because three is enough to express
every edge of every place.
The plain count (`[1, 2]`) is accepted as shorthand and normalizes to the same
thing. Total places (`totalCells`, the sum of the lengths) is what MAX_SLOTS
caps, not the number of weights, and `cells[i].length` is the part count —
comparing `cells[i]` to a number is how `describeLayout` once printed "25×100".
Overflow stacking is the same mechanism (it adds parts to one slot, evened
out), which is why the two collapsed into one code path — and it counts
*places*, not parts, since a divided part is worth several. The fuzzer caught
that one. Every edit that
inserts or drops a slot has to move both arrays together, hence the `shape*`
functions.

**`evenWeights` caps at MAX_SLOTS; a stack does not.** Eleven windows in one
slot is eleven parts whatever the slot cap says, so the runtime builds those
with `evenCell`, which does not clamp. Reusing `evenWeights` there silently
drops rects past the eighth.

**Slot targeting is keyed by workspace *and* class.** `W.slots[ws][class]`, read
from `win.workspace.id` inside `recalculate`. Keyed by class alone, an app
pinned to slot 1 of one workspace claimed slot 1 of every other workspace it
opened on — which is how an app can arrive in the right workspace and the wrong
place. For the same reason a terminal app's generated class carries the
workspace (`omarchy.wsl.cliamp.ws8`): two pins of one program need two classes,
or the window rule cannot tell them apart.

**Three ways to name a place, and they are not the same.** A tile's number is
its index in fill order (what a pin stores). `rectSlotPositions` maps that to
the *positional* slot in `weights`, which is what a shape edit needs. And the
generated Lua keys slot targeting by window class. Mixing them up is the
easiest bug to write here.

**Slot order is not window order.** `ratioRects` builds cells in *positional*
order and then hands them out in *fill* order (widest slot first, ties by
position). Both halves are mirrored in Lua, and `fill_order` needs its explicit
index tiebreak because `table.sort` is unstable — without it, an even split
would reshuffle its windows on every recalculation.

**The geometry exists twice.** `slotRects()` in JavaScript draws the canvas;
`W.rects` in `LUA_RUNTIME` places the windows. They must agree exactly, so
neither may round: `exactNormalize` is used for geometry and `normalizeWeights`
only for storage. `tests/model.test.js` runs the generated Lua through the `lua`
interpreter and diffs both against each other across every preset and window
count from 1 to 12. Change one side, run the tests.

**`hyprctl eval` refuses a payload starting with `-`.** It reads the leading
dash as a flag and prints its usage instead, silently doing nothing. Lua comments
start with `--`, and the generated file opens with a banner. `Model.evalPayload`
wraps everything in `do … end` so the first character is always a letter. Do not
bypass `hyprctlEvalArgs`.

## Hyprland API notes

Established by probing 0.56.2; the Lua stubs are at `/usr/share/hypr/stubs/hl.meta.lua`.

- `hl.layout.register(name, { recalculate, layout_msg })` — the layout is then
  referenced as `lua:name`. Without the `lua:` prefix, Hyprland silently falls
  back to dwindle.
- Registering the same name twice raises. This file is re-run on every config
  reload, so registration is remembered in `_G` for the compositor's lifetime and
  behaviour updates through `W.specs` instead.
- Workspace rules accumulate; a second rule for a workspace does not retire the
  first, and `hyprctl workspaces` reports the stale one. Keep the handle and
  `:set_enabled(false)` the previous rule.
- Changing a spec does not re-tile anything. `hl.dispatch(hl.dsp.layout(msg))`
  reaches the *active* workspace's layout only, and raises on a workspace running
  a built-in — hence the `pcall` in `W.relayout`.
- `hl.window_rule({ ... })`'s `name` is a **label**, not the rule. The rule is
  sibling fields on the same table — `workspace = "9 silent"`, `float = true` —
  the way `/usr/share/hypr/hyprland.lua` writes them. A spec of
  `{ name = "workspace 9 silent", match = { class = "foot" } }` is accepted,
  returns a live handle, and does nothing at all.
- Learning a class from a launch pairs only on the app's own name appearing in
  the class. There is deliberately no "one launch, one new window, so they
  match" fallback: a keyring prompt appearing while an app starts stole a pin
  that way, and a wrong pin is worse than none.
- Window rules fire when a window opens. Pinning an app therefore needs a
  one-shot catch-up for what is already running: `hl.get_windows({ class = … })`
  and `hl.dsp.window.move({ workspace = n, window = win, follow = false })`.
  `follow = false` is the silent move — `silent = true` is accepted and ignored,
  and without it the view jumps to the destination workspace.
- Window rules accumulate like workspace rules do, but a deleted pin leaves no
  line behind to overwrite, so the generated file calls `W.reset_apps()` to
  disable every rule it owns before installing the current set.
- **`hl.get_windows({ class = … })` matches the class exactly — it is not a
  regex**, unlike the identically-named field on a window rule. Handing it the
  anchored pattern finds nothing and reports no error, which is why
  `gatherAppLua` asks for the plain classes from `slotKeys` instead.
- `hl.dsp.window.move({ workspace = n, window = w, follow = false })` moves one
  window silently. `silent = true` is accepted and ignored.
- `ctx.targets[i].window` in a layout's `recalculate` is the real `HL.Window`,
  so the layout can read `.class` and decide *which* window gets which rect.
  That is all slot targeting is: `W.assign` maps a targeted class to an index
  into the rects `W.rects` already returns. A class holds a *list* of indices,
  so the second window of an app takes the next one on its list — which is why
  the assignment is one pass claiming slots and a second pass filling gaps,
  rather than a per-window lookup.
- `StdioCollector.text` is a property. `FileView.text()` is a function. Calling
  the collector's as a function throws inside the handler and the output is lost.

## Shell integration notes

- `DesktopEntries.applications.values` starts **empty** and fills one entry at a
  time, each firing `valuesChanged` — a few hundred signals in a row. Read it
  once behind a debounce timer, not on every signal, and never assume it is
  populated in `Component.onCompleted`.
- A packaged entry's `startupClass` is sometimes the unexpanded substitution
  token (`@@startup_wm_class` on Chromium here). Fall back to the entry id, or
  the pin names a class no window will ever have.
- `KeyboardPanel.fittedContentHeight` clamps the card to what fits on screen; it
  does not scroll. Content taller than that needs a `QQC.ScrollView` inside the
  `PanelKeyCatcher`, and every MouseArea that drags — the canvas dividers —
  needs `preventStealing: true`, or the Flickable takes the grab mid-drag.
- **`\uXXXX` in QML takes exactly four hex digits.** A Nerd Font glyph above
  U+FFFF written as `"\uf0100"` silently becomes U+F010 followed by "0" — a
  magnifier and a zero where a camera was meant. Paste the literal character,
  the way the other icons in `Panel.qml` do.
- Two handlers for the same property (a second `Component.onCompleted`) is an
  error that stops the whole panel loading: *"Property value set multiple
  times"*. `qmllint` still exits 0; the tell is its warning count for the file
  collapsing, because analysis bails at that point.

- `omarchy plugin enable` places a bar widget; mounting a `service` kind needs an
  entry in shell.json's top-level `plugins[]`. A plugin declaring both, enabled
  normally, gets the widget and **not** the service. `Panel.qml` therefore does
  its own syncing and never assumes `Service.qml` is running.
- `omarchy-shell shell rescanPlugins` reloads plugin code but does not always
  re-instantiate a live bar widget. Use `omarchy restart shell` when testing
  anything that runs at construction.
- A `FileView` watching a path that does not exist yet can emit neither
  `onLoaded` nor `onLoadFailed`, so `ConfigStore` has a fallback timer. Without
  it, a first run never becomes ready and nothing downstream ever runs.
- **Omarchy's SUPER+L is a separate writer.** It persists
  `~/.local/state/omarchy/workspace-layouts/<id>.lua` and applies a workspace
  rule immediately. This plugin's generated file loads *after* those rules and
  used to overwrite them with whatever the JSON last said. `OmarchyToggleFollow`
  reads the directory (inotify + a startup `cat`) and writes Super+L's builtin
  into the active profile. A live write always wins; the startup scan will not
  steal a workspace that already has one of this plugin's layouts.

**Editing a shipped layout forks it.** `Panel.forkPreset` runs inside the same
`store.stage`/`store.mutate` as the edit, so the copy and the change land in one
write. The copy takes a random `custom-3f9a` id and the name "Custom" — random
because the fork happens mid-drag, against a document that is changing under
it. `isPreset` judges by **id**, not by content: comparing shapes sounds
cleverer, but then a preset edited last week is quietly no longer a preset and
the next drag rewrites it on every workspace using it. Judging by id also makes
the per-frame call safe, since a `custom-…` copy is never a preset.

**A terminal app is a command, not a window.** A `Terminal=true` desktop entry
run bare exits the moment it finds no tty, and run in a terminal its window
carries the terminal's class. Both are solved by asking the terminal for a
class of ours — but GTK refuses an app id without a dot, so `ghostty
--class=nvim` is silently ignored, and ghostty additionally hands a second
invocation to the running instance unless `--gtk-single-instance=false` is
passed. Hence `omarchy.wsl.<slug>`, and hence the pin carrying `command`: no
desktop entry mentions that class, so the pin is the only record of how to make
such a window again. Established by probing ghostty 1.2 here.

**Opening at login is claimed, not scheduled.** `autostartClaim` runs `mkdir`
in `$XDG_RUNTIME_DIR`, keyed by `HYPRLAND_INSTANCE_SIGNATURE`, and only the
process that creates the directory furnishes anything. Two monitors mean two
copies of `Panel.qml`, and `omarchy restart shell` builds fresh ones
mid-session — a timer alone would open everything twice on the first and reopen
what the user had closed on the second. The launch waits on a fresh
`hyprctl clients` read (`beginAutostart` → `refreshCounts`) because the window
poll only runs while the panel is open, and it waits on the terminal probe and
the desktop-entry catalogue, without which a pin has no command to run. It
lives in `Panel.qml` for the same reason the CLI does: that file is always
loaded, `Service.qml` is not.

## The command line

`Panel.qml`'s `IpcHandler` is the whole CLI, and it lives there rather than in
`Service.qml` because the panel is the copy of the document that is always
loaded. Two rules: every function takes what it acts on (nothing reads
`selectedWorkspace`, so a script behaves the same whether the panel is open or
not), and arguments are not optional — Quickshell enforces arity, so `pin` takes
three and callers pass `""` for no slots. A test asserts both.

## Validation

Run all three before committing:

```sh
node --test tests/model.test.js
/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell *.qml
omarchy plugin validate .
```

`qmllint` cannot resolve `qs.Commons` / `qs.Ui` outside Quickshell, so unresolved-
import warnings are expected — the first-party plugins produce the same ones.
Read it for syntax errors and genuine property mistakes.

## Manual check

The tests cover the model; they cannot prove Hyprland agrees. After a change to
the Lua or the sync path:

```sh
hyprctl eval 'hl.exec_cmd("foot", { workspace = "9 silent" })'   # ×3, an empty workspace
# assign a 25/50/25 layout to workspace 9 in the panel or the JSON
hyprctl -j clients | jq '[.[] | select(.workspace.id == 9) | .size[0]]'
```

On a 3072px-wide logical screen that must read `[754, 1512, 754]`. Close the test
windows afterwards.

For a pin, from a workspace that is *not* the destination:

```sh
# pin `foot` to workspace 9 in the panel's Apps row, then
hyprctl eval 'hl.exec_cmd("foot")'
hyprctl -j clients | jq -r '.[] | select(.class == "foot") | .workspace.id'
```

The new window must be on 9 and the active workspace must not have changed.
