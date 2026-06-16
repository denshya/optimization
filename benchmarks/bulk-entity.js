import { bench } from "benchik"

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const N = 100_000
const RAND_K = 1_000
const RAND_IDX = Array.from({ length: RAND_K }, (_, i) => (i * 7919 + 13) % N)

// Entity: { id: i32, type: i32, x: f32, y: f32, hp: i32, maxHp: i32 } -> 24 bytes
const MAX_HP = 100

// ---------------------------------------------------------------
// Source data (pre-generated, same for all approaches)
// ---------------------------------------------------------------
const SRC = new Array(N)
for (let i = 0; i < N; i++) SRC[i] = { id: i, type: i % 5, x: i * 1.5, y: i * 2.5, hp: i * 3, maxHp: MAX_HP }

// Expected sums for assertions
const WRITE_EXPECT = SRC[N - 1].id + SRC[N - 1].hp // (N-1)*4
let readSum = 0
for (let i = 0; i < N; i++) readSum += SRC[i].id + SRC[i].hp // = 4 * N*(N-1)/2 = 2*N*(N-1)
let randSum = 0
for (const idx of RAND_IDX) randSum += SRC[idx].id + SRC[idx].hp

// ---------------------------------------------------------------
// Buffers (pre-populated for read benchmarks)
// ---------------------------------------------------------------

// 1. Plain objects
const objArr = SRC.slice() // same data

// 2. Pre-allocated object pool
const pool = new Array(N)
for (let i = 0; i < N; i++) pool[i] = { id: 0, type: 0, x: 0, y: 0, hp: 0, maxHp: 0 }

// 3. Uint8Array + DataView (AoS byte-level)
const bufU8 = new Uint8Array(N * 24)
const dv = new DataView(bufU8.buffer)
for (let i = 0; i < N; i++) {
  const o = i * 24
  dv.setInt32(o, SRC[i].id, true)
  dv.setInt32(o + 4, SRC[i].type, true)
  dv.setFloat32(o + 8, SRC[i].x, true)
  dv.setFloat32(o + 12, SRC[i].y, true)
  dv.setInt32(o + 16, SRC[i].hp, true)
  dv.setInt32(o + 20, SRC[i].maxHp, true)
}

// 4. AoS dual TypedArray views (Int32Array + Float32Array on same buffer)
const bufAoS = new ArrayBuffer(N * 24)
const i32v = new Int32Array(bufAoS)
const f32v = new Float32Array(bufAoS)
for (let i = 0; i < N; i++) {
  const o = i * 6
  i32v[o] = SRC[i].id; i32v[o + 1] = SRC[i].type
  f32v[o + 2] = SRC[i].x; f32v[o + 3] = SRC[i].y
  i32v[o + 4] = SRC[i].hp; i32v[o + 5] = SRC[i].maxHp
}

// 5. SoA (separate TypedArray per field)
const sid = new Int32Array(N)
const stype = new Int32Array(N)
const sx = new Float32Array(N)
const sy = new Float32Array(N)
const shp = new Int32Array(N)
const smaxHp = new Int32Array(N)
for (let i = 0; i < N; i++) {
  sid[i] = SRC[i].id; stype[i] = SRC[i].type; sx[i] = SRC[i].x
  sy[i] = SRC[i].y; shp[i] = SRC[i].hp; smaxHp[i] = SRC[i].maxHp
}

// ---------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------
{ let s = 0; for (let i = 0; i < 1000; i++) s += SRC[i].id + SRC[i].hp }

await bench.untilCompiled()

