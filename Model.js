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

// How each slot is cut up across the layout's grain, as one list of weights
// per slot: `[100]` is a plain slot, `[50, 50]` a column split into an equal
// top and bottom, `[30, 70]` the same split dragged. In a rows layout the
// grain runs the other way and the parts sit side by side.
//
// The plain count is accepted as shorthand — `"cells": [1, 2]` is what a hand
// edit wants to write, and it means the same as `[[100], [50, 50]]`.
//
// Parallel to `weights`, and padded or trimmed to match it, so a hand-edit
// that adds a slot without adding a cell still opens. Capped on the total
// rather than per slot: a layout is at most MAX_SLOTS places to put a window,
// however they are arranged.
function normalizeCells(cells, slotCount) {
  var out = []
  var list = (cells instanceof Array) ? cells : []
  var total = 0
  for (var i = 0; i < slotCount; i++) {
    var parts = cellParts(list[i])
    // Every slot keeps at least one part, so a layout can always be drawn.
    var room = Math.max(1, MAX_SLOTS - total - (slotCount - i - 1))
    var kept = []
    var used = 0
    for (var j = 0; j < parts.length; j++) {
      var pieces = partPieces(parts[j])
      if (used + pieces > room) break
      kept.push(parts[j])
      used += pieces
    }
    if (kept.length === 0) kept = [100]
    out.push(balanceParts(kept))
    total += used > 0 ? used : 1
  }
  return out
}

// One slot's parts, from any of the three forms: a count, the cross weights
// themselves, or — for a part that is divided again along the grain — an
// object saying how wide it is and how it is cut.
//
//   2                          two equal parts
//   [30, 70]                   two parts, uneven
//   [50, { weight: 50, parts: [40, 60] }]
//                              two parts, the second cut into two columns
//
// That second cut is the third dimension of a layout that has no nesting
// beyond it: slots run one way, their parts the other, and a part's own parts
// the first way again. Deeper than that and the panel would be drawing a tree.
function cellParts(value) {
  if (value instanceof Array) {
    var out = []
    for (var i = 0; i < value.length && i < MAX_SLOTS; i++) out.push(normalizePart(value[i]))
    return out.length > 0 ? out : [100]
  }
  var count = Math.round(Number(value))
  if (!isFiniteNumber(count) || count < 1) count = 1
  if (count > MAX_SLOTS) count = MAX_SLOTS
  return evenWeights(count)
}

function normalizePart(value) {
  if (value && typeof value === "object" && value.parts instanceof Array) {
    var weight = Number(value.weight)
    var inner = []
    for (var i = 0; i < value.parts.length && i < MAX_SLOTS; i++) {
      var piece = Number(value.parts[i])
      inner.push(isFiniteNumber(piece) && piece > 0 ? piece : 1)
    }
    if (inner.length < 2) return isFiniteNumber(weight) && weight > 0 ? weight : 1
    return {
      weight: isFiniteNumber(weight) && weight > 0 ? weight : 1,
      parts: normalizeWeights(inner, inner.length)
    }
  }
  var plain = Number(value)
  return isFiniteNumber(plain) && plain > 0 ? plain : 1
}

// The cross-grain weight of a part, whichever form it is in.
function partWeight(part) {
  return (part && typeof part === "object") ? part.weight : part
}

// How a part is cut along the grain, or [] for a part that is not.
function partSplit(part) {
  return (part && typeof part === "object" && part.parts instanceof Array) ? part.parts : []
}

// How many places a part is worth.
function partPieces(part) {
  var split = partSplit(part)
  return split.length > 1 ? split.length : 1
}

// Normalize the cross weights of a slot's parts to sum to 100, leaving each
// part's own cut alone.
function balanceParts(parts) {
  var weights = []
  var i
  for (i = 0; i < parts.length; i++) weights.push(partWeight(parts[i]))
  weights = normalizeWeights(weights, weights.length)
  var out = []
  for (i = 0; i < parts.length; i++) {
    var split = partSplit(parts[i])
    out.push(split.length > 1 ? { weight: weights[i], parts: split } : weights[i])
  }
  return out
}

// How many places a layout offers, counting every part of every slot.
function totalCells(cells) {
  var total = 0
  for (var i = 0; i < cells.length; i++) {
    for (var j = 0; j < cells[i].length; j++) total += partPieces(cells[i][j])
  }
  return total
}

// The parts of one slot, evened out — what a fresh split gives, and what
// overflow stacking falls back to when it adds parts to a slot that had a
// ratio drawn for a smaller number of them.
//
// Built directly rather than through evenWeights, which caps at MAX_SLOTS:
// that cap is about how many places a layout may be *drawn* with, and a stack
// of eleven windows in one slot is eleven parts whatever the cap says.
function evenCell(count) {
  var n = Math.max(1, Math.round(Number(count)))
  var out = []
  for (var i = 0; i < n; i++) out.push(100 / n)
  return out
}

function evenWeights(count) {
  var n = Math.max(1, Math.min(MAX_SLOTS, Math.round(Number(count) || 1)))
  var out = []
  for (var i = 0; i < n; i++) out.push(round2(100 / n))
  return repairSum(out)
}

// What is drawn and what is stored are the same thing until "extra → new
// slots" appends places: those take room from everything else, so every stored
// edge lands somewhere else on screen. The appended slots scale the rest
// uniformly, so one factor converts between the two — drawn = stored × scale.
//
// Without it the divider handle floats away from the seam it belongs to: a
// 70/30 with a third window draws its edge at 53.8% while the handle sits at
// 70%, and dragging moves the seam by some other amount again.
function dividerScale(layout, windowCount) {
  var spec = normalizeLayout(layout)
  if (spec.kind === "grid" || spec.overflow !== "extend") return 1
  var n = Math.max(0, Math.round(Number(windowCount) || 0))
  var base = totalCells(spec.cells)
  if (n <= base) return 1
  var extra = (n - base) * spec.weights[spec.weights.length - 1]
  if (extra <= 0) return 1
  return 100 / (100 + extra)
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

// Split one slot into equal parts in place, taking the room from that slot
// alone so the rest of the shape does not shift. Two by default: the answer to
// "this half should really be two columns".
function splitSlot(weights, index, parts) {
  var current = normalizeWeights(weights, weights ? weights.length : 0)
  var at = Math.round(Number(index))
  var count = Math.round(Number(parts))
  if (!isFiniteNumber(count) || count < 2) count = 2
  if (!isFiniteNumber(at) || at < 0 || at >= current.length) return current
  // Splitting past the cap would silently drop the tail; refuse instead.
  if (current.length + count - 1 > MAX_SLOTS) return current

  var share = current[at] / count
  var out = []
  for (var i = 0; i < current.length; i++) {
    if (i !== at) {
      out.push(current[i])
      continue
    }
    for (var p = 0; p < count; p++) out.push(share)
  }
  return normalizeWeights(out, out.length)
}

// The shape edits, as whole-layout operations: `weights` and `cells` are
// parallel arrays, and an edit that inserts or drops a slot has to move both
// or the cross-grain splits slide onto the wrong slots.
//
// Each returns `{ weights, cells }`, ready to assign onto a layout.

function shapeAddSlot(weights, cells) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  if (w.length >= MAX_SLOTS || totalCells(c) >= MAX_SLOTS) return { weights: w, cells: c }

  var widest = 0
  for (var i = 1; i < w.length; i++) if (w[i] > w[widest]) widest = i
  var next = addSlot(w)
  // addSlot splits the widest slot in place and inserts the new half after it;
  // the new half starts unsplit.
  if (next.length === w.length + 1) c.splice(widest + 1, 0, [100])
  return { weights: next, cells: normalizeCells(c, next.length) }
}

function shapeRemoveSlot(weights, cells, index) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  var at = Math.round(Number(index))
  if (!isFiniteNumber(at) || at < 0 || at >= w.length || w.length <= 1) {
    return { weights: w, cells: c }
  }
  var next = removeSlot(w, at)
  c.splice(at, 1)
  return { weights: next, cells: normalizeCells(c, next.length) }
}

// Along the grain: the slot becomes two (or three) slots side by side, taking
// the room from itself so the rest of the shape does not move. The new pieces
// start unsplit — inheriting a cross-grain split would multiply the places on
// screen rather than divide them.
function shapeSplitAlong(weights, cells, index, parts) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  var at = Math.round(Number(index))
  var count = Math.round(Number(parts))
  if (!isFiniteNumber(count) || count < 2) count = 2
  if (!isFiniteNumber(at) || at < 0 || at >= w.length) return { weights: w, cells: c }
  if (totalCells(c) - c[at].length + count > MAX_SLOTS) return { weights: w, cells: c }

  var next = splitSlot(w, at, count)
  if (next.length === w.length) return { weights: w, cells: c }
  var out = []
  for (var i = 0; i < c.length; i++) {
    if (i !== at) {
      out.push(c[i])
      continue
    }
    for (var p = 0; p < count; p++) out.push([100])
  }
  return { weights: next, cells: normalizeCells(out, next.length) }
}

