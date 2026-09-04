// Pure logic for the Workspace Layout plugin: the layout geometry, the config
// document, and the Lua that teaches Hyprland to tile the way the panel draws.
//
// Nothing in here imports QML or touches the filesystem, so `node --test`
// exercises the same code the panel runs. The geometry in `slotRects()` is
// mirrored by `LUA_RUNTIME` below; tests/model.test.js runs the real Lua
// through the `lua` interpreter and compares it rect for rect, which is what
// keeps the panel preview honest about what Hyprland will actually do.

// --------------------------------------------------------------- constants

// A slot narrower than this is a sliver nobody can use, and Hyprland's gaps
// and borders would eat most of it. Drags clamp here rather than at zero.
var MIN_WEIGHT = 5

// Past eight slots a ratio layout stops being a layout and starts being a
// grid; the panel offers `grid` for that case.
var MAX_SLOTS = 8

// Cumulative divider positions that are worth landing exactly on. Thirds and
// the golden ratio are irrational in percent terms, so a free drag would
// otherwise settle on 33 or 62 and quietly stay wrong.
var SNAP_POINTS = [
  20, 25, 100 / 3, 37.5, 38.2, 40, 50,
  60, 61.8, 62.5, 200 / 3, 75, 80
]
var SNAP_TOLERANCE = 1.6

// ------------------------------------------------------------------ number

function isFiniteNumber(value) {
  var n = Number(value)
  return typeof n === "number" && isFinite(n)
}

function clamp(value, low, high) {
  if (!isFiniteNumber(value)) return low
  return Math.min(high, Math.max(low, Number(value)))
}

// Percentages are stored as floats but compared and displayed at 0.01
// resolution, so that `25 / 50 / 25` round-trips through a drag unchanged.
function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

// ----------------------------------------------------------------- weights

// Weights are always stored normalized to sum to 100, so a weight *is* a
// percentage. Every entry point funnels through here, which means the panel
// never has to ask "relative to what?".
function normalizeWeights(weights, count) {
  var raw = []
  var i
  if (weights instanceof Array) {
    for (i = 0; i < weights.length; i++) {
      var n = Number(weights[i])
      raw.push(isFiniteNumber(n) && n > 0 ? n : MIN_WEIGHT)
    }
  }
  if (isFiniteNumber(count) && count > 0) {
    while (raw.length < count) raw.push(100 / count)
    raw = raw.slice(0, count)
  }
  if (raw.length === 0) return [100]
  if (raw.length > MAX_SLOTS) raw = raw.slice(0, MAX_SLOTS)

  var total = 0
  for (i = 0; i < raw.length; i++) total += raw[i]
  if (total <= 0) return evenWeights(raw.length)

  var scaled = []
  for (i = 0; i < raw.length; i++) scaled.push(round2(raw[i] * 100 / total))
  return repairSum(scaled)
}

// Rounding each weight independently can drift the sum off 100 by a few
// hundredths. Push the remainder into the widest slot, where it is invisible,
// instead of letting the drift accumulate across edits.
function repairSum(weights) {
  var out = weights.slice()
  var total = 0
  var widest = 0
  for (var i = 0; i < out.length; i++) {
    total += out[i]
    if (out[i] > out[widest]) widest = i
  }
  var drift = round2(100 - total)
  if (drift !== 0) out[widest] = round2(out[widest] + drift)
  return out
}

// Geometry normalization, as opposed to the storage normalization above: no
// rounding and no drift repair, because this has to agree with the Lua bit for
// bit. Rounding here is what would make the panel preview and the compositor
// disagree in the fourth decimal place.
function exactNormalize(weights) {
  var total = 0
  var i
  for (i = 0; i < weights.length; i++) total += weights[i]

  var out = []
  if (total <= 0) {
    for (i = 0; i < weights.length; i++) out.push(100 / weights.length)
    return out
  }
  for (i = 0; i < weights.length; i++) out.push(weights[i] * 100 / total)
  return out
}

// The order slots get filled in, as slot indices. Widest first, so the first
// window on a workspace lands in the layout's main area rather than in a
// 25% sliver at the edge — in a 25/50/25 that means the centre. Ties keep
// positional order, so an even split still fills left to right.
//
// Compared explicitly rather than leaning on a stable sort: Lua's table.sort
// is not stable, and this has to match the Lua exactly.
function fillOrder(weights) {
  var index = []
  for (var i = 0; i < weights.length; i++) index.push(i)
  index.sort(function(a, b) {
    if (weights[b] !== weights[a]) return weights[b] - weights[a]
    return a - b
  })
  return index
}

