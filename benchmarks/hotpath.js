import { bench } from "benchik"

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const SIZES = [50_000, 200_000, 500_000, 1_000_000]
const VIEW = { minX: 0, minY: 0, maxX: 1920, maxY: 1080 }
const DIRTY_PCT = 0.1

// ---------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------
function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------
// Pre-compute world-space AABB from local w/h + transform
// ---------------------------------------------------------------
function computeWorldBox(w, h, px, py, sx, sy, rz, out) {
  const cos = Math.cos(rz), sin = Math.sin(rz)
  const t0x = 0 * sx * cos - 0 * sy * sin + px
  const t0y = 0 * sx * sin + 0 * sy * cos + py
  const t1x = w * sx * cos - 0 * sy * sin + px
  const t1y = w * sx * sin + 0 * sy * cos + py
  const t2x = w * sx * cos - h * sy * sin + px
  const t2y = w * sx * sin + h * sy * cos + py
  const t3x = 0 * sx * cos - h * sy * sin + px
  const t3y = 0 * sx * sin + h * sy * cos + py
  out[0] = Math.min(t0x, t1x, t2x, t3x) | 0
  out[1] = Math.min(t0y, t1y, t2y, t3y) | 0
  out[2] = Math.max(t0x, t1x, t2x, t3x) | 0
  out[3] = Math.max(t0y, t1y, t2y, t3y) | 0
}

function genData(N) {
  const rng = mulberry32(42)

  const localW = new Int32Array(N)
  const localH = new Int32Array(N)
  const posX = new Int32Array(N)
  const posY = new Int32Array(N)
  const scaleX = new Int32Array(N)
  const scaleY = new Int32Array(N)
  const rotZ = new Int32Array(N)
  const visible = new Uint8Array(N)
  const shouldUpdate = new Uint8Array(N)
  const zIndex = new Int32Array(N)

  // Pre-computed world-space AABBs (for non-dirty nodes)
  const worldMinX = new Int32Array(N)
  const worldMinY = new Int32Array(N)
  const worldMaxX = new Int32Array(N)
  const worldMaxY = new Int32Array(N)

  const tmp = [0, 0, 0, 0]

  for (let i = 0; i < N; i++) {
    const w = ((rng() * 200) + 20) | 0
    const h = ((rng() * 200) + 20) | 0
    const px = (rng() * 200000) | 0
    const py = (rng() * 200000) | 0
    const sx = 1
    const sy = 1
    const rz = 0
    const vis = 1
    const dirty = rng() < DIRTY_PCT ? 1 : 0
    const z = (rng() * 200000) | 0

    localW[i] = w
    localH[i] = h
    posX[i] = px
    posY[i] = py
    scaleX[i] = sx
    scaleY[i] = sy
    rotZ[i] = rz
    visible[i] = vis
    shouldUpdate[i] = dirty
    zIndex[i] = z

    if (!dirty) {
      computeWorldBox(w, h, px, py, sx, sy, rz, tmp)
      worldMinX[i] = tmp[0]
      worldMinY[i] = tmp[1]
      worldMaxX[i] = tmp[2]
      worldMaxY[i] = tmp[3]
    } else {
      // Dirty: will be computed fresh each frame; pre-populate with local box
      worldMinX[i] = 0
      worldMinY[i] = 0
      worldMaxX[i] = w
      worldMaxY[i] = h
    }
  }

  return { N, localW, localH, posX, posY, scaleX, scaleY, rotZ, visible, shouldUpdate, zIndex, worldMinX, worldMinY, worldMaxX, worldMaxY }
}

// ---------------------------------------------------------------
// Impl 1 — Struct (AoS, current object pattern)
// ---------------------------------------------------------------
function buildStructScene(data) {
  const { N, localW, localH, posX, posY, scaleX, scaleY, rotZ, visible, shouldUpdate, zIndex, worldMinX, worldMinY, worldMaxX, worldMaxY } = data
  const nodes = []

  for (let i = 0; i < N; i++) {
    // Represent both dirty and clean nodes the same way
    // box will be toggled between local and world state by the update
    const box = { min: { x: worldMinX[i], y: worldMinY[i] }, max: { x: worldMaxX[i], y: worldMaxY[i] } }
    nodes[i] = {
      visible: visible[i],
      shouldUpdate: shouldUpdate[i],
      zIndex: zIndex[i],
      box,
      posX: posX[i],
      posY: posY[i],
      scaleX: scaleX[i],
      scaleY: scaleY[i],
      rotZ: rotZ[i],
      localW: localW[i],
      localH: localH[i],
    }
  }

  return nodes
}

