import { bench } from "benchik"

const SIZE = 100
const arr = Array.from({ length: SIZE }, (_, i) => i)

await bench.untilCompiled()

{
  using g = bench.group("Array.splice — remove middle")
  const idx = SIZE >> 1

  bench("splice (mutate)", () => {
    const a = arr.slice()
    a.splice(idx, 1)
    return a
  })
  bench("slice spread (copy)", () => {
    return [...arr.slice(0, idx), ...arr.slice(idx + 1)]
  })
  bench("filter (copy)", () => {
    return arr.filter((_, i) => i !== idx)
  })
  bench("toSpliced (copy)", () => {
    return arr.toSpliced(idx, 1)
  })
  bench("slice concat (copy)", () => {
    return arr.slice(0, idx).concat(arr.slice(idx + 1))
  })
  bench("for loop copy", () => {
    const a = Array(SIZE - 1)
    for (let i = 0, j = 0; i < SIZE; i++) {
      if (i !== idx) a[j++] = arr[i]
    }
    return a
  })
}

{
  using g = bench.group("Array.splice — insert middle")
  const newItem = 999
  const idx = SIZE >> 1

  bench("splice (mutate)", () => {
    const a = arr.slice()
    a.splice(idx, 0, newItem)
    return a
  })
  bench("slice spread (copy)", () => {
    return [...arr.slice(0, idx), newItem, ...arr.slice(idx)]
  })
  bench("toSpliced (copy)", () => {
    return arr.toSpliced(idx, 0, newItem)
  })
  bench("slice concat (copy)", () => {
    return arr.slice(0, idx).concat(newItem, arr.slice(idx))
  })
  bench("generator (copy)", () => {
    return Array.from((function* () {
      for (let i = 0; i < SIZE; i++) {
        if (i === idx) yield newItem
        yield arr[i]
      }
    })())
  })
  bench("for loop copy", () => {
    const a = Array(SIZE + 1)
    for (let i = 0, j = 0; i < SIZE; i++, j++) {
      if (i === idx) a[j++] = newItem
      a[j] = arr[i]
    }
    return a
  })
}

{
  using g = bench.group("Array.splice — replace middle")
  const idx = SIZE >> 1

  bench("splice (mutate)", () => {
    const a = arr.slice()
    a.splice(idx, 1, 999)
    return a
  })
  bench("direct assign (mutate)", () => {
    const a = arr.slice()
    a[idx] = 999
    return a
  })
  bench("slice spread (copy)", () => {
    return [...arr.slice(0, idx), 999, ...arr.slice(idx + 1)]
  })
  bench("with (copy)", () => {
    return arr.with(idx, 999)
  })
  bench("Array.from map (copy)", () => {
    return Array.from({ length: SIZE }, (_, i) => i === idx ? 999 : arr[i])
  })
}

{
  using g = bench.group("Array.splice — multi insert middle")
  const items = [100, 200, 300]
  const idx = SIZE >> 1

  bench("splice (mutate)", () => {
    const a = arr.slice()
    a.splice(idx, 0, ...items)
    return a
  })
  bench("slice spread (copy)", () => {
    return [...arr.slice(0, idx), ...items, ...arr.slice(idx)]
  })
  bench("toSpliced (copy)", () => {
    return arr.toSpliced(idx, 0, ...items)
  })
  bench("slice concat (copy)", () => {
    return arr.slice(0, idx).concat(items, arr.slice(idx))
  })
  bench("copyWithin (mutate, shift first)", () => {
    const a = arr.slice()
    const len = a.length
    const ins = items.length
    a.length = len + ins
    a.copyWithin(idx + ins, idx)
    for (let i = 0; i < ins; i++) a[idx + i] = items[i]
    return a
  })
}

{
  using g = bench.group("Array.splice — multi remove middle")
  const removeCount = 5
  const idx = SIZE >> 1

  bench("splice (mutate)", () => {
    const a = arr.slice()
    a.splice(idx, removeCount)
    return a
  })
  bench("slice spread (copy)", () => {
    return [...arr.slice(0, idx), ...arr.slice(idx + removeCount)]
  })
  bench("for loop copy", () => {
    const a = Array(SIZE - removeCount)
    let j = 0
    for (let i = 0; i < SIZE; i++) {
      if (i < idx || i >= idx + removeCount) a[j++] = arr[i]
    }
    return a
  })
}

/**
 * Verdict:
 *   Remove/insert: prefer toSpliced (non-mutating) or splice (mutating).
 *   Replace:       prefer direct assign (mutating) or .with() (non-mutating).
 *   For loops:     faster than spread/concat/filter/generator for copies.
 *   Avoid:         filter, concat, generator for splice-like work.
 */
