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
    "PINS = {}",
    "hl = { layout = { register = function() end },",
    "       workspace_rule = function() return { set_enabled = function() end } end,",
    // Window rules are recorded rather than discarded: the pin tests below read
    // PINS back to prove the rule Hyprland would get says what the config does.
    "       window_rule = function(spec)",
    "         PINS[#PINS + 1] = spec",
    "         return { set_enabled = function(self, v) spec.enabled = v end }",
    "       end,",
    "       get_windows = function() return {} end,",
    "       dispatch = function() end,",
    "       dsp = { layout = function() end, window = { move = function() end } } }"
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

// ------------------------------------------------------------------- pins

test("a pin is keyed by the app, so an app can only live in one place", () => {
  const config = Model.normalizeConfig({
    profiles: [{ name: "default", fallback: "dwindle", pins: { firefox: 3, Slack: "2" } }],
    activeProfile: "default"
  })
  assert.deepEqual(Model.activeProfile(config).pins, {
    firefox: { workspace: "3", slots: [] },
    Slack: { workspace: "2", slots: [] }
  })
  assert.deepEqual(Model.pinsForWorkspace(config, 3),
    [{ match: "firefox", workspace: "3", slots: [], name: "", command: "" }])
  assert.deepEqual(Model.pinsForWorkspace(config, 9), [])
  assert.equal(Model.pinnedWorkspace(config, "firefox"), "3")
  assert.equal(Model.pinnedWorkspace(config, "nothing"), "")
})

test("the short form of a pin is the whole pin, so the JSON stays hand-writable", () => {
  // `"firefox": "3"` and the long form mean the same thing.
  assert.deepEqual(Model.normalizePin("3"), { workspace: "3", slots: [] })
  assert.deepEqual(Model.normalizePin({ workspace: 3, slot: 2 }), { workspace: "3", slots: [2] })
  // An app is not one window: two terminals can hold two places in the split.
  assert.deepEqual(Model.normalizePin({ workspace: 3, slots: [3, 1] }), { workspace: "3", slots: [1, 3] })
  assert.deepEqual(Model.normalizePin({ workspace: 3, slots: [2, 2] }), { workspace: "3", slots: [2] })
  // A slot that no layout could offer is not a reason to lose the pin.
  assert.deepEqual(Model.normalizePin({ workspace: 3, slot: 99 }), { workspace: "3", slots: [] })
  assert.deepEqual(Model.normalizePin({ workspace: 3, slot: "x" }), { workspace: "3", slots: [] })
  assert.equal(Model.normalizePin({ slot: 2 }), null)
  assert.equal(Model.normalizePin("special:scratchpad"), null)
})

test("a pin to a workspace that cannot hold one is dropped, not kept half-formed", () => {
  const config = Model.normalizeConfig({
    profiles: [{
      name: "default",
      fallback: "dwindle",
      pins: { firefox: "special:scratchpad", chromium: 0, "": 4, "  ": 5, ghostty: 2 }
    }],
    activeProfile: "default"
  })
  assert.deepEqual(Model.activeProfile(config).pins, { ghostty: { workspace: "2", slots: [] } })
})

test("only a match that reduces to plain class names can claim a slot", () => {
  assert.deepEqual(Model.slotKeys("firefox"), ["firefox"])
  // Dots are class names, not wildcards — reading them as regex would cost
  // every GTK app its slot.
  assert.deepEqual(Model.slotKeys("org.gnome.Nautilus"), ["org.gnome.Nautilus"])
  assert.deepEqual(Model.slotKeys("^(firefox|chromium)$"), ["firefox", "chromium"])
  assert.deepEqual(Model.slotKeys("^(fire.*)$"), [])
  assert.deepEqual(Model.slotKeys("foo[0-9]"), [])
})

test("the search reads names as well as classes, and running beats installed", () => {
  const config = Model.normalizeConfig({
    profiles: [{ name: "default", fallback: "dwindle" }],
    activeProfile: "default"
  })
  const catalog = [
    { match: "org.gnome.Nautilus", name: "Files", command: "nautilus" },
    { match: "firefox", name: "Firefox", command: "firefox", running: true },
    { match: "firefox-developer-edition", name: "Firefox Developer Edition", command: "firefox-dev" },
    { match: "chromium", name: "Chromium", command: "chromium" }
  ]

  // An app is found by the word on its launcher, not only by its class.
  assert.deepEqual(
    Model.searchApps(config, 3, catalog, "files").rows.map((r) => r.match),
    ["org.gnome.Nautilus", "files"]
  )

  // The one with a window open comes first, then the name that starts with
  // what was typed.
  assert.deepEqual(
    Model.searchApps(config, 3, catalog, "firefox").rows.map((r) => r.name),
    ["Firefox", "Firefox Developer Edition"]
  )

  // A row carries what it takes to launch it.
  const row = Model.searchApps(config, 3, catalog, "chromium").rows[0]
  assert.equal(row.command, "chromium")
  assert.equal(row.running, false)

  // A bare string is still a valid catalogue entry — a window class with no
  // desktop entry behind it.
  const plain = Model.searchApps(config, 3, ["mpv"], "mpv").rows[0]
  assert.equal(plain.name, "mpv")
  assert.equal(plain.command, "")
})

test("opening an app puts it on the workspace without following it there", () => {
  assert.equal(
    Model.launchAppLua("nautilus", 3),
    'hl.exec_cmd("nautilus", { workspace = "3 silent" })'
  )
  assert.equal(Model.launchAppLua("", 3), "")
  assert.equal(Model.launchAppLua("nautilus", "special:x"), "")
})

test("a hostile command cannot break out of the launch payload",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    // This one matters more than the rest: breaking out here would run
    // arbitrary Lua inside the user's own compositor.
    const nasty = 'foot" }) BREACHED = true hl.exec_cmd("x'
    const output = runLua([
      "BREACHED = false",
      "SEEN = nil",
      "hl = { exec_cmd = function(cmd) SEEN = cmd end }",
      Model.launchAppLua(nasty, 3),
      'print(BREACHED and "BREACHED" or "intact")',
      'print(#SEEN)'
    ].join("\n"))
    const lines = output.trim().split("\n")
    assert.equal(lines[0], "intact")
    // The whole payload arrived as one string argument rather than as code.
    assert.equal(Number(lines[1]), nasty.length)
  })

