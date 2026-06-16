import { bench } from "benchik"

const N = 1_000_000

// ---------------------------------------------------------------
// Impl 1 — Plain JS object properties (current)
// ---------------------------------------------------------------
const plainNodes = new Array(N)
for (let i = 0; i < N; i++) {
  plainNodes[i] = {
    x: ((i * 7 + 13) % 200000) | 0,
    y: ((i * 3 + 5) % 200000) | 0,
  }
}

// ---------------------------------------------------------------
// Impl 2 — Getters/setters backed by typed array
// ---------------------------------------------------------------
const BUF_STRIDE = 2
const buf = new Int32Array(N * BUF_STRIDE)
for (let i = 0; i < N; i++) {
  buf[i * BUF_STRIDE + 0] = ((i * 7 + 13) % 200000) | 0
  buf[i * BUF_STRIDE + 1] = ((i * 3 + 5) % 200000) | 0
}

class V2Getter {
  constructor(_idx) { this._idx = _idx }
  get x() { return buf[this._idx * BUF_STRIDE + 0] }
  set x(v) { buf[this._idx * BUF_STRIDE + 0] = v }
  get y() { return buf[this._idx * BUF_STRIDE + 1] }
  set y(v) { buf[this._idx * BUF_STRIDE + 1] = v }
}

const getterNodes = new Array(N)
for (let i = 0; i < N; i++) getterNodes[i] = new V2Getter(i)

// ---------------------------------------------------------------
// Impl 3 — Direct typed array access (hot path target)
// ---------------------------------------------------------------
const directBuf = new Int32Array(N * 2)
for (let i = 0; i < N; i++) {
  directBuf[i * 2 + 0] = ((i * 7 + 13) % 200000) | 0
  directBuf[i * 2 + 1] = ((i * 3 + 5) % 200000) | 0
}

// ---------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------
await bench.untilCompiled()

const ITER = 100_000

// ====== GROUP 1: Property read speed ======
{
  using group = bench.group(`Property read · ${ITER.toLocaleString()} iters`)
  group.memory = process.memoryUsage

  const p = plainNodes[42]
  const g = getterNodes[42]

  bench("plain obj .x + .y", () => {
    let s = 0
    for (let i = 0; i < ITER; i++) s += p.x + p.y
    return s
  })

  bench("getter/setter .x + .y", () => {
    let s = 0
    for (let i = 0; i < ITER; i++) s += g.x + g.y
    return s
  })

  bench("buf[i*2+0] + buf[i*2+1]", () => {
    let s = 0
    for (let i = 0; i < ITER; i++) s += directBuf[i * 2 + 0] + directBuf[i * 2 + 1]
    return s
  })

  bench("local arr[0] + arr[1]", () => {
    let s = 0
    const bx = directBuf[42 * 2 + 0], by = directBuf[42 * 2 + 1]
    for (let i = 0; i < ITER; i++) s += bx + by
    return s
  })
}

// ====== GROUP 2: Property write speed ======
{
  using group = bench.group(`Property write · ${ITER.toLocaleString()} writes`)
  group.memory = process.memoryUsage

  const p = { x: 0, y: 0 }
  const g = new V2Getter(999_999)

  bench("plain obj .x = i, .y = i", () => {
    for (let i = 0; i < ITER; i++) { p.x = i; p.y = i }
  })

  bench("getter .x = i, .y = i", () => {
    for (let i = 0; i < ITER; i++) { g.x = i; g.y = i }
  })

  bench("buf[i*2+0] = i, buf[i*2+1] = i", () => {
    for (let i = 0; i < ITER; i++) { directBuf[i * 2 + 0] = i; directBuf[i * 2 + 1] = i }
  })
}

// ====== GROUP 3: Vector2 object creation cost ======
{
  using group = bench.group(`Vector2 creation · ${ITER.toLocaleString()} creates`)
  group.memory = process.memoryUsage

  const idx = 42

  bench("new { x, y } object", () => {
    let o
    for (let i = 0; i < ITER; i++) o = { x: buf[idx * 2 + 0], y: buf[idx * 2 + 1] }
    return o
  })

  bench("reuse pool object", () => {
    const o = { x: 0, y: 0 }
    for (let i = 0; i < ITER; i++) { o.x = buf[idx * 2 + 0]; o.y = buf[idx * 2 + 1] }
    return o
  })

  bench("read ints directly (no create)", () => {
    let sx = 0, sy = 0
    for (let i = 0; i < ITER; i++) { sx = buf[idx * 2 + 0]; sy = buf[idx * 2 + 1] }
    return sx + sy
  })
}

