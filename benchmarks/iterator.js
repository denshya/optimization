import { bench } from "benchik"

function* rangeGenerator(start, end) {
  for (let i = start; i < end; i++) {
    yield i;
  }
}

class ZeroGCRange {
  constructor(start, end) {
    this.start = start;
    this.end = end;

    // The "Pre-allocated" result object
    this.result = { value: 0, done: false };
  }

  // Make the class itself an Iterable
  [Symbol.iterator]() {
    this.result.value = this.start - 1;
    this.result.done = false;
    return this;
  }

  // The Iterator protocol
  next() {
    this.result.value++;
    if (this.result.value >= this.end) {
      this.result.done = true;
    }
    return this.result;
  }

  static sharedInstance = new ZeroGCRange
  /**
   * This fails when nesting loops as the pointer jumps to unrelevant array,
   * while this doesn't give any performance gains.
   */
  static shared(start, end) {
    this.sharedInstance.start = start
    this.sharedInstance.end = end

    return this.sharedInstance
  }
}

// ----------------------------------------

function unrolledIterate(items, callback) {
  let i = 0
  const l = items.length
  const limit = l & -8

  // 🏎️ The Fast Lane (Blocks of 8)
  for (i; i < limit; i += 8) {
    callback(items[i])
    callback(items[i + 1])
    callback(items[i + 2])
    callback(items[i + 3])
    callback(items[i + 4])
    callback(items[i + 5])
    callback(items[i + 6])
    callback(items[i + 7])
  }

  // 🛑 The Cleanup Loop (Remaining elements)
  for (i; i < l; i++) callback(items[i])
}

// ----------------------------------------
const ITERATION_MAX = 1_000_000
const ITERATION_ITEMS = Array(ITERATION_MAX).fill(0).map((_, i) => i)
const ITERATION_RESULT = ITERATION_ITEMS.reduce((r, n) => r + n)


await bench.untilCompiled()

{
  using group = bench.group("Iterating Array (1_000_000)")
  group.assert = ITERATION_RESULT

  let r = 0
  const sum = x => r += x
  const noop = () => { }
  const getArray = () => arr

  let i = 0
  let l = 0

  bench("Generator", () => {
    r = 0
    for (const val of rangeGenerator(0, ITERATION_MAX)) r += val
    return r
  })
  bench("Generator (forEach)", () => {
    r = 0
    rangeGenerator(0, ITERATION_MAX).forEach(sum)
    return r
  })
  bench("Shared iterator", () => {
    r = 0
    for (const val of new ZeroGCRange(0, ITERATION_MAX)) r += val
    return r
  })
  bench("Shared iterator + Shared instance", () => {
    r = 0
    for (const val of ZeroGCRange.shared(0, ITERATION_MAX)) r += val
    return r
  })
  bench("array for range", () => {
    r = 0
    l = ITERATION_ITEMS.length
    for (i = 0; i < l; i++) r += ITERATION_ITEMS[i]
    return r
  })
  bench("array (forEach)", () => {
    r = 0
    ITERATION_ITEMS.forEach(sum)
    return r
  })
  bench("array for..of", () => {
    r = 0
    for (const val of ITERATION_ITEMS) r += val
    return r
  })
  bench("Unrolled Loop", () => {
    r = 0
    i = 0
    l = ITERATION_ITEMS.length
    const limit = l & -8

    for (i; i < limit; i += 8) {
      r += ITERATION_ITEMS[i]
      r += ITERATION_ITEMS[i + 1]
      r += ITERATION_ITEMS[i + 2]
      r += ITERATION_ITEMS[i + 3]
      r += ITERATION_ITEMS[i + 4]
      r += ITERATION_ITEMS[i + 5]
      r += ITERATION_ITEMS[i + 6]
      r += ITERATION_ITEMS[i + 7]
    }

    for (i; i < l; i++) r += ITERATION_ITEMS[i]

    return r
  })
  bench("Unrolled Loop (Function)", () => {
    r = 0
    unrolledIterate(ITERATION_ITEMS, sum)
    return r
  })
}



// Record (plain object) with alphabetic keys
const ITERATION_RECORD = {}
for (let i = 0; i < ITERATION_MAX; i++) ITERATION_RECORD["k" + i] = i
const ITERATION_RECORD_KEYS = Object.keys(ITERATION_RECORD)

