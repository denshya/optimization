import { bench } from "benchik"

const array = [1, 2, 3]
const plus = x => x + 1

await bench.untilCompiled()

{
  using _ = bench.group("[].map")

  bench(() => array.map(plus))
  bench(() => Array.from({ length: array.length }, plus))
}