// ====== GROUP 4: Full frame (update 10% + cull + sort) ======
{
  using group = bench.group(`Full frame · N = 500,000`)
  group.memory = process.memoryUsage

  const M = 500_000

  // --- Struct data (plain JS props) ---
  const sNodes = []
  for (let i = 0; i < M; i++) {
    const dirty = i % 10 === 0 ? 1 : 0
    sNodes[i] = {
      visible: 1,
      shouldUpdate: dirty,
      zIndex: i,
      localW: 100, localH: 100,
      posX: (i * 7) % 200000, posY: (i * 3) % 200000,
      scaleX: 1, scaleY: 1, rotZ: 0,
      // World-space box (pre-computed for non-dirty)
      wmX: dirty ? 0 : ((i * 7) % 200000) + 50,
      wmY: dirty ? 0 : ((i * 3) % 200000) + 50,
      wMx: dirty ? 100 : ((i * 7) % 200000) + 150,
      wMy: dirty ? 100 : ((i * 3) % 200000) + 150,
    }
  }

  // --- Getter-backed struct data ---
  const bPosX = new Int32Array(M)
  const bPosY = new Int32Array(M)
  const bZIndex = new Int32Array(M)
  const bWmX = new Int32Array(M)
  const bWmY = new Int32Array(M)
  const bWMx = new Int32Array(M)
  const bWMy = new Int32Array(M)
  for (let i = 0; i < M; i++) {
    const dirty = i % 10 === 0 ? 1 : 0
    bPosX[i] = (i * 7) % 200000
    bPosY[i] = (i * 3) % 200000
    bZIndex[i] = i
    bWmX[i] = dirty ? 0 : ((i * 7) % 200000) + 50
    bWmY[i] = dirty ? 0 : ((i * 3) % 200000) + 50
    bWMx[i] = dirty ? 100 : ((i * 7) % 200000) + 150
    bWMy[i] = dirty ? 100 : ((i * 3) % 200000) + 150
  }

  class GetterNode {
    constructor(i) {
      const dirty = i % 10 === 0 ? 1 : 0
      this._idx = i
      this.visible = 1
      this.shouldUpdate = dirty
      this.localW = 100
      this.localH = 100
    }
    get zIndex() { return bZIndex[this._idx] }
    get wmX() { return bWmX[this._idx] }
    set wmX(v) { bWmX[this._idx] = v }
    get wmY() { return bWmY[this._idx] }
    set wmY(v) { bWmY[this._idx] = v }
    get wMx() { return bWMx[this._idx] }
    set wMx(v) { bWMx[this._idx] = v }
    get wMy() { return bWMy[this._idx] }
    set wMy(v) { bWMy[this._idx] = v }
  }

  const gNodes = new Array(M)
  for (let i = 0; i < M; i++) gNodes[i] = new GetterNode(i)

  // --- Buffer data (direct typed arrays) ---
  const bufVisible = new Uint8Array(M)
  const bufShouldUpdate = new Uint8Array(M)
  const bufLocalW = new Int32Array(M)
  const bufLocalH = new Int32Array(M)
  const bufPosX = new Int32Array(M)
  const bufPosY = new Int32Array(M)
  const bufZIndex = new Int32Array(M)
  const bufWmX = new Int32Array(M)
  const bufWmY = new Int32Array(M)
  const bufWMx = new Int32Array(M)
  const bufWMy = new Int32Array(M)
  const bufOutIdx = new Int32Array(M)

  for (let i = 0; i < M; i++) {
    const dirty = i % 10 === 0 ? 1 : 0
    bufVisible[i] = 1
    bufShouldUpdate[i] = dirty
    bufLocalW[i] = 100; bufLocalH[i] = 100
    bufPosX[i] = (i * 7) % 200000
    bufPosY[i] = (i * 3) % 200000
    bufZIndex[i] = i
    bufWmX[i] = dirty ? 0 : ((i * 7) % 200000) + 50
    bufWmY[i] = dirty ? 0 : ((i * 3) % 200000) + 50
    bufWMx[i] = dirty ? 100 : ((i * 7) % 200000) + 150
    bufWMy[i] = dirty ? 100 : ((i * 3) % 200000) + 150
  }

  const VIEW = { minX: 0, minY: 0, maxX: 500000, maxY: 500000 }

  // --- Struct full frame ---
  bench("struct plain props", () => {
    let wi = 0
    const out = []
    for (let i = 0; i < M; i++) {
      const n = sNodes[i]
      if (!n.visible) continue
      if (n.shouldUpdate) {
        n.wmX = n.posX; n.wmY = n.posY
        n.wMx = n.posX + n.localW; n.wMy = n.posY + n.localH
      }
      if (n.wMx < VIEW.minX || n.wmX > VIEW.maxX ||
          n.wMy < VIEW.minY || n.wmY > VIEW.maxY) continue
      out[wi++] = n
    }
    out.length = wi
    out.sort((a, b) => a.zIndex - b.zIndex)
    return wi
  })

  // --- Getter-backed full frame ---
  bench("getter-backed", () => {
    let wi = 0
    const out = []
    for (let i = 0; i < M; i++) {
      const n = gNodes[i]
      if (!n.visible) continue
      if (n.shouldUpdate) {
        n.wmX = bPosX[i]; n.wmY = bPosY[i]
        n.wMx = bPosX[i] + n.localW; n.wMy = bPosY[i] + n.localH
      }
      if (n.wMx < VIEW.minX || n.wmX > VIEW.maxX ||
          n.wMy < VIEW.minY || n.wmY > VIEW.maxY) continue
      out[wi++] = n
    }
    out.length = wi
    out.sort((a, b) => a.zIndex - b.zIndex)
    return wi
  })

  // --- Buffer (direct typed array access) ---
  bench("buffer direct arrays", () => {
    let wi = 0
    for (let i = 0; i < M; i++) {
      if (!bufVisible[i]) continue
      if (bufShouldUpdate[i]) {
        bufWmX[i] = bufPosX[i]; bufWmY[i] = bufPosY[i]
        bufWMx[i] = bufPosX[i] + bufLocalW[i]; bufWMy[i] = bufPosY[i] + bufLocalH[i]
      }
      if (bufWMx[i] < VIEW.minX || bufWmX[i] > VIEW.maxX ||
          bufWMy[i] < VIEW.minY || bufWmY[i] > VIEW.maxY) continue
      bufOutIdx[wi++] = i
    }
    bufOutIdx.subarray(0, wi).sort((a, b) => bufZIndex[a] - bufZIndex[b])
    return wi
  })

  // --- Buffer with cached local references (what JIT naturally produces) ---
  bench("buffer cached locals", () => {
    const v = bufVisible, d = bufShouldUpdate, z = bufZIndex
    const wmX = bufWmX, wmY = bufWmY, wMx = bufWMx, wMy = bufWMy
    const pX = bufPosX, pY = bufPosY, lW = bufLocalW, lH = bufLocalH
    const o = bufOutIdx

    let wi = 0
    for (let i = 0; i < M; i++) {
      if (!v[i]) continue
      if (d[i]) {
        wmX[i] = pX[i]; wmY[i] = pY[i]
        wMx[i] = pX[i] + lW[i]; wMy[i] = pY[i] + lH[i]
      }
      if (wMx[i] < VIEW.minX || wmX[i] > VIEW.maxX ||
          wMy[i] < VIEW.minY || wmY[i] > VIEW.maxY) continue
      o[wi++] = i
    }
    o.subarray(0, wi).sort((a, b) => z[a] - z[b])
    return wi
  })
}

// ====== GROUP 5: GC pressure ====
{
  using group = bench.group(`GC pressure · 100 frames × 50k nodes`)
  group.memory = process.memoryUsage

  const M = 50_000

  bench("struct (new array + sort per frame)", () => {
    const out = []
    for (let frame = 0; frame < 100; frame++) {
      out.length = 0
      for (let i = 0; i < M; i++) out.push(i)
      out.sort((a, b) => a - b)
    }
    return out.length
  })

  bench("buffer (reuse typed array, no alloc per frame)", () => {
    const out = new Int32Array(M)
    let wi = 0
    for (let frame = 0; frame < 100; frame++) {
      wi = 0
      for (let i = 0; i < M; i++) out[wi++] = i
      out.subarray(0, wi).sort((a, b) => a - b)
    }
    return wi
  })
}
