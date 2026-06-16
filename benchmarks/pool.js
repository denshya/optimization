import { bench } from "benchik"
import Vector2 from "../src/modules/geometry/Vector2.ts"

const K = 10_000
const n = 100_000
const out = new Vector2

await bench.untilCompiled()

// ── 1. Allocation strategies ───────────────────────────────────────
{
  using _ = bench.group("Allocation × 10k")

  bench("new Vector2", () => {
    const a = []
    for (let i = 0; i < K; i++) a.push(new Vector2)
    return a
  })

  bench("POOL.get()", () => {
    const a = []
    for (let i = 0; i < K; i++) a.push(Vector2.Pooled)
    return a
  })

  bench("POOL.acquire() + using", () => {
    const a = []
    for (let i = 0; i < K; i++) {
      using v = Vector2.POOL.acquire()
      a.push(v)
    }
    return a
  })
}

// ── 2. Single acquire + op ─────────────────────────────────────────
{
  using _ = bench.group("Single acquire + add")

  const b = new Vector2(3, 4)

  bench("new V2 + add", () => {
    const v = new Vector2(1, 2)
    for (let i = 0; i < n; i++) v.add(b)
    return v
  })

  bench("POOL.get() + add", () => {
    const v = Vector2.Pooled
    v.x = 1; v.y = 2
    for (let i = 0; i < n; i++) v.add(b)
    return v
  })

  bench("POOL.acquire() + using + add", () => {
    using v = Vector2.POOL.acquire()
    v.x = 1; v.y = 2
    for (let i = 0; i < n; i++) v.add(b)
    return v
  })
}

// ── 3. acquire / release cycling ───────────────────────────────────
{
  using _ = bench.group("Acquire/release cycling × 10k")

  // Manual: get + manually "release" (no-op, but we simulate with a write)
  bench("get() (manual cycle)", () => {
    for (let i = 0; i < K; i++) {
      const v = Vector2.Pooled
      v.x = i; v.y = i
    }
    return K
  })

  // Using: acquire + auto-release on scope exit
  bench("acquire() + using (auto cycle)", () => {
    for (let i = 0; i < K; i++) {
      using v = Vector2.POOL.acquire()
      v.x = i; v.y = i
    }
    return K
  })
}

// ── 4. Stacked (nested) acquires ───────────────────────────────────
{
  using _ = bench.group("Stacked x3 × 10k")

  bench("get() x3", () => {
    for (let i = 0; i < K; i++) {
      const a = Vector2.Pooled
      const b = Vector2.Pooled
      const c = Vector2.Pooled
      a.x = b.x = c.x = i
    }
    return K
  })

  bench("get() x3 (once)", () => {
    let a = Vector2.Pooled
    let b = Vector2.Pooled
    let c = Vector2.Pooled
    for (let i = 0; i < K; i++) {
      a.x = b.x = c.x = i
    }
    return K
  })

  bench("acquire() x3 + using", () => {
    for (let i = 0; i < K; i++) {
      using a = Vector2.POOL.acquire()
      using b = Vector2.POOL.acquire()
      using c = Vector2.POOL.acquire()
      a.x = b.x = c.x = i
    }
    return K
  })

  bench("acquire() x3 + using (once)", () => {
    using a = Vector2.POOL.acquire()
    using b = Vector2.POOL.acquire()
    using c = Vector2.POOL.acquire()

    for (let i = 0; i < K; i++) {
      a.x = b.x = c.x = i
    }
    return K
  })
}

// ── 5. Realistic frame-style usage ─────────────────────────────────
{
  using _ = bench.group("Frame cycle × 1k (50 iter × 20vec)")

  bench("get() + manual reset", () => {
    for (let frame = 0; frame < 50; frame++) {
      for (let i = 0; i < 20; i++) {
        const v = Vector2.Pooled
        v.x = i; v.y = frame
        v.add(out)
      }
      Vector2.POOL.reset()
    }
    return 1
  })

  bench("acquire() + using (auto-return)", () => {
    for (let frame = 0; frame < 50; frame++) {
      for (let i = 0; i < 20; i++) {
        using v = Vector2.POOL.acquire()
        v.x = i; v.y = frame
        v.add(out)
      }
      // no reset needed — each using returned its vector
    }
    return 1
  })
}