// Whether a layout should hold its slots in place when it is not full.
//
// A layout whose widest slots are all interior was drawn to put something in
// the middle — a 25/50/25, a 20/60/20. Rescaling that down to one window blows
// it up to fullscreen and down to two slides the main slot off to one side,
// which is the opposite of what it is for. A layout whose main slot is against
// an edge (60/40, golden) has no centre to lose, and an even split has no main
// slot at all, so both grow to fill the screen instead.
//
// Only the default: an explicit "hold" or "rescale" in the document wins.
function defaultUnderfill(weights) {
  if (!(weights instanceof Array) || weights.length < 3) return "rescale"

  var widest = weights[0]
  var i
  for (i = 1; i < weights.length; i++) if (weights[i] > widest) widest = weights[i]
  if (weights[0] === widest || weights[weights.length - 1] === widest) return "rescale"
  return "hold"
}

function evenWeights(count) {
  var n = Math.max(1, Math.min(MAX_SLOTS, Math.round(Number(count) || 1)))
  var out = []
  for (var i = 0; i < n; i++) out.push(round2(100 / n))
  return repairSum(out)
}

// Cumulative edges between slots — what the user actually grabs in the canvas.
// A layout with k slots has k-1 dividers.
function dividerPositions(weights) {
  var w = normalizeWeights(weights)
  var out = []
  var running = 0
  for (var i = 0; i < w.length - 1; i++) {
    running += w[i]
    out.push(round2(running))
  }
  return out
}

// Snap to the *nearest* candidate, not the first one in range: 61.2 sits
// inside the tolerance of both 60 and 61.8, and the golden ratio is the one
// the user was reaching for.
function snapPosition(position, enabled) {
  if (enabled === false) return position

  var best = position
  var bestDistance = SNAP_TOLERANCE
  for (var i = 0; i < SNAP_POINTS.length; i++) {
    var distance = Math.abs(position - SNAP_POINTS[i])
    if (distance <= bestDistance) {
      bestDistance = distance
      best = SNAP_POINTS[i]
    }
  }
  return best
}

// Move one divider to an absolute position, leaving every other divider where
// it is. Only the two slots either side of the divider change, which is what
// makes dragging feel local rather than like re-solving the whole row.
function setDivider(weights, index, position, options) {
  var w = normalizeWeights(weights)
  if (index < 0 || index >= w.length - 1) return w

  var opts = options || {}
  var edges = dividerPositions(w)
  var lower = (index === 0 ? 0 : edges[index - 1]) + MIN_WEIGHT
  var upper = (index === edges.length - 1 ? 100 : edges[index + 1]) - MIN_WEIGHT

  var target = snapPosition(Number(position), opts.snap)
  target = clamp(target, lower, Math.max(lower, upper))

  var previous = index === 0 ? 0 : edges[index - 1]
  var next = index === edges.length - 1 ? 100 : edges[index + 1]

  var out = w.slice()
  out[index] = round2(target - previous)
  out[index + 1] = round2(next - target)
  return repairSum(out)
}

// Adding a slot takes room from the widest one rather than rescaling
// everything, so the shape the user built stays recognizable.
function addSlot(weights) {
  var w = normalizeWeights(weights)
  if (w.length >= MAX_SLOTS) return w

  var widest = 0
  for (var i = 1; i < w.length; i++) if (w[i] > w[widest]) widest = i

  var share = w[widest] / 2
  if (share < MIN_WEIGHT) return evenWeights(w.length + 1)

  var out = w.slice()
  out[widest] = round2(share)
  out.splice(widest + 1, 0, round2(share))
  return repairSum(out)
}

// Removing a slot hands its space to the neighbour on the left (or the right
// for the first slot) — the same rule a tiling WM uses when a window closes.
function removeSlot(weights, index) {
  var w = normalizeWeights(weights)
  if (w.length <= 1) return w

  var at = isFiniteNumber(index) ? clamp(Math.round(index), 0, w.length - 1) : w.length - 1
  var absorber = at === 0 ? 1 : at - 1

  var out = w.slice()
  out[absorber] = round2(out[absorber] + out[at])
  out.splice(at, 1)
  return repairSum(out)
}

// ---------------------------------------------------------------- geometry

// Where each window goes, in 0..1 fractions of the workspace's usable area.
// Returned in window order: element i is for the i-th window Hyprland hands
// the layout. Mirrored exactly by `wsl_rects` in LUA_RUNTIME.
function slotRects(layout, windowCount) {
  var n = Math.max(0, Math.round(Number(windowCount) || 0))
  if (n === 0) return []

  var spec = normalizeLayout(layout)
  if (spec.kind === "grid") return gridRects(spec, n)
  return ratioRects(spec, n)
}

