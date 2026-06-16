import { bench } from "benchik"

const array = [1, 2, 3]

await bench.untilCompiled()

{
  using _ = bench.group("Array.at")

  bench(() => array[0])
  bench(() => array.at(0))

  bench(() => array[array.length - 1])
  bench(() => array.at(-1))
}