function structUpdate(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.shouldUpdate) {
      // Idempotent: always start from local w/h, never accumulate state
      const w = n.localW, h = n.localH
      const b = n.box
      b.min.x = 0; b.min.y = 0
      b.max.x = w; b.max.y = h

      const px = n.posX, py = n.posY, sx = n.scaleX, sy = n.scaleY, rz = n.rotZ
      const cos = Math.cos(rz), sin = Math.sin(rz)

      const t0x = 0 * sx * cos - 0 * sy * sin + px
      const t0y = 0 * sx * sin + 0 * sy * cos + py
      const t1x = w * sx * cos - 0 * sy * sin + px
      const t1y = w * sx * sin + 0 * sy * cos + py
      const t2x = w * sx * cos - h * sy * sin + px
      const t2y = w * sx * sin + h * sy * cos + py
      const t3x = 0 * sx * cos - h * sy * sin + px
      const t3y = 0 * sx * sin + h * sy * cos + py

      b.min.x = Math.min(t0x, t1x, t2x, t3x) | 0
      b.min.y = Math.min(t0y, t1y, t2y, t3y) | 0
      b.max.x = Math.max(t0x, t1x, t2x, t3x) | 0
      b.max.y = Math.max(t0y, t1y, t2y, t3y) | 0
    }
  }
}

function structCull(nodes, view, out) {
  let wi = 0
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n.visible) continue
    // box is guaranteed up-to-date (structUpdate called before for dirty nodes)
    const b = n.box
    if (b.max.x < view.minX || b.min.x > view.maxX ||
        b.max.y < view.minY || b.min.y > view.maxY) continue
    out[wi++] = n
  }
  out.length = wi
  return out
}

function structUpdateCull(nodes, view, out) {
  let wi = 0
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n.visible) continue
    if (n.shouldUpdate) {
      const w = n.localW, h = n.localH
      const b = n.box
      b.min.x = 0; b.min.y = 0
      b.max.x = w; b.max.y = h

      const px = n.posX, py = n.posY, sx = n.scaleX, sy = n.scaleY, rz = n.rotZ
      const cos = Math.cos(rz), sin = Math.sin(rz)

      const t0x = 0 * sx * cos - 0 * sy * sin + px
      const t0y = 0 * sx * sin + 0 * sy * cos + py
      const t1x = w * sx * cos - 0 * sy * sin + px
      const t1y = w * sx * sin + 0 * sy * cos + py
      const t2x = w * sx * cos - h * sy * sin + px
      const t2y = w * sx * sin + h * sy * cos + py
      const t3x = 0 * sx * cos - h * sy * sin + px
      const t3y = 0 * sx * sin + h * sy * cos + py

      b.min.x = Math.min(t0x, t1x, t2x, t3x) | 0
      b.min.y = Math.min(t0y, t1y, t2y, t3y) | 0
      b.max.x = Math.max(t0x, t1x, t2x, t3x) | 0
      b.max.y = Math.max(t0y, t1y, t2y, t3y) | 0
    }
    const b = n.box
    if (b.max.x < view.minX || b.min.x > view.maxX ||
        b.max.y < view.minY || b.min.y > view.maxY) continue
    out[wi++] = n
  }
  out.length = wi
  return out
}

function structFullFrame(nodes, view, out) {
  let wi = 0
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n.visible) continue
    if (n.shouldUpdate) {
      const w = n.localW, h = n.localH
      const b = n.box
      b.min.x = 0; b.min.y = 0
      b.max.x = w; b.max.y = h

      const px = n.posX, py = n.posY, sx = n.scaleX, sy = n.scaleY, rz = n.rotZ
      const cos = Math.cos(rz), sin = Math.sin(rz)

      const t0x = 0 * sx * cos - 0 * sy * sin + px
      const t0y = 0 * sx * sin + 0 * sy * cos + py
      const t1x = w * sx * cos - 0 * sy * sin + px
      const t1y = w * sx * sin + 0 * sy * cos + py
      const t2x = w * sx * cos - h * sy * sin + px
      const t2y = w * sx * sin + h * sy * cos + py
      const t3x = 0 * sx * cos - h * sy * sin + px
      const t3y = 0 * sx * sin + h * sy * cos + py

      b.min.x = Math.min(t0x, t1x, t2x, t3x) | 0
      b.min.y = Math.min(t0y, t1y, t2y, t3y) | 0
      b.max.x = Math.max(t0x, t1x, t2x, t3x) | 0
      b.max.y = Math.max(t0y, t1y, t2y, t3y) | 0
    }
    const b = n.box
    if (b.max.x < view.minX || b.min.x > view.maxX ||
        b.max.y < view.minY || b.min.y > view.maxY) continue
    out[wi++] = n
  }
  out.length = wi
  out.sort((a, b) => a.zIndex - b.zIndex)
  return out
}

