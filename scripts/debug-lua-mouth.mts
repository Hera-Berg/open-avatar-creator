// Debug the mouth rig on the real Lua_Faye PSD without a browser.
// Run: npx vite-node scripts/debug-lua-mouth.mts [psd-path]

import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- minimal 2D-canvas stub (plain-JS bilinear downscale + put/get) ------
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
          const gx = (x + 0.5) * (s.width / dw) - 0.5;
          const gy = (y + 0.5) * (s.height / dh) - 0.5;
          const x0 = Math.max(0, Math.floor(gy) * s.width + Math.floor(gx));
          const sx = Math.min(s.width - 1, Math.max(0, Math.floor(gx)));
          const sy = Math.min(s.height - 1, Math.max(0, Math.floor(gy)));
          const i = (sy * s.width + sx) * 4;
          const o = (y * dw + x) * 4;
          out[o] = s.data[i]!;
          out[o + 1] = s.data[i + 1]!;
          out[o + 2] = s.data[i + 2]!;
          out[o + 3] = s.data[i + 3]!;
          void x0;
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

// ag-psd creates image data through its own canvas helpers — inject ours.
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

// ---- run the real pipeline -----------------------------------------------
const { importPsd } = await import(join(root, "packages/creator/src/import/psd.ts"));
const { runAutoRig } = await import(join(root, "packages/creator/src/autorig/index.ts"));
const { History } = await import(join(root, "packages/creator/src/state/undo.ts"));

const psdPath = process.argv[2] ?? join(root, "packages/creator/public/test-lua.psd");
const buffer = readFileSync(psdPath);
const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

console.log("importing", psdPath, `(${(ab.byteLength / 1048576).toFixed(1)} MB)…`);
const t0 = Date.now();
const result = await importPsd(ab, "lua.psd", { targetSize: 2048 }, (name, done, total) => {
  if (done % 10 === 0) console.log(`  ${done}/${total} ${name}`);
});
console.log(`imported in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${result.manifest.layers.length} layers, scale ${result.report.scale.toFixed(3)}`);

const rig = runAutoRig(result.manifest, result.pixels, {
  classify: true, skeleton: true, bindings: true, meshes: true, physics: true, face: true,
});
new History().execute(result.manifest, rig.cmd);
const m = result.manifest;

console.log("\n=== mouth rig ===");
console.log("warnings:", rig.warnings.join(" | ") || "(none)");
const lip = (id: string | null | undefined) => {
  const l = id ? m.layers.find((x) => x.id === id) : null;
  if (!l) return "null";
  const img = result.pixels.get(l.id);
  let opaque = 0;
  if (img) for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) opaque++;
  return `${l.name} rect=(${l.x},${l.y} ${l.width}x${l.height}) ord=${l.order} visible=${l.visible} opaquePx=${opaque}`;
};
console.log("upperLip:", lip(m.rig?.mouth.upperLip));
console.log("lowerLip:", lip(m.rig?.mouth.lowerLip));
console.log("apertureMesh:", m.rig?.mouth.apertureMesh);
console.log("apertureLayer:", m.rig?.mouth.apertureLayer);
const cav = m.rig?.mouth.apertureLayer ? m.layers.find((x) => x.id === m.rig!.mouth.apertureLayer) : null;
console.log("cavity:", cav ? `ord=${cav.order} rect=(${cav.x},${cav.y} ${cav.width}x${cav.height}) bone=${cav.boneId}` : "null");

const ap = m.rig?.mouth.apertureMesh ? m.meshes.find((x) => x.id === m.rig!.mouth.apertureMesh) : null;
if (ap) {
  const cols = Math.round(ap.vertices.length / 3);
  console.log(`aperture: ${ap.vertices.length} verts, ${cols} cols`);
  console.log("top boundary y:", ap.vertices.slice(0, cols).map((v) => v[1].toFixed(0)).join(","));
  console.log("bottom boundary y:", ap.vertices.slice(cols * 2, cols * 3).map((v) => v[1].toFixed(0)).join(","));
  console.log("x span:", ap.vertices.slice(0, cols).map((v) => v[0].toFixed(0)).join(","));
}
// Orders around the mouth stack.
console.log("\n=== stack around mouth (ascending = back→front) ===");
const near = m.layers
  .filter((l) => ["mouth_inner", "mouth_cavity", "lip_upper", "lip_lower", "head", "nose", "blush"].includes(l.slot ?? ""))
  .sort((a, b) => a.order - b.order);
for (const l of near) console.log(`  ord=${l.order.toFixed(1).padStart(5)} ${l.name} (${l.slot}) visible=${l.visible}`);

// ---- software render of the mouth region ----------------------------------
if (rig.cavityPixels && rig.faceRig?.cavityLayer) {
  result.pixels.set(rig.faceRig.cavityLayer.id, rig.cavityPixels);
}
const core = await import(join(root, "packages/core/src/index.ts"));
const { createSolveContext, solveModel, withDriverDefaults } = core as typeof import("@oar/core");

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