function ratioRects(spec, n) {
  var weights = spec.weights
  var k = weights.length

  var primary
  var stackAt = -1
  var stackCount = 0
  var i

  if (n <= k && spec.underfill === "hold") {
    // Hold: every slot keeps the position it would have when full, and the
    // slots without a window in them stay empty. This is what keeps a centred
    // layout centred — rescaling a 25/50/25 down to one window would blow it
    // up to fullscreen, and down to two would slide the main slot off to one
    // side, which is the opposite of what the layout was drawn for.
    primary = weights.slice()
  } else if (n <= k) {
    // Rescale: keep the slots that matter most and grow them to fill the
    // screen. Picking by priority rather than by position is what puts a lone
    // window in the main area instead of the leftmost sliver.
    var chosen = fillOrder(weights).slice(0, n)
    chosen.sort(function(a, b) { return a - b })
    primary = []
    for (i = 0; i < chosen.length; i++) primary.push(weights[chosen[i]])
  } else if (spec.overflow === "extend") {
    primary = weights.slice()
    // New slots inherit the last slot's width, so a main/stack layout grows
    // its stack instead of squeezing the main window.
    while (primary.length < n) primary.push(weights[k - 1])
  } else {
    primary = weights.slice()
    stackAt = spec.overflow === "first" ? 0 : k - 1
    stackCount = n - k + 1
  }

  primary = exactNormalize(primary)

  // Cells in positional order — reading order on screen. The overflow slot
  // expands into several; every other slot is one cell.
  var cells = []
  var cellSlot = []
  var offset = 0
  for (var slot = 0; slot < primary.length; slot++) {
    var size = primary[slot] / 100
    if (slot === primary.length - 1) size = 1 - offset  // absorb rounding drift
    if (slot === stackAt) {
      for (var s = 0; s < stackCount; s++) {
        var subOffset = s / stackCount
        var subSize = (s === stackCount - 1) ? 1 - subOffset : 1 / stackCount
        cells.push(orient(spec.orientation, offset, size, subOffset, subSize))
        cellSlot.push(slot)
      }
    } else {
      cells.push(orient(spec.orientation, offset, size, 0, 1))
      cellSlot.push(slot)
    }
    offset += size
  }

  // Windows are handed out in fill order; a slot holding a stack gives up its
  // cells top to bottom before the next slot gets one.
  var order = []
  if (spec.fill === "order") {
    for (i = 0; i < primary.length; i++) order.push(i)
  } else {
    order = fillOrder(primary)
  }

  var rects = []
  for (i = 0; i < order.length; i++) {
    for (var c = 0; c < cells.length; c++) {
      if (cellSlot[c] === order[i]) rects.push(cells[c])
    }
  }
  // Under "hold" there are more cells than windows; the surplus are the empty
  // slots, and they are last because the list is in fill order.
  return rects.slice(0, n)
}

// A ratio layout is one-dimensional; `orientation` decides whether that
// dimension is x or y. Splitting the two apart here means the stacking,
// overflow, and drag code never has to branch on it.
function orient(orientation, mainOffset, mainSize, crossOffset, crossSize) {
  if (orientation === "rows") {
    return { x: crossOffset, y: mainOffset, w: crossSize, h: mainSize }
  }
  return { x: mainOffset, y: crossOffset, w: mainSize, h: crossSize }
}

// A short final row stretches to fill the width rather than leaving a ragged
// edge — five windows in a 3-wide grid read better as 3 + 2 than 3 + 2 + hole.
function gridRects(spec, n) {
  var columns = spec.gridColumns > 0
    ? Math.min(spec.gridColumns, n)
    : Math.ceil(Math.sqrt(n))
  var rows = Math.ceil(n / columns)

  var rects = []
  for (var row = 0; row < rows; row++) {
    var first = row * columns
    var inRow = Math.min(columns, n - first)
    for (var col = 0; col < inRow; col++) {
      rects.push({
        x: col / inRow,
        y: row / rows,
        w: (col === inRow - 1 ? 1 : (col + 1) / inRow) - col / inRow,
        h: (row === rows - 1 ? 1 : (row + 1) / rows) - row / rows
      })
    }
  }
  return rects
}

// ------------------------------------------------------------------ layout

// Names are user text that ends up inside a Lua comment in the generated file
// and inside tooltips. A newline would end the comment early and turn the rest
// of the name into code, so collapse every control character to a space.
function sanitizeName(value, fallback) {
  var name = String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^ +| +$/g, "")
    .slice(0, 40)
    .replace(/ +$/, "")
  return name.length > 0 ? name : fallback
}

function slugify(name) {
  var slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug.length > 0 ? slug : "layout"
}

function uniqueLayoutId(config, base) {
  var slug = slugify(base)
  var taken = {}
  var layouts = (config && config.layouts instanceof Array) ? config.layouts : []
  for (var i = 0; i < layouts.length; i++) taken[String(layouts[i].id)] = true
  if (!taken[slug]) return slug
  var suffix = 2
  while (taken[slug + "-" + suffix]) suffix++
  return slug + "-" + suffix
}

