# Workspace Layout

An Omarchy plugin for deciding how a Hyprland workspace splits its screen.

Drag the dividers and your real windows move under the cursor. `25 / 50 / 25`,
a `60 / 40` main-and-side, thirds, a grid, or whatever you drag to. Name a shape
and reuse it. Give a shape to one workspace or to all of them. Save the whole
arrangement as a profile and switch the lot when the work changes.

![The panel](screenshots/panel.png)

## Why it is not just a script

Hyprland 0.55 gained Lua-defined tiling layouts. This plugin registers one per
layout you create and assigns them with workspace rules, so the split is a
property of the workspace rather than a resize you have to redo every time a
window opens. Close a window and the rest reflow into the shape. Open a fifth
one and it stacks where you said extras should go.

## Requirements

| Needs | Why |
| --- | --- |
| Omarchy (Quattro plugin runtime) | the bar widget and panel are Quickshell QML loaded by `omarchy-shell` |
| Hyprland 0.55 or newer | `hl.layout.register`, the Lua layout API the whole plugin is built on |
| `hyprctl` | on `PATH`; how layouts and workspace rules are applied |

No other runtime, package, background service, network access, or privileged
command. Everything ships in this repository: the panel is QML, the layout
engine is Lua generated from `Model.js`, and there is no compiled component.

Built and tested against Hyprland 0.56.2 on Omarchy 4.0.2.

## Install

```bash
omarchy plugin add https://github.com/bjarneo/omarchy-workspace-layout --enable
```

Or, from a clone:

```bash
cp -r omarchy-workspace-layout ~/.config/omarchy/plugins/bjarneo.workspace-layout
omarchy plugin enable bjarneo.workspace-layout right
omarchy restart shell
```

On first run the plugin appends one guarded line to `~/.config/hypr/hyprland.lua`
that loads its generated layouts. Nothing is assigned to any workspace until you
pick something, so installing it changes nothing about how your desktop tiles.

## Using it

Click the bar icon — it is a live miniature of the current workspace's layout.

**Workspace strip.** Every workspace with the shape it is running. Click one to
edit it, double-click to jump there.

**Canvas.** The layout at your monitor's real proportions. Slots holding a window
are filled and numbered; empty slots are outlined. Drag a divider and the windows
move as you drag — nothing is written to disk until you let go. Dividers snap to
halves, thirds, quarters, fifths and the golden ratio; hold `Shift` to drag free.
Double-click a divider to even everything out.

**Shape row.** Add or remove a slot, flip between columns and rows, split evenly,
and choose where windows past the last slot go:

| Setting | With 5 windows in a 3-slot layout |
| --- | --- |
| `extra → stack last` | slots 1 and 2 take one window, slot 3 stacks three |
| `extra → stack first` | slot 1 stacks three, slots 2 and 3 take one each |
| `extra → new slots` | five slots, the new ones as wide as the last |

**With fewer windows than slots**, `fewer → rescale` grows the surviving slots
to fill the screen, and `fewer → keep place` leaves every slot exactly where it
would be when full. `Focus` and `Wide centre` ship on *keep place*, which is what
makes them useful: one window sits in the middle 50% with margins either side
and stays there as the second and third arrive, instead of blowing up to
fullscreen and then sliding off-centre. Layouts without a main area — `Even`,
`Thirds`, `Main` — rescale, so a lone window fills the screen.

**Which slot fills first.** The widest one. In a `25/50/25` the first window on
the workspace takes the centre and later windows go out to the sides; in a
`60/40` it takes the 60. Slots of equal width fill left to right, so an even
split or thirds behaves exactly as it reads. The slot numbers in the canvas show
the order. To fill strictly left to right instead, set `"fill": "order"` on the
layout in the JSON.

**Layouts.** Your library, plus Hyprland's own `Dwindle`, `Master` and
`Scrolling` for handing a workspace back. `Give it to` decides whether clicking
a layout claims the selected workspace or becomes the default every workspace
falls back to. Rename in the field below; `＋` starts a new one, `󰆏` duplicates
the current one so you can diverge from a shape you like.

**Profiles.** A profile is the whole picture: the default layout plus every
per-workspace exception. Switch and every workspace re-tiles at once. `＋` copies
the current profile under a new name.

Editing a layout edits it everywhere it is used. Duplicate first if you want one
workspace to differ.

### Keys

Press `?` in the panel for this list.

| Key | Does |
| --- | --- |
| `←` `→` | select a workspace |
| `↑` `↓` | change its layout |
| `[` `]` | move the divider (`{` `}` finer) |
| `1`…`8` | pick which divider the brackets move |
| `+` `-` | add or remove a slot |
| `r` | columns ⇄ rows |
| `o` | where extra windows go |
| `f` | with fewer windows: keep place or rescale |
| `0` | split evenly |
| `Esc` | close |

### A keybinding

The panel answers on the shell's IPC bus, so bind it in
`~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + ALT + L", "Workspace layout", "omarchy-shell workspace-layout toggle")
```

`SUPER + ALT + L` is unbound in a stock Omarchy install.

## Files

| Path | What |
| --- | --- |
| `~/.config/omarchy/workspace-layout.json` | your layouts and profiles — edit it by hand, it reloads |
| `~/.config/hypr/omarchy-workspace-layout.lua` | generated; rewritten from the JSON, never edit |
| `~/.config/hypr/hyprland.lua` | gains one guarded `dofile` line on first run |

The JSON is the source of truth and safe to keep in dotfiles. A hand-edit applies
within a second. Anything malformed is repaired rather than refused, so you
cannot end up with no layouts.

To run it without a bar widget, add `"bjarneo.workspace-layout"` to the top-level
`plugins[]` array in `~/.config/omarchy/shell.json`; the background service then
keeps the JSON applied on its own.

## Removing it

```bash
omarchy plugin remove bjarneo.workspace-layout
rm ~/.config/hypr/omarchy-workspace-layout.lua
```

Delete the `dofile` line from `~/.config/hypr/hyprland.lua` when convenient — it
checks the file exists first, so leaving it does no harm. Workspaces return to
`general:layout` on the next Hyprland reload.

## Known limits

- **Mouse-resizing a window does not change the split.** Hyprland's Lua layout
  interface has no resize hook, so `SUPER` + right-drag does nothing inside these
  layouts. Drag the panel's dividers, or use `[` and `]`. Ratios set that way are
  named and saved, which the mouse gesture never was.
- **Integer workspaces only.** Named and special workspaces (`special:scratchpad`)
  are left alone, because a rule keyed by name would not survive a rename.

## Development

```bash
node --test tests/model.test.js
/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell *.qml
omarchy plugin validate .
```

`Model.js` holds the layout geometry, the config document, and the Lua generator,
with no QML in it, so the tests run the same code the panel does. The geometry
lives twice — once in JavaScript for the canvas, once in Lua for Hyprland — and
`tests/model.test.js` runs the generated Lua through the `lua` interpreter and
diffs it against the JavaScript rectangle for rectangle. If the preview and the
compositor ever disagree, that test fails first.

## License

MIT. See [LICENSE](LICENSE).