test("the search is empty-handed until you type, then finds what is running", () => {
  const config = Model.normalizeConfig({
    layouts: [{ id: "focus", name: "Focus", weights: [25, 50, 25] }],
    profiles: [{
      name: "default",
      fallback: "dwindle",
      assignments: { 5: "focus" },
      pins: { ghostty: { workspace: 5, slot: 2 }, Slack: 3 }
    }],
    activeProfile: "default"
  })
  const running = ["Alacritty", "firefox", "ghostty", "Slack"]

  // Nothing typed: the workspace's own pins, so the section stays short.
  const idle = Model.searchApps(config, 5, running, "")
  assert.deepEqual(idle.rows.map((r) => r.match), ["ghostty"])
  assert.deepEqual(idle.rows[0].slots, [2])

  // Typing searches the catalogue, case-insensitively, and says where an app
  // already pinned elsewhere lives. A pin that has nothing to do with the
  // query drops out of the way while searching.
  const found = Model.searchApps(config, 5, running, "sla")
  assert.deepEqual(found.rows.map((r) => r.match), ["Slack", "sla"])
  assert.equal(found.rows[0].elsewhere, "3")
  assert.equal(found.rows[1].literal, true)

  // An exact hit is not doubled by the row that offers the query itself.
  const exact = Model.searchApps(config, 5, running, "firefox")
  assert.deepEqual(exact.rows.map((r) => r.match), ["firefox"])

  // Nothing matches: the query is still pinnable, which is how an app that is
  // not running yet gets a pin at all.
  const unknown = Model.searchApps(config, 5, running, "obsidian")
  assert.deepEqual(unknown.rows.map((r) => r.match), ["obsidian"])
  assert.equal(unknown.rows[0].literal, true)

  const capped = Model.searchApps(config, 5, ["a1", "a2", "a3", "a4"], "a", 2)
  assert.equal(capped.rows.filter((r) => !r.literal).length, 2)
  assert.equal(capped.hidden, 2)
})

test("a bare class is anchored, a regex is left as written", () => {
  assert.equal(Model.appPattern("firefox"), "^(firefox)$")
  // Anchoring matters: unanchored, `foot` would also claim `footclient`.
  assert.equal(Model.appPattern("org.gnome.Nautilus"), "^(org.gnome.Nautilus)$")
  assert.equal(Model.appPattern("^(firefox|chromium)$"), "^(firefox|chromium)$")
  assert.equal(Model.normalizeAppMatch("  firefox  "), "firefox")
  assert.equal(Model.normalizeAppMatch(""), null)
  assert.equal(Model.normalizeAppMatch("a\nb"), "ab")
})

test("the generated file installs a window rule per pin and clears the rest", () => {
  const config = Model.normalizeConfig({
    profiles: [{ name: "default", fallback: "dwindle", pins: { firefox: 3 } }],
    activeProfile: "default"
  })
  const lua = Model.generateLua(config, [1])
  assert.ok(lua.includes("W.reset_apps()"))
  assert.ok(lua.includes('W.set_app("firefox", "^(firefox)$", "3")'))
  // Slot 0 is "wherever it lands", so it teaches the layout nothing. The
  // runtime always defines W.set_slot; what must be absent is a call.
  assert.ok(!/^W\.set_slot\(/m.test(lua))

  // The last pin removed has to reach Hyprland as an absence, which only the
  // unconditional reset can express — there is no line left to carry it.
  const empty = Model.normalizeConfig({
    profiles: [{ name: "default", fallback: "dwindle" }],
    activeProfile: "default"
  })
  const cleared = Model.generateLua(empty, [1])
  assert.ok(cleared.includes("W.reset_apps()"))
  // The runtime always defines W.set_app; what must be gone is any call to it.
  assert.ok(!/^W\.set_app\(/m.test(cleared))
})

test("a slot reaches the layout as a class it can compare, or not at all", () => {
  const config = Model.normalizeConfig({
    profiles: [{
      name: "default",
      fallback: "dwindle",
      pins: {
        firefox: { workspace: 3, slot: 2 },
        "^(a|b)$": { workspace: 3, slot: 1 },
        "^(zoom.*)$": { workspace: 3, slot: 3 }
      }
    }],
    activeProfile: "default"
  })
  const lua = Model.generateLua(config, [1])
  // Keyed by workspace: an app pinned to slot 1 of one workspace must not
  // claim slot 1 of every other workspace it opens on.
  assert.ok(lua.includes('W.set_slot("3", "firefox", { 2 })'))
  assert.ok(lua.includes('W.set_slot("3", "a", { 1 })'))
  assert.ok(lua.includes('W.set_slot("3", "b", { 1 })'))
  // The layout callback has no regex engine, so this one keeps its workspace
  // and quietly goes without a slot.
  assert.ok(lua.includes('W.set_app("^(zoom.*)$"'))
  assert.ok(!/^W\.set_slot\(.*zoom/m.test(lua), "no slot line may carry a pattern")
})

test("a targeted window takes its slot and the rest close ranks",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    const source = [
      lua_prelude(),
      Model.LUA_RUNTIME,
      'W.slots = { ["1"] = { firefox = { 2 }, slack = { 3 } } }',
      'local function pick(classes)',
      '  local targets = {}',
      '  for i = 1, #classes do',
      '    targets[i] = { window = { class = classes[i], workspace = { id = 1 } } }',
      '  end',
      '  local out = W.assign(targets, #classes)',
      '  local parts = {}',
      '  for i = 1, #out do parts[i] = tostring(out[i]) end',
      '  return table.concat(parts, ",")',
      'end',
      'print(pick({ "foot", "firefox", "slack" }))',
      'print(pick({ "firefox" }))',
      'print(pick({ "slack", "foot" }))',
      'print(pick({ "firefox", "firefox" }))'
    ].join("\n")
    const lines = runLua(source).trim().split("\n")
    // firefox takes 2 and slack takes 3; foot fills what is left.
    assert.equal(lines[0], "1,2,3")
    // A slot nobody can have yet is ignored rather than held open.
    assert.equal(lines[1], "1")
    assert.equal(lines[2], "1,2")
    // Two windows of the same class: one gets the slot, the other queues.
    assert.equal(lines[3], "2,1")
  })

test("a place is claimed only on the workspace it was pinned to",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    // An app pinned to slot 1 of workspace 9 must not claim slot 1 of every
    // other workspace it opens on — which is what a class-keyed table did.
    const source = [
      lua_prelude(),
      Model.LUA_RUNTIME,
      'W.slots = { ["9"] = { cliamp = { 1 } } }',
      'local function pick(ws)',
      '  local targets = {',
      '    { window = { class = "Aether", workspace = { id = ws } } },',
      '    { window = { class = "cliamp", workspace = { id = ws } } }',
      '  }',
      '  local out = W.assign(targets, 2)',
      '  return out[1] .. "," .. out[2]',
      'end',
      'print(pick(9))',
      'print(pick(8))'
    ].join("\n")
    const lines = runLua(source).trim().split("\n")
    // On 9, cliamp takes the place it asked for and Aether fills the other.
    assert.equal(lines[0], "2,1")
    // On 8 it asked for nothing, so both keep the order they arrived in.
    assert.equal(lines[1], "1,2")
  })

test("one app can hold several places in the split",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    const config = Model.normalizeConfig({
      layouts: [{ id: "thirds", name: "Thirds", weights: [34, 33, 33] }],
      profiles: [{
        name: "default",
        fallback: "thirds",
        pins: { foot: { workspace: 9, slots: [1, 3] }, firefox: { workspace: 9, slot: 2 } }
      }],
      activeProfile: "default"
    })
    assert.ok(Model.generateLua(config, [9]).includes('W.set_slot("9", "foot", { 1, 3 })'))
    // The canvas writes the app into both of its tiles.
    assert.deepEqual(Model.slotApps(config, 9), [["foot"], ["firefox"], ["foot"]])

    const source = [
      lua_prelude(),
      Model.LUA_RUNTIME,
      'W.slots = { ["1"] = { foot = { 1, 3 }, firefox = { 2 } } }',
      'local function pick(classes)',
      '  local targets = {}',
      '  for i = 1, #classes do',
      '    targets[i] = { window = { class = classes[i], workspace = { id = 1 } } }',
      '  end',
      '  local out = W.assign(targets, #classes)',
      '  local parts = {}',
      '  for i = 1, #out do parts[i] = tostring(out[i]) end',
      '  return table.concat(parts, ",")',
      'end',
      'print(pick({ "foot", "foot", "firefox" }))',
      'print(pick({ "foot", "firefox", "foot" }))',
      'print(pick({ "foot", "foot", "foot" }))',
      'print(pick({ "foot", "foot" }))'
    ].join("\n")
    const lines = runLua(source).trim().split("\n")
    // The second window of the same app takes the next place on its list
    // rather than fighting the first for one.
    assert.equal(lines[0], "1,3,2")
    // Which window opened first does not change where the app ends up.
    assert.equal(lines[1], "1,2,3")
    // A third window has no place left on the list and fills the gap.
    assert.equal(lines[2], "1,3,2")
    // With only two rects, slot 3 does not exist yet.
    assert.equal(lines[3], "1,2")
  })