{
  using group = bench.group("Iterating Record (1_000_000) [Alphabetic]")
  group.assert = ITERATION_RESULT

  let r = 0
  let l = 0
  let i = 0

  const keys = ITERATION_RECORD_KEYS

  bench("for..in (record)", () => {
    r = 0
    for (const key in ITERATION_RECORD) r += ITERATION_RECORD[key]
    return r
  })

  bench("for..of (Keys)", () => {
    r = 0
    for (const key of keys) r += ITERATION_RECORD[key]
    return r
  })

  bench("for range (Keys)", () => {
    r = 0
    l = keys.length
    for (i = 0; i < l; i++) r += ITERATION_RECORD[keys[i]]
    return r
  })

  bench("Unrolled (Keys)", () => {
    r = 0
    l = keys.length
    const limit = l & -8

    for (i = 0; i < limit; i += 8) {
      r += ITERATION_RECORD[keys[i]]
      r += ITERATION_RECORD[keys[i + 1]]
      r += ITERATION_RECORD[keys[i + 2]]
      r += ITERATION_RECORD[keys[i + 3]]
      r += ITERATION_RECORD[keys[i + 4]]
      r += ITERATION_RECORD[keys[i + 5]]
      r += ITERATION_RECORD[keys[i + 6]]
      r += ITERATION_RECORD[keys[i + 7]]
    }

    for (i; i < l; i++) r += ITERATION_RECORD[keys[i]]
    return r
  })
}



// Record (plain object) with numeric keys
const ITERATION_RECORD_NUM = {}
for (let i = 0; i < ITERATION_MAX; i++) ITERATION_RECORD_NUM[i] = i
const ITERATION_RECORD_NUM_KEYS = Object.keys(ITERATION_RECORD_NUM)

{
  using group = bench.group("Iterating Record (1_000_000) [Numeric]")
  group.assert = ITERATION_RESULT

  let r = 0
  let l = 0
  let i = 0

  const keys = ITERATION_RECORD_NUM_KEYS

  bench("for..in (record)", () => {
    r = 0
    for (const key in ITERATION_RECORD_NUM) r += ITERATION_RECORD_NUM[key]
    return r
  })

  bench("for..of (Keys)", () => {
    r = 0
    for (const key of keys) r += ITERATION_RECORD_NUM[key]
    return r
  })

  bench("for range (Keys)", () => {
    r = 0
    l = keys.length
    for (i = 0; i < l; i++) r += ITERATION_RECORD_NUM[keys[i]]
    return r
  })

  bench("Unrolled (Keys)", () => {
    r = 0
    l = keys.length
    const limit = l & -8

    for (i = 0; i < limit; i += 8) {
      r += ITERATION_RECORD_NUM[keys[i]]
      r += ITERATION_RECORD_NUM[keys[i + 1]]
      r += ITERATION_RECORD_NUM[keys[i + 2]]
      r += ITERATION_RECORD_NUM[keys[i + 3]]
      r += ITERATION_RECORD_NUM[keys[i + 4]]
      r += ITERATION_RECORD_NUM[keys[i + 5]]
      r += ITERATION_RECORD_NUM[keys[i + 6]]
      r += ITERATION_RECORD_NUM[keys[i + 7]]
    }

    for (i; i < l; i++) r += ITERATION_RECORD_NUM[keys[i]]
    return r
  })
}



// Unconventional: baked straight-line access via eval on the alphabetic record
const BAKED_N = 10_000
const BAKED_RECORD = {}
for (let i = 0; i < BAKED_N; i++) BAKED_RECORD["k" + i] = i

const BAKED_KEYS = ITERATION_RECORD_KEYS.slice(0, BAKED_N)
const BAKED_ITEMS = BAKED_KEYS.map(k => BAKED_RECORD[k])
const BAKED_RESULT = BAKED_ITEMS.reduce((r, n) => r + n)

// Pre-generate a flat sum expression: RECORD["k0"] + RECORD["k1"] + ...
// eval runs in local scope, so it can see BAKED_RECORD directly.
const bakedBodyEval = BAKED_KEYS.map(k => `BAKED_RECORD["${k}"]`).join('+')
/** @type {() => number} */
const bakedSumFnEval = eval(`() => ${bakedBodyEval}`)

// new Function has no closure access — can only see globals.
// We pass the record as a parameter instead.
const bakedBodyFn = BAKED_KEYS.map(k => `OBJ["${k}"]`).join('+')
/** @type {(obj: Record<string, number>) => number} */
const bakedSumFn = new Function('OBJ', `return ${bakedBodyFn}`)


await bench.untilCompiled()

