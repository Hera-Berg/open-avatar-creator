// Debug the head-pitch warp on the real Lua_Faye PSD without a browser.
// Renders the whole head at pitch -1 / 0 / +1 to /tmp/pitch-*.png.
// Run: npx vite-node scripts/debug-lua-pitch.mts [psd-path]

import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- minimal 2D-canvas stub ------------------------------------------------
type Img = { width: number; height: number; data: Uint8ClampedArray };
const canvases = new WeakMap<object, { img?: Img; width: number; height: number }>();

function makeCtx(state: { img?: Img; width: number; height: number }) {
  return {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
    putImageData(im: Img) {
      state.img = { width: im.width, height: im.height, data: new Uint8ClampedArray(im.data) };
    },
    drawImage(src: object, _sx: number, _sy: number, dw: number, dh: number) {
      const s = canvases.get(src as object)?.img;
      if (!s) throw new Error("drawImage: empty source");
      const out = new Uint8ClampedArray(dw * dh * 4);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(s.width - 1, Math.max(0, Math.floor((x + 0.5) * (s.width / dw))));
          const sy = Math.min(s.height - 1, Math.max(0, Math.floor((y + 0.5) * (s.height / dh))));
          const i = (sy * s.width + sx) * 4;
          const o = (y * dw + x) * 4;
          out[o] = s.data[i]!;
          out[o + 1] = s.data[i + 1]!;
          out[o + 2] = s.data[i + 2]!;
          out[o + 3] = s.data[i + 3]!;
        }
      }
      state.img = { width: dw, height: dh, data: out };
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      const img = state.img ?? { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
    },
  };
}

(globalThis as Record<string, unknown>).document = {
  createElement(tag: string) {
    if (tag !== "canvas") throw new Error("stub: only canvas");
    const state = { width: 300, height: 150, img: undefined as Img | undefined };
    const canvas = {
      getContext: (kind: string) => (kind === "2d" ? makeCtx(state) : null),
      get width() { return state.width; },
      set width(v: number) { state.width = v; },
      get height() { return state.height; },
      set height(v: number) { state.height = v; },
    };
    canvases.set(canvas, state);
    return canvas;
  },
};

(globalThis as Record<string, unknown>).ImageData = class {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const { initializeCanvas } = await import("ag-psd");
initializeCanvas(
  (width: number, height: number) => {
    const state = { width: width ?? 300, height: height ?? 150, img: undefined as Img | undefined };
    const canvas = {
      getContext: (kind: string) =>
        kind === "2d"
          ? {
              ...makeCtx(state),
              createImageData: (w: number, h: number) => ({
                width: w,
                height: h,
                data: new Uint8ClampedArray(w * h * 4),
              }),
            }
          : null,
      get width() { return state.width; },
      set width(v: number) { state.width = v; },
      get height() { return state.height; },
      set height(v: number) { state.height = v; },
    } as unknown as HTMLCanvasElement;
    canvases.set(canvas, state);
    return canvas;
  },
  (width: number, height: number) =>
    ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
);

// ---- run the real pipeline -------------------------------------------------
const { importPsd } = await import(join(root, "packages/creator/src/import/psd.ts"));
const { runAutoRig } = await import(join(root, "packages/creator/src/autorig/index.ts"));
const { History } = await import(join(root, "packages/creator/src/state/undo.ts"));

const psdPath = process.argv[2] ?? join(root, "packages/creator/public/test-lua.psd");
const buffer = readFileSync(psdPath);
const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

console.log("importing", psdPath, `(${(ab.byteLength / 1048576).toFixed(1)} MB)…`);
const result = await importPsd(ab, "lua.psd", { targetSize: 2048 }, () => {});
console.log(`imported — ${result.manifest.layers.length} layers, scale ${result.report.scale.toFixed(3)}`);

const rig = runAutoRig(result.manifest, result.pixels, {
  classify: true, skeleton: true, bindings: true, meshes: true, physics: true, face: true,
});
new History().execute(result.manifest, rig.cmd);
const m = result.manifest;
console.log("warnings:", rig.warnings.join(" | ") || "(none)");
console.log("head rig:", m.rig?.head);

const core = await import(join(root, "packages/core/src/index.ts"));
const { createSolveContext, solveModel, withDriverDefaults, deriveLashLowerEdge } =
  core as typeof import("@oar/core");

// ---- renderer --------------------------------------------------------------
function encodePng(width: number, height: number, data: Uint8ClampedArray): Buffer {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, y * (1 + width * 4) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeCtx2() {
  const ctx = createSolveContext();
  ctx.meshes = new Map(m.meshes.map((x) => [x.id, x]));
  for (const side of ["left", "right"] as const) {
    const lashId = m.rig?.eyes[side]?.lashTop;
    const layer = lashId ? m.layers.find((l) => l.id === lashId) : null;
    const img = lashId ? result.pixels.get(lashId) : undefined;
    ctx.eyeRuntime[side].lashLower = layer && img ? deriveLashLowerEdge(img, layer.x, layer.y) : null;
  }
  return ctx;
}

function render(params: Record<string, number>, outPath: string, region: { x: number; y: number; w: number; h: number; scale: number }) {
  const ctx = makeCtx2();
  const solved = solveModel(m, withDriverDefaults(params), ctx);
  const W = Math.round(region.w * region.scale);
  const H = Math.round(region.h * region.scale);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = 30; out[i * 4 + 1] = 30; out[i * 4 + 2] = 34; out[i * 4 + 3] = 255;
  }
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
    const i = (y * W + x) * 4;
    const da = out[i + 3]! / 255;
    const oa = a + da * (1 - a);
    if (oa === 0) return;
    out[i] = Math.round((r * a + out[i]! * da * (1 - a)) / oa);
    out[i + 1] = Math.round((g * a + out[i + 1]! * da * (1 - a)) / oa);
    out[i + 2] = Math.round((b * a + out[i + 2]! * da * (1 - a)) / oa);
    out[i + 3] = Math.round(oa * 255);
  };
  for (const layer of solved.layers) {
    if (!layer.visible) continue;
    const tex = result.pixels.get(layer.id);
    if (!tex) continue;
    const toPx = (p: [number, number]): [number, number] => [
      Math.round((p[0] - region.x) * region.scale),
      Math.round((p[1] - region.y) * region.scale),
    ];
    for (const tri of layer.triangles) {
      const [ia, ib, ic] = tri;
      const a = toPx(layer.positions[ia]!);
      const b = toPx(layer.positions[ib]!);
      const c = toPx(layer.positions[ic]!);
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-6) continue;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / area;
          const w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
          const u = layer.uvs[ia]![0] * w0 + layer.uvs[ib]![0] * w1 + layer.uvs[ic]![0] * w2;
          const v = layer.uvs[ia]![1] * w0 + layer.uvs[ib]![1] * w1 + layer.uvs[ic]![1] * w2;
          const tx = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
          const ty = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
          const ti = (ty * tex.width + tx) * 4;
          const alpha = (tex.data[ti + 3]! / 255) * layer.alpha;
          put(x, y, tex.data[ti]!, tex.data[ti + 1]!, tex.data[ti + 2]!, alpha);
        }
      }
    }
  }
  writeFileSync(outPath, encodePng(W, H, out));
  console.log("wrote", outPath);
}

