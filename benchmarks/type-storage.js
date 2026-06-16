import { bench } from "benchik"

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const N = 100_000
const RAND_K = 1_000
const RAND_IDX = Array.from({ length: RAND_K }, (_, i) => (i * 7919 + 13) % N)

// Type strings
const TYPE_NAMES = ["warrior", "mage", "rogue", "paladin", "ranger", "druid", "warlock", "priest"]
// lengths:            7         4        5        7          6        5         7         6

function typeAt(i) { return TYPE_NAMES[i % 8] }

// ---------------------------------------------------------------
// Expected values for assertions
// ---------------------------------------------------------------
const EXPECT_TYPE = typeAt(N - 1) // "priest"

let lenSum = 0
for (let i = 0; i < N; i++) lenSum += typeAt(i).length
// N/8 * (7+4+5+7+6+5+7+6) = 12500 * 47 = 587500

let randSum = 0
for (const idx of RAND_IDX) randSum += typeAt(idx).length

const enc = new TextEncoder
const dec = new TextDecoder

// ---------------------------------------------------------------
// Shared id/hp arrays (same for all approaches)
// ---------------------------------------------------------------
const idArr = new Int32Array(N)
const hpArr = new Int32Array(N)
for (let i = 0; i < N; i++) { idArr[i] = i; hpArr[i] = i * 3 }

// ---------------------------------------------------------------
// Approach buffers
// ---------------------------------------------------------------

// 1. Int enum (baseline) — type stored as Int32 0–7
const intType = new Int32Array(N)
function intTypeStr(i) { return TYPE_NAMES[intType[i]] }

// 2. Pool pointer — type stored as Int32 index into external string[]
const poolTypeIdx = new Int32Array(N)
function poolTypeStr(i) { return TYPE_NAMES[poolTypeIdx[i]] }

// 3. String arena — offset+len into a contiguous Uint8Array blob
const arenaOff = new Int32Array(N)
const arenaLen = new Int32Array(N)
const arenaBlob = new Uint8Array(N * 12)
let arenaCur = 0
function arenaTypeStr(i) { return dec.decode(arenaBlob.subarray(arenaOff[i], arenaOff[i] + arenaLen[i])) }

// 4. Fixed-width inline — 8-byte slot per entity, NUL-padded
const FIXED_SZ = 8
const fixedBuf = new Uint8Array(N * FIXED_SZ)
function fixedTypeStr(i) {
  const o = i * FIXED_SZ; let end = o
  while (end < o + FIXED_SZ && fixedBuf[end] !== 0) end++
  return dec.decode(fixedBuf.subarray(o, end))
}

// 5. Length-prefixed inline — record: [len:u16, bytes…], + offset index
const lpIdx = new Int32Array(N)
const lpBlob = new Uint8Array(N * 11) // 2 + 8 max + 1 pad
const lpDv = new DataView(lpBlob.buffer)
let lpCur = 0
function lpTypeStr(i) {
  const o = lpIdx[i]; const l = lpDv.getUint16(o, true)
  return dec.decode(lpBlob.subarray(o + 2, o + 2 + l))
}

// 6. Null-terminated inline — record: [bytes…, 0x00], + offset index
const ntIdx = new Int32Array(N)
const ntBlob = new Uint8Array(N * 10) // 8 + 1 + 1 pad
let ntCur = 0
function ntTypeStr(i) {
  const o = ntIdx[i]; let end = o
  while (ntBlob[end] !== 0) end++
  return dec.decode(ntBlob.subarray(o, end))
}

// ---------------------------------------------------------------
// Pre-populate for read benchmarks
// ---------------------------------------------------------------
{
  // Int enum
  for (let i = 0; i < N; i++) intType[i] = i % 8

  // Pool pointer
  for (let i = 0; i < N; i++) poolTypeIdx[i] = i % 8

  // Arena
  arenaCur = 0
  for (let i = 0; i < N; i++) {
    const raw = enc.encode(typeAt(i))
    arenaOff[i] = arenaCur; arenaLen[i] = raw.length
    arenaBlob.set(raw, arenaCur); arenaCur += raw.length
  }

  // Fixed-width
  for (let i = 0; i < N; i++) {
    const o = i * FIXED_SZ; const raw = enc.encode(typeAt(i))
    fixedBuf.set(raw, o)
    if (raw.length < FIXED_SZ) fixedBuf[o + raw.length] = 0
  }

  // Length-prefixed
  lpCur = 0
  for (let i = 0; i < N; i++) {
    lpIdx[i] = lpCur; const raw = enc.encode(typeAt(i))
    lpDv.setUint16(lpCur, raw.length, true)
    lpBlob.set(raw, lpCur + 2); lpCur += 2 + raw.length
  }

  // Null-terminated
  ntCur = 0
  for (let i = 0; i < N; i++) {
    ntIdx[i] = ntCur; const raw = enc.encode(typeAt(i))
    ntBlob.set(raw, ntCur); ntBlob[ntCur + raw.length] = 0
    ntCur += raw.length + 1
  }
}

