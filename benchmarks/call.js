import { bench } from "benchik"

const method = () => 1
const context = {}

await bench.untilCompiled()

{
  using _ = bench.group("Function Call")

  bench(() => method())

  bench(() => method.call())
  bench(() => method.apply())

  bench(() => method.call(context))
  bench(() => method.apply(context))
}