// ---- numeric dump: feature slide + foreshortening ---------------------------
{
  const ctx = makeCtx2();
  const solved = solveModel(m, withDriverDefaults({ head_pitch: 1 }), ctx);
  const headModel = m.layers.find((l) => l.slot === "head")!;
  const head = solved.layers.find((l) => l.id === headModel.id)!;
  const mesh = ctx.meshCache.get(headModel.id)!;
  const restH = Math.max(...mesh.vertices.map((v) => v[1])) - Math.min(...mesh.vertices.map((v) => v[1]));
  const solvedH = Math.max(...head.positions.map((p) => p[1])) - Math.min(...head.positions.map((p) => p[1]));
  console.log(`\nhead height: rest ${restH.toFixed(1)} → pitched ${solvedH.toFixed(1)} (${(((solvedH - restH) / restH) * 100).toFixed(1)}%)`);
  const eyeModel = m.layers.find((l) => l.slot === "eye_white" && l.side === "left")!;
  const eye = solved.layers.find((l) => l.id === eyeModel.id)!;
  const eyeMesh = ctx.meshCache.get(eyeModel.id)!;
  const restCy = eyeMesh.vertices.reduce((s, v) => s + v[1], 0) / eyeMesh.vertices.length;
  const solvedCy = eye.positions.reduce((s, p) => s + p[1], 0) / eye.positions.length;
  console.log(`left eye centre slide at pitch=+1: ${(solvedCy - restCy).toFixed(1)} px down`);
}

// ---- renders ---------------------------------------------------------------
const headLayer = m.layers.find((l) => l.slot === "head")!;
const pad = 60;
const region = {
  x: headLayer.x - pad,
  y: headLayer.y - pad,
  w: headLayer.width + pad * 2,
  h: headLayer.height + pad * 2,
  scale: Math.min(2, 1100 / (headLayer.width + pad * 2)),
};
console.log(`head region: (${region.x.toFixed(0)},${region.y.toFixed(0)} ${region.w.toFixed(0)}x${region.h.toFixed(0)}) scale ${region.scale.toFixed(2)}`);

for (const pitch of [-1, 0, 1]) {
  // pitch +1 = nod down (features slide down), pitch -1 = tilt up.
  render({ head_pitch: pitch }, `/tmp/pitch-${pitch > 0 ? "down" : pitch < 0 ? "up" : "rest"}.png`, region);
}
// Diagonals and the full extreme: yaw and pitch must compose without shear.
render({ head_yaw: -1, head_pitch: -1 }, "/tmp/pitch-diag-up-left.png", region);
render({ head_yaw: 1, head_pitch: 1 }, "/tmp/pitch-diag-down-right.png", region);
render({ head_yaw: 1, head_pitch: 1, head_roll: 1 }, "/tmp/pitch-extreme.png", region);
