import { bench } from "benchik"

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const N = 20_000
const MIN_LEN = 5
const MAX_LEN = 50
const UPDATE_N = 4_000
const RAND_K = 1_000

const enc = new TextEncoder
const dec = new TextDecoder

// ---------------------------------------------------------------
// Deterministic name generation
// ---------------------------------------------------------------
function generateNames(count, minLen, maxLen) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
  const names = []
  for (let i = 0; i < count; i++) {
    const len = minLen + ((i * 7 + 13) % (maxLen - minLen + 1))
    let s = ""
    for (let j = 0; j < len; j++) s += chars[(i * 31 + j * 17) % chars.length]
    names.push(s)
  }
  return names
}

const NAMES = generateNames(N, MIN_LEN, MAX_LEN)
const NEW_NAMES = generateNames(UPDATE_N, MIN_LEN, MAX_LEN)

// String pool for approach 1 (pool pointer)
const ALL_POOL = [...NAMES, ...NEW_NAMES]
const nameToIdx = new Map(ALL_POOL.map((n, i) => [n, i]))

// Random indices for random-access read
const RAND_IDX = Array.from({ length: RAND_K }, (_, i) => (i * 7919 + 13) % N)

// Indices to update (deterministic, covers 20% of N)
const UPD_IDX = Array.from({ length: UPDATE_N }, (_, i) => (i * 3271 + 7) % N)

// Expected returns for assertions
const EXPECT_WRITE = NAMES[N - 1]
const EXPECT_RAND = NAMES[RAND_IDX[RAND_K - 1]]
const EXPECT_UPDATE = NEW_NAMES[0]

// ---------------------------------------------------------------
// Store factories — each encapsulates buffer, cursor, index
// ---------------------------------------------------------------

// 1. Pool pointer (C# ref-style: external string[] + Int32 index)
function createPoolStore() {
  const buf = new Int32Array(N * 3)
  return {
    reset() {},
    write(i, id, dmg, name) { const o = i * 3; buf[o] = id; buf[o + 1] = dmg; buf[o + 2] = nameToIdx.get(name) },
    readName(i) { return ALL_POOL[buf[i * 3 + 2]] },
    update(i, name) { buf[i * 3 + 2] = nameToIdx.get(name) },
  }
}

// 2. String arena (entity buffer + name blob, offset+length in entity)
function createArenaStore() {
  const ent = new Int32Array(N * 4)
  const blob = new Uint8Array((N + UPDATE_N) * (MAX_LEN + 8))
  let cur = 0
  return {
    reset() { cur = 0 },
    write(i, id, dmg, name) {
      const o = i * 4; ent[o] = id; ent[o + 1] = dmg
      const raw = enc.encode(name)
      ent[o + 2] = cur; ent[o + 3] = raw.length
      blob.set(raw, cur); cur += raw.length
    },
    readName(i) {
      const o = i * 4; const off = ent[o + 2], len = ent[o + 3]
      return dec.decode(blob.subarray(off, off + len))
    },
    update(i, name) {
      const o = i * 4
      const raw = enc.encode(name)
      ent[o + 2] = cur; ent[o + 3] = raw.length
      blob.set(raw, cur); cur += raw.length
    },
  }
}

// 3. Fixed-width inline (name slot padded with NUL)
function createFixedStore() {
  const STRIDE = 4 + 4 + MAX_LEN
  const buf = new Uint8Array(N * STRIDE)
  const dv = new DataView(buf.buffer)
  return {
    reset() {},
    write(i, id, dmg, name) {
      const o = i * STRIDE; dv.setInt32(o, id, true); dv.setInt32(o + 4, dmg, true)
      const slot = new Uint8Array(buf.buffer, o + 8, MAX_LEN)
      const { written } = enc.encodeInto(name, slot)
      if (written < MAX_LEN) slot.fill(0, written)
    },
    readName(i) {
      const o = i * STRIDE
      const slot = buf.subarray(o + 8, o + 8 + MAX_LEN)
      let end = slot.indexOf(0)
      if (end === -1) end = MAX_LEN
      return dec.decode(slot.subarray(0, end))
    },
    update(i, name) {
      const o = i * STRIDE
      const slot = new Uint8Array(buf.buffer, o + 8, MAX_LEN)
      const { written } = enc.encodeInto(name, slot)
      if (written < MAX_LEN) slot.fill(0, written)
    },
  }
}

// 4. Length-prefixed inline (variable record, offset index)
function createLPStore() {
  const MAX_RECS = N + UPDATE_N
  const REC_MAX = 2 + MAX_LEN + 8
  const blob = new Uint8Array(MAX_RECS * REC_MAX)
  const dv = new DataView(blob.buffer)
  const idx = new Int32Array(N)
  const ent = new Int32Array(N * 2)
  let cur = 0
  return {
    reset() { cur = 0 },
    write(i, id, dmg, name) {
      ent[i * 2] = id; ent[i * 2 + 1] = dmg
      idx[i] = cur
      const raw = enc.encode(name)
      dv.setUint16(cur, raw.length, true)
      blob.set(raw, cur + 2)
      cur += 2 + raw.length
    },
    readName(i) {
      const off = idx[i]
      const len = dv.getUint16(off, true)
      return dec.decode(blob.subarray(off + 2, off + 2 + len))
    },
    update(i, name) {
      idx[i] = cur
      const raw = enc.encode(name)
      dv.setUint16(cur, raw.length, true)
      blob.set(raw, cur + 2)
      cur += 2 + raw.length
    },
  }
}

