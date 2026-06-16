import { bench } from "benchik"

const array = Array(1_000).fill(0)

await bench.untilCompiled()

{
  using _ = bench.group("Loops")

  bench("plain", () => {
    const gg = []
    const len = array.length
    for (let i = 0; i < len; i++) {
      const element = array[i]
      gg.push(element)
    }
    return gg
  })

  bench("bce", () => {
    const gg = []
    const len = array.length
    if (array.length >= len) {
      for (let i = 0; i < len; i++) {
        const element = array[i]
        gg.push(element)
      }
    }
    return gg
  })
}