{
  using group = bench.group("Unconventional Iteration (10_000)")
  group.assert = BAKED_RESULT

  let r = 0
  let l = 0
  let i = 0

  bench("for..in (record)", () => {
    r = 0
    for (const key in BAKED_RECORD) r += BAKED_RECORD[key]
    return r
  })

  bench("for range", () => {
    r = 0
    l = BAKED_KEYS.length
    for (i = 0; i < l; i++) r += BAKED_RECORD[BAKED_KEYS[i]]
    return r
  })

  bench("Unrolled", () => {
    r = 0
    l = BAKED_KEYS.length
    const limit = l & -8

    for (i = 0; i < limit; i += 8) {
      r += BAKED_RECORD[BAKED_KEYS[i]]
      r += BAKED_RECORD[BAKED_KEYS[i + 1]]
      r += BAKED_RECORD[BAKED_KEYS[i + 2]]
      r += BAKED_RECORD[BAKED_KEYS[i + 3]]
      r += BAKED_RECORD[BAKED_KEYS[i + 4]]
      r += BAKED_RECORD[BAKED_KEYS[i + 5]]
      r += BAKED_RECORD[BAKED_KEYS[i + 6]]
      r += BAKED_RECORD[BAKED_KEYS[i + 7]]
    }

    for (i; i < l; i++) r += BAKED_RECORD[BAKED_KEYS[i]]
    return r
  })

  bench("Baked (Function)", () => bakedSumFn(BAKED_RECORD))
  bench("Baked (eval)", bakedSumFnEval)
}



// Amortized cost: what if you iterate the same object many times?
// This simulates real workloads where you have one object and
// repeatedly process its fields across frames/tick/requests.
const AMORT_N = 100             // iterating the object 100 times
const AMORT_REC_SIZE = 10_000   // 10k keys each time
const AMORT_RECORD = {}
const AMORT_RECORD_NUM = {}
for (let i = 0; i < AMORT_REC_SIZE; i++) {
  AMORT_RECORD["k" + i] = i
  AMORT_RECORD_NUM[i] = i
}
const AMORT_KEYS_STR = Object.keys(AMORT_RECORD)      // extracted once
const AMORT_KEYS_NUM = Object.keys(AMORT_RECORD_NUM)  // extracted once
const AMORT_RESULT = AMORT_REC_SIZE * (AMORT_REC_SIZE - 1) / 2  // sum 0..(n-1)


{
  using group = bench.group(`Amortized: String keys, ${AMORT_N}×${AMORT_REC_SIZE}`)
  group.assert = AMORT_RESULT * AMORT_N

  let r = 0
  let i = 0
  let l = 0

  // ── for..in: prototype walk every iteration, every pass ──
  bench("for..in (record)", () => {
    r = 0
    for (let pass = 0; pass < AMORT_N; pass++) {
      for (const key in AMORT_RECORD) r += AMORT_RECORD[key]
    }
    return r
  })

  // ── Object.keys() once, array reused across all passes ──
  bench("for range on pre-extracted keys", () => {
    r = 0
    const keys = AMORT_KEYS_STR
    l = keys.length
    for (let pass = 0; pass < AMORT_N; pass++) {
      for (i = 0; i < l; i++) r += AMORT_RECORD[keys[i]]
    }
    return r
  })

  // ── Object.keys() called on EVERY pass (common mistake) ──
  bench("for range on Object.keys() every pass", () => {
    r = 0
    for (let pass = 0; pass < AMORT_N; pass++) {
      const keys = Object.keys(AMORT_RECORD)
      l = keys.length
      for (i = 0; i < l; i++) r += AMORT_RECORD[keys[i]]
    }
    return r
  })
}


{
  using group = bench.group(`Amortized: Numeric keys, ${AMORT_N}×${AMORT_REC_SIZE}`)
  group.assert = AMORT_RESULT * AMORT_N

  let r = 0
  let i = 0
  let l = 0

  bench("for..in (record)", () => {
    r = 0
    for (let pass = 0; pass < AMORT_N; pass++) {
      for (const key in AMORT_RECORD_NUM) r += AMORT_RECORD_NUM[key]
    }
    return r
  })

  bench("for range on pre-extracted keys", () => {
    r = 0
    const keys = AMORT_KEYS_NUM
    l = keys.length
    for (let pass = 0; pass < AMORT_N; pass++) {
      for (i = 0; i < l; i++) r += AMORT_RECORD_NUM[keys[i]]
    }
    return r
  })

  bench("for range on Object.keys() every pass", () => {
    r = 0
    for (let pass = 0; pass < AMORT_N; pass++) {
      const keys = Object.keys(AMORT_RECORD_NUM)
      l = keys.length
      for (i = 0; i < l; i++) r += AMORT_RECORD_NUM[keys[i]]
    }
    return r
  })
}
