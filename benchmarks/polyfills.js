const mockCtx = {}
Object.assign(mockCtx, {
  setTransform() {},
  clearRect() {},
  globalCompositeOperation: "source-over",
  globalAlpha: 1,
  isPointInPath() { return true },
  fill() {},
  stroke() {},
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  beginPath() {},
  closePath() {},
  moveTo() {},
  lineTo() {},
  arc() {},
  arcTo() {},
  bezierCurveTo() {},
  quadraticCurveTo() {},
  rect() {},
  ellipse() {},
  save() {},
  restore() {},
  scale() {},
  rotate() {},
  translate() {},
  transform() {},
  measureText() { return { width: 0 } },
  fillText() {},
  strokeText() {},
  createLinearGradient() { return { addColorStop() {} } },
  createRadialGradient() { return { addColorStop() {} } },
  createPattern() { return {} },
  drawImage() {},
  putImageData() {},
  getImageData() { return { data: new Uint8ClampedArray(0) } },
  clip() {},
  resetTransform() {},
})

globalThis.window = {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
}

globalThis.document = {
  createElement() {
    return { getContext() { return mockCtx } }
  },
}

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16)
globalThis.HTMLCanvasElement = class {
  width = 1920
  height = 1080
  getContext() { return mockCtx }
  get style() { return this._style || (this._style = {}) }
}
globalThis.HTMLElement = class {
  getBoundingClientRect() { return { width: 1920, height: 1080, x: 0, y: 0, left: 0, top: 0 } }
  get style() { return this._style || (this._style = {}) }
}
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h }
  getContext() { return mockCtx }
}
globalThis.DOMMatrix = class {
  constructor(init) { if (init) Object.assign(this, init) }
  static fromFloat32Array(arr) {
    return new DOMMatrix({ a: arr[0], b: arr[1], c: arr[2], d: arr[3], e: arr[4], f: arr[5] })
  }
  inverse() { return new DOMMatrix() }
}
globalThis.Path2D = class {
  constructor() {}
  moveTo() {}
  lineTo() {}
  rect() {}
  arc() {}
  arcTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  ellipse() {}
  closePath() {}
  addPath() {}
}
globalThis.CanvasRenderingContext2D = class {
  constructor() { return mockCtx }
}
