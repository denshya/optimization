import { bench } from "benchik"

{
  using _ = bench.group("Array.new")

  bench("new Array", () => new Array(1_000))
  bench("Array", () => Array(1_000))
}