function renderMouth(params: Record<string, number>, outPath: string, region: { x: number; y: number; w: number; h: number; scale: number }) {
  const ctx = createSolveContext();
  ctx.meshes = new Map(m.meshes.map((x) => [x.id, x]));
  const solved = solveModel(m, withDriverDefaults(params), ctx);
  const W = Math.round(region.w * region.scale);
  const H = Math.round(region.h * region.scale);
  const out = new Uint8ClampedArray(W * H * 4);
  // dark background
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

const region = { x: 480, y: 290, w: 210, h: 140, scale: 3 };
const zoom = { x: 530, y: 330, w: 90, h: 50, scale: 8 };

// Numeric dump: aperture boundary rows vs lip inner edges at open=0.5.
{
  const ctx = createSolveContext();
  ctx.meshes = new Map(m.meshes.map((x) => [x.id, x]));
  const solved = solveModel(m, withDriverDefaults({ mouth_open: 0.5 }), ctx);
  const cavSolved = solved.layers.find((l) => l.id === m.rig?.mouth.apertureLayer)!;
  const apMesh = m.meshes.find((x) => x.id === m.rig!.mouth.apertureMesh)!;
  const cols = Math.round(cavSolved.positions.length / 3);
  console.log("\n=== aperture @ open=0.5 (top row / bottom row y per column) ===");
  for (let c = 0; c < cols; c++) {
    const top = cavSolved.positions[c]!;
    const bot = cavSolved.positions[cols * 2 + c]!;
    console.log(
      `  col${c} x=${top[0].toFixed(1)} top=${top[1].toFixed(1)} bot=${bot[1].toFixed(1)} open=${(bot[1] - top[1]).toFixed(1)}`,
    );
  }
  console.log("aperture uv v-values:", apMesh.uvs.slice(0, cols).map((u) => u[1].toFixed(2)).join(","));
  const upper = solved.layers.find((l) => l.id === m.rig!.mouth.upperLip)!;
  const lower = solved.layers.find((l) => l.id === m.rig!.mouth.lowerLip)!;
  const lipMeshOf = (layer: (typeof m.layers)[number]) =>
    layer.mesh ? m.meshes.find((x) => x.id === layer.mesh)! : ctx.meshCache.get(layer.id)!;
  const upperMesh = lipMeshOf(m.layers.find((x) => x.id === upper.id)!);
  const lowerMesh = lipMeshOf(m.layers.find((x) => x.id === lower.id)!);
  const edgeY = (mesh: typeof upperMesh, solvedL: typeof upper, wantBottom: boolean) => {
    const out: string[] = [];
    for (let i = 0; i < mesh.vertices.length; i++) {
      const v = mesh.uvs[i]![1];
      if ((wantBottom && v === 1) || (!wantBottom && v === 0)) {
        out.push(`${mesh.vertices[i]![0].toFixed(0)}:${solvedL.positions[i]![1].toFixed(1)}`);
      }
    }
    return out.join(" ");
  };
  console.log("upper lip bottom edge (x:y):", edgeY(upperMesh, upper, true));
  console.log("lower lip top edge (x:y):", edgeY(lowerMesh, lower, false));
}
renderMouth({ mouth_open: 0 }, "/tmp/mouth-rest.png", region);
// The exact reported problem pose: yaw=−1, roll=−1, mouth=0.88
const face = { x: 350, y: 150, w: 350, h: 350, scale: 2 };
renderMouth({ head_yaw: -1, head_roll: -1, mouth_open: 0.88 }, "/tmp/pose-extreme.png", face);
renderMouth({ mouth_open: 0.88 }, "/tmp/mouth-88.png", { x: 500, y: 300, w: 170, h: 120, scale: 4 });
m.params.mouthCorner = 1.2;
renderMouth({ mouth_open: 0.88 }, "/tmp/mouth-corner-long.png", { x: 500, y: 300, w: 170, h: 120, scale: 4 });
m.params.mouthCorner = 0.4;
renderMouth({ mouth_open: 0.88 }, "/tmp/mouth-corner-short.png", { x: 500, y: 300, w: 170, h: 120, scale: 4 });
delete m.params.mouthCorner;

renderMouth({ head_yaw: 0, head_roll: 0, mouth_open: 0.88 }, "/tmp/pose-mouthwide.png", face);
const corner = { x: 590, y: 335, w: 35, h: 30, scale: 16 };
renderMouth({ mouth_open: 0.88 }, "/tmp/mouth-corner.png", corner);
const cornerL = { x: 535, y: 335, w: 35, h: 30, scale: 16 };
renderMouth({ mouth_open: 0.88 }, "/tmp/mouth-cornerL.png", cornerL);
renderMouth({ mouth_open: 0.5 }, "/tmp/mouth-zoom-mid.png", zoom);
renderMouth({ mouth_open: 0.2 }, "/tmp/mouth-zoom-low.png", zoom);
renderMouth({ mouth_open: 0.5 }, "/tmp/mouth-mid.png", region);
renderMouth({ mouth_open: 1 }, "/tmp/mouth-open.png", region);
// Isolation: same frame with the cavity layer hidden.
const cavLayer = m.layers.find((x) => x.id === m.rig?.mouth.apertureLayer);
if (cavLayer) {
  const was = cavLayer.visible;
  cavLayer.visible = false;
  renderMouth({ mouth_open: 0.88 }, "/tmp/mouth-corner-nocavity.png", corner);
  renderMouth({ mouth_open: 0.88 }, "/tmp/mouth-88-nocavity.png", { x: 500, y: 300, w: 170, h: 120, scale: 4 });
  renderMouth({ mouth_open: 0.5 }, "/tmp/mouth-zoom-mid-nocavity.png", zoom);
  renderMouth({ mouth_open: 0.5 }, "/tmp/mouth-mid-nocavity.png", region);
  renderMouth({ mouth_open: 1 }, "/tmp/mouth-open-nocavity.png", region);
  cavLayer.visible = was;
}