function normalizeLayout(raw) {
  var input = (raw && typeof raw === "object") ? raw : {}
  var kind = input.kind === "grid" ? "grid" : "ratio"
  var orientation = input.orientation === "rows" ? "rows" : "columns"
  var overflow = input.overflow === "first" || input.overflow === "extend"
    ? input.overflow : "last"
  var fill = input.fill === "order" ? "order" : "largest"
  var weights = normalizeWeights(input.weights)
  var underfill = input.underfill === "hold" || input.underfill === "rescale"
    ? input.underfill
    : defaultUnderfill(weights)

  return {
    id: slugify(input.id || input.name || "layout"),
    name: sanitizeName(input.name || input.id, "Layout"),
    kind: kind,
    orientation: orientation,
    overflow: overflow,
    fill: fill,
    underfill: underfill,
    weights: weights,
    gridColumns: clamp(Math.round(Number(input.gridColumns) || 0), 0, MAX_SLOTS)
  }
}

// "25 / 50 / 25" — the layout's shape as a line of text, for tooltips and the
// layout list where drawing a thumbnail would be too much.
function describeLayout(layout) {
  var spec = normalizeLayout(layout)
  if (spec.kind === "grid") {
    return spec.gridColumns > 0 ? spec.gridColumns + "-column grid" : "auto grid"
  }
  var parts = []
  for (var i = 0; i < spec.weights.length; i++) parts.push(formatWeight(spec.weights[i]))
  return parts.join(" / ") + (spec.orientation === "rows" ? "  (rows)" : "")
}

function formatWeight(weight) {
  var n = Number(weight)
  var rounded = Math.round(n)
  return Math.abs(n - rounded) < 0.5 ? String(rounded) : n.toFixed(1)
}

// ----------------------------------------------------------------- presets

// The starting library. Every one of these is a plain layout document, so a
// preset the user tweaks is indistinguishable from one they built themselves.
var PRESETS = [
  { id: "even", name: "Even", kind: "ratio", orientation: "columns", overflow: "extend", weights: [50, 50] },
  { id: "focus", name: "Focus", kind: "ratio", orientation: "columns", overflow: "last", weights: [25, 50, 25] },
  { id: "main", name: "Main", kind: "ratio", orientation: "columns", overflow: "last", weights: [60, 40] },
  { id: "main-right", name: "Main right", kind: "ratio", orientation: "columns", overflow: "first", weights: [40, 60] },
  { id: "golden", name: "Golden", kind: "ratio", orientation: "columns", overflow: "last", weights: [61.8, 38.2] },
  { id: "thirds", name: "Thirds", kind: "ratio", orientation: "columns", overflow: "extend", weights: [100 / 3, 100 / 3, 100 / 3] },
  { id: "wide-centre", name: "Wide centre", kind: "ratio", orientation: "columns", overflow: "last", weights: [20, 60, 20] },
  { id: "stacked", name: "Stacked", kind: "ratio", orientation: "rows", overflow: "last", weights: [50, 50] },
  { id: "grid", name: "Grid", kind: "grid", orientation: "columns", overflow: "last", weights: [50, 50], gridColumns: 0 }
]

function presets() {
  var out = []
  for (var i = 0; i < PRESETS.length; i++) out.push(normalizeLayout(PRESETS[i]))
  return out
}

// ------------------------------------------------------------------ config

// Layout ids that mean "hand this workspace back to Hyprland".
var BUILTIN_LAYOUTS = ["dwindle", "master", "scrolling"]

function isBuiltin(id) {
  return BUILTIN_LAYOUTS.indexOf(String(id)) !== -1
}

function defaultConfig() {
  return normalizeConfig({
    version: 1,
    activeProfile: "default",
    profiles: [{ name: "default", fallback: "dwindle", assignments: {} }],
    layouts: presets()
  })
}

function normalizeConfig(raw) {
  var input = (raw && typeof raw === "object") ? raw : {}

  var layouts = []
  var seen = {}
  var rawLayouts = (input.layouts instanceof Array) ? input.layouts : []
  for (var i = 0; i < rawLayouts.length; i++) {
    var layout = normalizeLayout(rawLayouts[i])
    if (seen[layout.id] || isBuiltin(layout.id)) continue
    seen[layout.id] = true
    layouts.push(layout)
  }
  if (layouts.length === 0) layouts = presets()

  var profiles = []
  var profileNames = {}
  var rawProfiles = (input.profiles instanceof Array) ? input.profiles : []
  for (i = 0; i < rawProfiles.length; i++) {
    var profile = normalizeProfile(rawProfiles[i], layouts)
    if (profileNames[profile.name]) continue
    profileNames[profile.name] = true
    profiles.push(profile)
  }
  if (profiles.length === 0) {
    profiles = [normalizeProfile({ name: "default", fallback: "dwindle" }, layouts)]
  }

  var active = String(input.activeProfile || "")
  if (!profileNames[active]) active = profiles[0].name

  return {
    version: 1,
    activeProfile: active,
    bindings: input.bindings === true,
    profiles: profiles,
    layouts: layouts
  }
}