// ---------------------------------------------------------------
// GROUP 1: Write (fresh allocation + populate)
// ---------------------------------------------------------------
{
  using g = bench.group(`Write (fresh) × ${N.toLocaleString()} entities`)
  g.assert = WRITE_EXPECT

  bench("Plain objects (new)", () => {
    const a = new Array(N)
    for (let i = 0; i < N; i++) a[i] = { id: SRC[i].id, type: SRC[i].type, x: SRC[i].x, y: SRC[i].y, hp: SRC[i].hp, maxHp: SRC[i].maxHp }
    return a[N - 1].id + a[N - 1].hp
  })

  bench("Object pool (reuse)", () => {
    for (let i = 0; i < N; i++) { const e = pool[i]; const s = SRC[i]; e.id = s.id; e.type = s.type; e.x = s.x; e.y = s.y; e.hp = s.hp; e.maxHp = s.maxHp }
    return pool[N - 1].id + pool[N - 1].hp
  })

  bench("Uint8 + DataView", () => {
    const d = dv; let o = 0
    for (let i = 0; i < N; i++) { const s = SRC[i]; d.setInt32(o, s.id, true); d.setInt32(o + 4, s.type, true); d.setFloat32(o + 8, s.x, true); d.setFloat32(o + 12, s.y, true); d.setInt32(o + 16, s.hp, true); d.setInt32(o + 20, s.maxHp, true); o += 24 }
    return d.getInt32(N * 24 - 24, true) + d.getInt32(N * 24 - 8, true)
  })

  bench("AoS (dual views)", () => {
    const i32 = i32v; const f32 = f32v; let o = 0
    for (let i = 0; i < N; i++) { const s = SRC[i]; i32[o] = s.id; i32[o + 1] = s.type; f32[o + 2] = s.x; f32[o + 3] = s.y; i32[o + 4] = s.hp; i32[o + 5] = s.maxHp; o += 6 }
    return i32[N * 6 - 6] + i32[N * 6 - 2]
  })

  bench("SoA (per-field arrays)", () => {
    for (let i = 0; i < N; i++) { const s = SRC[i]; sid[i] = s.id; stype[i] = s.type; sx[i] = s.x; sy[i] = s.y; shp[i] = s.hp; smaxHp[i] = s.maxHp }
    return sid[N - 1] + shp[N - 1]
  })
}

// ---------------------------------------------------------------
// GROUP 2: Read (sequential) × N
// ---------------------------------------------------------------
{
  using g = bench.group(`Read (sequential) × ${N.toLocaleString()} entities`)
  g.assert = readSum

  bench("Plain objects", () => { let s = 0; for (let i = 0; i < N; i++) { const e = objArr[i]; s += e.id + e.hp } return s })
  bench("Object pool", () => { let s = 0; for (let i = 0; i < N; i++) { const e = pool[i]; s += e.id + e.hp } return s })
  bench("Uint8 + DataView", () => { let s = 0; for (let i = 0; i < N; i++) { const o = i * 24; s += dv.getInt32(o, true) + dv.getInt32(o + 16, true) } return s })
  bench("AoS (dual views)", () => { let s = 0; for (let i = 0; i < N; i++) { const o = i * 6; s += i32v[o] + i32v[o + 4] } return s })
  bench("SoA (per-field arrays)", () => { let s = 0; for (let i = 0; i < N; i++) s += sid[i] + shp[i]; return s })
}

// ---------------------------------------------------------------
// GROUP 3: Read (random) × 1,000
// ---------------------------------------------------------------
{
  using g = bench.group(`Read (random) × ${RAND_K.toLocaleString()} entities`)
  g.assert = randSum

  bench("Plain objects", () => { let s = 0; for (const idx of RAND_IDX) { const e = objArr[idx]; s += e.id + e.hp } return s })
  bench("Object pool", () => { let s = 0; for (const idx of RAND_IDX) { const e = pool[idx]; s += e.id + e.hp } return s })
  bench("Uint8 + DataView", () => { let s = 0; for (const idx of RAND_IDX) { const o = idx * 24; s += dv.getInt32(o, true) + dv.getInt32(o + 16, true) } return s })
  bench("AoS (dual views)", () => { let s = 0; for (const idx of RAND_IDX) { const o = idx * 6; s += i32v[o] + i32v[o + 4] } return s })
  bench("SoA (per-field arrays)", () => { let s = 0; for (const idx of RAND_IDX) s += sid[idx] + shp[idx]; return s })
}
