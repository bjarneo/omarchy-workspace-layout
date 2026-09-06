# Features

Everything the plugin does, in one list.

- Use numeric or named workspaces for layouts, app pins, and startup entries
- Decide how a Hyprland workspace splits its screen, by dragging the dividers
  rather than resizing windows one at a time
- Save a shape as a layout, give it a name, and reuse it on any workspace
- Give a layout to one workspace, to every workspace on one monitor, or to all
  of them
- Save the whole arrangement as a profile and switch the lot when the work
  changes
- Pin an app to a workspace so it opens there wherever you launch it from,
  using a Hyprland window rule
- Pin an app to a numbered place, or to several places at once
- Put several apps in one place; whichever is open takes it
- Search every app installed on the machine, not just what is running
- Read names and launch commands from desktop entries
- One button opens everything the workspace is missing, one window per empty
  place
- Mark a workspace `at login` and it opens its own apps once per session, with
  no autostart entries to write
- Terminal apps like nvim and btop open in your terminal under a class the pin
  can match
- A pin corrects itself when a launch opens a window under a different class,
  as webapps and terminal apps do
- A pin remembers the command that opened it and the readable name of the app
- Windows an app already has are collected onto its workspace when you pin it
- Split a slot the other way, so a column becomes a top and a bottom
- Split that half again, three levels deep: columns, then rows, then columns
- Drag the divider at every level, including the one inside a split
- Dividers snap to halves, thirds, quarters, fifths and the golden ratio; hold
  Shift to drag free
- Extra windows become real places instead of a temporary stack while you work
  in the panel
- Editing a shipped layout makes a copy called custom-xxxx and leaves the
  original alone
- Capture builds a layout plus pins from the windows already on screen
- Drag one tile onto another and the two swap their apps
- Hold a tile near an edge and that half lights up; drop it there and the place
  splits, your app takes the half, and the place it came from disappears
- Hover a tile for two arrows that split it either way
- Right-click a tile to split, merge, remove, even out, clear its apps, or put
  an app in it
- Right-click a workspace to hand it back to Hyprland, capture it, or clear its
  apps
- App names are drawn inside the tiles they live in
- The tile you are carrying follows the cursor with its name and target
- The bar icon is a live miniature of the layout the focused workspace is
  running
- Clicking a workspace takes you to it
- The panel scrolls when it grows taller than the screen
- Restore defaults puts back the shipped layouts, one profile, and every
  workspace on Hyprland's own tiling
- Sixteen command-line commands: status, workspace, json, profiles, apply,
  layouts, set, reset, pin, unpin, capture, launch, open, close, show, hide,
  toggle
- The config is plain JSON you can edit by hand, and it reloads within a second
- Anything malformed in it is repaired rather than refused

See [cli.md](cli.md) for what each command prints, and the
[README](../README.md) for how the panel is used.
