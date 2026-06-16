import { bench } from "benchik"
import Vector2 from "../src/modules/geometry/Vector2.ts"

// Shared no-op dispose — reused to avoid allocation noise
const NOOP = () => { }
const noopDisposable = { [Symbol.dispose]: NOOP }

// Disposable that does a real (cheap) cleanup: track active count
let active = 0
const dec = () => { active-- }
function trackedDisposable() {
  active++
  return { [Symbol.dispose]: dec }
}

// Disposable with a small actual workload
const freshDisposable = () => ({ [Symbol.dispose]: NOOP })

await bench.untilCompiled()

// ── 1. Binding overhead: using vs const (no disposal work) ─────────
{
  using _ = bench.group("Binding Overhead (no-op dispose)")

  // Zero allocation — same object, just bound
  bench("const (reused)", () => {
    const x = noopDisposable
    return x
  })

  bench("using (reused)", () => {
    using x = noopDisposable
    return x
  })

  // Fresh object every iteration (pay allocation + disposal)
  bench("const (fresh)", () => {
    const x = freshDisposable()
    return x
  })

  bench("using (fresh)", () => {
    using x = freshDisposable()
    return x
  })
}

// ── 1b. Pure `using` overhead (no allocation, no disposal work) ────
{
  using _ = bench.group("Pure using Cost (reused disposable)")

  const reusable = { [Symbol.dispose]: () => { } }

  bench("const", () => {
    const x = reusable
    return x
  })

  bench("using", () => {
    using x = reusable
    return x
  })
}

// ── 2. Disposal invocation speed ───────────────────────────────────
{
  using _ = bench.group("Disposal Invocation")

  let c = 0
  const inc = () => { c++ }

  bench("manual .dispose() call", () => {
    const obj = { [Symbol.dispose]: inc }
    obj[Symbol.dispose]()
    return c
  })

  bench("using auto-dispose", () => {
    using obj = { [Symbol.dispose]: inc }
    return c
  })

  bench("manual (fresh each iter)", () => {
    const obj = freshDisposable()
    obj[Symbol.dispose]()
    return obj
  })

  bench("using (fresh each iter)", () => {
    using obj = freshDisposable()
    return obj
  })
}

// ── 3. Multiple stacked disposals ──────────────────────────────────
{
  using _ = bench.group("Multiple Stacked Disposals (x3)")

  bench("const x3 manual", () => {
    const a = freshDisposable()
    const b = freshDisposable()
    const c = freshDisposable()
    a[Symbol.dispose]()
    b[Symbol.dispose]()
    c[Symbol.dispose]()
    return 1
  })

  bench("using x3", () => {
    using a = freshDisposable()
    using b = freshDisposable()
    using c = freshDisposable()
    return 1
  })
}

// ── 4. Realistic disposal (tracked active count) ───────────────────
{
  using _ = bench.group("Realistic Cleanup (tracked)")

  bench("manual create + dispose", () => {
    const obj = trackedDisposable()
    obj[Symbol.dispose]()
    return active
  })

  bench("using auto-dispose", () => {
    using obj = trackedDisposable()
    return active
  })
}

// ── 5. Deeply nested disposals ─────────────────────────────────────
{
  using _ = bench.group("Nested Disposals (depth 3)")

  bench("const nested manual", () => {
    const a = freshDisposable()
    const b = freshDisposable()
    const c = freshDisposable()
    // inner → outer manual unwind
    c[Symbol.dispose]()
    b[Symbol.dispose]()
    a[Symbol.dispose]()
    return 1
  })

  bench("using nested (auto unwind)", () => {
    // using unwinds in reverse order automatically
    using a = freshDisposable()
    using b = freshDisposable()
    using c = freshDisposable()
    return 1
  })
}

// ── 6. await using (async disposal) ────────────────────────────────
{
  using _ = bench.group("Async Disposal (await using)")

  const asyncNoop = () => Promise.resolve()

  bench("await using (noop)", async () => {
    await using x = { [Symbol.asyncDispose]: asyncNoop }
    return 1
  })

  bench("await .dispose() manually", async () => {
    const obj = { [Symbol.asyncDispose]: asyncNoop }
    await obj[Symbol.asyncDispose]()
    return 1
  })
}

// ── 8. Vector2 pool: using acquire vs manual get + reset ──────────
{
  using _ = bench.group("Vector2 Pool (acquire vs get)")

  // Without `using`: manual checkout + manual clear
  bench("Vector2.Pooled + manual clear", () => {
    const v = Vector2.Pooled
    v.x = 10
    v.y = 20
    // … use v …
    v.x = 0
    v.y = 0
    return v
  })

  // With `using`: auto-return on scope exit  
  bench("Vector2.POOL.acquire() + using", () => {
    using v = Vector2.POOL.acquire()
    v.x = 10
    v.y = 20
    return v
  })
}

// ── 9. Vector2 pool: stacked acquires ──────────────────────────────
{
  using _ = bench.group("Vector2 Pool (stacked x3)")

  bench("get() x3 + manual clear", () => {
    const a = Vector2.Pooled
    const b = Vector2.Pooled
    const c = Vector2.Pooled
    a.x = 1; a.y = 2
    b.x = 3; b.y = 4
    c.x = 5; c.y = 6
    // … use …
    a.x = 0; a.y = 0
    b.x = 0; b.y = 0
    c.x = 0; c.y = 0
    return a.x + b.x + c.x
  })

  bench("acquire() x3 + using", () => {
    using a = Vector2.POOL.acquire()
    using b = Vector2.POOL.acquire()
    using c = Vector2.POOL.acquire()
    a.x = 1; a.y = 2
    b.x = 3; b.y = 4
    c.x = 5; c.y = 6
    return a.x + b.x + c.x
  })
}

// ── 7. Inline disposable creation in expression context ────────────
{
  using _ = bench.group("Inline Expression Context")

  // Simulate a "scoped lock" pattern where you create and use inline
  bench("const inline, manual dispose", () => {
    const release = { [Symbol.dispose]: NOOP }
    // … use resource …
    release[Symbol.dispose]()
    return 1
  })

  bench("using inline", () => {
    using _ = { [Symbol.dispose]: NOOP }
    // … use resource …
    return 1
  })
}

/**
 * Outcome:
 * - `using` emission (no-op): similar perf to `const` — engine optimises the dispose call away
 * - `using` with real dispose: on par with manual .dispose() — no meaningful overhead
 * - Stacked `using` (x3): same cost as stacking const + manual dispose calls
 * - `await using`: minimal overhead over manual async dispose
 * - The primary value of `using` is correctness (guaranteed disposal), not speed
 */