function normalizeProfile(raw, layouts) {
  var input = (raw && typeof raw === "object") ? raw : {}
  var known = {}
  for (var i = 0; i < layouts.length; i++) known[layouts[i].id] = true

  var assignments = {}
  var rawAssignments = (input.assignments && typeof input.assignments === "object")
    ? input.assignments : {}
  for (var key in rawAssignments) {
    var workspace = normalizeWorkspaceId(key)
    if (workspace === null) continue
    var value = String(rawAssignments[key])
    // A layout that was deleted out from under a profile silently reverts to
    // the fallback rather than pinning the workspace to a layout that is gone.
    if (!known[value] && !isBuiltin(value)) continue
    assignments[workspace] = value
  }

  var fallback = String(input.fallback || "dwindle")
  if (!known[fallback] && !isBuiltin(fallback)) fallback = "dwindle"

  return {
    name: sanitizeName(input.name, "default"),
    fallback: fallback,
    assignments: assignments
  }
}

// Hyprland workspace ids are integers; named and special workspaces are out of
// scope because a workspace rule keyed by name would not survive a rename.
function normalizeWorkspaceId(value) {
  var n = Number(value)
  if (!isFiniteNumber(n)) return null
  n = Math.round(n)
  if (n < 1 || n > 99) return null
  return String(n)
}

function findLayout(config, id) {
  var layouts = (config && config.layouts instanceof Array) ? config.layouts : []
  for (var i = 0; i < layouts.length; i++) {
    if (layouts[i].id === String(id)) return layouts[i]
  }
  return null
}

function findProfile(config, name) {
  var profiles = (config && config.profiles instanceof Array) ? config.profiles : []
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].name === String(name)) return profiles[i]
  }
  return null
}

function activeProfile(config) {
  return findProfile(config, config && config.activeProfile) ||
    ((config && config.profiles instanceof Array && config.profiles.length > 0)
      ? config.profiles[0] : normalizeProfile({}, []))
}

// What layout a workspace resolves to right now — an explicit assignment if it
// has one, the profile's fallback otherwise.
function layoutIdForWorkspace(config, workspaceId) {
  var profile = activeProfile(config)
  var key = normalizeWorkspaceId(workspaceId)
  if (key !== null && profile.assignments[key]) return profile.assignments[key]
  return profile.fallback
}

function uniqueProfileName(config, base) {
  var name = sanitizeName(base, "profile")
  if (!findProfile(config, name)) return name
  var suffix = 2
  while (findProfile(config, name + " " + suffix)) suffix++
  return name + " " + suffix
}

// --------------------------------------------------------------------- lua

var LAYOUT_PREFIX = "omarchy-wsl-"

function luaLayoutName(id) {
  return LAYOUT_PREFIX + slugify(id)
}

// What a workspace rule's `layout` field should say: builtins pass through
// under their own name, ours get the `lua:` prefix Hyprland uses to look up
// layouts registered from Lua.
function luaLayoutRef(id) {
  return isBuiltin(id) ? String(id) : "lua:" + luaLayoutName(id)
}

function luaString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

function luaNumber(value) {
  var n = Number(value)
  if (!isFiniteNumber(n)) return "0"
  return String(round2(n))
}