test("the pinned rule Hyprland receives is the one the config describes",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    const config = Model.normalizeConfig({
      profiles: [{ name: "default", fallback: "dwindle", pins: { firefox: 3 } }],
      activeProfile: "default"
    })
    const output = runLua([
      lua_prelude(),
      Model.generateLua(config, [1]),
      'local p = PINS[1]',
      'print(#PINS, p.match.class, p.workspace)'
    ].join("\n"))
    // "silent" is what stops a window opening on workspace 3 from dragging the
    // user's view there from wherever they are working.
    assert.equal(output.trim(), "1\t^(firefox)$\t3 silent")
  })

test("a hostile pin cannot break out of the generated Lua",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    const nasty = 'evil" }) W.rules = nil hl.window_rule({ name = "x'
    const config = Model.normalizeConfig({
      profiles: [{ name: "default", fallback: "dwindle", pins: { [nasty]: 3 } }],
      activeProfile: "default"
    })
    const output = runLua([
      lua_prelude(),
      Model.generateLua(config, [1]),
      'print(W.rules == nil and "BREACHED" or "intact")'
    ].join("\n"))
    assert.equal(output.trim(), "intact")
  })

test("gathering an app that is already running asks by class, not by pattern",
  { skip: luaAvailable ? false : "lua interpreter not installed" }, () => {
    assert.equal(Model.gatherAppLua("firefox", "special:x"), "")
    assert.equal(Model.gatherAppLua("", 3), "")

    const lua = Model.gatherAppLua("firefox", 3)
    // hl.get_windows matches a class exactly — handing it the anchored pattern
    // a window rule wants finds nothing at all, silently.
    assert.ok(lua.includes('{ "firefox" }'))
    assert.ok(!lua.includes("^(firefox)$"))
    assert.ok(lua.includes("follow = false"), "a gather must not drag the user's view along")
    assert.doesNotThrow(() => runLua(`${lua_prelude()}\n${lua}\nprint("ok")`))

    assert.ok(Model.gatherAppLua("^(a|b)$", 3).includes('{ "a", "b" }'))
    // A pattern that cannot be reduced to class names has nothing to ask for.
    assert.equal(Model.gatherAppLua("^(zoom.*)$", 3), "")
  })

test("pinning an app is wired to a click and brings its open windows along", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function pinApp\(match, name\)/)
  assert.match(qml, /var pin = \{ workspace: workspace, slots: next \}/)
  assert.match(qml, /target\.pins\[clean\] = pin/)
  // Aiming at a tile an app already holds takes that one back.
  assert.match(qml, /if \(at === -1\) next\.push\(slot\)/)
  // A window rule only fires on open, so without the gather a pin would do
  // nothing to the app the user is looking at when they make it.
  assert.match(qml, /sync\.gather\(clean, workspace\)/)
  assert.match(qml, /function unpinApp\(match\)/)
  // Aiming at a tile in the canvas is what gives a pin its slot.
  assert.match(qml, /function selectSlot\(slot\)/)
  assert.match(qml, /onSlotClicked: function\(slot\) \{ root\.selectSlot\(slot\) \}/)
  // Typing into the search must not reach the panel's single-key shortcuts.
  assert.match(qml, /blocked:.*appSearch\.activeFocus/)

  const sync = fs.readFileSync(path.join(__dirname, "..", "HyprlandSync.qml"), "utf8")
  assert.match(sync, /function gather\(match, workspaceId\)/)
  assert.match(sync, /function launch\(command, workspaceId\)/)
  // A Terminal=true app needs wrapping before it is a window at all.
  assert.match(qml, /function launchCommandFor\(app\)/)
  assert.match(qml, /terminal: entry\.runInTerminal === true/)
  // The apps the search offers come from the machine, not only from what
  // happens to be open.
  assert.match(qml, /DesktopEntries\.applications/)
  // The first scan arrives one entry at a time, so the rebuild is debounced.
  assert.match(qml, /onValuesChanged\(\) \{ catalogTimer\.restart\(\) \}/)
  // Chromium's entry ships the unexpanded token as its StartupWMClass.
  assert.match(qml, /match\.indexOf\("@@"\) !== -1/)
  // One press starts the workspace rather than one press per app.
  assert.match(qml, /function launchMissing\(workspace, list\)/)
  // One window per place the app was given, not one per app.
  assert.match(qml, /for \(var c = 0; c < wanted; c\+\+\) sync\.launch/)
  assert.match(qml, /onClicked: root\.launchMissing\(String\(root\.selectedWorkspace\), root\.missingApps\)/)
})

test("clicking a workspace goes there, because a layout is edited by watching it", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  const click = /root\.selectWorkspace\(chip\.modelData\)[\s\S]{0,400}?if \(root\.bar\) root\.bar\.run\(Model\.focusWorkspaceCommand\(chip\.modelData\)\)/
  assert.match(qml, click)
})