// ---------------------------------------------------------------
// Impl 2 — Buffer (SoA typed arrays)
// ---------------------------------------------------------------
function bufferUpdate(data) {
  const { N, localW, localH, posX, posY, scaleX, scaleY, rotZ, shouldUpdate, worldMinX, worldMinY, worldMaxX, worldMaxY } = data
  for (let i = 0; i < N; i++) {
    if (shouldUpdate[i]) {
      const w = localW[i], h = localH[i]
      const px = posX[i], py = posY[i], sx = scaleX[i], sy = scaleY[i], rz = rotZ[i]
      const cos = Math.cos(rz), sin = Math.sin(rz)

      const t0x = 0 * sx * cos - 0 * sy * sin + px
      const t0y = 0 * sx * sin + 0 * sy * cos + py
      const t1x = w * sx * cos - 0 * sy * sin + px
      const t1y = w * sx * sin + 0 * sy * cos + py
      const t2x = w * sx * cos - h * sy * sin + px
      const t2y = w * sx * sin + h * sy * cos + py
      const t3x = 0 * sx * cos - h * sy * sin + px
      const t3y = 0 * sx * sin + h * sy * cos + py

      worldMinX[i] = Math.min(t0x, t1x, t2x, t3x) | 0
      worldMinY[i] = Math.min(t0y, t1y, t2y, t3y) | 0
      worldMaxX[i] = Math.max(t0x, t1x, t2x, t3x) | 0
      worldMaxY[i] = Math.max(t0y, t1y, t2y, t3y) | 0
    }
  }
}

function bufferCull(data, view, outIdx) {
  const { N, visible, worldMinX, worldMinY, worldMaxX, worldMaxY } = data
  let wi = 0
  for (let i = 0; i < N; i++) {
    if (!visible[i]) continue
    if (worldMaxX[i] < view.minX || worldMinX[i] > view.maxX ||
        worldMaxY[i] < view.minY || worldMinY[i] > view.maxY) continue
    outIdx[wi++] = i
  }
  return wi
}

function bufferUpdateCull(data, view, outIdx) {
  const { N, localW, localH, posX, posY, scaleX, scaleY, rotZ, visible, shouldUpdate, worldMinX, worldMinY, worldMaxX, worldMaxY } = data
  let wi = 0

  for (let i = 0; i < N; i++) {
    if (!visible[i]) continue

    if (shouldUpdate[i]) {
      const w = localW[i], h = localH[i]
      const px = posX[i], py = posY[i], sx = scaleX[i], sy = scaleY[i], rz = rotZ[i]
      const cos = Math.cos(rz), sin = Math.sin(rz)

      const t0x = 0 * sx * cos - 0 * sy * sin + px
      const t0y = 0 * sx * sin + 0 * sy * cos + py
      const t1x = w * sx * cos - 0 * sy * sin + px
      const t1y = w * sx * sin + 0 * sy * cos + py
      const t2x = w * sx * cos - h * sy * sin + px
      const t2y = w * sx * sin + h * sy * cos + py
      const t3x = 0 * sx * cos - h * sy * sin + px
      const t3y = 0 * sx * sin + h * sy * cos + py

      worldMinX[i] = Math.min(t0x, t1x, t2x, t3x) | 0
      worldMinY[i] = Math.min(t0y, t1y, t2y, t3y) | 0
      worldMaxX[i] = Math.max(t0x, t1x, t2x, t3x) | 0
      worldMaxY[i] = Math.max(t0y, t1y, t2y, t3y) | 0
    }

    if (worldMaxX[i] < view.minX || worldMinX[i] > view.maxX ||
        worldMaxY[i] < view.minY || worldMinY[i] > view.maxY) continue
    outIdx[wi++] = i
  }
  return wi
}

function bufferFullFrame(data, view, outIdx) {
  const wi = bufferUpdateCull(data, view, outIdx)

  const { zIndex } = data
  const idxView = outIdx.subarray(0, wi)
  idxView.sort((a, b) => zIndex[a] - zIndex[b])

  return wi
}

// ---------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------
await bench.untilCompiled()

for (const N of SIZES) {
  using group = bench.group(`Hot Path · N = ${N.toLocaleString()}`)
  group.memory = process.memoryUsage

  // Raw data (same source for both impls)
  const data = genData(N)

  // Struct scene (built from raw data, independent copy)
  const structNodes = buildStructScene(data)
  const structOut = []

  // Reusable buffer output
  const bufOutIdx = new Int32Array(N)

  // --- Cull only (read-only, same result every call) ---
  bench("struct · cull only", () => {
    return structCull(structNodes, VIEW, structOut).length
  })
  bench("buffer · cull only", () => {
    return bufferCull(data, VIEW, bufOutIdx)
  })

  // --- Update only (10% dirty, idempotent — resets from localW/H each time) ---
  bench("struct · update only (10%)", () => {
    structUpdate(structNodes)
  })
  bench("buffer · update only (10%)", () => {
    bufferUpdate(data)
  })

  // --- Update + Cull ---
  bench("struct · update + cull (10%)", () => {
    return structUpdateCull(structNodes, VIEW, structOut).length
  })
  bench("buffer · update + cull (10%)", () => {
    return bufferUpdateCull(data, VIEW, bufOutIdx)
  })

  // --- Full frame (update + cull + sort) ---
  bench("struct · full frame (10%)", () => {
    return structFullFrame(structNodes, VIEW, structOut).length
  })
  bench("buffer · full frame (10%)", () => {
    return bufferFullFrame(data, VIEW, bufOutIdx)
  })
}
