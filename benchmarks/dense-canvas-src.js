import "./polyfills.js"
import { bench } from "benchik"

const N = 500_000

import { CanvasNode as SrcNode, CanvasViewer as SrcViewer } from "../src/samples.ts"

// Spread 80% of nodes across the scene, 20% within viewport region
const SCENE = 200_000, VP = 1920, VPH = 1080

const nodes = new Array(N)
for (let i = 0; i < N; i++) {
  const s = new SrcNode()
  s.visible = i % 7 !== 0
  s.shouldUpdate = false  // static scene — quadtree positions stay valid
  s.zIndex = i
  s.name = String(i)
  s.composePath = () => s.composedPath
  const inView = i % 5 === 0  // 20% in viewport
  const x = inView ? (i * 101 + 7) % VP : (i * 773 + 13) % SCENE
  const y = inView ? (i * 97 + 3) % VPH : (i * 541 + 7) % SCENE
  s.wmX = x; s.wmY = y; s.wMx = x + 100; s.wMy = y + 100
  s.box.min.x = x; s.box.min.y = y; s.box.max.x = x + 100; s.box.max.y = y + 100
  nodes[i] = s
}

const canvas = new HTMLCanvasElement()
const wrapper = new HTMLElement()
const viewer = new SrcViewer(canvas, wrapper)
viewer.scene.children.append(nodes)

viewer.renderingCandidates.refresh()

await bench.untilCompiled()

bench("untransformed", () => {
  viewer.renderingCandidates.refresh()
  viewer.draw()
  return viewer.renderingCandidates.nodes.length
})