test("the panel scrolls when it outgrows the screen", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  // KeyboardPanel clamps the card to what fits on screen, so without this the
  // bottom of the panel is simply cut off.
  assert.match(qml, /QQC\.ScrollView \{/)
  assert.match(qml, /clip: true/)
  assert.match(qml, /width: scroller\.availableWidth/)

  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  // A Flickable steals a drag once it crosses the threshold; the divider has
  // to keep the grab or aiming it becomes a scroll.
  assert.match(canvas, /preventStealing: true/)
})

test("the canvas keeps its delegates alive across a drag", () => {
  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  // A Repeater fed a JavaScript array rebuilds every delegate when that array
  // is replaced, and a drag replaces it on every frame — destroying the handle
  // that holds the mouse grab, so the divider moves once and stops. Counts as
  // models keep the items; each reads its geometry out of the array by index.
  assert.match(canvas, /model: root\.rects\.length/)
  assert.match(canvas, /model: root\.isRatio \? root\.dividers\.length : 0/)
  assert.ok(!/model: root\.rects$/m.test(canvas))
  assert.ok(!/model: root\.isRatio \? root\.dividers : \[\]/.test(canvas))
})

test("the app lists are not rebuilt on every frame of a drag", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  // A drag rewrites the document continuously; bound to `config`, every row
  // in the Apps section would be destroyed and recreated sixty times a second.
  assert.match(qml, /function refreshAppState\(\)/)
  assert.match(qml, /if \(!canvas\.dragging\) root\.refreshAppState\(\)/)
})

test("a new profile inherits the pins it was copied from", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /pins: source && source\.pins \? JSON\.parse\(JSON\.stringify\(source\.pins\)\) : \{\}/)
})

test("a terminal app is opened in a terminal, under its own class", () => {
  // nvim, btop, a TUI player: `Terminal=true` entries are commands, not
  // windows. Run bare, the process exits the moment it finds no tty; run in a
  // terminal, the window carries the terminal's class and the pin that asked
  // for it never matches. Asking the terminal for the class fixes both.
  // GTK refuses an app id with no dot in it, so the class is one of ours.
  assert.equal(Model.terminalClassFor("nvim"), "omarchy.wsl.nvim")
  assert.equal(Model.terminalClassFor("btop++"), "omarchy.wsl.btop")
  assert.equal(Model.terminalClassFor(""), "omarchy.wsl.app")

  // Ghostty hands a second invocation to the instance already running, which
  // keeps its own class — proved on 1.2: `--class=nvim` alone changes nothing.
  assert.equal(Model.terminalLaunch("ghostty", "omarchy.wsl.nvim", "nvim"),
    "ghostty --gtk-single-instance=false --class=omarchy.wsl.nvim -e nvim")
  assert.equal(Model.terminalLaunch("foot", "omarchy.wsl.btop", "btop"),
    "foot --app-id=omarchy.wsl.btop -e btop")
  assert.equal(Model.terminalLaunch("kitty", "omarchy.wsl.cliamp", "cliamp"),
    "kitty --class=omarchy.wsl.cliamp cliamp")

  // No terminal we know: the app still opens, under the terminal's own class.
  assert.equal(Model.terminalLaunch("", "omarchy.wsl.nvim", "nvim"), "xdg-terminal-exec nvim")
  // Nothing to run is nothing to run.
  assert.equal(Model.terminalLaunch("ghostty", "omarchy.wsl.nvim", ""), "")
  assert.equal(Model.terminalLaunch("ghostty", "", "nvim"),
    "ghostty --gtk-single-instance=false -e nvim")
})

test("a pin remembers how it was started, because nothing else knows", () => {
  // A terminal app's window is called what we asked the terminal to call it,
  // and no desktop entry mentions that class — so the launcher would find
  // nothing to run the second time.
  const config = Model.normalizeConfig({
    profiles: [{
      name: "d",
      fallback: "dwindle",
      pins: {
        "omarchy.wsl.nvim": {
          workspace: 9, slots: [1], name: "Neovim",
          command: "ghostty --class=omarchy.wsl.nvim -e nvim"
        }
      }
    }],
    activeProfile: "d"
  })
  // No catalogue entry for that class at all, and it still knows what to run.
  const missing = Model.missingApps(config, 9, [], {})
  assert.equal(missing.length, 1)
  assert.equal(missing[0].command, "ghostty --class=omarchy.wsl.nvim -e nvim")
  assert.equal(missing[0].name, "Neovim")
  // Already wrapped: the launcher must not wrap it again.
  assert.equal(missing[0].terminal, false)
})

test("the catalogue remembers which apps need a terminal", () => {
  const config = Model.normalizeConfig({
    profiles: [{ name: "d", fallback: "dwindle", pins: { nvim: { workspace: 3, slots: [1] } } }],
    activeProfile: "d"
  })
  const catalog = [{ match: "nvim", name: "Neovim", command: "nvim", terminal: true }]
  const missing = Model.missingApps(config, 3, catalog, {})
  assert.equal(missing.length, 1)
  assert.equal(missing[0].terminal, true, "the launcher has to know to wrap it")
  assert.equal(Model.searchApps(config, 3, catalog, "").rows[0].terminal, true)
})

test("opening a workspace skips what is already on screen", () => {
  const config = Model.normalizeConfig({
    profiles: [{
      name: "default",
      fallback: "dwindle",
      pins: { firefox: 3, ghostty: 3, "some.class": 3, elsewhere: 4 }
    }],
    activeProfile: "default"
  })
  const catalog = [
    { match: "firefox", name: "Firefox", command: "firefox", running: true },
    { match: "ghostty", name: "Ghostty", command: "ghostty" },
    { match: "elsewhere", name: "Elsewhere", command: "elsewhere" }
    // "some.class" is pinned but the machine has no entry for it, so there is
    // nothing to run and it is not offered.
  ]
  // firefox already has a window here; ghostty does not.
  const missing = Model.missingApps(config, 3, catalog, { firefox: 1 })
  assert.deepEqual(missing.map((a) => a.match), ["ghostty"])
  assert.equal(missing[0].command, "ghostty")
  assert.equal(missing[0].count, 1)
  // A pin on another workspace is that workspace's business.
  assert.deepEqual(Model.missingApps(config, 4, catalog, {}).map((a) => a.match), ["elsewhere"])
})