// Across the grain: the slot keeps its width and is cut into more parts, which
// is the split a flat list of weights cannot express. Splitting in two adds
// one part, so asking twice gives three.
function shapeSplitAcross(weights, cells, index, parts) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  var at = Math.round(Number(index))
  var count = Math.round(Number(parts))
  if (!isFiniteNumber(count) || count < 2) count = 2
  if (!isFiniteNumber(at) || at < 0 || at >= c.length) return { weights: w, cells: c }
  if (totalCells(c) + count - 1 > MAX_SLOTS) return { weights: w, cells: c }

  // Evened out: a ratio drawn for two parts says nothing about how three
  // should sit, and an equal split is the honest starting point to drag from.
  var out = c.slice()
  out[at] = evenCell(out[at].length + count - 1)
  return { weights: w, cells: out }
}

// Give the layout enough places for the windows that are actually open, the
// way its own overflow rule would have drawn them — but written down.
//
// Overflow is a drawing rule: five windows in a three-place layout are shown
// stacked, and the moment one closes the stack is gone. That is fine for a
// layout you are not looking at, and wrong for one you are arranging: the
// extra windows have no place to be pinned to, no divider to drag, and no
// memory of where you put them. Working from the panel, they become places.
function growForCount(weights, cells, overflow, count) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  var n = Math.round(Number(count))
  var places = totalCells(c)
  if (!isFiniteNumber(n) || n <= places || places >= MAX_SLOTS) return { weights: w, cells: c }
  var extra = Math.min(n, MAX_SLOTS) - places

  if (overflow === "extend") {
    // New slots as wide as the last, which is what "extra → new slots" drew.
    var out = w.slice()
    var parts = c.slice()
    for (var i = 0; i < extra; i++) {
      out.push(w[w.length - 1])
      parts.push([100])
    }
    return { weights: normalizeWeights(out, out.length), cells: normalizeCells(parts, out.length) }
  }

  // Stacked into one slot, evenly, exactly as it was being drawn.
  var at = overflow === "first" ? 0 : c.length - 1
  var grown = c.slice()
  grown[at] = evenCell(grown[at].length + extra)
  return { weights: w, cells: grown }
}

// Drag of the divider inside a divided part: its pieces, replaced wholesale.
// The part keeps its band across the grain; only the split along it moves.
function shapeSetPiece(weights, cells, index, part, pieces) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  var at = Math.round(Number(index))
  var which = Math.round(Number(part))
  if (!isFiniteNumber(at) || at < 0 || at >= c.length) return { weights: w, cells: c }
  if (!isFiniteNumber(which) || which < 0 || which >= c[at].length) return { weights: w, cells: c }
  var given = (pieces instanceof Array) ? pieces.length : 0
  if (given < 2) return { weights: w, cells: c }
  if (totalCells(c) - partPieces(c[at][which]) + given > MAX_SLOTS) return { weights: w, cells: c }

  var out = c.slice()
  var parts = out[at].slice()
  parts[which] = {
    weight: partWeight(parts[which]),
    parts: normalizeWeights(pieces, given)
  }
  out[at] = parts
  return { weights: w, cells: out }
}

// Back to one place: the slot keeps its width and stops being cut up.
function shapeMerge(weights, cells, index) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  var at = Math.round(Number(index))
  if (!isFiniteNumber(at) || at < 0 || at >= c.length) return { weights: w, cells: c }
  var out = c.slice()
  out[at] = [100]
  return { weights: w, cells: out }
}

// Drag of a cross-grain divider: one slot's parts, replaced wholesale. The
// panel hands over what `setDivider` produced, so the maths that moves a
// divider is the same on both axes.
//
// The part count may differ from what is stored, and that is the point: a slot
// showing three windows because overflow stacked them there has no ratio to
// drag — dragging its divider is how you say "these are places now", and the
// stack becomes a split the layout remembers.
function shapeSetCell(weights, cells, index, parts) {
  var w = normalizeWeights(weights)
  var c = normalizeCells(cells, w.length)
  var at = Math.round(Number(index))
  if (!isFiniteNumber(at) || at < 0 || at >= c.length) return { weights: w, cells: c }
  var given = (parts instanceof Array) ? parts.length : 0
  if (given < 1) return { weights: w, cells: c }
  // Materialising a stack must still respect the ceiling on places.
  if (totalCells(c) - c[at].length + given > MAX_SLOTS) return { weights: w, cells: c }
  var previous = c[at]
  var next = normalizeWeights(parts, given)
  var built = []
  for (var i = 0; i < given; i++) {
    // A drag moves the bands; it must not flatten a part that is divided
    // again inside. Only a changing part count — a stack being written down —
    // starts from plain parts.
    var keep = given === previous.length ? partSplit(previous[i]) : []
    built.push(keep.length > 1 ? { weight: next[i], parts: keep } : next[i])
  }
  var out = c.slice()
  out[at] = built
  return { weights: w, cells: out }
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
  return ratioCells(spec, n).rects
}

// Which slot of the *layout* each rect belongs to, 0-based and counted by
// position on screen rather than by fill order. The canvas needs it to act on
// the tile the user clicked: splitting the middle third means splitting
// `weights[1]`, whichever place that slot takes in the fill order.
function rectSlotPositions(layout, windowCount) {
  var n = Math.max(0, Math.round(Number(windowCount) || 0))
  if (n === 0) return []
  var spec = normalizeLayout(layout)
  if (spec.kind === "grid") {
    var out = []
    for (var i = 0; i < n; i++) out.push(i)
    return out
  }
  return ratioCells(spec, n).slots
}

// What each drawn place *is*: which slot, which of its parts, and which piece
// of that part. Taken from the same pass that draws the rectangles, so the two
// can never drift apart — everything that edits a place goes through this
// rather than re-deriving the order.
function placeAddresses(layout, windowCount) {
  var spec = normalizeLayout(layout)
  var n = Math.max(0, Math.round(Number(windowCount) || 0))
  if (n === 0 || spec.kind === "grid") return []
  return ratioCells(spec, n).addresses
}

