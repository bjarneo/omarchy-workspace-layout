# Repository guidance

## What lives where

| File | Role |
| --- | --- |
| `Model.js` | All logic: geometry, config document, Lua generation. No QML — `node --test` runs it directly. |
| `LayoutCanvas.qml` | The drag-to-resize editor. |
| `LayoutThumb.qml` | Non-interactive miniature, used by the bar icon and the chips. |
| `ConfigStore.qml` | The JSON document on disk, normalized on every read. |
| `HyprlandSync.qml` | Config document → live Hyprland, via the generated Lua and `hyprctl eval`. |
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
- `StdioCollector.text` is a property. `FileView.text()` is a function. Calling
  the collector's as a function throws inside the handler and the output is lost.

## Shell integration notes

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
