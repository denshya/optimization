import { bench } from "../../bench-suite/bench.suite"
import Box2 from "../src/modules/geometry/Box2"

const nan = NaN
const number = 0
const box = new Box2

await bench.untilCompiled()

{
  using _ = bench.group("|| vs &&")

  bench(() => nan || number)
  bench(() => isNaN(nan) && number)
}


{


  using _ = bench.group("sanitize")

  bench(() => {
    for (let i = 0; i < 1_000; i++) box.sanitize()
  })
  bench(() => {
    for (let i = 0; i < 1_000; i++) {
      if (!isFinite(box.min.x)) box.min.x = 0
      if (!isFinite(box.min.y)) box.min.y = 0
      if (!isFinite(box.max.x)) box.max.x = 0
      if (!isFinite(box.max.y)) box.max.y = 0
    }
  })
}