function ratioCells(spec, n) {
  var weights = spec.weights
  var counts = spec.cells
  var k = weights.length
  var i, s

  // The three parallel arrays this all runs on: the main-axis weight of each
  // slot, how many parts it is cut into across the grain, and where it sits in
  // the layout as written (the rescale branch drops slots, so the index into
  // these is not the index into `weights`).
  var primary = []
  var subs = []
  var primaryPos = []
  var base = totalCells(counts)
  // A layout with a split slot was drawn in two dimensions, and there is no
  // sensible way to grow one: rescaling would have to decide whether a missing
  // window widens its column or gives its half to its neighbour. It holds.
  var split = base > k

  if (n <= base && (spec.underfill === "hold" || split)) {
    // Hold: every slot keeps the position it would have when full, and the
    // places without a window in them stay empty. This is what keeps a centred
    // layout centred — rescaling a 25/50/25 down to one window would blow it
    // up to fullscreen, and down to two would slide the main slot off to one
    // side, which is the opposite of what the layout was drawn for.
    for (i = 0; i < k; i++) {
      primary.push(weights[i])
      subs.push(counts[i])
      primaryPos.push(i)
    }
  } else if (n <= base) {
    // Rescale: keep the slots that matter most and grow them to fill the
    // screen. Picking by priority rather than by position is what puts a lone
    // window in the main area instead of the leftmost sliver.
    var chosen = fillOrder(weights).slice(0, n)
    chosen.sort(function(a, b) { return a - b })
    for (i = 0; i < chosen.length; i++) {
      primary.push(weights[chosen[i]])
      subs.push([100])
      primaryPos.push(chosen[i])
    }
  } else if (spec.overflow === "extend") {
    for (i = 0; i < k; i++) {
      primary.push(weights[i])
      subs.push(counts[i])
      primaryPos.push(i)
    }
    // New slots inherit the last slot's width, so a main/stack layout grows
    // its stack instead of squeezing the main window.
    var grown = base
    while (grown < n) {
      primary.push(weights[k - 1])
      subs.push([100])
      primaryPos.push(primary.length - 1)
      grown++
    }
  } else {
    for (i = 0; i < k; i++) {
      primary.push(weights[i])
      subs.push(counts[i])
      primaryPos.push(i)
    }
    // Everything past the last place stacks into one slot, which simply means
    // that slot is cut into more parts. A ratio drawn for two parts says
    // nothing about how four should sit, so the stack shares the slot evenly —
    // counting the *places* it already holds, which is not the number of parts
    // once one of them is divided again.
    var stackAt = spec.overflow === "first" ? 0 : k - 1
    var held = 0
    for (i = 0; i < subs[stackAt].length; i++) held += partPieces(subs[stackAt][i])
    subs[stackAt] = evenCell(held + n - base)
  }

  primary = exactNormalize(primary)

  // Cells in positional order — reading order on screen. A slot cut in two
  // gives two cells side by side across the grain; the overflow slot is the
  // same thing with a count that grows as windows arrive.
  var cells = []
  var cellSlot = []
  var cellAddr = []
  var offset = 0
  for (var slot = 0; slot < primary.length; slot++) {
    var size = primary[slot] / 100
    if (slot === primary.length - 1) size = 1 - offset  // absorb rounding drift
    var list = subs[slot]
    var weights = []
    for (s = 0; s < list.length; s++) weights.push(partWeight(list[s]))
    var parts = exactNormalize(weights)
    var crossed = 0
    for (s = 0; s < parts.length; s++) {
      var subSize = parts[s] / 100
      if (s === parts.length - 1) subSize = 1 - crossed  // absorb rounding drift
      var split = partSplit(list[s])
      if (split.length > 1) {
        // The part is cut again, back along the grain: same band across, and
        // the slot's own width divided between the pieces.
        var inner = exactNormalize(split)
        var run = 0
        for (var q = 0; q < inner.length; q++) {
          var innerSize = size * inner[q] / 100
          if (q === inner.length - 1) innerSize = size - run
          cells.push(orient(spec.orientation, offset + run, innerSize, crossed, subSize))
          cellSlot.push(slot)
          cellAddr.push({ slot: primaryPos[slot], part: s, piece: q })
          run += innerSize
        }
      } else {
        cells.push(orient(spec.orientation, offset, size, crossed, subSize))
        cellSlot.push(slot)
        cellAddr.push({ slot: primaryPos[slot], part: s, piece: 0 })
      }
      crossed += subSize
    }
    offset += size
  }

  // Windows are handed out in fill order; a slot cut into parts gives up its
  // cells across the grain before the next slot gets one.
  var order = []
  if (spec.fill === "order") {
    for (i = 0; i < primary.length; i++) order.push(i)
  } else {
    order = fillOrder(primary)
  }

  var rects = []
  var slots = []
  var addresses = []
  for (i = 0; i < order.length; i++) {
    for (var c = 0; c < cells.length; c++) {
      if (cellSlot[c] === order[i]) {
        rects.push(cells[c])
        slots.push(primaryPos[cellSlot[c]])
        addresses.push(cellAddr[c])
      }
    }
  }
  // Under "hold" there are more cells than windows; the surplus are the empty
  // places, and they are last because the list is in fill order.
  return {
    rects: rects.slice(0, n),
    slots: slots.slice(0, n),
    addresses: addresses.slice(0, n)
  }
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

// A fresh id for a layout nobody named: `custom-3f9a`. Random rather than
// counted because a fork happens mid-drag and the count would have to be
// recomputed against a document that is changing under it; the name is what
// the user reads, and that is theirs to change afterwards.
function customLayoutId(config) {
  for (var attempt = 0; attempt < 50; attempt++) {
    var suffix = Math.random().toString(36).slice(2, 6)
    if (suffix.length !== 4) continue
    var id = "custom-" + suffix
    if (!findLayout(config, id)) return id
  }
  return uniqueLayoutId(config, "custom")
}

// Layout names are not keys, but two cards both reading "Custom" are two cards
// you cannot tell apart.
function uniqueLayoutName(config, base) {
  var name = sanitizeName(base, "Custom")
  var layouts = (config && config.layouts instanceof Array) ? config.layouts : []
  var taken = {}
  for (var i = 0; i < layouts.length; i++) taken[String(layouts[i].name)] = true
  if (!taken[name]) return name
  var suffix = 2
  while (taken[name + " " + suffix]) suffix++
  return name + " " + suffix
}

function normalizeLayout(raw) {
  var input = (raw && typeof raw === "object") ? raw : {}
  var kind = input.kind === "grid" ? "grid" : "ratio"
  var orientation = input.orientation === "rows" ? "rows" : "columns"
  var overflow = input.overflow === "first" || input.overflow === "extend"
    ? input.overflow : "last"
  var fill = input.fill === "order" ? "order" : "largest"
  var weights = normalizeWeights(input.weights)
  var cells = normalizeCells(input.cells, weights.length)
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
    cells: cells,
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
  for (var i = 0; i < spec.weights.length; i++) {
    // A split slot reads as "50×2": half the screen, holding two windows.
    var piece = formatWeight(spec.weights[i])
    if (spec.cells[i].length > 1) piece += "\u00d7" + spec.cells[i].length
    parts.push(piece)
  }
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

// Whether a layout is one of the shipped ones. Editing one starts a copy
// instead of rewriting it: the presets are a library to reach for, and
// changing "Even" the first time a divider moves takes that away — on every
// workspace using it, at that.
//
// By id, not by content. Comparing shapes sounds cleverer — "it has already
// been changed, so it is yours now" — but it means a preset you edited last
// week is quietly no longer a preset, and the next drag rewrites it. Shipped
// is shipped.
function isPreset(id) {
  var slug = slugify(id)
  for (var i = 0; i < PRESETS.length; i++) {
    if (slugify(PRESETS[i].id) === slug) return true
  }
  return false
}

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

  // Keyed by the app rather than by the workspace, so an app can only ever be
  // pinned in one place: re-pinning it somewhere else overwrites the entry
  // instead of leaving two rules fighting over the same window.
  //
  // A value may be the workspace on its own — `"firefox": "3"` is the whole
  // pin, and the friendliest thing to type by hand — or an object that also
  // names a slot.
  var pins = {}
  var rawPins = (input.pins && typeof input.pins === "object") ? input.pins : {}
  for (var app in rawPins) {
    var match = normalizeAppMatch(app)
    if (match === null) continue
    var pin = normalizePin(rawPins[app])
    if (pin === null) continue
    pins[match] = pin
  }

  // A layout per monitor, between the per-workspace exceptions and the
  // profile's own default: a laptop panel and a 34" ultrawide rarely want the
  // same split, and workspaces move between them.
  var monitors = {}
  var rawMonitors = (input.monitors && typeof input.monitors === "object") ? input.monitors : {}
  for (var screen in rawMonitors) {
    var monitor = normalizeMonitorName(screen)
    if (monitor === null) continue
    var chosen = String(rawMonitors[screen])
    if (!known[chosen] && !isBuiltin(chosen)) continue
    monitors[monitor] = chosen
  }

  var fallback = String(input.fallback || "dwindle")
  if (!known[fallback] && !isBuiltin(fallback)) fallback = "dwindle"

  return {
    name: sanitizeName(input.name, "default"),
    fallback: fallback,
    assignments: assignments,
    monitors: monitors,
    pins: pins
  }
}

// Monitor names come from Hyprland (`eDP-1`, `DP-2`) and are only ever used as
// a key, so this just refuses the ones that would corrupt the document.
function normalizeMonitorName(value) {
  var text = String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
  if (text.length === 0) return null
  return text.slice(0, 64)
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

// An app pin's match string. Stored as the user gave it — the class picked
// off a running window, or a regex they typed — and turned into a Hyprland
// matcher by appPattern() at generation time. Control characters are stripped
// because the value ends up inside a Lua string literal, where a raw newline
// is a syntax error rather than an escape.
function normalizeAppMatch(value) {
  var text = String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
  if (text.length === 0) return null
  return text.slice(0, 120)
}

// One pin: the workspace it sends the app to, and which numbered slots of that
// workspace's layout its windows should take. An empty list means "wherever
// they land", which is what every pin is until a slot is picked.
//
// A list rather than a single slot because an app is not one window: two
// terminals can hold the left and right thirds, and the second one opened
// takes the second slot listed.
//
// `"slot": 2` is still read — it is what the short hand-written form says, and
// what this plugin's own config said before slots could be plural.
function normalizePin(value) {
  var raw = (value && typeof value === "object") ? value : { workspace: value }
  var workspace = normalizeWorkspaceId(raw.workspace)
  if (workspace === null) return null

  var name = normalizeAppMatch(raw.name)
  // How this app is started. Learned from the launch that first opened it, and
  // kept because the class it opens under may be nothing the machine's own
  // launchers mention — a terminal app's window is called what we asked the
  // terminal to call it, and no desktop entry says that.
  var command = String(raw.command === undefined || raw.command === null ? "" : raw.command)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 400)
  var input = (raw.slots instanceof Array) ? raw.slots : (raw.slot === undefined ? [] : [raw.slot])
  var slots = []
  var seen = {}
  for (var i = 0; i < input.length; i++) {
    var slot = Math.round(Number(input[i]))
    if (!isFiniteNumber(slot) || slot < 1 || slot > MAX_SLOTS || seen[slot]) continue
    seen[slot] = true
    slots.push(slot)
  }
  // Ascending, so the window opened first takes the leftmost place it was
  // given rather than whichever slot happened to be clicked first.
  slots.sort(function(a, b) { return a - b })
  var pin = { workspace: workspace, slots: slots }
  // Carried only when the class alone would be unreadable — a webapp's window
  // is called `chrome-discord.com__channels_@me-Default`, and nothing on the
  // machine maps that back to "Discord".
  if (name !== null) pin.name = name.slice(0, 60)
  if (command !== "") pin.command = command
  return pin
}

// Hyprland matches window rules by regex, and a bare class would match every
// class containing it — `foot` would claim `footclient` too. Anchor it, the
// same way the wiki writes matchers by hand. A match that already opens with
// `^` is left alone, so `^(firefox|chromium)$` typed into the field works.
function appPattern(match) {
  var text = String(match)
  if (text.charAt(0) === "^") return text
  return "^(" + text + ")$"
}

// Slot targeting is decided inside the layout callback, which is plain Lua with
// no regex engine, so it compares classes literally. This turns a match into
// the exact classes it stands for: a bare class is itself, `^(a|b)$` is both,
// and anything with real regex machinery in it gets no slot — the workspace
// pin still works, only the slot is out of reach.
//
// A dot is not treated as machinery: `org.gnome.Nautilus` is a class name, and
// reading its dots as wildcards would cost every GTK app its slot.
var REGEX_MACHINERY = /[\\^$*+?()\[\]{}|]/

function slotKeys(match) {
  var text = String(match)
  var wrapped = /^\^\((.*)\)\$$/.exec(text)
  var inner = wrapped ? wrapped[1] : text
  if (!wrapped && REGEX_MACHINERY.test(text)) return []
  var parts = inner.split("|")
  var out = []
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "" || REGEX_MACHINERY.test(parts[i])) return []
    out.push(parts[i])
  }
  return out
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