// 5. Null-terminated inline (variable record, offset index)
function createNTStore() {
  const MAX_RECS = N + UPDATE_N
  const REC_MAX = MAX_LEN + 8
  const blob = new Uint8Array(MAX_RECS * REC_MAX)
  const idx = new Int32Array(N)
  const ent = new Int32Array(N * 2)
  let cur = 0
  return {
    reset() { cur = 0 },
    write(i, id, dmg, name) {
      ent[i * 2] = id; ent[i * 2 + 1] = dmg
      idx[i] = cur
      const raw = enc.encode(name)
      blob.set(raw, cur)
      blob[cur + raw.length] = 0
      cur += raw.length + 1
    },
    readName(i) {
      const off = idx[i]
      const slot = blob.subarray(off)
      let end = slot.indexOf(0)
      return dec.decode(slot.subarray(0, end))
    },
    update(i, name) {
      idx[i] = cur
      const raw = enc.encode(name)
      blob.set(raw, cur)
      blob[cur + raw.length] = 0
      cur += raw.length + 1
    },
  }
}

// 6. Plain JS objects (baseline)
function createObjStore() {
  const arr = new Array(N)
  return {
    reset() { arr.length = 0; arr.length = N },
    write(i, id, dmg, name) { arr[i] = { id, dmg, name } },
    readName(i) { return arr[i].name },
    update(i, name) { arr[i].name = name },
  }
}

// ---------------------------------------------------------------
// Registration
// ---------------------------------------------------------------
const STORES = [
  ["Pool pointer", createPoolStore],
  ["String arena", createArenaStore],
  ["Fixed-width inline", createFixedStore],
  ["Length-prefixed inline", createLPStore],
  ["Null-terminated inline", createNTStore],
  ["Plain JS objects", createObjStore],
]

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function prePopulateAll() {
  for (const [, factory] of STORES) {
    const s = factory()
    s.reset()
    for (let i = 0; i < N; i++) s.write(i, i, i * 2, NAMES[i])
  }
  return STORES.map(([, factory]) => factory()).reduce((acc, s, i) => {
    acc[i] = s; return acc
  }, {})
}

// Single-use warming run
{
  for (const [, factory] of STORES) {
    const s = factory()
    s.write(0, 0, 0, NAMES[0])
    s.readName(0)
    s.update(0, NAMES[0])
  }
}

await bench.untilCompiled()

// ---------------------------------------------------------------
// GROUP 1: Write (sequential) × N
// ---------------------------------------------------------------
{
  using g = bench.group(`Write (sequential) × ${N.toLocaleString()}`)
  g.assert = EXPECT_WRITE
  for (const [label, factory] of STORES) {
    bench(label, () => {
      const s = factory()
      for (let i = 0; i < N; i++) s.write(i, i, i * 2, NAMES[i])
      return s.readName(N - 1)
    })
  }
}

// ---------------------------------------------------------------
// Pre-populate stores for read groups (fresh, unshared across groups)
// ---------------------------------------------------------------
const readStores = STORES.map(([, factory]) => factory())
for (const s of readStores) {
  s.reset()
  for (let i = 0; i < N; i++) s.write(i, i, i * 2, NAMES[i])
}

// ---------------------------------------------------------------
// GROUP 2: Read (sequential) × N
// ---------------------------------------------------------------
{
  using g = bench.group(`Read (sequential) × ${N.toLocaleString()}`)
  g.assert = EXPECT_WRITE
  for (let si = 0; si < STORES.length; si++) {
    const [label] = STORES[si]
    const s = readStores[si]
    bench(label, () => { let r; for (let i = 0; i < N; i++) r = s.readName(i); return r })
  }
}

// ---------------------------------------------------------------
// GROUP 3: Read (random access) × 1,000
// ---------------------------------------------------------------
{
  using g = bench.group(`Read (random) × ${RAND_K.toLocaleString()}`)
  g.assert = EXPECT_RAND
  for (let si = 0; si < STORES.length; si++) {
    const [label] = STORES[si]
    const s = readStores[si]
    bench(label, () => { let r; for (const idx of RAND_IDX) r = s.readName(idx); return r })
  }
}

// ---------------------------------------------------------------
// GROUP 4: Update (name, 20% of entities)
// Fresh store per bench iteration to avoid cursor overflow
// ---------------------------------------------------------------
{
  using g = bench.group(`Populate + update (${((UPDATE_N / N) * 100).toFixed(0)}% names) × ${N.toLocaleString()} entities`)
  g.assert = EXPECT_UPDATE
  for (const [label, factory] of STORES) {
    bench(label, () => {
      const s = factory()
      for (let i = 0; i < N; i++) s.write(i, i, i * 2, NAMES[i])
      for (let ui = 0; ui < UPDATE_N; ui++) s.update(UPD_IDX[ui], NEW_NAMES[ui])
      return s.readName(UPD_IDX[0])
    })
  }
}
