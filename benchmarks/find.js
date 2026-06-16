import { bench } from "../../bench-suite/bench.suite"

const array = Array(1_000).fill(0)

await bench.untilCompiled()


const asd = (_, i) => i === 500

{
  using _ = bench.group("|| vs &&")

  bench("array.find", () => array.find(asd))
  bench("for find", () => {
    for (let i = 0; i < array.length; i++) if (i === 500) return i
  })
}