// What layout a workspace resolves to right now, most specific first: the
// workspace's own choice, then whatever its monitor asks for, then the
// profile's fallback.
function layoutIdForWorkspace(config, workspaceId, monitorName) {
  var profile = activeProfile(config)
  var key = normalizeWorkspaceId(workspaceId)
  if (key !== null && profile.assignments[key]) return profile.assignments[key]
  var monitor = normalizeMonitorName(monitorName)
  if (monitor !== null && profile.monitors && profile.monitors[monitor]) {
    return profile.monitors[monitor]
  }
  return profile.fallback
}

// The pins in the active profile, as a sorted list, so the generated file is
// stable across edits that only reorder the JSON.
function pinEntries(config) {
  var profile = activeProfile(config)
  var pins = (profile && profile.pins && typeof profile.pins === "object") ? profile.pins : {}
  var out = []
  for (var match in pins) {
    out.push({
      match: match,
      workspace: pins[match].workspace,
      slots: pins[match].slots,
      name: pins[match].name || "",
      command: pins[match].command || ""
    })
  }
  out.sort(function(a, b) { return a.match < b.match ? -1 : (a.match > b.match ? 1 : 0) })
  return out
}

// What the panel lists under one workspace.
function pinsForWorkspace(config, workspaceId) {
  var key = normalizeWorkspaceId(workspaceId)
  if (key === null) return []
  var entries = pinEntries(config)
  var out = []
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].workspace === key) out.push(entries[i])
  }
  return out
}

// Where an app is pinned right now, or "" — the panel says so before a click
// moves a pin from one workspace to another.
function pinnedWorkspace(config, match) {
  var clean = normalizeAppMatch(match)
  if (clean === null) return ""
  var profile = activeProfile(config)
  var pins = (profile && profile.pins && typeof profile.pins === "object") ? profile.pins : {}
  return pins[clean] ? pins[clean].workspace : ""
}

// The apps pinned to each numbered slot of a workspace, indexed from zero, so
// the canvas can write their names inside the tile they claim. A pin with no
// slot is not here — it belongs to the workspace, not to a place in it.
function slotApps(config, workspaceId) {
  var entries = pinsForWorkspace(config, workspaceId)
  var out = []
  for (var i = 0; i < entries.length; i++) {
    var slots = entries[i].slots
    for (var j = 0; j < slots.length; j++) {
      var slot = slots[j]
      while (out.length < slot) out.push([])
      out[slot - 1].push(entries[i].match)
    }
  }
  return out
}

// One entry in the catalogue the search reads: an app the panel knows about,
// either because a window of it is open or because the machine has a desktop
// entry for it. A plain string is the degenerate case — a class and nothing
// else — which is what a running window with no entry amounts to.
function normalizeCatalogEntry(value) {
  var raw = (value && typeof value === "object") ? value : { match: value }
  var match = normalizeAppMatch(raw.match)
  if (match === null) return null
  var name = normalizeAppMatch(raw.name)
  return {
    match: match,
    name: name === null ? match : name,
    command: String(raw.command || ""),
    // A command that needs a terminal wrapped around it before it is a window.
    terminal: raw.terminal === true,
    running: raw.running === true
  }
}

// The Apps search. Empty query lists what is pinned here and nothing else, so
// the section stays two lines until you go looking; typing searches the whole
// catalogue — every window open and every app installed — by name and by class.
//
// Ranking is running-before-installed and name-before-class, because the app
// you are looking at beats the app you merely own, and you searched for the
// word you read on screen rather than the class behind it.
//
// The query itself is always offered as a last row when it matches nothing
// exactly. That row is what pins an app the machine has no entry for — and
// what takes a hand-written matcher, so the search field is also the class
// field.
function searchApps(config, workspaceId, catalog, query, limit) {
  var key = normalizeWorkspaceId(workspaceId)
  var typed = normalizeAppMatch(query)
  var needle = typed === null ? "" : typed.toLowerCase()
  var cap = (limit === undefined || limit === null) ? 6 : limit
  var pinned = key === null ? [] : pinsForWorkspace(config, key)
  var list = (catalog instanceof Array) ? catalog : []
  var i

  var known = {}
  for (i = 0; i < list.length; i++) {
    var entry = normalizeCatalogEntry(list[i])
    if (entry === null) continue
    // First writer wins so a caller can order its own preferences; the panel
    // puts desktop entries in front of bare window classes.
    if (!known[entry.match]) known[entry.match] = entry
  }

  var rows = []
  var here = {}
  for (i = 0; i < pinned.length; i++) {
    var pin = pinned[i]
    here[pin.match] = true
    var pinEntry = known[pin.match]
    // A search narrows the pinned rows too. With nothing typed they are the
    // whole list, which is the point of the section; while typing, a pin that
    // has nothing to do with the query is in the way.
    if (needle !== "") {
      var pinName = (pinEntry ? pinEntry.name : pin.match).toLowerCase()
      if (pinName.indexOf(needle) === -1 && pin.match.toLowerCase().indexOf(needle) === -1) continue
    }
    rows.push({
      match: pin.match,
      name: pin.name || (pinEntry ? pinEntry.name : pin.match),
      command: pinEntry ? pinEntry.command : "",
      terminal: pinEntry ? pinEntry.terminal : false,
      running: pinEntry ? pinEntry.running : false,
      pinned: true,
      slots: pin.slots,
      elsewhere: "",
      literal: false
    })
  }

  var exact = typed !== null && here[typed] === true
  for (i = 0; i < pinned.length; i++) here[pinned[i].match] = true
  var hidden = 0

  if (needle !== "") {
    var scored = []
    for (var match in known) {
      if (here[match]) continue
      var candidate = known[match]
      var nameAt = candidate.name.toLowerCase().indexOf(needle)
      var classAt = candidate.match.toLowerCase().indexOf(needle)
      if (nameAt === -1 && classAt === -1) continue
      if (candidate.match === typed) exact = true
      // Lower sorts first: running beats installed, a name beats a class, and
      // a word that starts with what you typed beats one that merely contains
      // it.
      var rank = (candidate.running ? 0 : 4) +
        (nameAt === 0 || classAt === 0 ? 0 : 2) +
        (nameAt !== -1 ? 0 : 1)
      scored.push({ rank: rank, entry: candidate })
    }
    scored.sort(function(a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank
      return a.entry.name < b.entry.name ? -1 : (a.entry.name > b.entry.name ? 1 : 0)
    })

    var room = cap - rows.length
    if (room < 0) room = 0
    hidden = scored.length > room ? scored.length - room : 0
    for (i = 0; i < scored.length && i < room; i++) {
      var found = scored[i].entry
      rows.push({
        match: found.match,
        name: found.name,
        command: found.command,
        terminal: found.terminal,
        running: found.running,
        pinned: false,
        slots: [],
        elsewhere: pinnedWorkspace(config, found.match),
        literal: false
      })
    }
  }

  if (typed !== null && !exact) {
    rows.push({
      match: typed,
      name: typed,
      command: "",
      terminal: false,
      running: false,
      pinned: false,
      slots: [],
      elsewhere: pinnedWorkspace(config, typed),
      literal: true
    })
  }
  return { rows: rows, hidden: hidden }
}

// What the workspace is short of: for every app pinned here, how many more of
// its windows it would take to fill the places it was given.
//
// An app pinned to three places wants three windows, not one — pressing the
// button once should furnish the workspace, so each entry carries a count and
// the caller starts that many. Windows already here are subtracted; windows of
// the same app on another workspace are not, because the user put them there.
//
// `present` maps a window class to how many of its windows are on this
// workspace right now.
function missingApps(config, workspaceId, catalog, present) {
  var pins = pinsForWorkspace(config, workspaceId)
  var list = (catalog instanceof Array) ? catalog : []
  var here = (present && typeof present === "object") ? present : {}
  var known = {}
  var i
  for (i = 0; i < list.length; i++) {
    var entry = normalizeCatalogEntry(list[i])
    if (entry === null || known[entry.match]) continue
    known[entry.match] = entry
  }

  var out = []
  for (i = 0; i < pins.length; i++) {
    var found = known[pins[i].match]
    // What the pin remembers wins: it is the command that actually produced a
    // window of this class, which for a terminal app or a webapp is something
    // no desktop entry could have told us.
    var command = pins[i].command || (found ? found.command : "")
    // Nothing to run: the machine has no launcher for this class, and nobody
    // has told us one — which is what a hand-typed matcher usually is.
    if (command === "") continue
    var wanted = pins[i].slots.length > 0 ? pins[i].slots.length : 1
    var have = Number(here[pins[i].match]) || 0
    if (have >= wanted) continue
    out.push({
      match: pins[i].match,
      name: pins[i].name || (found ? found.name : pins[i].match),
      workspace: pins[i].workspace,
      command: command,
      // A remembered command is already whatever it needs to be.
      terminal: pins[i].command === "" && found ? found.terminal : false,
      count: wanted - have
    })
  }
  return out
}