test("an app pinned to three places wants three windows", () => {
  const config = Model.normalizeConfig({
    profiles: [{
      name: "default",
      fallback: "dwindle",
      pins: { foot: { workspace: 9, slots: [1, 2, 3] }, signal: 9 }
    }],
    activeProfile: "default"
  })
  const catalog = [
    { match: "foot", name: "Foot", command: "foot" },
    { match: "signal", name: "Signal", command: "signal-desktop" }
  ]

  // Nothing there yet: three terminals and a Signal, in one press.
  const empty = Model.missingApps(config, 9, catalog, {})
  assert.deepEqual(empty.map((a) => a.name + "x" + a.count), ["Footx3", "Signalx1"])
  assert.equal(Model.missingCount(empty), 4)

  // One already here means two more, not another three.
  assert.equal(Model.missingApps(config, 9, catalog, { foot: 1 })[0].count, 2)

  // Full: nothing to do.
  assert.deepEqual(Model.missingApps(config, 9, catalog, { foot: 3, signal: 1 }), [])

  // Windows of the same app on another workspace are the user's business —
  // this counts what is on the workspace being filled.
  assert.equal(Model.missingCount(Model.missingApps(config, 9, catalog, {})), 4)
})

test("a pin learns the class its launch actually opened", () => {
  // A desktop entry does not have to say what its windows will be called, and
  // a webapp's never does: Omarchy's Discord entry launches Chromium, whose
  // window turns up under a class derived from the URL. Pinned from the entry,
  // the rule would name a class no window ever has.
  assert.deepEqual(
    Model.matchLaunchedWindows(
      [{ match: "Discord", name: "Discord" }],
      ["chrome-discord.com__channels_@me-Default"]
    ),
    [{ match: "Discord", become: "chrome-discord.com__channels_@me-Default" }]
  )

  // Several at once still pair up when each class carries its app's name.
  assert.deepEqual(
    Model.matchLaunchedWindows(
      [{ match: "Discord", name: "Discord" }, { match: "signal", name: "Signal" }],
      ["signal", "chrome-discord.com__channels_@me-Default"]
    ).map((p) => p.match),
    ["Discord", "signal"]
  )

  // One outstanding launch and one new window is confident enough on its own.
  assert.deepEqual(
    Model.matchLaunchedWindows([{ match: "zed", name: "Zed" }], ["dev.zed.Zed"]),
    [{ match: "zed", become: "dev.zed.Zed" }]
  )

  // Anything ambiguous is left alone: a wrong pin is worse than none.
  assert.deepEqual(
    Model.matchLaunchedWindows(
      [{ match: "a", name: "Alpha" }, { match: "b", name: "Beta" }],
      ["something", "other"]
    ),
    []
  )
  // A two-letter token would match half the classes on the machine.
  assert.deepEqual(Model.matchLaunchedWindows([{ match: "go", name: "Go" }], ["golang", "gopher"]), [])
  assert.equal(Model.launchToken("Signal Desktop"), "signaldesktop")
})

test("a pin can carry the name its class cannot", () => {
  const pin = Model.normalizePin({ workspace: 3, slots: [1], name: "Discord" })
  assert.equal(pin.name, "Discord")
  // Only when it says something: a pin whose class is already readable does
  // not carry a copy of it.
  assert.equal(Model.normalizePin({ workspace: 3 }).name, undefined)

  const config = Model.normalizeConfig({
    profiles: [{
      name: "default",
      fallback: "dwindle",
      pins: { "chrome-discord.com__channels_@me-Default": { workspace: 3, slots: [1], name: "Discord" } }
    }],
    activeProfile: "default"
  })
  // The row reads "Discord", not the Chromium app id.
  assert.equal(Model.searchApps(config, 3, [], "").rows[0].name, "Discord")
})

test("the panel corrects a pin from what the launch opened", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function adoptLaunched\(classes\)/)
  assert.match(qml, /function rewritePin\(from, to, command\)/)
  // The command goes with the class it produced, or the app could never be
  // started again under the name it now answers to.
  assert.match(qml, /if \(carried !== ""\) next\.command = carried/)
  // The rule is installed too late for the window that taught us the class.
  assert.match(qml, /sync\.gather\(to, workspace\)/)
  // And the watch outlives the panel: an app can take a few seconds to appear.
  assert.match(qml, /running: root\.opened \|\| root\.pendingLaunches\.length > 0/)
})

test("editing a shipped layout starts a copy instead of rewriting it", () => {
  for (const preset of Model.presets()) {
    assert.ok(Model.isPreset(preset.id), `${preset.id} ships with the plugin`)
  }

  // By id, not by content. A preset edited last week is still a preset: judged
  // on shape it would quietly become the user's, and the next drag would
  // rewrite it on every workspace using it.
  assert.ok(Model.isPreset("even"))
  assert.ok(Model.isPreset("focus"))

  // A layout of the user's own is never a preset, whatever it holds.
  assert.ok(!Model.isPreset("custom-3f9a"))
  assert.ok(!Model.isPreset("golden-2"))
  assert.ok(!Model.isPreset(""))

  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function forkPreset\(draft, sourceId\)/)
  assert.match(qml, /var id = Model\.customLayoutId\(draft\)/)
  assert.match(qml, /copy\.name = Model\.uniqueLayoutName\(draft, "Custom"\)/)
  // Every path that changes a shape goes through it: the two drags and the
  // discrete edits.
  assert.match(qml, /edited = root\.forkPreset\(draft, sourceId\)[\s\S]{0,200}draft\.layouts\[i\]\.weights = weights/)
  assert.match(qml, /edited = root\.forkPreset\(draft, sourceId\)[\s\S]{0,300}shapeSetCell/)
  assert.match(qml, /var id = root\.forkPreset\(draft, sourceId\)/)
})

test("a layout nobody named gets an id of its own and a name you can change", () => {
  const config = Model.defaultConfig()
  const first = Model.customLayoutId(config)
  assert.match(first, /^custom-[a-z0-9]{4}$/)
  // Random, not counted: a fork happens mid-drag, against a document that is
  // changing under it.
  assert.ok(!Model.findLayout(config, first))

  assert.equal(Model.uniqueLayoutName(config, "Custom"), "Custom")
  const taken = Model.normalizeConfig({
    layouts: [{ id: "a", name: "Custom", weights: [50, 50] },
      { id: "b", name: "Custom 2", weights: [50, 50] }],
    profiles: [{ name: "d", fallback: "dwindle" }]
  })
  // Two cards both reading "Custom" are two cards you cannot tell apart.
  assert.equal(Model.uniqueLayoutName(taken, "Custom"), "Custom 3")
})