// The layout engine, in Lua. Kept as one string so the generated file, the
// live-preview payload, and the cross-check test all run byte-identical code.
//
// `wsl_rects` is a line-for-line port of slotRects(); tests/model.test.js runs
// this through the `lua` interpreter and diffs it against the JS.
var LUA_RUNTIME = [
  'local W = _G.__omarchy_wsl',
  'if not W then W = { registered = {}, rules = {} }; _G.__omarchy_wsl = W end',
  'W.specs = {}',
  '',
  'local function normalize(weights)',
  '  local total = 0',
  '  for i = 1, #weights do total = total + weights[i] end',
  '  local out = {}',
  '  if total <= 0 then',
  '    for i = 1, #weights do out[i] = 100 / #weights end',
  '    return out',
  '  end',
  '  for i = 1, #weights do out[i] = weights[i] * 100 / total end',
  '  return out',
  'end',
  '',
  'local function orient(orientation, main_offset, main_size, cross_offset, cross_size)',
  '  if orientation == "rows" then',
  '    return { cross_offset, main_offset, cross_size, main_size }',
  '  end',
  '  return { main_offset, cross_offset, main_size, cross_size }',
  'end',
  '',
  'local function grid_rects(spec, n)',
  '  local columns',
  '  if spec.grid_columns and spec.grid_columns > 0 then',
  '    columns = math.min(spec.grid_columns, n)',
  '  else',
  '    columns = math.ceil(math.sqrt(n))',
  '  end',
  '  local rows = math.ceil(n / columns)',
  '  local rects = {}',
  '  for row = 0, rows - 1 do',
  '    local first = row * columns',
  '    local in_row = math.min(columns, n - first)',
  '    for col = 0, in_row - 1 do',
  '      local right = (col == in_row - 1) and 1 or (col + 1) / in_row',
  '      local bottom = (row == rows - 1) and 1 or (row + 1) / rows',
  '      rects[#rects + 1] = { col / in_row, row / rows, right - col / in_row, bottom - row / rows }',
  '    end',
  '  end',
  '  return rects',
  'end',
  '',
  '-- Widest slot first, so the first window lands in the main area rather than',
  '-- in a sliver at the edge. Ties keep positional order. table.sort is not',
  '-- stable in Lua, hence the explicit index tiebreak.',
  'local function fill_order(weights)',
  '  local index = {}',
  '  for i = 1, #weights do index[i] = i end',
  '  table.sort(index, function(a, b)',
  '    if weights[a] ~= weights[b] then return weights[a] > weights[b] end',
  '    return a < b',
  '  end)',
  '  return index',
  'end',
  '',
  'local function ratio_rects(spec, n)',
  '  local weights = spec.weights',
  '  local k = #weights',
  '  local primary = {}',
  '  local stack_at, stack_count = -1, 0',
  '',
  '  if n <= k and spec.underfill == "hold" then',
  '    for i = 1, k do primary[i] = weights[i] end',
  '  elseif n <= k then',
  '    local chosen = {}',
  '    local priority = fill_order(weights)',
  '    for i = 1, n do chosen[i] = priority[i] end',
  '    table.sort(chosen)',
  '    for i = 1, n do primary[i] = weights[chosen[i]] end',
  '  elseif spec.overflow == "extend" then',
  '    for i = 1, k do primary[i] = weights[i] end',
  '    for i = k + 1, n do primary[i] = weights[k] end',
  '  else',
  '    for i = 1, k do primary[i] = weights[i] end',
  '    stack_at = (spec.overflow == "first") and 1 or k',
  '    stack_count = n - k + 1',
  '  end',
  '',
  '  primary = normalize(primary)',
  '',
  '  local cells, cell_slot = {}, {}',
  '  local offset = 0',
  '  for slot = 1, #primary do',
  '    local size = primary[slot] / 100',
  '    if slot == #primary then size = 1 - offset end',
  '    if slot == stack_at then',
  '      for s = 0, stack_count - 1 do',
  '        local sub_offset = s / stack_count',
  '        local sub_size = (s == stack_count - 1) and (1 - sub_offset) or (1 / stack_count)',
  '        cells[#cells + 1] = orient(spec.orientation, offset, size, sub_offset, sub_size)',
  '        cell_slot[#cell_slot + 1] = slot',
  '      end',
  '    else',
  '      cells[#cells + 1] = orient(spec.orientation, offset, size, 0, 1)',
  '      cell_slot[#cell_slot + 1] = slot',
  '    end',
  '    offset = offset + size',
  '  end',
  '',
  '  local order',
  '  if spec.fill == "order" then',
  '    order = {}',
  '    for i = 1, #primary do order[i] = i end',
  '  else',
  '    order = fill_order(primary)',
  '  end',
  '',
  '  local rects = {}',
  '  for i = 1, #order do',
  '    for c = 1, #cells do',
  '      if cell_slot[c] == order[i] then rects[#rects + 1] = cells[c] end',
  '    end',
  '  end',
  '  -- Under "hold" there are more cells than windows; the surplus are the',
  '  -- empty slots, and they are last because the list is in fill order.',
  '  while #rects > n do table.remove(rects) end',
  '  return rects',
  'end',
  '',
  'function W.rects(spec, n)',
  '  if n <= 0 then return {} end',
  '  if spec.kind == "grid" then return grid_rects(spec, n) end',
  '  return ratio_rects(spec, n)',
  'end',
  '',
  '-- Convert fractions to pixels by rounding the *edges*, not the sizes, so',
  '-- neighbouring windows always share an exact boundary and no seam of dead',
  '-- pixels opens up between them.',
  'function W.place(id, ctx)',
  '  local n = #ctx.targets',
  '  if n == 0 then return end',
  '  local spec = W.specs[id]',
  '  if not spec then return end',
  '  local a = ctx.area',
  '  local rects = W.rects(spec, n)',
  '  for i = 1, n do',
  '    local r = rects[i]',
  '    if r then',
  '      local x0 = math.floor(a.w * r[1] + 0.5)',
  '      local y0 = math.floor(a.h * r[2] + 0.5)',
  '      local x1 = math.floor(a.w * (r[1] + r[3]) + 0.5)',
  '      local y1 = math.floor(a.h * (r[2] + r[4]) + 0.5)',
  '      ctx.targets[i]:place({ x = a.x + x0, y = a.y + y0, w = x1 - x0, h = y1 - y0 })',
  '    end',
  '  end',
  'end',
  '',
  '-- Hyprland refuses a second registration under the same name, and this file',
  '-- is re-run on every config reload, so registration is remembered for the',
  '-- life of the compositor. Behaviour still updates: the closure reads',
  '-- W.specs, which the reload has just replaced.',
  'function W.register(id)',
  '  local name = ' + luaString(LAYOUT_PREFIX) + ' .. id',
  '  if W.registered[name] then return end',
  '  W.registered[name] = true',
  '  hl.layout.register(name, {',
  '    recalculate = function(ctx) W.place(id, ctx) end,',
  '    layout_msg = function(ctx, msg)',
  '      if ctx then W.place(id, ctx) end',
  '      return true',
  '    end,',
  '  })',
  'end',
  '',
  '-- Workspace rules accumulate: adding a second rule for a workspace does not',
  '-- retire the first. Keep the handle so the previous rule can be disabled,',
  '-- otherwise switching profiles would pile up dead rules that still win.',
  'function W.set_workspace(ws, layout)',
  '  local previous = W.rules[ws]',
  '  if previous then pcall(function() previous:set_enabled(false) end) end',
  '  W.rules[ws] = hl.workspace_rule({ workspace = ws, layout = layout })',
  'end',
  '',
  '-- Nothing re-tiles a workspace just because its spec changed, so ask the',
  '-- active layout to lay itself out again. Errors on a workspace running a',
  '-- built-in layout, which has no idea what this message means.',
  'function W.relayout()',
  '  pcall(function() hl.dispatch(hl.dsp.layout("relayout")) end)',
  'end'
].join("\n")