// How many windows the "open these" button is about to start.
function missingCount(missing) {
  var total = 0
  var list = (missing instanceof Array) ? missing : []
  for (var i = 0; i < list.length; i++) total += Math.max(1, Number(list[i].count) || 1)
  return total
}

// ---------------------------------------------------------------- terminals

// A `Terminal=true` desktop entry — nvim, btop, a TUI music player — is a
// command, not a window. Run it as-is and the process exits the moment it
// finds no tty; run it in a terminal and the window carries the *terminal's*
// class, so the pin that asked for it never matches.
//
// Both go away by asking the terminal for a window class: `ghostty
// --class=nvim -e nvim` opens a window Hyprland calls `nvim`, which is what
// the pin was written against.
var TERMINALS = [
  { id: "ghostty", classFlag: "--class=", exec: "-e" },
  { id: "foot", classFlag: "--app-id=", exec: "-e" },
  { id: "alacritty", classFlag: "--class=", exec: "-e" },
  { id: "kitty", classFlag: "--class=", exec: "" },
  { id: "wezterm", classFlag: "--class=", exec: "start --" }
]

// The window class to ask a terminal for. Not the class the user typed: GTK
// refuses an app id with no dot in it, so ghostty ignores `--class=nvim`
// outright and a terminal app has to be given a name of our own making. The
// pin learns it from the window that appears, and keeps beside it the command
// that produced it.
function terminalClassFor(match, workspaceId) {
  var clean = normalizeAppMatch(match)
  // slugify() answers "layout" for nothing at all, which would be a lie here.
  var slug = clean === null ? "" : slugify(clean).replace(/[^a-z0-9]/g, "")
  if (slug === "") slug = "app"
  // The workspace is part of the name so the same program pinned to two
  // workspaces gets two classes. Sharing one, the second pin could never be
  // told from the first, and the rule would send both windows to one place.
  var where = normalizeWorkspaceId(workspaceId)
  // `ws` first because a GTK app id element may not start with a digit.
  return "omarchy.wsl." + slug + (where === null ? "" : ".ws" + where)
}

function terminalSpec(id) {
  for (var i = 0; i < TERMINALS.length; i++) {
    if (TERMINALS[i].id === String(id)) return TERMINALS[i]
  }
  return null
}

// The command that opens `command` in a terminal window called `appClass`.
// With no terminal we recognise, fall back to the desktop standard: the app
// opens, but under the terminal's own class, so a pin cannot place it.
function terminalLaunch(terminal, appClass, command) {
  var cmd = String(command || "").trim()
  if (cmd === "") return ""
  var spec = terminalSpec(terminal)
  if (spec === null) return "xdg-terminal-exec " + cmd
  var parts = [spec.id]
  // Ghostty hands a second invocation to the instance already running, which
  // keeps its own class; only a fresh process can be given another.
  if (spec.id === "ghostty") parts.push("--gtk-single-instance=false")
  var cls = normalizeAppMatch(appClass)
  if (cls !== null) parts.push(spec.classFlag + cls)
  if (spec.exec !== "") parts.push(spec.exec)
  parts.push(cmd)
  return parts.join(" ")
}

// The word an app is known by, reduced to something a window class can be
// searched for: "Signal Desktop" and "signal-desktop" both come out "signal".
function launchToken(text) {
  var out = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
  return out.slice(0, 24)
}

// Pair the windows that just appeared with the launches we are waiting on.
//
// A desktop entry does not have to say what its windows will be called, and
// for a webapp it never does: Omarchy's Discord entry launches Chromium, whose
// window turns up as `chrome-discord.com__channels_@me-Default`. A pin made
// from that entry would name a class no window ever has, so the rule would sit
// there doing nothing — which is exactly what a pin looks like when it is
// broken. Rather than guess harder, watch what the launch actually opened.
//
// Only confident pairings are returned: a class carrying the app's own name,
// or a single new window when a single launch is outstanding. Anything
// ambiguous is left alone — a wrong pin is worse than none.
function matchLaunchedWindows(pending, fresh) {
  var waiting = (pending instanceof Array) ? pending : []
  var classes = (fresh instanceof Array) ? fresh : []
  var pairs = []
  var claimed = {}
  var i, j

  for (i = 0; i < waiting.length; i++) {
    var want = waiting[i]
    var tokens = [launchToken(want.name), launchToken(want.match)]
    var hits = []
    for (j = 0; j < classes.length; j++) {
      if (claimed[classes[j]]) continue
      var lower = String(classes[j]).toLowerCase()
      for (var t = 0; t < tokens.length; t++) {
        if (tokens[t].length >= 3 && lower.indexOf(tokens[t]) !== -1) {
          hits.push(classes[j])
          break
        }
      }
    }
    if (hits.length === 1) {
      claimed[hits[0]] = true
      pairs.push({ match: want.match, become: hits[0] })
    }
  }

  // No "one launch, one new window, they must be the same" fallback: a
  // keyring prompt that happens to appear while an app is starting would
  // steal the pin, and a wrong pin is worse than none. If a class shares
  // nothing with the app's name, the pin stays as written.
  return pairs
}

// Open an app on a particular workspace, whether or not anything is pinned:
// Hyprland's own exec takes the workspace as a rule, and `silent` keeps the
// launch from dragging the user's view to it.
function launchAppLua(command, workspaceId) {
  var target = normalizeWorkspaceId(workspaceId)
  var cmd = String(command || "").replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (target === null || cmd.length === 0) return ""
  return "hl.exec_cmd(" + luaString(cmd) + ", { workspace = " +
    luaString(target + " silent") + " })"
}

function uniqueProfileName(config, base) {
  var name = sanitizeName(base, "profile")
  if (!findProfile(config, name)) return name
  var suffix = 2
  while (findProfile(config, name + " " + suffix)) suffix++
  return name + " " + suffix
}

// Swap two places: every app that was in one is now in the other. Places are
// numbered in fill order, so this is the drag the canvas offers — pick up the
// tile with the browser in it, drop it on the tile with the terminal, and the
// two exchange.
function swappedPins(pins, workspaceId, a, b) {
  var key = normalizeWorkspaceId(workspaceId)
  var from = Math.round(Number(a))
  var to = Math.round(Number(b))
  var out = {}
  var input = (pins && typeof pins === "object") ? pins : {}
  for (var match in input) {
    var pin = normalizePin(input[match])
    if (pin === null) continue
    if (key === null || pin.workspace !== key || from === to) {
      out[match] = input[match]
      continue
    }
    var slots = []
    for (var i = 0; i < pin.slots.length; i++) {
      var slot = pin.slots[i]
      slots.push(slot === from ? to : (slot === to ? from : slot))
    }
    slots.sort(function(x, y) { return x - y })
    var next = { workspace: pin.workspace, slots: slots }
    if (pin.name) next.name = pin.name
    if (pin.command) next.command = pin.command
    out[match] = next
  }
  return out
}

// ------------------------------------------------------------- moving places

// The layout as slots of parts of pieces, each piece carrying the apps pinned
// to it. Everything about a drop is easier to say in this shape than in
// weights, cells and place numbers — and turning it back afterwards renumbers
// the pins for free, which is the part that is easy to get wrong.
function placeTree(layout, pins, workspaceId) {
  var spec = normalizeLayout(layout)
  var apps = slotApps({ profiles: [{ name: "x", pins: pins || {}, fallback: "dwindle" }],
    activeProfile: "x", layouts: [] }, workspaceId)
  var addresses = placeAddresses(spec, totalCells(spec.cells))

  var number = {}
  for (var i = 0; i < addresses.length; i++) {
    var at = addresses[i]
    number[at.slot + ":" + at.part + ":" + at.piece] = i + 1
  }

  var slots = []
  for (var s = 0; s < spec.weights.length; s++) {
    var parts = []
    for (var p = 0; p < spec.cells[s].length; p++) {
      var split = partSplit(spec.cells[s][p])
      var count = split.length > 1 ? split.length : 1
      var pieces = []
      for (var q = 0; q < count; q++) {
        var place = number[s + ":" + p + ":" + q]
        pieces.push({
          weight: split.length > 1 ? split[q] : 100,
          apps: (place !== undefined && apps.length >= place) ? apps[place - 1].slice() : []
        })
      }
      parts.push({ weight: partWeight(spec.cells[s][p]), pieces: pieces })
    }
    slots.push({ weight: spec.weights[s], parts: parts })
  }
  return slots
}