test("a preset edited through the panel's path leaves the shipped one alone", () => {
  // The same steps Panel.forkPreset takes, on a real document.
  const draft = JSON.parse(JSON.stringify(Model.defaultConfig()))
  const source = Model.findLayout(draft, "focus")
  assert.ok(Model.isPreset(source.id))

  const id = Model.customLayoutId(draft)
  const copy = JSON.parse(JSON.stringify(source))
  copy.id = id
  copy.name = Model.uniqueLayoutName(draft, "Custom")
  draft.layouts.push(copy)
  draft.profiles[0].assignments["3"] = id
  copy.weights = [30, 40, 30]

  const after = Model.normalizeConfig(draft)
  assert.deepEqual(Model.findLayout(after, "focus").weights, [25, 50, 25], "the shipped layout moved")
  assert.deepEqual(Model.findLayout(after, id).weights, [30, 40, 30])
  assert.equal(Model.layoutIdForWorkspace(after, 3), id)
  // The copy is nobody's preset — it is named for what it is, and renaming it
  // is the field under the library.
  assert.match(id, /^custom-[a-z0-9]{4}$/)
  assert.equal(Model.findLayout(after, id).name, "Custom")

  // The copy is not a preset, so the next edit lands on it rather than
  // spawning another. A drag that snaps back to the original ratio would
  // otherwise fork once per frame.
  assert.ok(!Model.isPreset(id))

  // And a preset that has already been changed is still a preset: the next
  // edit forks again rather than rewriting it.
  const used = Model.normalizeConfig({
    layouts: [{ id: "even", name: "Even", weights: [60, 40] }],
    profiles: [{ name: "d", fallback: "even" }]
  })
  assert.ok(Model.isPreset(Model.findLayout(used, "even").id))
})

test("carrying one place onto another exchanges their apps", () => {
  const pins = {
    foot: { workspace: "9", slots: [1, 2], name: "Foot" },
    zed: { workspace: "9", slots: [3], command: "zed" },
    elsewhere: { workspace: "5", slots: [1] }
  }
  const swapped = Model.swappedPins(pins, 9, 1, 3)
  assert.deepEqual(swapped.foot.slots, [2, 3])
  assert.deepEqual(swapped.zed.slots, [1])
  // Another workspace's pins are none of this drag's business.
  assert.deepEqual(swapped.elsewhere.slots, [1])
  // What the pin remembers survives the swap.
  assert.equal(swapped.foot.name, "Foot")
  assert.equal(swapped.zed.command, "zed")

  // Dropping a tile on itself changes nothing.
  assert.deepEqual(Model.swappedPins(pins, 9, 2, 2).foot.slots, [1, 2])
  assert.deepEqual(Model.swappedPins(pins, "special:x", 1, 3).foot.slots, [1, 2])
})

test("the canvas carries a tile rather than mistaking a drag for a click", () => {
  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  assert.match(canvas, /signal placesSwapped\(int from, int to\)/)
  assert.match(canvas, /function placeAt\(x, y\)/)
  // A few pixels of wobble is a click; past that the tile is being carried,
  // and the release must not also select the slot.
  assert.match(canvas, /if \(root\.carrying === 0 && moved < Style\.space\(6\)\) return/)
  assert.match(canvas, /if \(from > 0\) \{/)
  // And you can see what you are carrying: the tile fades, the target lights
  // up, and a label rides with the pointer.
  assert.match(canvas, /id: ghost/)
  assert.match(canvas, /readonly property var carryApps/)
  assert.match(canvas, /opacity: tile\.carried \? 0\.45 : 1/)

  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function swapPlaces\(from, to\)/)
  assert.match(qml, /onPlacesSwapped: function\(from, to\) \{ root\.swapPlaces\(from, to\) \}/)
})

// ------------------------------------------------------------- slot menu

test("splitting a slot takes the room from that slot alone", () => {
  assert.deepEqual(Model.splitSlot([25, 50, 25], 1, 2), [25, 25, 25, 25])
  assert.deepEqual(Model.splitSlot([50, 50], 0, 2), [25, 25, 50])
  assert.equal(Model.splitSlot([50, 50], 0, 3).length, 4)
  // Splitting past the cap would silently drop the tail, so it does nothing.
  const full = Model.evenWeights(Model.MAX_SLOTS)
  assert.deepEqual(Model.splitSlot(full, 0, 2), full)
  assert.deepEqual(Model.splitSlot([25, 50, 25], 9, 2), [25, 50, 25])
})

test("a slot can be split across the grain as well as along it", () => {
  // Along: the slot becomes two slots, taking the room from itself.
  assert.deepEqual(
    Model.shapeSplitAlong([60, 40], [1, 1], 0, 2),
    { weights: [30, 30, 40], cells: [[100], [100], [100]] }
  )
  // Across: the slot keeps its width and holds two windows, one above the
  // other — the split a flat list of weights cannot express.
  assert.deepEqual(
    Model.shapeSplitAcross([60, 40], [1, 1], 1, 2),
    { weights: [60, 40], cells: [[100], [50, 50]] }
  )
  // Asking twice gives three parts, and merging puts it back.
  assert.equal(Model.shapeSplitAcross([60, 40], [1, 2], 1, 2).cells[1].length, 3)
  assert.deepEqual(Model.shapeMerge([60, 40], [1, 3], 1).cells, [[100], [100]])

  // Splitting along drops the cross-grain split of the piece it divides,
  // rather than multiplying the places on screen.
  assert.deepEqual(Model.shapeSplitAlong([60, 40], [1, 2], 1, 2).cells, [[100], [100], [100]])

  // Both refuse rather than truncate at the cap of eight places.
  assert.equal(Model.shapeSplitAcross([50, 50], [4, 4], 0, 2).cells[0].length, 4)
  const full = Model.evenWeights(Model.MAX_SLOTS)
  assert.deepEqual(Model.shapeSplitAlong(full, [], 0, 2).weights, full)
  // Splitting a slot that is itself cut into four is fine, though: the four
  // parts go away with it, so the total comes down rather than up.
  assert.deepEqual(
    Model.shapeSplitAlong([50, 50], [4, 4], 0, 2).cells.map((c) => c.length),
    [1, 1, 4]
  )
})

test("a divider handle sits on the seam it moves", () => {
  // "extra → new slots" appends places, which takes room from everything
  // else: the stored 70 is drawn at 53.8 with three windows. Placed by the
  // stored number, the handle floats away from the seam and the drag moves it
  // by some other amount again.
  const extend = Model.normalizeLayout({ id: "x", weights: [70, 30], overflow: "extend" })
  assert.equal(Model.dividerScale(extend, 2), 1)
  assert.equal(Math.round(70 * Model.dividerScale(extend, 3) * 10) / 10, 53.8)
  assert.equal(Math.round(70 * Model.dividerScale(extend, 4) * 10) / 10, 43.8)
  // And that is where the rects actually put it.
  const seam = Model.slotRects(extend, 3)[0]
  assert.equal(Math.round((seam.x + seam.w) * 1000) / 10, 53.8)

  // Stacking and holding leave the stored edges where they are.
  assert.equal(Model.dividerScale(Model.normalizeLayout({ id: "y", weights: [70, 30] }), 5), 1)
  assert.equal(Model.dividerScale(Model.normalizeLayout({ id: "g", kind: "grid" }), 5), 1)

  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  assert.match(canvas, /readonly property real dividerScale/)
  // Placed through the scale, and dragged back through it.
  assert.match(canvas, /\(root\.dividers\[handle\.index\] \|\| 0\) \* root\.dividerScale \/ 100/)
  assert.match(canvas, /var position = drawn \/ Math\.max\(0\.01, root\.dividerScale\)/)
})