// The `W.specs[id] = {...}` line for one layout. Small enough to push on every
// frame of a drag, which is what makes the live preview live.
function layoutSpecLua(layout) {
  var spec = normalizeLayout(layout)
  var weights = []
  for (var i = 0; i < spec.weights.length; i++) weights.push(luaNumber(spec.weights[i]))
  return "W.specs[" + luaString(spec.id) + "] = { " +
    "kind = " + luaString(spec.kind) + ", " +
    "orientation = " + luaString(spec.orientation) + ", " +
    "overflow = " + luaString(spec.overflow) + ", " +
    "fill = " + luaString(spec.fill) + ", " +
    "underfill = " + luaString(spec.underfill) + ", " +
    "grid_columns = " + luaNumber(spec.gridColumns) + ", " +
    "weights = { " + weights.join(", ") + " } }"
}

// Which workspaces the generated file must speak for. Rules are emitted for
// every workspace the profile assigns *and* every workspace that exists right
// now, so switching to a profile that assigns nothing still resets the
// workspaces the previous profile had claimed.
function managedWorkspaceIds(config, liveWorkspaceIds) {
  var profile = activeProfile(config)
  var ids = {}
  var key
  for (key in profile.assignments) ids[key] = true
  var live = (liveWorkspaceIds instanceof Array) ? liveWorkspaceIds : []
  for (var i = 0; i < live.length; i++) {
    var normalized = normalizeWorkspaceId(live[i])
    if (normalized !== null) ids[normalized] = true
  }
  for (var w = 1; w <= 10; w++) ids[String(w)] = true

  var out = []
  for (key in ids) out.push(key)
  out.sort(function(a, b) { return Number(a) - Number(b) })
  return out
}

// The whole runtime: engine, specs, registrations, and this profile's
// workspace rules. Written to disk so it survives a restart, and eval'd
// verbatim so it takes effect now.
function generateLua(config, liveWorkspaceIds) {
  var normalized = normalizeConfig(config)
  var profile = activeProfile(normalized)
  var lines = [
    "-- Generated by the Omarchy Workspace Layout plugin. Do not edit.",
    "-- Your layouts and profiles live in ~/.config/omarchy/workspace-layout.json;",
    "-- this file is rewritten from that document every time it changes.",
    "--",
    "-- Active profile: " + profile.name,
    "",
    LUA_RUNTIME,
    ""
  ]

  var i
  for (i = 0; i < normalized.layouts.length; i++) {
    lines.push(layoutSpecLua(normalized.layouts[i]))
  }
  lines.push("")
  for (i = 0; i < normalized.layouts.length; i++) {
    lines.push("W.register(" + luaString(normalized.layouts[i].id) + ")")
  }
  lines.push("")

  var workspaces = managedWorkspaceIds(normalized, liveWorkspaceIds)
  for (i = 0; i < workspaces.length; i++) {
    var id = layoutIdForWorkspace(normalized, workspaces[i])
    lines.push("W.set_workspace(" + luaString(workspaces[i]) + ", " +
      luaString(luaLayoutRef(id)) + ")")
  }
  lines.push("")
  return lines.join("\n")
}