// Back to a layout, and to the pins that go with it: an app's places are
// wherever its name ended up in the tree, numbered in the new fill order.
function placeTreeToShape(layout, slots, pins, workspaceId) {
  var spec = normalizeLayout(layout)
  var weights = []
  var cells = []
  var kept = []
  var i, j, q

  for (i = 0; i < slots.length; i++) {
    var parts = []
    for (j = 0; j < slots[i].parts.length; j++) {
      var part = slots[i].parts[j]
      if (part.pieces.length === 0) continue
      if (part.pieces.length === 1) parts.push(part.weight)
      else {
        var inner = []
        for (q = 0; q < part.pieces.length; q++) inner.push(part.pieces[q].weight)
        parts.push({ weight: part.weight, parts: inner })
      }
    }
    if (parts.length === 0) continue
    weights.push(slots[i].weight)
    cells.push(parts)
    kept.push(i)
  }
  if (weights.length === 0) return null

  var shape = normalizeLayout({
    id: spec.id, name: spec.name, kind: spec.kind, orientation: spec.orientation,
    overflow: spec.overflow, fill: spec.fill, underfill: spec.underfill,
    gridColumns: spec.gridColumns, weights: weights, cells: cells
  })

  var addresses = placeAddresses(shape, totalCells(shape.cells))
  var number = {}
  for (i = 0; i < addresses.length; i++) {
    var at = addresses[i]
    number[at.slot + ":" + at.part + ":" + at.piece] = i + 1
  }

  var wanted = {}
  for (i = 0; i < kept.length; i++) {
    var live = 0
    for (j = 0; j < slots[kept[i]].parts.length; j++) {
      var source = slots[kept[i]].parts[j]
      if (source.pieces.length === 0) continue
      for (q = 0; q < source.pieces.length; q++) {
        var place = number[i + ":" + live + ":" + q]
        var here = source.pieces[q].apps
        for (var a = 0; a < here.length; a++) {
          if (!wanted[here[a]]) wanted[here[a]] = []
          if (place !== undefined && wanted[here[a]].indexOf(place) === -1) wanted[here[a]].push(place)
        }
      }
      live++
    }
  }

  var key = normalizeWorkspaceId(workspaceId)
  var out = {}
  var input = (pins && typeof pins === "object") ? pins : {}
  for (var match in input) {
    var pin = normalizePin(input[match])
    if (pin === null) continue
    if (key === null || pin.workspace !== key) {
      out[match] = input[match]
      continue
    }
    var next = {
      workspace: pin.workspace,
      slots: (wanted[match] || []).sort(function(x, y) { return x - y })
    }
    if (pin.name) next.name = pin.name
    if (pin.command) next.command = pin.command
    out[match] = next
  }
  return { weights: shape.weights, cells: shape.cells, pins: out }
}

// Which edges of a place can be dropped on: all four, for any place of a ratio
// layout. Three levels are enough for that — a slot with one thing in it
// becomes two slots, a part gets another part beside it, and a part divides
// into pieces along the grain — so there is no cut left to refuse.
function dropDirections(layout, place) {
  var spec = normalizeLayout(layout)
  var addresses = placeAddresses(spec, totalCells(spec.cells))
  if (spec.kind === "grid" || addresses[Math.round(Number(place)) - 1] === undefined) return {}
  return { left: true, right: true, top: true, bottom: true }
}

// Drop one place onto an edge of another: the place being carried is taken out
// of the shape, the place under the cursor is cut in two, and the apps land in
// the half nearest the edge. What a tiling window manager does when you move a
// window onto the side of another, except that it is written down.
function movePlaceInto(layout, pins, workspaceId, fromPlace, toPlace, edge) {
  var spec = normalizeLayout(layout)
  if (spec.kind === "grid") return null
  var from = Math.round(Number(fromPlace))
  var to = Math.round(Number(toPlace))
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || from === to) return null
  if (!dropDirections(spec, to)[edge]) return null

  var addresses = placeAddresses(spec, totalCells(spec.cells))
  if (from > addresses.length || to > addresses.length || from < 1 || to < 1) return null
  var source = { slot: addresses[from - 1].slot, part: addresses[from - 1].part,
    piece: addresses[from - 1].piece }
  var target = addresses[to - 1]

  var slots = placeTree(spec, pins, workspaceId)
  var carried = slots[source.slot].parts[source.part].pieces[source.piece].apps.slice()
  var first = edge === "left" || edge === "top"
  var alongEdges = spec.orientation === "rows"
    ? { top: true, bottom: true } : { left: true, right: true }

  if (alongEdges[edge]) {
    var slot = slots[target.slot]
    var part = slot.parts[target.part]
    if (slot.parts.length === 1 && part.pieces.length === 1) {
      // A slot holding one thing: it becomes two slots side by side.
      var half = slot.weight / 2
      slot.weight = half
      slots.splice(target.slot + (first ? 0 : 1), 0,
        { weight: half, parts: [{ weight: 100, pieces: [{ weight: 100, apps: carried }] }] })
      if (source.slot >= target.slot + (first ? 0 : 1)) source.slot += 1
    } else {
      // A part of a slot: the part divides along the grain instead, which is
      // the level that lets a stacked half become two columns.
      var piece = part.pieces[target.piece]
      var share = piece.weight / 2
      piece.weight = share
      part.pieces.splice(target.piece + (first ? 0 : 1), 0, { weight: share, apps: carried })
      if (source.slot === target.slot && source.part === target.part
        && source.piece >= target.piece + (first ? 0 : 1)) source.piece += 1
    }
  } else {
    var into = slots[target.slot]
    var whole = into.parts[target.part]
    var band = whole.weight / 2
    whole.weight = band
    into.parts.splice(target.part + (first ? 0 : 1), 0,
      { weight: band, pieces: [{ weight: 100, apps: carried }] })
    if (source.slot === target.slot && source.part >= target.part + (first ? 0 : 1)) source.part += 1
  }

  // Take the carried place out. A part or a slot left holding nothing goes
  // too, and its room is shared out by the normalizing on the way back.
  var origin = slots[source.slot].parts[source.part]
  origin.pieces.splice(source.piece, 1)
  if (origin.pieces.length === 0) slots[source.slot].parts.splice(source.part, 1)

  return placeTreeToShape(spec, slots, pins, workspaceId)
}

// ------------------------------------------------------------------ capture

// Group windows that share a band of the main axis: the columns of a columns
// layout, the rows of a rows layout. Two windows belong together when their
// extents overlap by more than half of the narrower one, which is loose enough
// to survive gaps and borders and tight enough not to merge real neighbours.
function bandGroups(items, startKey, sizeKey) {
  var sorted = items.slice().sort(function(a, b) { return a[startKey] - b[startKey] })
  var groups = []
  for (var i = 0; i < sorted.length; i++) {
    var item = sorted[i]
    var placed = false
    for (var g = 0; g < groups.length; g++) {
      var band = groups[g]
      var overlap = Math.min(band.end, item[startKey] + item[sizeKey]) -
        Math.max(band.start, item[startKey])
      if (overlap > Math.min(band.end - band.start, item[sizeKey]) / 2) {
        band.start = Math.min(band.start, item[startKey])
        band.end = Math.max(band.end, item[startKey] + item[sizeKey])
        band.items.push(item)
        placed = true
        break
      }
    }
    if (!placed) {
      groups.push({
        start: item[startKey],
        end: item[startKey] + item[sizeKey],
        items: [item]
      })
    }
  }
  groups.sort(function(a, b) { return a.start - b.start })
  return groups
}