test("a place can be cut in two from the tile itself", () => {
  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  assert.match(canvas, /signal splitRequested\(int slot, string direction\)/)
  // Named by what the user will see: in a rows layout the arrows swap.
  assert.match(canvas, /glyph: root\.horizontal \? "\\u2194" : "\\u2195"/)

  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function splitPlace\(slot, direction\)/)
  assert.match(qml, /onSplitRequested: function\(slot, direction\) \{ root\.splitPlace\(slot, direction\) \}/)
})

test("the canvas offers a handle for a cross-grain divider", () => {
  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  assert.match(canvas, /signal cellWeightsChanged\(int slot, var parts\)/)
  assert.match(canvas, /readonly property var crossHandles/)
  // Derived from the tiles actually drawn, so the handle lands on the seam.
  assert.match(canvas, /indices\.length !== parts\.length\) continue/)

  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function stageCells\(slot, parts\)/)
  assert.match(qml, /onCellWeightsChanged: function\(slot, parts\) \{ root\.stageCells\(slot, parts\) \}/)
})

test("a cross-grain divider is dragged the same way as any other", () => {
  // The panel hands over what setDivider produced, so one piece of maths
  // moves a divider on either axis.
  const dragged = Model.shapeSetCell([60, 40], [1, 2], 1, Model.setDivider([50, 50], 0, 30, {}))
  assert.deepEqual(dragged.cells, [[100], [30, 70]])
  // A part count that does not match the slot is a stale drag, not an edit.
  assert.deepEqual(Model.shapeSetCell([60, 40], [1, 2], 1, [100]).cells, [[100], [50, 50]])
  assert.deepEqual(Model.shapeSetCell([60, 40], [1, 2], 9, [30, 70]).cells, [[100], [50, 50]])

  // And the geometry follows it: the top part takes 30% of the column.
  const layout = Model.normalizeLayout({ id: "d", weights: [60, 40], cells: [[100], [30, 70]] })
  const rects = Model.slotRects(layout, 3)
  assert.equal(Math.round(rects[1].h * 100), 30)
  assert.equal(Math.round(rects[2].h * 100), 70)
})

test("an edit that adds or drops a slot moves its split with it", () => {
  // Otherwise the cross-grain splits slide onto the wrong slots.
  assert.deepEqual(Model.shapeAddSlot([60, 40], [1, 2]),
    { weights: [30, 30, 40], cells: [[100], [100], [50, 50]] })
  assert.deepEqual(Model.shapeRemoveSlot([25, 50, 25], [1, 2, 1], 1),
    { weights: [75, 25], cells: [[100], [100]] })
})

test("a split slot reads as its parts, not as its weights", () => {
  // `cells` holds weights now, so a careless comparison prints "25×100".
  const split = Model.normalizeLayout({ id: "s", weights: [25, 50, 25], cells: [1, [40, 60], 1] })
  assert.equal(Model.describeLayout(split), "25 / 50\u00d72 / 25")
  const plain = Model.normalizeLayout({ id: "p", weights: [60, 40] })
  assert.equal(Model.describeLayout(plain), "60 / 40")
})

test("the shorthand for a split is the count, and it round-trips", () => {
  // `"cells": [1, 2]` is what a hand edit wants to write.
  assert.deepEqual(Model.normalizeCells([1, 2], 2), [[100], [50, 50]])
  assert.deepEqual(Model.normalizeCells([[30, 70]], 1), [[30, 70]])
  // Garbage degrades to one part rather than losing the slot.
  assert.deepEqual(Model.normalizeCells(["x", null], 2), [[100], [100]])
  // Padded and trimmed to the slots it belongs to.
  assert.equal(Model.normalizeCells([1], 3).length, 3)
  assert.equal(Model.normalizeCells([1, 1, 1], 2).length, 2)
})

test("a split slot holds its places rather than growing into the gap", () => {
  const split = Model.normalizeLayout({ id: "s", weights: [60, 40], cells: [1, 2], underfill: "rescale" })
  // Three places, one window: it takes the first in fill order and the other
  // two stay empty, even though the layout asked to rescale — there is no
  // sensible way to grow half of a split slot.
  const one = Model.slotRects(split, 1)
  assert.equal(one.length, 1)
  assert.equal(Math.round(one[0].w * 100), 60)
  assert.equal(Math.round(one[0].h * 100), 100)

  const three = Model.slotRects(split, 3)
  assert.equal(three.length, 3)
  // The two halves of the 40 sit one above the other and keep its width.
  assert.equal(Math.round(three[1].w * 100), 40)
  assert.equal(Math.round(three[1].h * 100), 50)
  assert.equal(Math.round(three[2].h * 100), 50)
  assert.ok(three[2].y > three[1].y, "the second half sits below the first")
})

test("a tile's number is its fill order, and the menu needs its position", () => {
  const layout = Model.normalizeLayout({ id: "f", weights: [25, 50, 25] })
  // The centre fills first, so tile 1 is slot index 1 — splitting "tile 1"
  // has to split weights[1], not weights[0].
  assert.deepEqual(Model.rectSlotPositions(layout, 3), [1, 0, 2])
  assert.deepEqual(Model.rectSlotPositions(layout, 1), [1])
  // Overflow stacks two windows into the last slot, which keeps its position.
  assert.deepEqual(Model.rectSlotPositions(layout, 4), [1, 0, 2, 2])
  const even = Model.normalizeLayout({ id: "e", weights: [50, 50] })
  assert.deepEqual(Model.rectSlotPositions(even, 2), [0, 1])
})

test("the canvas draws every place, not every slot", () => {
  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  // Sized by slot count, a slot split in two would draw one tile and the new
  // half would not appear until enough windows were open to fill it.
  assert.match(canvas, /readonly property int placeCount: Model\.totalCells\(spec\.cells\)/)
  assert.match(canvas, /drawnCount: Math\.max\(1, Math\.max\(root\.windowCount, root\.isRatio \? root\.placeCount : 1\)\)/)

  // And the geometry backs that up: three places on an empty workspace.
  const split = Model.normalizeLayout({ id: "s", weights: [60, 40], cells: [1, 2] })
  assert.equal(Model.totalCells(split.cells), 3)
  assert.equal(Model.slotRects(split, 3).length, 3)
})

test("a split aims at the place it just made", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function aimNewPlace\(key, at\)/)
  assert.match(qml, /if \(key === "along" \|\| key === "across"\) aimNewPlace\(key, at\)/)
  // And the menu can aim at any place without splitting first.
  assert.match(qml, /key: "add", label: "Put an app here"/)
})