// ---------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------
{ let s = 0; for (let i = 0; i < 100; i++) s += typeAt(i).charCodeAt(0) }

await bench.untilCompiled()

// ---------------------------------------------------------------
// GROUP 1: Write (id + type + hp) × N
// ---------------------------------------------------------------
{
  using g = bench.group(`Write (id + type + hp) × ${N.toLocaleString()} entities`)
  g.assert = EXPECT_TYPE

  bench("Int enum", () => {
    for (let i = 0; i < N; i++) { const t = i % 8; intType[i] = t }
    return intTypeStr(N - 1)
  })

  bench("Pool pointer", () => {
    for (let i = 0; i < N; i++) { const t = i % 8; poolTypeIdx[i] = t }
    return poolTypeStr(N - 1)
  })

  bench("String arena", () => {
    arenaCur = 0
    for (let i = 0; i < N; i++) {
      const raw = enc.encode(typeAt(i))
      arenaOff[i] = arenaCur; arenaLen[i] = raw.length
      arenaBlob.set(raw, arenaCur); arenaCur += raw.length
    }
    return arenaTypeStr(N - 1)
  })

  bench("Fixed-width inline", () => {
    for (let i = 0; i < N; i++) {
      const o = i * FIXED_SZ; const raw = enc.encode(typeAt(i))
      fixedBuf.set(raw, o); if (raw.length < FIXED_SZ) fixedBuf[o + raw.length] = 0
    }
    return fixedTypeStr(N - 1)
  })

  bench("Length-prefixed inline", () => {
    lpCur = 0
    for (let i = 0; i < N; i++) {
      lpIdx[i] = lpCur; const raw = enc.encode(typeAt(i))
      lpDv.setUint16(lpCur, raw.length, true)
      lpBlob.set(raw, lpCur + 2); lpCur += 2 + raw.length
    }
    return lpTypeStr(N - 1)
  })

  bench("Null-terminated inline", () => {
    ntCur = 0
    for (let i = 0; i < N; i++) {
      ntIdx[i] = ntCur; const raw = enc.encode(typeAt(i))
      ntBlob.set(raw, ntCur); ntBlob[ntCur + raw.length] = 0
      ntCur += raw.length + 1
    }
    return ntTypeStr(N - 1)
  })
}

// ---------------------------------------------------------------
// GROUP 2: Read type (sequential) × N
// ---------------------------------------------------------------
{
  using g = bench.group(`Read type (sequential) × ${N.toLocaleString()}`)
  g.assert = lenSum

  bench("Int enum", () => { let s = 0; for (let i = 0; i < N; i++) s += intTypeStr(i).length; return s })
  bench("Pool pointer", () => { let s = 0; for (let i = 0; i < N; i++) s += poolTypeStr(i).length; return s })
  bench("String arena", () => { let s = 0; for (let i = 0; i < N; i++) s += arenaTypeStr(i).length; return s })
  bench("Fixed-width inline", () => { let s = 0; for (let i = 0; i < N; i++) s += fixedTypeStr(i).length; return s })
  bench("Length-prefixed inline", () => { let s = 0; for (let i = 0; i < N; i++) s += lpTypeStr(i).length; return s })
  bench("Null-terminated inline", () => { let s = 0; for (let i = 0; i < N; i++) s += ntTypeStr(i).length; return s })
}

// ---------------------------------------------------------------
// GROUP 3: Read type (random) × 1,000
// ---------------------------------------------------------------
{
  using g = bench.group(`Read type (random) × ${RAND_K.toLocaleString()}`)
  g.assert = randSum

  bench("Int enum", () => { let s = 0; for (const idx of RAND_IDX) s += intTypeStr(idx).length; return s })
  bench("Pool pointer", () => { let s = 0; for (const idx of RAND_IDX) s += poolTypeStr(idx).length; return s })
  bench("String arena", () => { let s = 0; for (const idx of RAND_IDX) s += arenaTypeStr(idx).length; return s })
  bench("Fixed-width inline", () => { let s = 0; for (const idx of RAND_IDX) s += fixedTypeStr(idx).length; return s })
  bench("Length-prefixed inline", () => { let s = 0; for (const idx of RAND_IDX) s += lpTypeStr(idx).length; return s })
  bench("Null-terminated inline", () => { let s = 0; for (const idx of RAND_IDX) s += ntTypeStr(idx).length; return s })
}