// Read a workspace back into a layout: the shape the windows are already in,
// plus a pin for every app saying which place it was in.
//
// Approximate by construction — an arbitrary arrangement is not always a row
// of columns — but the arrangements people build by hand almost always are,
// and an approximation you can then drag is worth more than a refusal.
//
// `windows` are `{ class, x, y, w, h }` in any consistent unit; the bounding
// box of the set is taken as the screen, which drops the outer gap for free.
function captureLayout(windows) {
  var items = []
  var list = (windows instanceof Array) ? windows : []
  var i, j
  for (i = 0; i < list.length; i++) {
    var raw = list[i]
    if (!raw) continue
    var box = {
      match: normalizeAppMatch(raw.class),
      x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h)
    }
    if (box.match === null) continue
    if (!isFiniteNumber(box.x) || !isFiniteNumber(box.y)) continue
    if (!isFiniteNumber(box.w) || !isFiniteNumber(box.h) || box.w <= 0 || box.h <= 0) continue
    items.push(box)
  }
  if (items.length === 0) return null

  var columns = bandGroups(items, "x", "w")
  var rows = bandGroups(items, "y", "h")
  // Whichever axis the windows are actually divided along. A tie — one window,
  // or a grid — reads as columns, which is how the rest of the plugin defaults.
  var byColumns = columns.length >= rows.length
  var bands = byColumns ? columns : rows
  var startKey = byColumns ? "x" : "y"
  var sizeKey = byColumns ? "w" : "h"
  var crossStart = byColumns ? "y" : "x"
  var crossSize = byColumns ? "h" : "w"

  var span = 0
  for (i = 0; i < bands.length; i++) span += bands[i].end - bands[i].start
  if (span <= 0) return null

  var weights = []
  var cells = []
  var order = []
  for (i = 0; i < bands.length; i++) {
    var band = bands[i]
    weights.push((band.end - band.start) / span * 100)
    var members = band.items.slice().sort(function(a, b) { return a[crossStart] - b[crossStart] })
    var extent = 0
    for (j = 0; j < members.length; j++) extent += members[j][crossSize]
    var parts = []
    for (j = 0; j < members.length; j++) {
      parts.push(extent > 0 ? members[j][crossSize] / extent * 100 : 100)
      order.push({ slot: i, part: j, match: members[j].match })
    }
    cells.push(parts)
  }

  var layout = normalizeLayout({
    id: "captured",
    name: "Captured",
    orientation: byColumns ? "columns" : "rows",
    weights: weights,
    cells: cells,
    // The shape was read off a full workspace: it should stay that shape when
    // a window closes rather than reflowing into something else.
    underfill: "hold"
  })

  // Which numbered place each window ended up in. The canvas numbers places in
  // fill order, so walk the drawn rects and count the parts of each slot as
  // they come.
  var positions = rectSlotPositions(layout, totalCells(layout.cells))
  var seen = {}
  var placeOf = {}
  for (i = 0; i < positions.length; i++) {
    var slot = positions[i]
    var part = seen[slot] === undefined ? 0 : seen[slot]
    seen[slot] = part + 1
    placeOf[slot + ":" + part] = i + 1
  }

  var pins = {}
  for (i = 0; i < order.length; i++) {
    var place = placeOf[order[i].slot + ":" + order[i].part]
    if (place === undefined) continue
    var key = order[i].match
    if (!pins[key]) pins[key] = []
    // Two windows of the same app become two places on one pin, which is what
    // the pin was made plural for.
    if (pins[key].indexOf(place) === -1) pins[key].push(place)
  }
  for (var match in pins) pins[match].sort(function(a, b) { return a - b })

  return { layout: layout, pins: pins }
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
  '-- Added after the first release: a compositor still running the older',
  '-- runtime has a W without this table, and reload must not lose its rules.',
  'W.app_rules = W.app_rules or {}',
  'W.specs = {}',
  '-- workspace -> class -> the places that class wants there. Per workspace,',
  '-- because the same app pinned to slot 1 of one workspace must not claim',
  '-- slot 1 of every other workspace it happens to open on.',
  'W.slots = {}',
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
  '-- A part is either a plain cross weight or a table saying how wide it is and',
  '-- how it is cut along the grain again.',
  'local function part_weight(part)',
  '  if type(part) == "table" then return part.weight end',
  '  return part',
  'end',
  '',
  'local function part_split(part)',
  '  if type(part) == "table" and part.parts then return part.parts end',
  '  return {}',
  'end',
  '',
  'local function part_pieces(part)',
  '  local split = part_split(part)',
  '  if #split > 1 then return #split end',
  '  return 1',
  'end',
  '',
  '-- Even parts for a slot: what overflow stacking falls back to when it adds',
  '-- parts to a slot whose ratio was drawn for fewer of them.',
  'local function even_cell(count)',
  '  local out = {}',
  '  for i = 1, count do out[i] = 100 / count end',
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
  '  local counts = spec.cells',
  '  local k = #weights',
  '  local primary, subs = {}, {}',
  '  local base = 0',
  '  for i = 1, k do',
  '    for j = 1, #counts[i] do base = base + part_pieces(counts[i][j]) end',
  '  end',
  '  -- A layout with a split slot was drawn in two dimensions and holds: there',
  '  -- is no sensible way to grow one of its halves into the missing window.',
  '  local split = base > k',
  '',
  '  if n <= base and (spec.underfill == "hold" or split) then',
  '    for i = 1, k do primary[i] = weights[i]; subs[i] = counts[i] end',
  '  elseif n <= base then',
  '    local chosen = {}',
  '    local priority = fill_order(weights)',
  '    for i = 1, n do chosen[i] = priority[i] end',
  '    table.sort(chosen)',
  '    for i = 1, n do primary[i] = weights[chosen[i]]; subs[i] = { 100 } end',
  '  elseif spec.overflow == "extend" then',
  '    for i = 1, k do primary[i] = weights[i]; subs[i] = counts[i] end',
  '    local grown = base',
  '    while grown < n do',
  '      primary[#primary + 1] = weights[k]',
  '      subs[#subs + 1] = { 100 }',
  '      grown = grown + 1',
  '    end',
  '  else',
  '    for i = 1, k do primary[i] = weights[i]; subs[i] = counts[i] end',
  '    local at = (spec.overflow == "first") and 1 or k',
  '    local held = 0',
  '    for i = 1, #subs[at] do held = held + part_pieces(subs[at][i]) end',
  '    subs[at] = even_cell(held + n - base)',
  '  end',
  '',
  '  primary = normalize(primary)',
  '',
  '  local cells, cell_slot = {}, {}',
  '  local offset = 0',
  '  for slot = 1, #primary do',
  '    local size = primary[slot] / 100',
  '    if slot == #primary then size = 1 - offset end',
  '    local list = subs[slot]',
  '    local weights_of = {}',
  '    for s = 1, #list do weights_of[s] = part_weight(list[s]) end',
  '    local parts = normalize(weights_of)',
  '    local crossed = 0',
  '    for s = 1, #parts do',
  '      local sub_size = parts[s] / 100',
  '      if s == #parts then sub_size = 1 - crossed end',
  '      local split = part_split(list[s])',
  '      if #split > 1 then',
  '        -- The part is cut again, back along the grain.',
  '        local inner = normalize(split)',
  '        local run = 0',
  '        for q = 1, #inner do',
  '          local inner_size = size * inner[q] / 100',
  '          if q == #inner then inner_size = size - run end',
  '          cells[#cells + 1] = orient(spec.orientation, offset + run, inner_size, crossed, sub_size)',
  '          cell_slot[#cell_slot + 1] = slot',
  '          run = run + inner_size',
  '        end',
  '      else',
  '        cells[#cells + 1] = orient(spec.orientation, offset, size, crossed, sub_size)',
  '        cell_slot[#cell_slot + 1] = slot',
  '      end',
  '      crossed = crossed + sub_size',
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
  '-- Which rect each window takes. W.rects hands them back in fill order —',
  '-- the same order the canvas numbers its slots — so a targeted class is',
  '-- simply an index into that list, and everyone else keeps the order',
  '-- Hyprland handed them in, filling whatever is left.',
  '--',
  '-- A class holds a *list* of slots, so a second window of the same app takes',
  '-- the next place on its list rather than fighting the first for one.',
  '--',
  '-- A slot nobody can have right now (a 3 with two windows open) is skipped',
  '-- rather than held empty: the window falls back to its normal place.',
  'function W.assign(targets, n)',
  '  local out, taken = {}, {}',
  '  for i = 1, n do',
  '    local win = targets[i].window',
  '    local wants = nil',
  '    if win then',
  '      local ok, class = pcall(function() return win.class end)',
  '      local fine, ws = pcall(function() return win.workspace and win.workspace.id end)',
  '      if ok and class and fine and ws then',
  '        local here = W.slots[tostring(ws)]',
  '        if here then wants = here[class] end',
  '      end',
  '    end',
  '    if wants then',
  '      for k = 1, #wants do',
  '        local want = wants[k]',
  '        if want >= 1 and want <= n and not taken[want] then',
  '          out[i] = want',
  '          taken[want] = true',
  '          break',
  '        end',
  '      end',
  '    end',
  '  end',
  '  local free = 1',
  '  for i = 1, n do',
  '    if not out[i] then',
  '      while taken[free] do free = free + 1 end',
  '      out[i] = free',
  '      taken[free] = true',
  '    end',
  '  end',
  '  return out',
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
  '  local pick = W.assign(ctx.targets, n)',
  '  for i = 1, n do',
  '    local r = rects[pick[i]]',
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
  '-- App pins, as window rules. Unlike a workspace rule there is no fixed set',
  '-- of keys to overwrite — a pin the user deleted simply is not in the new',
  '-- file — so every rule this plugin owns is retired before the current set',
  '-- is installed, and the table is rebuilt from scratch.',
  'function W.reset_apps()',
  '  for _, rule in pairs(W.app_rules) do',
  '    pcall(function() rule:set_enabled(false) end)',
  '  end',
  '  W.app_rules = {}',
  'end',
  '',
  '-- `silent` keeps a window that opens while you are elsewhere from dragging',
  '-- your view to its workspace, which is the whole point of pinning it there.',
  'function W.set_slot(ws, class, slots)',
  '  if not W.slots[ws] then W.slots[ws] = {} end',
  '  W.slots[ws][class] = slots',
  'end',
  '',
  'function W.set_app(match, pattern, ws)',
  '  W.app_rules[match] = hl.window_rule({',
  '    name = "omarchy-wsl-pin-" .. match,',
  '    match = { class = pattern },',
  '    workspace = ws .. " silent",',
  '  })',
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
  var cells = []
  for (i = 0; i < spec.cells.length; i++) {
    var parts = []
    for (var p = 0; p < spec.cells[i].length; p++) {
      var part = spec.cells[i][p]
      var split = partSplit(part)
      if (split.length > 1) {
        var inner = []
        for (var q = 0; q < split.length; q++) inner.push(luaNumber(split[q]))
        parts.push("{ weight = " + luaNumber(partWeight(part)) +
          ", parts = { " + inner.join(", ") + " } }")
      } else {
        parts.push(luaNumber(partWeight(part)))
      }
    }
    cells.push("{ " + parts.join(", ") + " }")
  }
  return "W.specs[" + luaString(spec.id) + "] = { " +
    "kind = " + luaString(spec.kind) + ", " +
    "orientation = " + luaString(spec.orientation) + ", " +
    "overflow = " + luaString(spec.overflow) + ", " +
    "fill = " + luaString(spec.fill) + ", " +
    "underfill = " + luaString(spec.underfill) + ", " +
    "grid_columns = " + luaNumber(spec.gridColumns) + ", " +
    "cells = { " + cells.join(", ") + " }, " +
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
function generateLua(config, liveWorkspaceIds, workspaceMonitors) {
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
  var screens = (workspaceMonitors && typeof workspaceMonitors === "object") ? workspaceMonitors : {}
  for (i = 0; i < workspaces.length; i++) {
    // Resolved per workspace with the monitor it is on right now: a monitor
    // default is a property of where the workspace *is*, so the file is
    // rewritten when workspaces move between screens.
    var id = layoutIdForWorkspace(normalized, workspaces[i], screens[workspaces[i]])
    lines.push("W.set_workspace(" + luaString(workspaces[i]) + ", " +
      luaString(luaLayoutRef(id)) + ")")
  }
  lines.push("")

  // Emitted unconditionally: with no pins left this is the line that takes the
  // last one's rule back off Hyprland.
  lines.push("W.reset_apps()")
  var pins = pinEntries(normalized)
  for (i = 0; i < pins.length; i++) {
    lines.push("W.set_app(" + luaString(pins[i].match) + ", " +
      luaString(appPattern(pins[i].match)) + ", " + luaString(pins[i].workspace) + ")")
    if (pins[i].slots.length === 0) continue
    // The layout callback compares classes literally, so a match it cannot
    // reduce to plain class names keeps its workspace and loses its slots.
    var keys = slotKeys(pins[i].match)
    var wanted = []
    for (var s = 0; s < pins[i].slots.length; s++) wanted.push(luaNumber(pins[i].slots[s]))
    for (var j = 0; j < keys.length; j++) {
      lines.push("W.set_slot(" + luaString(pins[i].workspace) + ", " +
        luaString(keys[j]) + ", { " + wanted.join(", ") + " })")
    }
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

// A window rule only fires when a window opens, so pinning an app that is
// already running would otherwise do nothing until you closed and reopened it.
// This is the one-shot catch-up, run when a pin is created and never on a
// plain sync — a window the user deliberately dragged elsewhere afterwards
// should stay where they put it.
//
// `hl.get_windows` filters by an exact class, *not* by a regex the way a window
// rule does, so this asks for the plain classes the match stands for rather
// than the anchored pattern. A match too clever to reduce to class names gets
// no catch-up: its rule still governs every window it opens from now on.
//
// Self-contained rather than a W.* function: it has to work on a session whose
// generated file predates this feature, before the new runtime has been eval'd.
function gatherAppLua(match, workspaceId) {
  var target = normalizeWorkspaceId(workspaceId)
  var clean = normalizeAppMatch(match)
  if (target === null || clean === null) return ""
  var classes = slotKeys(clean)
  if (classes.length === 0) return ""
  var quoted = []
  for (var i = 0; i < classes.length; i++) quoted.push(luaString(classes[i]))
  return [
    "for _, class in ipairs({ " + quoted.join(", ") + " }) do",
    "  local ok, windows = pcall(function() return hl.get_windows({ class = class }) end)",
    "  if ok and windows then",
    "    for i = 1, #windows do",
    // follow = false is the silent move: the windows come to the workspace,
    // the view stays where the user is.
    "      pcall(function() hl.dispatch(hl.dsp.window.move(" +
      "{ workspace = " + Number(target) + ", window = windows[i], follow = false })) end)",
    "    end",
    "  end",
    "end"
  ].join("\n")
}

// --------------------------------------------------------------- reporting

// One line about a workspace, for `workspace-layout status`. Written for a
// terminal: what it is tiling with, which profile decided that, and what is
// pinned there.
function statusLine(config, workspaceId, monitorName) {
  var key = normalizeWorkspaceId(workspaceId)
  if (key === null) return "workspace " + workspaceId + " is out of range"
  var profile = activeProfile(config)
  var id = layoutIdForWorkspace(config, key, monitorName)
  var layout = findLayout(config, id)
  var monitor = normalizeMonitorName(monitorName)

  var source = "profile default"
  if (profile.assignments[key]) source = "workspace"
  else if (monitor !== null && profile.monitors[monitor]) source = "monitor " + monitor

  var parts = ["workspace " + key]
  parts.push(layout ? layout.name + " (" + describeLayout(layout) + ")" : "Hyprland " + id)
  parts.push("from " + source)
  parts.push("profile " + profile.name)

  var pins = pinsForWorkspace(config, key)
  if (pins.length > 0) {
    var apps = []
    for (var i = 0; i < pins.length; i++) {
      var label = pins[i].name || pins[i].match
      apps.push(pins[i].slots.length > 0 ? label + "@" + pins[i].slots.join(",") : label)
    }
    parts.push("apps " + apps.join(" "))
  }
  return parts.join(" · ")
}

// The whole picture as data, for `workspace-layout json`. Everything a script
// could want to read without parsing the config file itself — including how
// each workspace currently resolves, which the file does not say.
function stateJson(config, workspaceMonitors, liveWorkspaceIds) {
  var normalized = normalizeConfig(config)
  var profile = activeProfile(normalized)
  var screens = (workspaceMonitors && typeof workspaceMonitors === "object") ? workspaceMonitors : {}
  var ids = managedWorkspaceIds(normalized, liveWorkspaceIds)
  var i

  var workspaces = []
  for (i = 0; i < ids.length; i++) {
    var id = layoutIdForWorkspace(normalized, ids[i], screens[ids[i]])
    var layout = findLayout(normalized, id)
    workspaces.push({
      workspace: Number(ids[i]),
      monitor: screens[ids[i]] || "",
      layout: id,
      name: layout ? layout.name : id,
      builtin: isBuiltin(id),
      places: layout ? totalCells(layout.cells) : 0
    })
  }

  var layouts = []
  for (i = 0; i < normalized.layouts.length; i++) {
    var each = normalized.layouts[i]
    layouts.push({
      id: each.id,
      name: each.name,
      kind: each.kind,
      orientation: each.orientation,
      weights: each.weights,
      cells: each.cells,
      places: totalCells(each.cells)
    })
  }

  var names = []
  for (i = 0; i < normalized.profiles.length; i++) names.push(normalized.profiles[i].name)

  return {
    profile: profile.name,
    profiles: names,
    fallback: profile.fallback,
    monitors: profile.monitors,
    workspaces: workspaces,
    layouts: layouts,
    pins: pinEntries(normalized)
  }
}

// `1,3` or `1 3` — how a slot list arrives from a shell.
function parseSlots(text) {
  var out = []
  var parts = String(text === undefined || text === null ? "" : text).split(/[^0-9]+/)
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue
    var slot = Math.round(Number(parts[i]))
    if (!isFiniteNumber(slot) || slot < 1 || slot > MAX_SLOTS || out.indexOf(slot) !== -1) continue
    out.push(slot)
  }
  out.sort(function(a, b) { return a - b })
  return out
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
    dividerScale: dividerScale,
    setDivider: setDivider,
    addSlot: addSlot,
    removeSlot: removeSlot,
    splitSlot: splitSlot,
    normalizeCells: normalizeCells,
    totalCells: totalCells,
    cellParts: cellParts,
    partWeight: partWeight,
    partSplit: partSplit,
    partPieces: partPieces,
    shapeAddSlot: shapeAddSlot,
    shapeRemoveSlot: shapeRemoveSlot,
    shapeSplitAlong: shapeSplitAlong,
    shapeSplitAcross: shapeSplitAcross,
    shapeMerge: shapeMerge,
    shapeSetCell: shapeSetCell,
    shapeSetPiece: shapeSetPiece,
    growForCount: growForCount,
    rectSlotPositions: rectSlotPositions,
    placeAddresses: placeAddresses,
    slotRects: slotRects,
    sanitizeName: sanitizeName,
    slugify: slugify,
    uniqueLayoutId: uniqueLayoutId,
    customLayoutId: customLayoutId,
    uniqueLayoutName: uniqueLayoutName,
    normalizeLayout: normalizeLayout,
    describeLayout: describeLayout,
    formatWeight: formatWeight,
    presets: presets,
    isPreset: isPreset,
    isBuiltin: isBuiltin,
    defaultConfig: defaultConfig,
    normalizeConfig: normalizeConfig,
    normalizeProfile: normalizeProfile,
    normalizeWorkspaceId: normalizeWorkspaceId,
    normalizeMonitorName: normalizeMonitorName,
    findLayout: findLayout,
    findProfile: findProfile,
    activeProfile: activeProfile,
    layoutIdForWorkspace: layoutIdForWorkspace,
    normalizeAppMatch: normalizeAppMatch,
    normalizePin: normalizePin,
    slotKeys: slotKeys,
    slotApps: slotApps,
    swappedPins: swappedPins,
    dropDirections: dropDirections,
    movePlaceInto: movePlaceInto,
    captureLayout: captureLayout,
    appPattern: appPattern,
    pinEntries: pinEntries,
    pinsForWorkspace: pinsForWorkspace,
    pinnedWorkspace: pinnedWorkspace,
    searchApps: searchApps,
    normalizeCatalogEntry: normalizeCatalogEntry,
    launchAppLua: launchAppLua,
    terminalLaunch: terminalLaunch,
    terminalClassFor: terminalClassFor,
    missingApps: missingApps,
    missingCount: missingCount,
    launchToken: launchToken,
    matchLaunchedWindows: matchLaunchedWindows,
    gatherAppLua: gatherAppLua,
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
    statusLine: statusLine,
    stateJson: stateJson,
    parseSlots: parseSlots,
    loaderLine: loaderLine,
    needsLoader: needsLoader,
    withLoader: withLoader
  }
}
