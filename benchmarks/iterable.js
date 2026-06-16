import { bench } from "benchik"
import { FastArrayIterator } from "../src/modules/common/FastArrayIterator"

// A reusable token to reset iterator state
const ITERATOR_RESET = Symbol('IteratorReset');

class OptimizedCollection {
  #items = [];
  #cachedIterator = null;
  #cachedResult = { value: null, done: false };
  #index = 0;

  constructor(initialItems) {
    this.#items = initialItems;

    // 1. Create the underlying iterator once, inheriting from standard Iterator
    this.#cachedIterator = Iterator.from({
      next: () => {
        if (this.#index < this.#items.length) {
          // Mutate the exact same result object
          this.#cachedResult.value = this.#items[this.#index++];
          this.#cachedResult.done = false;
          return this.#cachedResult;
        }

        // Reset and return done
        this.#cachedResult.value = undefined;
        this.#cachedResult.done = true;
        return this.#cachedResult;
      }
    });

    // Add a backdoor way to reset the index pointer safely
    this.#cachedIterator[ITERATOR_RESET] = () => {
      this.#index = 0;
    };
  }

  // The drop-in replacement method
  recycledValues() {
    // Reset the internal pointer before handing it out
    this.#cachedIterator[ITERATOR_RESET]();
    return this.#cachedIterator;
  }

  // Standard immutable iterator remains untouched for safe code paths
  values() {
    return this.#items.values();
  }

  // Default iterable behavior (defaults to safe, standard iteration)
  [Symbol.iterator]() {
    return this.values();
  }
}

const array = Array(1_000).fill(0)
const collection = new OptimizedCollection(array)
const iterator = new FastArrayIterator(array)

await bench.untilCompiled()

{
  using g = bench.group("Iterable Map")
  const f = g.fresh(() => ({ plus: x => x + 1 }))
  g.assert = array.map(f.plus)

  // Control group.

  bench(() => array.map(f.plus))
  bench("for loop", () => {
    const l = array.length
    const r = new Array(l)
    for (let i = 0; i < l; i++) r[i] = f.plus(array[i])
    return r
  })

  // Comparison.
  bench("Iterator", () => array.values().map(f.plus).toArray())
  bench("Iterator (reused ResultObject)", () => collection.recycledValues().map(f.plus).toArray())
  bench("Iterator (custom)", () => iterator.reset().map(f.plus).toArray())
}

{
  using g = bench.group("Iterable ForEach")
  g.assert = array.reduce((r, n) => r + n + 1, 0)

  const f = g.fresh(() => ({ plus: x => x + 1 }))

  // Control group.

  // bench(() => array.forEach(f.plus))
  // bench("for loop", () => {
  //   const l = array.length
  //   for (let i = 0; i < l; i++) f.plus(array[i])
  // })

  // Comparison.
  bench("for of", () => {
    let r = 0
    for (let m of iterator.reset()) r += f.plus(m)
    return r
  })
  bench("while next", () => {
    iterator.reset()

    let m
    let r = 0
    while ((m = iterator.next(), !m.done)) {
      r += f.plus(m.value)
    }
    return r
  })

  bench("Iterator", () => array.values().forEach(f.plus))
  bench("Iterator (reused ResultObject)", () => collection.recycledValues().forEach(f.plus))
  bench("Iterator (custom)", () => iterator.reset().forEach(f.plus))
}