test("right-clicking a tile opens the menu where the cursor is", () => {
  const canvas = fs.readFileSync(path.join(__dirname, "..", "LayoutCanvas.qml"), "utf8")
  assert.match(canvas, /signal slotMenuRequested\(int slot, real x, real y\)/)
  assert.match(canvas, /acceptedButtons: Qt\.LeftButton \| Qt\.RightButton/)

  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.match(qml, /function openSlotMenu\(slot, x, y\)/)
  // Both directions, named by what the user sees rather than by the grain.
  assert.match(qml, /key: "along"/)
  assert.match(qml, /key: "across"/)
  assert.match(qml, /var sideways = layout\.orientation === "rows"/)
  assert.match(qml, /function runSlotMenu\(key\)/)
  // Escape has to reach the menu before it reaches the panel.
  assert.match(qml, /if \(root\.menuOpen\) root\.closeSlotMenu\(\)/)
  // The same overlay opens on a workspace chip, for the workspace itself.
  assert.match(qml, /function openWorkspaceMenu\(workspace, item, x, y\)/)
  assert.match(qml, /function runWorkspaceMenu\(key\)/)
})

test("every command the CLI documents is answered by the panel", () => {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  const commands = [
    "open", "close", "show", "hide", "toggle",
    "status", "workspace", "json", "profiles", "apply", "layouts",
    "set", "reset", "pin", "unpin", "capture", "launch"
  ]
  for (const name of commands) {
    assert.match(qml, new RegExp(`function ${name}\\(`), `ipc ${name}`)
  }
  // Nothing reads the panel's own selection, so a script gets the same answer
  // whether the panel is open or not.
  const ipc = qml.slice(qml.indexOf("IpcHandler {"), qml.indexOf("function summon()"))
  assert.ok(!/root\.selectedWorkspace/.test(ipc), "an IPC command read the panel's selection")
  assert.ok(!/root\.selectedSlot/.test(ipc), "an IPC command read the panel's aim")
})

test("a status line says what a workspace is tiling with and why", () => {
  const config = Model.normalizeConfig({
    layouts: [{ id: "focus", name: "Focus", weights: [25, 50, 25] }],
    profiles: [{
      name: "work",
      fallback: "dwindle",
      assignments: { 3: "focus" },
      monitors: { "DP-2": "focus" },
      pins: { firefox: { workspace: 3, slots: [1], name: "Firefox" } }
    }],
    activeProfile: "work"
  })
  assert.match(Model.statusLine(config, 3, "eDP-1"), /workspace 3 · Focus \(25 \/ 50 \/ 25\) · from workspace/)
  assert.match(Model.statusLine(config, 3, "eDP-1"), /apps Firefox@1/)
  // The monitor default is why, when nothing more specific says otherwise.
  assert.match(Model.statusLine(config, 5, "DP-2"), /from monitor DP-2/)
  assert.match(Model.statusLine(config, 7, "eDP-1"), /Hyprland dwindle · from profile default/)
  assert.match(Model.statusLine(config, 0, ""), /out of range/)
})

test("the JSON state says how each workspace resolves, which the file does not", () => {
  const config = Model.normalizeConfig({
    layouts: [{ id: "focus", name: "Focus", weights: [60, 40], cells: [1, 2] }],
    profiles: [{ name: "d", fallback: "dwindle", monitors: { "DP-2": "focus" } }],
    activeProfile: "d"
  })
  const state = Model.stateJson(config, { "5": "DP-2" }, [5])
  const five = state.workspaces.find((w) => w.workspace === 5)
  assert.equal(five.layout, "focus")
  assert.equal(five.monitor, "DP-2")
  assert.equal(five.places, 3)
  assert.equal(state.layouts[0].places, 3)
  assert.deepEqual(state.profiles, ["d"])
  // It has to survive JSON.stringify, which is the only thing it is for.
  assert.doesNotThrow(() => JSON.stringify(state))
})

test("slot lists arrive from a shell in whatever shape the shell felt like", () => {
  assert.deepEqual(Model.parseSlots("1,3"), [1, 3])
  assert.deepEqual(Model.parseSlots("3 1"), [1, 3])
  assert.deepEqual(Model.parseSlots("2,2,2"), [2])
  assert.deepEqual(Model.parseSlots("9,1"), [1])
  assert.deepEqual(Model.parseSlots(""), [])
  assert.deepEqual(Model.parseSlots(null), [])
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
      Model.normalizeLayout({ id: "i", weights: [20, 30, 30, 20], underfill: "hold", orientation: "rows" }),
      // Split slots: the same shape cut across the grain, which is the second
      // dimension the flat weight list cannot express on its own.
      Model.normalizeLayout({ id: "j", weights: [60, 40], cells: [1, 2] }),
      Model.normalizeLayout({ id: "k", weights: [50, 50], cells: [2, 2] }),
      Model.normalizeLayout({ id: "l", weights: [25, 50, 25], cells: [2, 1, 2], orientation: "rows" }),
      Model.normalizeLayout({ id: "m", weights: [60, 40], cells: [1, 3], overflow: "first" }),
      Model.normalizeLayout({ id: "n", weights: [70, 30], cells: [1, 2], overflow: "extend" }),
      Model.normalizeLayout({ id: "o", weights: [40, 60], cells: [2, 1], fill: "order" })
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
      // %.17g round-trips a double exactly. Rounded text would compare the two
      // languages' half-rounding rules rather than their geometry: 0.65625
      // prints as 0.6563 from JavaScript and 0.6562 from Lua, and neither is
      // a disagreement about where the window goes.
      "      parts[#parts + 1] = string.format('%.17g,%.17g,%.17g,%.17g', r[1], r[2], r[3], r[4])",
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
        expected.push({ id: layout.id, n, rects: Model.slotRects(layout, n) })
      }
    }

    assert.equal(luaLines.length, expected.length)
    for (let i = 0; i < expected.length; i++) {
      const [id, n, body] = luaLines[i].split("|")
      const want = expected[i]
      assert.equal(id, want.id)
      assert.equal(Number(n), want.n)
      const got = body.length === 0 ? [] : body.split(" ").map((cell) => cell.split(",").map(Number))
      assert.equal(got.length, want.rects.length, `rect count for ${id} with ${n} windows`)
      for (let r = 0; r < got.length; r++) {
        const mine = [want.rects[r].x, want.rects[r].y, want.rects[r].w, want.rects[r].h]
        for (let k = 0; k < 4; k++) {
          // Compared as numbers, to a tolerance far tighter than a pixel on any
          // monitor: the two sides must agree about geometry, not about how
          // their standard libraries round the fourth decimal.
          assert.ok(Math.abs(got[r][k] - mine[k]) < 1e-12,
            `Lua and JS disagree on ${id} with ${n} windows: rect ${r} [${got[r]}] vs [${mine}]`)
        }
      }
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