// The drag path. Only the edited layout's spec is replaced, then the active
// workspace is asked to re-tile — no re-registration, no rule churn, so
// windows glide instead of blinking.
function livePreviewLua(layout) {
  return [
    "local W = _G.__omarchy_wsl",
    "if W then",
    "  " + layoutSpecLua(layout),
    "  W.relayout()",
    "end"
  ].join("\n")
}

// ----------------------------------------------------------------- commands

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// hyprctl parses an argument that starts with "-" as a flag, and Lua comments
// start with "--" — a payload that opens with a comment banner is read as
// garbage flags and never runs. A do-block guarantees the first character is a
// letter whatever the payload contains. Everything the runtime defines hangs
// off the _G table, so the extra scope changes nothing.
function evalPayload(lua) {
  return "do\n" + String(lua) + "\nend"
}

function hyprctlEvalArgs(lua) {
  return ["hyprctl", "eval", evalPayload(lua)]
}

// Hyprland has no "focus this workspace" IPC that Quickshell exposes directly,
// so the bar's `run` shell is the shortest honest path.
function focusWorkspaceCommand(workspaceId) {
  return "hyprctl dispatch " +
    shellQuote('hl.dsp.focus({ workspace = "' + String(workspaceId) + '" })')
}

// ------------------------------------------------------------------ loader

var LOADER_MARKER = "omarchy-workspace-layout.lua"

// One line, guarded by an existence check, so removing the plugin's generated
// file cannot break the user's Hyprland config.
function loaderLine() {
  return '-- Added by the Omarchy Workspace Layout plugin: registers its Lua tiling layouts.\n' +
    'do local path = (os.getenv("XDG_CONFIG_HOME") or os.getenv("HOME") .. "/.config") .. ' +
    '"/hypr/omarchy-workspace-layout.lua"; local file = io.open(path, "r"); ' +
    'if file then file:close(); dofile(path) end end'
}

function needsLoader(hyprlandLua) {
  return String(hyprlandLua || "").indexOf(LOADER_MARKER) === -1
}

function withLoader(hyprlandLua) {
  var text = String(hyprlandLua || "")
  if (!needsLoader(text)) return text
  var separator = text.length === 0 || /\n\s*$/.test(text) ? "\n" : "\n\n"
  return text + separator + loaderLine() + "\n"
}

// ------------------------------------------------------------------ exports

if (typeof module !== "undefined") {
  module.exports = {
    MIN_WEIGHT: MIN_WEIGHT,
    MAX_SLOTS: MAX_SLOTS,
    SNAP_POINTS: SNAP_POINTS,
    LUA_RUNTIME: LUA_RUNTIME,
    BUILTIN_LAYOUTS: BUILTIN_LAYOUTS,
    normalizeWeights: normalizeWeights,
    fillOrder: fillOrder,
    defaultUnderfill: defaultUnderfill,
    evenWeights: evenWeights,
    dividerPositions: dividerPositions,
    setDivider: setDivider,
    addSlot: addSlot,
    removeSlot: removeSlot,
    slotRects: slotRects,
    sanitizeName: sanitizeName,
    slugify: slugify,
    uniqueLayoutId: uniqueLayoutId,
    normalizeLayout: normalizeLayout,
    describeLayout: describeLayout,
    formatWeight: formatWeight,
    presets: presets,
    isBuiltin: isBuiltin,
    defaultConfig: defaultConfig,
    normalizeConfig: normalizeConfig,
    normalizeProfile: normalizeProfile,
    normalizeWorkspaceId: normalizeWorkspaceId,
    findLayout: findLayout,
    findProfile: findProfile,
    activeProfile: activeProfile,
    layoutIdForWorkspace: layoutIdForWorkspace,
    uniqueProfileName: uniqueProfileName,
    luaLayoutName: luaLayoutName,
    luaLayoutRef: luaLayoutRef,
    layoutSpecLua: layoutSpecLua,
    managedWorkspaceIds: managedWorkspaceIds,
    generateLua: generateLua,
    livePreviewLua: livePreviewLua,
    shellQuote: shellQuote,
    evalPayload: evalPayload,
    hyprctlEvalArgs: hyprctlEvalArgs,
    focusWorkspaceCommand: focusWorkspaceCommand,
    loaderLine: loaderLine,
    needsLoader: needsLoader,
    withLoader: withLoader
  }
}
