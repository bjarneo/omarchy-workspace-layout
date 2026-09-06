# Command line

Every panel action has a command behind it. The panel answers on the shell's
IPC bus whether or not it is on screen, so these work from a script, a
keybinding, or a terminal:

```bash
omarchy-shell workspace-layout <command> [arguments]
```

Nothing reads the panel's own selection — each command takes what it acts on —
so a script behaves the same whether the panel is open, closed, or has never
been opened.

**Arguments are not optional.** The shell checks the count before the command
runs, so `pin` always takes three; pass `""` when an app should land anywhere
rather than in a particular place.

Workspace arguments accept a number such as `9` or a named selector such as
`name:code`. Quote selectors that contain spaces. Special workspaces are excluded.

```bash
omarchy-shell workspace-layout workspace name:code
omarchy-shell workspace-layout set name:code golden
```

## Reading

### `status`

One line per workspace worth mentioning — one the plugin is tiling, one with
apps pinned to it, or the one you are looking at, which is marked `*`.

```
$ omarchy-shell workspace-layout status
* workspace 2 · Hyprland dwindle · from profile default · profile default
  workspace 9 · Even (50 / 50×2) · from workspace · profile default · apps Foot@1,2,3
  workspace 10 · Main right (44 / 56) · from workspace · profile default · apps Discord signal
```

`from` says *why* a workspace tiles the way it does: its own choice, the
monitor's default, or the profile falling back. A workspace marked `at login`
in the panel says `opens at login` at the end of its line.

### `workspace <n>`

The same line for one workspace, whether or not it is worth mentioning.

```
$ omarchy-shell workspace-layout workspace 9
workspace 9 · Even (50 / 50×2) · from workspace · profile default · apps Foot@1,2,3
```

### `json`

The whole picture, including how each workspace resolves right now — which the
config file cannot tell you, because it depends on which monitor a workspace is
on at the time.

The `workspace` field remains a number for numeric workspaces. Named workspaces
use a `name:<workspace>` string.

```bash
omarchy-shell workspace-layout json | jq '.workspaces[] | select(.builtin == false)'
```

```jsonc
{
  "profile": "default",
  "profiles": ["default", "focus"],
  "fallback": "dwindle",
  "monitors": { "DP-2": "wide-centre" },
  "workspaces": [
    { "workspace": 9, "monitor": "eDP-1", "layout": "even",
      "name": "Even", "builtin": false, "places": 3, "autostart": true }
  ],
  "layouts": [
    { "id": "even", "name": "Even", "kind": "ratio", "orientation": "columns",
      "weights": [50, 50], "cells": [[100], [50, 50]], "places": 3 }
  ],
  "pins": [
    { "match": "foot", "workspace": "9", "slots": [1, 2, 3], "name": "Foot" }
  ]
}
```

### `profiles` · `layouts`

```
$ omarchy-shell workspace-layout profiles
* default
  focus

$ omarchy-shell workspace-layout layouts
dwindle	Dwindle	Hyprland
even	Even	50 / 50×2
focus	Focus	25 / 50 / 25
```

`layouts` prints id, name and shape, tab separated. A `×2` means that slot is
split across the grain and holds two windows.

## Changing

### `apply <profile>`

Switch profile. Every workspace re-tiles at once.

```
$ omarchy-shell workspace-layout apply focus
profile focus
```

### `set <workspace> <layout>`

Give one workspace a layout, by id. `dwindle`, `master` and `scrolling` hand it
to Hyprland's own tiling.

```
$ omarchy-shell workspace-layout set 3 wide-centre
workspace 3 uses wide-centre
```

### `reset <workspace>`

Hand one workspace back to Hyprland, apps and all — the layout goes, and so do
the pins aimed at it and its `at login` mark. The rest of the profile is
untouched.

```
$ omarchy-shell workspace-layout reset 3
workspace 3 handed back to Hyprland
```

### `pin <app> <workspace> <slots>`

Send an app to a workspace, optionally into particular places. `<app>` is a
window class; `hyprctl clients | grep class` names anything you cannot guess.
Slots are the numbers the canvas draws, and an app may hold several.

```
$ omarchy-shell workspace-layout pin ghostty 3 "1,3"
ghostty opens on workspace 3 in slot 1,3

$ omarchy-shell workspace-layout pin signal 9 ""
signal opens on workspace 9
```

Windows the app already has are collected onto the workspace as the pin is
made; after that they are yours to move.

### `unpin <app>`

```
$ omarchy-shell workspace-layout unpin ghostty
ghostty released
```

### `capture <workspace>`

Read the workspace back into a layout: the shape its windows are already in
becomes a new layout assigned to it, and every app is pinned to the place it
was in. Two windows of the same app become two places on one pin.

```
$ omarchy-shell workspace-layout capture 9
captured workspace 9
```

### `launch <workspace>`

Open what the workspace is short of: for every app pinned there, one window per
place it was given, minus the windows it already has. Apps with no launcher and
no remembered command are skipped — there is nothing to run.

A `Terminal=true` app (`nvim`, `btop`, a TUI player) is opened in your terminal
under a window class of the plugin's own, so the pin can place it; the class and
the command are then remembered on the pin. The first launch teaches it, and the
ones after put the app straight in its place.

```
$ omarchy-shell workspace-layout launch 9
opening Foot ×3, Signal on workspace 9
```

This is exactly what the panel's `at login → open these` does for you a few
seconds into a session. Driving it from Hyprland instead means waiting for the
shell to come up first — the command answers on its bus — so the panel's own
setting is the easier of the two:

```lua
-- ~/.config/hypr/autostart.lua
o.exec_on_start("sleep 5; omarchy-shell workspace-layout launch 1")
```

## The panel

```bash
omarchy-shell workspace-layout toggle   # or open / close / show / hide
```

Bind it in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + ALT + L", "Workspace layout", "omarchy-shell workspace-layout toggle")
```

## Scripting a desk

```bash
#!/bin/bash
# Set up the machine the way Monday morning wants it.
wsl() { omarchy-shell workspace-layout "$@"; }

wsl apply work
wsl set 1 wide-centre
wsl pin chromium 1 "1"
wsl pin ghostty 2 "1,2"
wsl launch 1
wsl launch 2
```
