import { bench } from "../../bench-suite/bench.suite"
import { Tree } from "../src/pages/Nodes/Tree"

// Simulates the two core operations in Tree.moveBefore:
//   1. array.splice (remove + insert) – O(N) element shifting
//   2. for-loop Map.set reindex – O(N) position map update
//
// We compare them in isolation and combined to understand
// where the cost actually lives.

const SIZES = [100, 1_000, 10_000, 100_000]

await bench.untilCompiled()

for (const N of SIZES) {
  using group = bench.group(`N = ${N.toLocaleString()}`)

  // Fresh data factory – cost excluded from measurement.
  const data = group.fresh(() => {
    const order = Array.from({ length: N }, (_, i) => i)
    const positionMap = new Map(order.map((v, i) => [v, i]))
    return { order, positionMap }
  })

  // --- splice-only: remove from middle, insert at middle ---
  bench("splice (remove+insert mid→mid)", () => {
    const { order } = data
    const from = N >> 1
    const to = (N >> 1) + (N >> 2)
    const [moved] = order.splice(from, 1)
    const actualTo = from < to ? to - 1 : to
    order.splice(actualTo, 0, moved)
  })

  // --- for-loop Map.set reindex only (no splice) ---
  bench("Map for-loop reindex (mid→mid range)", () => {
    const { order, positionMap } = data
    const from = N >> 1
    const to = (N >> 1) + (N >> 2)
    const actualTo = from < to ? to - 1 : to
    const start = Math.min(from, actualTo)
    const end = Math.max(from, actualTo)
    for (let i = start; i <= end; i++) {
      positionMap.set(order[i], i)
    }
  })

  // --- combined: splice + reindex (the real moveBefore cost) ---
  bench("splice + Map reindex (full moveBefore)", () => {
    const { order, positionMap } = data
    const from = N >> 1
    const to = (N >> 1) + (N >> 2)
    const [moved] = order.splice(from, 1)
    const actualTo = from < to ? to - 1 : to
    order.splice(actualTo, 0, moved)
    const start = Math.min(from, actualTo)
    const end = Math.max(from, actualTo)
    for (let i = start; i <= end; i++) {
      positionMap.set(order[i], i)
    }
  })

  // --- splice worst case: move first element to end ---
  bench("splice (remove+insert 0→end) worst", () => {
    const { order } = data
    const [moved] = order.splice(0, 1)
    order.splice(N - 1, 0, moved)
  })

  // --- Map for-loop worst case: full range ---
  bench("Map for-loop reindex (full range) worst", () => {
    const { order, positionMap } = data
    for (let i = 0; i < N; i++) {
      positionMap.set(order[i], i)
    }
  })
}

// -------- Object property vs Map: the reindex loop --------
{
  using group = bench.group(`Map.set vs node._pos reindex (standalone)`)

  for (const N of SIZES) {
    // Build object-keyed maps once
    const objs = Array.from({ length: N }, (_, i) => ({ id: i, _pos: -1 }))
    const map = new Map(objs.map((o, i) => [o, i]))

    // mid→mid reindex: ~N/4 entries
    const from = N >> 1
    const to = (N >> 1) + (N >> 2)
    const actualTo = from < to ? to - 1 : to
    const start = Math.min(from, actualTo)
    const end = Math.max(from, actualTo)

    bench(`Map.set  mid→mid  N=${N}`, () => {
      for (let i = start; i <= end; i++) {
        map.set(objs[i], i)
      }
    })

    bench(`obj._pos  mid→mid  N=${N}`, () => {
      for (let i = start; i <= end; i++) {
        objs[i]._pos = i
      }
    })
  }
}

// -------- Tree operation benchmarks --------

// Minimal TreeNode implementation for benchmarking
class BenchNode {
  id = 0
  parent = null
  children = new Tree(this)

  constructor(id) { this.id = id }
}

for (const N of SIZES) {
  // Pre-build a flat tree once (not timed)
  const root = new BenchNode(-1)
  const kids = Array.from({ length: N }, (_, i) => new BenchNode(i))
  for (const k of kids) root.children.insert(k)

  using group = bench.group(`Tree N = ${N.toLocaleString()}`)

  // --- indexOf ---
  const mid = root.children.at(N >> 1)
  bench("indexOf (hit)", () => root.children.indexOf(mid))

  // --- at ---
  bench("at (mid)", () => root.children.at(N >> 1))

  // --- insert append + cleanup (restore state) ---
  bench("insert append", () => {
    const n = new BenchNode(-2)
    root.children.insert(n)
    root.children.remove(n)
  })

  // --- insert mid + cleanup ---
  bench("insert mid", () => {
    const n = new BenchNode(-2)
    root.children.insert(n, N >> 1)
    root.children.remove(n)
  })

  // --- remove + restore ---
  bench("remove (swap-and-pop)", () => {
    const n = root.children.at(N >> 1)
    root.children.remove(n)
    root.children.insert(n, N >> 1)
  })

  // --- reorder (O(1) swap) + restore ---
  bench("reorder", () => {
    const n = root.children.at(N >> 1)
    root.children.reorder(n, (N >> 1) + 10)
    root.children.reorder(n, N >> 1)
  })

  // --- swap (O(1)) + restore ---
  bench("swap", () => {
    const a = root.children.at(0)
    const b = root.children.at(N - 1)
    root.children.swap(a, b)
    root.children.swap(a, b)
  })

  // --- moveBefore mid→mid + restore ---
  bench("moveBefore mid→mid", () => {
    const n = root.children.at(N >> 1)
    const t = root.children.at((N >> 1) + (N >> 2))
    root.children.moveBefore(n, t)
    root.children.moveBefore(n, root.children.at(N >> 1))
  })
}

// -------- Batch insertion benchmarks --------
// Compare one-by-one insert vs append vs insertMany

for (const N of SIZES) {
  // Pre-build K fresh nodes once per size group (outside timing)
  const K = Math.max(10, N >> 2)

  using group = bench.group(`Batch N=${N} K=${K}`)

  // --- one-by-one append (baseline) ---
  {
    const freshNodes = Array.from({ length: K }, (_, i) => new BenchNode(N + i))
    const data = group.fresh(() => new BenchNode(-1))
    bench("one-by-one append (K)", () => {
      for (let i = 0; i < K; i++) {
        data.children.insert(freshNodes[i])
      }
    })
  }

  // --- append at end ---
  {
    const freshNodes = Array.from({ length: K }, (_, i) => new BenchNode(N + i))
    const data = group.fresh(() => new BenchNode(-1))
    bench("append (K)", () => {
      data.children.append(freshNodes)
    })
  }

  // --- one-by-one insert at mid ---
  {
    const data = group.fresh(() => {
      const r = new BenchNode(-1)
      // Pre-fill with N nodes so mid-insert cost is real
      r.children.append(Array.from({ length: N }, (_, i) => new BenchNode(i)))
      return r
    })
    bench("one-by-one insert mid (K)", () => {
      for (let i = 0; i < K; i++) {
        data.children.insert(new BenchNode(N + i), data.children.length >> 1)
      }
    })
  }

  // --- insertMany at mid ---
  {
    const data = group.fresh(() => {
      const r = new BenchNode(-1)
      r.children.append(Array.from({ length: N }, (_, i) => new BenchNode(i)))
      return r
    })
    bench("insertMany mid (K)", () => {
      const batch = Array.from({ length: K }, (_, i) => new BenchNode(N + i))
      data.children.insertMany(batch, data.children.length >> 1)
    })
  }
}
