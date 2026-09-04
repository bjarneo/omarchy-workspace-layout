const test = require("node:test")
const assert = require("node:assert/strict")
const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const Model = require("../Model.js")

// --------------------------------------------------- lua interpreter bridge
//
// The panel draws slotRects(); Hyprland runs the Lua. If those two ever
// disagree the preview becomes a lie, so several tests below run the real
// generated Lua through the `lua` interpreter and diff it against the JS.

function lua_prelude() {
  // LUA_RUNTIME calls into `hl`, which only exists inside Hyprland. Stub the
  // two entry points it touches at load time so the file can be required in a
  // plain interpreter.
  return [
    "hl = { layout = { register = function() end },",
    "       workspace_rule = function() return { set_enabled = function() end } end,",
    "       dispatch = function() end, dsp = { layout = function() end } }"
  ].join("\n")
}

function runLua(source) {
  const result = childProcess.spawnSync("lua", ["-"], { input: source, encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`lua exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

const luaAvailable = (() => {
  const probe = childProcess.spawnSync("lua", ["-v"], { encoding: "utf8" })
  return !probe.error && probe.status === 0
})()

// --------------------------------------------------------------- weights

test("weights are stored as percentages so a weight is readable on its own", () => {
  assert.deepEqual(Model.normalizeWeights([1, 2, 1]), [25, 50, 25])
  assert.deepEqual(Model.normalizeWeights([25, 50, 25]), [25, 50, 25])
  assert.deepEqual(Model.normalizeWeights([]), [100])
})

test("normalized weights always sum to exactly 100, including thirds", () => {
  const cases = [[1, 1, 1], [1, 1, 1, 1, 1, 1, 1], [61.8, 38.2], [7, 3], [1, 2, 3, 4]]
  for (const input of cases) {
    const sum = Model.normalizeWeights(input).reduce((a, b) => a + b, 0)
    assert.equal(Math.round(sum * 100) / 100, 100, `sum for ${input}`)
  }
})

test("garbage weights degrade to something usable instead of throwing", () => {
  assert.deepEqual(Model.normalizeWeights(["x", null, undefined]), Model.normalizeWeights([5, 5, 5]))
  assert.deepEqual(Model.normalizeWeights([0, 0]), [50, 50])
  assert.deepEqual(Model.normalizeWeights([-4, -4]), [50, 50])
  assert.equal(Model.normalizeWeights(null).length, 1)
})

test("a layout cannot grow past the slot cap", () => {
  const wide = new Array(40).fill(1)
  assert.equal(Model.normalizeWeights(wide).length, Model.MAX_SLOTS)
  let weights = Model.evenWeights(Model.MAX_SLOTS)
  assert.equal(Model.addSlot(weights).length, Model.MAX_SLOTS)
})

// --------------------------------------------------------------- dividers

test("dividers are the cumulative edges the canvas draws", () => {
  assert.deepEqual(Model.dividerPositions([25, 50, 25]), [25, 75])
  assert.deepEqual(Model.dividerPositions([100]), [])
})

test("dragging a divider moves only the two slots it separates", () => {
  const moved = Model.setDivider([25, 50, 25], 0, 40, { snap: false })
  assert.deepEqual(moved, [40, 35, 25])
  assert.equal(moved.reduce((a, b) => a + b, 0), 100)
})

test("a divider cannot be dragged through its neighbours", () => {
  const crushed = Model.setDivider([25, 50, 25], 1, 5, { snap: false })
  assert.equal(crushed[1], Model.MIN_WEIGHT)
  assert.ok(crushed.every((w) => w >= Model.MIN_WEIGHT), `got ${crushed}`)

  const stretched = Model.setDivider([25, 50, 25], 1, 99, { snap: false })
  assert.equal(stretched[2], Model.MIN_WEIGHT)
})

test("dragging snaps to ratios that are impossible to hit by hand", () => {
  assert.equal(Model.setDivider([50, 50], 0, 33.6, { snap: true })[0], 33.33)
  assert.equal(Model.setDivider([50, 50], 0, 61.2, { snap: true })[0], 61.8)
  // Far from any snap point, the drag is left exactly where the user put it.
  assert.equal(Model.setDivider([50, 50], 0, 45, { snap: true })[0], 45)
  assert.equal(Model.setDivider([50, 50], 0, 33.6, { snap: false })[0], 33.6)
})

test("an out-of-range divider index is ignored rather than corrupting the layout", () => {
  assert.deepEqual(Model.setDivider([25, 50, 25], 9, 40, {}), [25, 50, 25])
  assert.deepEqual(Model.setDivider([25, 50, 25], -1, 40, {}), [25, 50, 25])
})

// ------------------------------------------------------------ add / remove

test("adding a slot splits the widest one so the shape stays recognizable", () => {
  assert.deepEqual(Model.addSlot([25, 50, 25]), [25, 25, 25, 25])
  assert.deepEqual(Model.addSlot([100]), [50, 50])
})

test("removing a slot hands its space to a neighbour", () => {
  assert.deepEqual(Model.removeSlot([25, 50, 25], 1), [75, 25])
  assert.deepEqual(Model.removeSlot([25, 50, 25], 0), [75, 25])
  assert.deepEqual(Model.removeSlot([100], 0), [100])
})

// --------------------------------------------------------------- geometry

function totalArea(rects) {
  return rects.reduce((sum, r) => sum + r.w * r.h, 0)
}

function overlaps(a, b) {
  return a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 &&
    a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9
}

test("25/50/25 with three windows is exactly 25/50/25", () => {
  // The shape, independent of which window goes where — see the fill-order
  // test below for that half.
  const rects = Model.slotRects({ weights: [25, 50, 25] }, 3).slice()
  rects.sort((a, b) => a.x - b.x)
  assert.deepEqual(rects, [
    { x: 0, y: 0, w: 0.25, h: 1 },
    { x: 0.25, y: 0, w: 0.5, h: 1 },
    { x: 0.75, y: 0, w: 0.25, h: 1 }
  ])
})

test("a single window gets the whole workspace, unless the layout holds its shape", () => {
  for (const layout of Model.presets()) {
    const rects = Model.slotRects(layout, 1)
    assert.equal(rects.length, 1, `preset ${layout.id}`)
    if (layout.underfill === "hold") {
      // It sits in the main slot, which is somewhere inside the screen rather
      // than filling it.
      assert.ok(rects[0].w < 1, `preset ${layout.id} holds its width`)
      assert.ok(rects[0].x > 0, `preset ${layout.id} stays off the left edge`)
    } else {
      assert.deepEqual(rects[0], { x: 0, y: 0, w: 1, h: 1 }, `preset ${layout.id}`)
    }
  }
})

test("fewer windows than slots rescales the shape instead of leaving a hole", () => {
  const rects = Model.slotRects({ weights: [25, 50, 25], underfill: "rescale" }, 2)
  assert.equal(rects.length, 2)
  assert.equal(Math.round(totalArea(rects) * 1000) / 1000, 1)
  // The main slot survives and the first window keeps it; the runner-up slot
  // is the wider of the two edges, so the split is 2/3 and 1/3.
  assert.equal(Math.round(rects[0].w * 1000) / 1000, 0.667)
  assert.equal(Math.round(rects[1].w * 1000) / 1000, 0.333)
})

test("the first window lands in the layout's main area, not at the edge", () => {
  // 25/50/25 with three windows: window 1 takes the centre, then the sides.
  const focus = Model.slotRects({ weights: [25, 50, 25] }, 3)
  assert.deepEqual(focus, [
    { x: 0.25, y: 0, w: 0.5, h: 1 },
    { x: 0, y: 0, w: 0.25, h: 1 },
    { x: 0.75, y: 0, w: 0.25, h: 1 }
  ])

  // A main/side layout already put the first window in the main slot, and
  // still does; mirrored, the first window follows the main slot to the right.
  assert.equal(Model.slotRects({ weights: [60, 40] }, 2)[0].x, 0)
  assert.equal(Model.slotRects({ weights: [40, 60] }, 2)[0].x, 0.4)

  // An even split has no main area, so it fills in reading order.
  assert.equal(Model.slotRects({ weights: [50, 50] }, 2)[0].x, 0)
  assert.equal(Model.slotRects({ kind: "ratio", weights: [100 / 3, 100 / 3, 100 / 3] }, 3)[0].x, 0)
})

test("a centred layout stays centred when it is not full", () => {
  const focus = { weights: [25, 50, 25], underfill: "hold" }

  // One window: the middle 50%, with the side slots left empty. Rescaling here
  // would blow it up to fullscreen and lose the point of the layout.
  assert.deepEqual(Model.slotRects(focus, 1), [{ x: 0.25, y: 0, w: 0.5, h: 1 }])

  // Two: the main slot has not moved, and the runner-up takes its own place.
  assert.deepEqual(Model.slotRects(focus, 2), [
    { x: 0.25, y: 0, w: 0.5, h: 1 },
    { x: 0, y: 0, w: 0.25, h: 1 }
  ])

  // Full, and beyond, is unchanged by the setting.
  assert.deepEqual(Model.slotRects(focus, 3), Model.slotRects({ weights: [25, 50, 25] }, 3))
  assert.deepEqual(Model.slotRects(focus, 5), Model.slotRects({ weights: [25, 50, 25] }, 5))
})

test("a lone window fills the screen when the layout has no centre to keep", () => {
  assert.deepEqual(Model.slotRects({ weights: [60, 40] }, 1), [{ x: 0, y: 0, w: 1, h: 1 }])
  assert.deepEqual(Model.slotRects({ weights: [50, 50] }, 1), [{ x: 0, y: 0, w: 1, h: 1 }])
  assert.deepEqual(Model.slotRects({ weights: [25, 50, 25], underfill: "rescale" }, 1),
    [{ x: 0, y: 0, w: 1, h: 1 }])
})

test("a layout holds its shape when its main area is interior", () => {
  // Derived from the shape, so a layout the user drags into a centred form
  // gets it too — and one written before the setting existed does not need a
  // migration to behave right.
  assert.equal(Model.defaultUnderfill([25, 50, 25]), "hold")
  assert.equal(Model.defaultUnderfill([20, 60, 20]), "hold")
  assert.equal(Model.defaultUnderfill([10, 40, 40, 10]), "hold")

  // Main slot against an edge: nothing to keep centred.
  assert.equal(Model.defaultUnderfill([60, 40]), "rescale")
  assert.equal(Model.defaultUnderfill([40, 60]), "rescale")
  assert.equal(Model.defaultUnderfill([61.8, 38.2]), "rescale")
  // No main slot at all.
  assert.equal(Model.defaultUnderfill([50, 50]), "rescale")
  assert.equal(Model.defaultUnderfill([100 / 3, 100 / 3, 100 / 3]), "rescale")
  assert.equal(Model.defaultUnderfill([]), "rescale")

  const held = {}
  for (const preset of Model.presets()) held[preset.id] = preset.underfill
  assert.equal(held.focus, "hold")
  assert.equal(held["wide-centre"], "hold")
  assert.equal(held.main, "rescale")
  assert.equal(held.even, "rescale")
  assert.equal(held.thirds, "rescale")
})

test("an explicit underfill setting beats the shape", () => {
  assert.equal(Model.normalizeLayout({ weights: [25, 50, 25], underfill: "rescale" }).underfill, "rescale")
  assert.equal(Model.normalizeLayout({ weights: [60, 40], underfill: "hold" }).underfill, "hold")
  assert.equal(Model.normalizeLayout({ weights: [25, 50, 25], underfill: "nonsense" }).underfill, "hold")
})

test("fill order can be pinned back to reading order", () => {
  const positional = Model.slotRects({ weights: [25, 50, 25], fill: "order" }, 3)
  assert.equal(positional[0].x, 0)
  assert.equal(positional[1].x, 0.25)
  assert.equal(positional[2].x, 0.75)
})

test("overflow windows keep filling the slot they belong to, in order", () => {
  // 25/50/25 with five windows: centre, left, then three stacked on the right.
  const rects = Model.slotRects({ weights: [25, 50, 25], overflow: "last" }, 5)
  assert.equal(rects[0].x, 0.25)
  assert.equal(rects[1].x, 0)
  for (const r of rects.slice(2)) assert.equal(r.x, 0.75)
  assert.deepEqual(rects.slice(2).map((r) => Math.round(r.y * 100) / 100), [0, 0.33, 0.67])
})

test("extra windows stack inside the overflow slot", () => {
  const rects = Model.slotRects({ weights: [25, 50, 25], overflow: "last" }, 5)
  assert.equal(rects.length, 5)
  // Windows 3..5 share the trailing 25% column, split vertically.
  for (const r of rects.slice(2)) assert.equal(r.w, 0.25)
  assert.deepEqual(rects.slice(2).map((r) => Math.round(r.h * 1000) / 1000), [0.333, 0.333, 0.333])
})

test("overflow can stack into the first slot instead", () => {
  const rects = Model.slotRects({ weights: [40, 60], overflow: "first" }, 4)
  assert.equal(rects.length, 4)
  // The 60% slot is the main one, so it takes window 1; the rest stack left.
  assert.equal(rects[0].x, 0.4)
  assert.equal(rects[0].h, 1)
  for (const r of rects.slice(1)) assert.equal(r.x, 0)
})

test("extend overflow grows new slots at the trailing width", () => {
  const rects = Model.slotRects({ weights: [60, 40], overflow: "extend" }, 3)
  assert.equal(rects.length, 3)
  for (const r of rects) assert.equal(r.h, 1)
  assert.equal(Math.round(rects[0].w * 1000) / 1000, 0.429)
  assert.equal(rects[0].x, 0)
})

test("a tie in slot width is broken by position, never at random", () => {
  // table.sort in Lua is unstable, so an even split could otherwise hand
  // window 1 to a different slot on each recalculation.
  assert.deepEqual(Model.fillOrder([25, 25, 25, 25]), [0, 1, 2, 3])
  assert.deepEqual(Model.fillOrder([25, 50, 25]), [1, 0, 2])
  assert.deepEqual(Model.fillOrder([20, 60, 20]), [1, 0, 2])
  assert.deepEqual(Model.fillOrder([100]), [0])
})

test("row orientation transposes the layout without changing the ratios", () => {
  const columns = Model.slotRects({ weights: [25, 50, 25], orientation: "columns" }, 3)
  const rows = Model.slotRects({ weights: [25, 50, 25], orientation: "rows" }, 3)
  assert.deepEqual(rows.map((r) => ({ x: r.y, y: r.x, w: r.h, h: r.w })), columns)
})

test("a short final grid row stretches instead of leaving a ragged edge", () => {
  const rects = Model.slotRects({ kind: "grid", gridColumns: 3 }, 5)
  assert.equal(rects.length, 5)
  assert.deepEqual(rects.slice(3).map((r) => Math.round(r.w * 100) / 100), [0.5, 0.5])
})

test("a held layout leaves real gaps, and that is the point", () => {
  const rects = Model.slotRects({ weights: [25, 50, 25], underfill: "hold" }, 2)
  assert.equal(totalArea(rects), 0.75)
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!overlaps(rects[i], rects[j]), "held slots still must not overlap")
    }
  }
})

test("every layout tiles the workspace with no gaps and no overlap", () => {
  const layouts = Model.presets().concat([
    Model.normalizeLayout({ weights: [25, 50, 25], overflow: "first" }),
    Model.normalizeLayout({ weights: [70, 30], orientation: "rows", overflow: "extend" }),
    Model.normalizeLayout({ kind: "grid", gridColumns: 3 })
  ])
  for (const layout of layouts) {
    for (let n = 1; n <= 12; n++) {
      const rects = Model.slotRects(layout, n)
      assert.equal(rects.length, n, `${layout.id} with ${n} windows`)
      // A "hold" layout deliberately leaves empty slots, so only the ones that
      // promise to fill the screen are held to it.
      if (layout.underfill !== "hold" || n >= layout.weights.length) {
        assert.equal(Math.round(totalArea(rects) * 1000) / 1000, 1,
          `${layout.id} with ${n} windows covers the workspace`)
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          assert.ok(!overlaps(rects[i], rects[j]),
            `${layout.id} with ${n} windows: slot ${i} overlaps ${j}`)
        }
      }
    }
  }
})

test("zero windows produce no rectangles", () => {
  assert.deepEqual(Model.slotRects({ weights: [50, 50] }, 0), [])
})

// ----------------------------------------------------------------- config

test("a fresh config ships the preset library and one profile", () => {
  const config = Model.defaultConfig()
  assert.equal(config.profiles.length, 1)
  assert.equal(config.activeProfile, "default")
  assert.equal(config.profiles[0].fallback, "dwindle")
  assert.ok(config.layouts.length >= 8)
})

test("restoring defaults hands every workspace back to Hyprland", () => {
  // What the Restore defaults button writes. The reset is only real if no
  // workspace is left claimed and the fallback is a built-in, otherwise the
  // user would still be tiling under this plugin after asking not to.
  const fresh = Model.defaultConfig()
  assert.deepEqual(fresh.profiles[0].assignments, {})
  assert.ok(Model.isBuiltin(fresh.profiles[0].fallback))

  for (let w = 1; w <= 10; w++) {
    assert.equal(Model.layoutIdForWorkspace(fresh, w), "dwindle", `workspace ${w}`)
  }

  const lua = Model.generateLua(fresh, [1, 4, 7])
  assert.ok(!lua.includes('"lua:omarchy-wsl-'), "no workspace may still point at a plugin layout")
})

test("restoring defaults is wired to a two-press button", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function restoreDefaults\(\)/)
  assert.match(qml, /store\.save\(Model\.defaultConfig\(\)\)/)
  // Guarded by the same arm-then-confirm as the delete buttons, and Escape
  // disarms so a primed reset cannot outlive the panel.
  assert.match(qml, /root\.armDelete\("restore"\)\) root\.restoreDefaults\(\)/)
  assert.match(qml, /if \(root\.armedDelete !== ""\) root\.armedDelete = ""/)
})

test("a corrupt config is repaired rather than rejected", () => {
  for (const input of [null, undefined, 42, "nonsense", [], { layouts: "no" }]) {
    const config = Model.normalizeConfig(input)
    assert.ok(config.layouts.length > 0)
    assert.ok(config.profiles.length > 0)
    assert.ok(Model.findProfile(config, config.activeProfile))
  }
})

test("an assignment to a deleted layout falls back instead of pinning a ghost", () => {
  const config = Model.normalizeConfig({
    layouts: [{ id: "focus", name: "Focus", weights: [25, 50, 25] }],
    profiles: [{ name: "work", fallback: "dwindle", assignments: { 1: "focus", 2: "gone" } }],
    activeProfile: "work"
  })
  assert.equal(Model.layoutIdForWorkspace(config, 1), "focus")
  assert.equal(Model.layoutIdForWorkspace(config, 2), "dwindle")
  assert.equal(Model.layoutIdForWorkspace(config, 7), "dwindle")
})

test("named, special, and absurd workspaces are refused", () => {
  assert.equal(Model.normalizeWorkspaceId("special:scratchpad"), null)
  assert.equal(Model.normalizeWorkspaceId("browser"), null)
  assert.equal(Model.normalizeWorkspaceId(0), null)
  assert.equal(Model.normalizeWorkspaceId(-3), null)
  assert.equal(Model.normalizeWorkspaceId(1000), null)
  assert.equal(Model.normalizeWorkspaceId("4"), "4")
})

test("an unknown active profile falls back to a real one", () => {
  const config = Model.normalizeConfig({
    profiles: [{ name: "work" }],
    activeProfile: "missing"
  })
  assert.equal(config.activeProfile, "work")
})

test("ids stay unique and url-safe so they can name a Hyprland layout", () => {
  const config = Model.defaultConfig()
  assert.equal(Model.slugify("Wide Centre!"), "wide-centre")
  assert.equal(Model.slugify("   "), "layout")
  assert.equal(Model.uniqueLayoutId(config, "focus"), "focus-2")
  assert.match(Model.luaLayoutName("wide centre"), /^[a-z0-9-]+$/)
})

test("every shipped preset survives normalization", () => {
  // A preset whose id collides with a Hyprland built-in is dropped by
  // normalizeConfig, so it would vanish from the library without a word.
  const presets = Model.presets()
  const config = Model.defaultConfig()
  assert.equal(config.layouts.length, presets.length)
  for (const preset of presets) {
    assert.ok(Model.findLayout(config, preset.id), `preset ${preset.id} survived`)
    assert.ok(!Model.isBuiltin(preset.id), `preset ${preset.id} does not shadow a built-in`)
  }
})

test("an eval payload never opens with a dash", () => {
  // hyprctl reads a leading "-" as a flag, and Lua comments start with "--",
  // so a payload with a comment banner would be parsed as garbage and dropped.
  const payloads = [
    Model.generateLua(Model.defaultConfig(), [1]),
    Model.livePreviewLua(Model.presets()[0]),
    "-- nothing but a comment"
  ]
  for (const payload of payloads) {
    const args = Model.hyprctlEvalArgs(payload)
    assert.equal(args[0], "hyprctl")
    assert.equal(args[1], "eval")
    assert.ok(!args[2].startsWith("-"), `payload starts with: ${args[2].slice(0, 20)}`)
  }
})

test("wrapping a payload for eval keeps it valid Lua",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    const wrapped = Model.hyprctlEvalArgs(Model.generateLua(Model.defaultConfig(), [1]))[2]
    const output = runLua([
      lua_prelude(),
      wrapped,
      'print(_G.__omarchy_wsl and "registered" or "missing")'
    ].join("\n"))
    assert.equal(output.trim(), "registered")
  })

test("a layout may not squat on a built-in layout name", () => {
  const config = Model.normalizeConfig({
    layouts: [{ id: "dwindle", name: "Dwindle", weights: [50, 50] },
      { id: "mine", name: "Mine", weights: [50, 50] }]
  })
  assert.equal(Model.findLayout(config, "dwindle"), null)
  assert.ok(Model.findLayout(config, "mine"))
})

test("profile names do not collide", () => {
  const config = Model.normalizeConfig({ profiles: [{ name: "work" }, { name: "work 2" }] })
  assert.equal(Model.uniqueProfileName(config, "work"), "work 3")
  assert.equal(Model.uniqueProfileName(config, "home"), "home")
})

// -------------------------------------------------------------------- lua

test("built-in layouts pass through, ours are namespaced under lua:", () => {
  assert.equal(Model.luaLayoutRef("dwindle"), "dwindle")
  assert.equal(Model.luaLayoutRef("scrolling"), "scrolling")
  assert.equal(Model.luaLayoutRef("focus"), "lua:omarchy-wsl-focus")
})

test("generated Lua registers every layout and rules every managed workspace", () => {
  const config = Model.defaultConfig()
  const lua = Model.generateLua(config, [1, 2, 3])
  for (const layout of config.layouts) {
    assert.match(lua, new RegExp(`W\\.register\\("${layout.id}"\\)`), `register ${layout.id}`)
    assert.ok(lua.includes(`W.specs["${layout.id}"]`), `spec ${layout.id}`)
  }
  for (let w = 1; w <= 10; w++) {
    assert.ok(lua.includes(`W.set_workspace("${w}", "dwindle")`), `workspace ${w}`)
  }
})

test("switching profiles releases workspaces the previous profile had claimed", () => {
  const config = Model.normalizeConfig({
    layouts: [{ id: "focus", name: "Focus", weights: [25, 50, 25] }],
    profiles: [
      { name: "work", fallback: "dwindle", assignments: { 3: "focus" } },
      { name: "plain", fallback: "dwindle", assignments: {} }
    ],
    activeProfile: "plain"
  })
  const lua = Model.generateLua(config, [3])
  assert.ok(lua.includes('W.set_workspace("3", "dwindle")'))
  assert.ok(!lua.includes('W.set_workspace("3", "lua:omarchy-wsl-focus")'))
})

test("a workspace that exists but is past 10 still gets a rule", () => {
  const ids = Model.managedWorkspaceIds(Model.defaultConfig(), [42])
  assert.ok(ids.includes("42"))
  assert.deepEqual(ids.slice(0, 3), ["1", "2", "3"])
})

test("the live preview payload is a no-op when the runtime is not loaded", () => {
  const lua = Model.livePreviewLua({ id: "focus", weights: [25, 50, 25] })
  assert.match(lua, /local W = _G\.__omarchy_wsl/)
  assert.match(lua, /^if W then$/m)
  assert.ok(!lua.includes("W.register("), "a drag must not re-register layouts")
})

test("a hostile name cannot break out of the generated Lua", () => {
  const nasty = 'evil"\nW.rules = nil\n--'
  const config = Model.normalizeConfig({
    layouts: [{ id: "x", name: nasty, weights: [50, 50] }],
    profiles: [{ name: nasty, fallback: "dwindle" }]
  })
  assert.ok(!config.profiles[0].name.includes("\n"))
  assert.ok(!config.layouts[0].name.includes("\n"))

  // The name reaches a Lua comment. Prove it stays there: run the generated
  // file and check the sentinel the payload tried to clear is still standing.
  const lua = Model.generateLua(config, [1])
  if (luaAvailable) {
    const output = runLua([
      lua_prelude(),
      lua,
      'print(W.rules == nil and "BREACHED" or "intact")'
    ].join("\n"))
    assert.equal(output.trim(), "intact")
  }

  assert.equal(Model.sanitizeName("", "fallback"), "fallback")
  assert.equal(Model.sanitizeName("  spaced  out  ", "x"), "spaced out")
})

// ----------------------------------------------------------------- loader

test("the Hyprland loader line is added once and only once", () => {
  const original = "require(\"hypr.bindings\")\n"
  assert.ok(Model.needsLoader(original))

  const once = Model.withLoader(original)
  assert.ok(!Model.needsLoader(once))
  assert.equal(Model.withLoader(once), once, "a second call must not duplicate the line")
  assert.ok(once.startsWith(original), "existing config must be left intact")
})

test("the loader survives its own generated file being deleted", () => {
  const line = Model.loaderLine()
  assert.match(line, /io\.open\(path, "r"\)/)
  assert.match(line, /if file then/)
})

// ------------------------------------------------------- lua cross-check
//
// The panel draws slotRects(); Hyprland runs the Lua. If those two ever
// disagree the preview becomes a lie, so run the real generated Lua through
// the `lua` interpreter and diff it against the JavaScript.


test("the Lua engine places windows exactly where the panel previews them",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    const layouts = Model.presets().concat([
      Model.normalizeLayout({ id: "a", weights: [25, 50, 25], overflow: "first" }),
      Model.normalizeLayout({ id: "b", weights: [70, 30], orientation: "rows", overflow: "extend" }),
      Model.normalizeLayout({ id: "c", weights: [61.8, 38.2], overflow: "last" }),
      Model.normalizeLayout({ id: "d", kind: "grid", gridColumns: 3 }),
      Model.normalizeLayout({ id: "e", weights: [5, 5, 5, 5, 5, 5, 5, 65] }),
      Model.normalizeLayout({ id: "f", weights: [25, 50, 25], fill: "order" }),
      Model.normalizeLayout({ id: "g", weights: [20, 60, 20], overflow: "first" }),
      Model.normalizeLayout({ id: "h", weights: [25, 50, 25], underfill: "hold" }),
      Model.normalizeLayout({ id: "i", weights: [20, 30, 30, 20], underfill: "hold", orientation: "rows" })
    ])

    const specs = layouts.map((l) => Model.layoutSpecLua(l)).join("\n")
    const source = [
      lua_prelude(),
      Model.LUA_RUNTIME,
      specs,
      "local out = {}",
      `for _, id in ipairs({${layouts.map((l) => `"${l.id}"`).join(", ")}}) do`,
      "  for n = 1, 12 do",
      "    local rects = W.rects(W.specs[id], n)",
      "    local parts = {}",
      "    for i = 1, #rects do",
      "      local r = rects[i]",
      "      parts[#parts + 1] = string.format('%.4f,%.4f,%.4f,%.4f', r[1], r[2], r[3], r[4])",
      "    end",
      "    out[#out + 1] = id .. '|' .. n .. '|' .. table.concat(parts, ' ')",
      "  end",
      "end",
      "print(table.concat(out, '\\n'))"
    ].join("\n")

    const luaLines = runLua(source).trim().split("\n")
    const expected = []
    for (const layout of layouts) {
      for (let n = 1; n <= 12; n++) {
        const parts = Model.slotRects(layout, n)
          .map((r) => [r.x, r.y, r.w, r.h].map((v) => v.toFixed(4)).join(","))
        expected.push(`${layout.id}|${n}|${parts.join(" ")}`)
      }
    }

    assert.equal(luaLines.length, expected.length)
    for (let i = 0; i < expected.length; i++) {
      assert.equal(luaLines[i], expected[i], `Lua and JS disagree on ${expected[i].split("|").slice(0, 2).join(" with ")} windows`)
    }
  })

test("the generated file is valid Lua", { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
  const lua = Model.generateLua(Model.defaultConfig(), [1, 2, 3])
  assert.doesNotThrow(() => runLua(`${lua_prelude()}\n${lua}\nprint("ok")`))
})

test("a live preview payload is valid Lua and safe with no runtime present",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    const lua = Model.livePreviewLua(Model.presets()[1])
    assert.equal(runLua(`${lua}\nprint("survived")`).trim(), "survived")
  })

// ------------------------------------------------------------- packaging

test("the manifest matches what the shell and the CLI validator require", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"))
  assert.equal(manifest.schemaVersion, 1)
  assert.match(manifest.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  assert.ok(!manifest.id.startsWith("omarchy."))
  assert.ok(manifest.kinds.length > 0)
  for (const kind of manifest.kinds) {
    const key = { "bar-widget": "barWidget", service: "service" }[kind]
    assert.ok(manifest.entryPoints[key], `kind ${kind} needs entryPoints.${key}`)
    assert.ok(fs.existsSync(path.join(__dirname, "..", manifest.entryPoints[key])),
      `${manifest.entryPoints[key]} exists`)
  }
  assert.ok(["left", "center", "right"].includes(manifest.barWidget.defaultSection))
})
