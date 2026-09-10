// Generates sample-avatar.oar — a small hand-written model that exercises
// bones, weighted meshes, physics, eyes, mouth and the runtime iris clip.
// Run: node scripts/make-sample-oar.mjs

import { writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(join(root, "packages/core/src/index.ts"));
const {
  writeOar,
  deriveLidContour,
  buildApertureMesh,
  emptyManifest,
} = core;

// ------------------------------------------------ minimal PNG encoder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, data) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, y * (1 + width * 4) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------ artwork helpers
function img(width, height, draw) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = draw(x, y);
      if (!px) continue;
      const i = (y * width + x) * 4;
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      data[i + 3] = px[3];
    }
  }
  return { width, height, data };
}
const ellipse = (cx, cy, rx, ry, colour) => (x, y) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 ? colour : null;
const SKIN = [242, 205, 178, 255];
const HAIR = [96, 74, 138, 255];
const WHITE = [250, 250, 252, 255];
const IRIS = [86, 156, 214, 255];
const LASH = [46, 36, 40, 255];
const LIP = [214, 120, 128, 255];
const DARK = [70, 30, 34, 255];

const layerDefs = [];
function addLayer(name, slot, side, x, y, image, order, extra = {}) {
  const id = `l_${name.replace(/[^a-z0-9]/gi, "_")}`;
  layerDefs.push({ id, name, slot, side, x, y, image, order, ...extra });
  return id;
}

// Canvas 900×1200. Character's left = canvas right.
const headImg = img(360, 460, ellipse(180, 230, 175, 225, SKIN));
const hairBackImg = img(440, 700, (x, y) => {
  const d = ((x - 220) / 210) ** 2 + ((y - 280) / 300) ** 2;
  return d <= 1 && y > 40 ? HAIR : null;
});
const torsoImg = img(500, 500, (x, y) =>
  ((x - 250) / 230) ** 2 + ((y - 300) / 260) ** 2 <= 1 ? [222, 118, 118, 255] : null,
);
const neckImg = img(120, 140, (x, y) => (x > 20 && x < 100 ? SKIN : null));
const eyeWhiteImg = img(90, 46, ellipse(45, 23, 42, 20, WHITE));
const irisImg = img(40, 40, ellipse(20, 20, 17, 17, IRIS));
const lashImg = img(94, 26, (x, y) => {
  const d = ((x - 47) / 44) ** 2 + ((y - 26) / 24) ** 2;
  return d <= 1 && y > 8 ? LASH : null;
});
const browImg = img(90, 18, (x, y) => (y > 6 && y < 12 && x > 4 && x < 86 ? LASH : null));
// Lips: rounded shapes whose inner edges meet on a flat line across the
// whole span — the mouth corners touch, so the aperture is zero-area at rest.
const upperLipImg = img(120, 30, (x, y) => {
  const inEllipse = ((x - 60) / 52) ** 2 + ((y - 4) / 20) ** 2 <= 1;
  const meetLine = y === 24 && x >= 8 && x <= 112;
  return (inEllipse && y <= 24) || meetLine ? LIP : null;
});
const lowerLipImg = img(120, 30, (x, y) => {
  const inEllipse = ((x - 60) / 52) ** 2 + ((y - 26) / 20) ** 2 <= 1;
  const meetLine = y === 6 && x >= 8 && x <= 112;
  return (inEllipse && y >= 6) || meetLine ? LIP : null;
});
const teethImg = img(100, 24, (x, y) => (y < 12 ? [245, 245, 240, 255] : null));
const mouthBackImg = img(100, 40, () => DARK);

addLayer("hair-back-middle", "hair_back", "middle", 230, 90, hairBackImg, 0, {
  physics: { enabled: true, stiffness: 5, damping: 0.86, maxAngle: 16, inertia: 1, gravity: 0.5, pivot: "top", customPivot: null },
});
addLayer("torso", "torso", null, 200, 760, torsoImg, 1);
addLayer("Neck", "neck", null, 390, 640, neckImg, 2);
addLayer("head", "head", null, 270, 180, headImg, 3);
addLayer("mouth-back", "mouth_inner", null, 400, 520, mouthBackImg, 4);
addLayer("teeth-upper", "mouth_inner", null, 400, 520, teethImg, 5);
const upperLipId = addLayer("top-lip", "lip_upper", null, 390, 545, upperLipImg, 8);
const lowerLipId = addLayer("bottom-lip", "lip_lower", null, 390, 563, lowerLipImg, 9);
const whiteL = addLayer("eye-white-left", "eye_white", "left", 480, 360, eyeWhiteImg, 10);
const irisL = addLayer("iris-left", "iris", "left", 505, 363, irisImg, 11);
const lashL = addLayer("eyelash-top-left", "eyelash_top", "left", 478, 344, lashImg, 12);
const whiteR = addLayer("eye-white-right", "eye_white", "right", 330, 360, eyeWhiteImg, 10);
const irisR = addLayer("iris-right", "iris", "right", 355, 363, irisImg, 11);
const lashR = addLayer("eyelash-top-right", "eyelash_top", "right", 328, 344, lashImg, 12);
addLayer("eyebrow-left", "eyebrow", "left", 480, 320, browImg, 13);
addLayer("eyebrow-right", "eyebrow", "right", 330, 320, browImg, 13);

// ------------------------------------------------ bones (§16 table)
const cx = 450;
const mk = (name, y, follow, parentId) => ({
  id: `b_${name}`,
  name,
  parentId,
  head: [cx, y],
  tail: [cx, y - 120],
  locked: false,
  follow,
  rotation: 0,
});
const bones = [
  mk("root", 1180, 0.0, null),
  mk("hips", 1050, -0.09, "b_root"),
  mk("torso", 900, 0.1, "b_hips"),
  mk("chest", 780, 0.36, "b_torso"),
  mk("neck", 640, 0.64, "b_chest"),
  mk("head", 560, 1.0, "b_neck"),
];
const pivots = bones.map((b) => ({ id: b.id, pivotY: b.head[1] }));

// ------------------------------------------------ manifest
const manifest = emptyManifest("sample-avatar", { width: 900, height: 1200 });
manifest.params = { blinkFloor: 0.32, mouthGain: 1.6, mouthRangeUpper: 24, mouthRangeLower: 34 };

const pngs = new Map();
manifest.layers = layerDefs.map((d, i) => {
  const src = `layers/${String(d.order).padStart(3, "0")}_${d.name.replace(/[^a-z0-9_-]/gi, "_")}.png`;
  pngs.set(d.id, encodePng(d.image.width, d.image.height, d.image.data));
  const weighted = ["torso", "Neck"].includes(d.name);
  return {
    id: d.id,
    name: d.name,
    path: [],
    src,
    x: d.x,
    y: d.y,
    width: d.image.width,
    height: d.image.height,
    opacity: 1,
    visible: !["mouth-back", "teeth-upper"].includes(d.name), // cavity feed
    order: d.order,
    slot: d.slot,
    side: d.side ?? null,
    boneId: ["torso", "Neck"].includes(d.name) ? null : "b_head",
    mesh: null,
    clipTo: d.name.startsWith("iris-left") ? whiteL : d.name.startsWith("iris-right") ? whiteR : null,
    physics: d.physics ?? null,
  };
});

// Weighted meshes for torso and neck (the neck is a joint, not a body part).
const { subdivideQuad } = core;
for (const d of layerDefs.filter((x) => ["torso", "Neck"].includes(x.name))) {
  const mesh = subdivideQuad(`m_${d.name}`, d.x, d.y, d.image.width, d.image.height, 3, 6);
  mesh.weights = mesh.vertices.map(([, y]) => core.spineWeights(y, pivots));
  manifest.meshes.push(mesh);
  manifest.layers.find((l) => l.id === d.id).mesh = mesh.id;
}
manifest.bones = bones;

// ------------------------------------------------ rig block
const rig = {
  head: { centre: [450, 410], radius: [180, 230] },
  eyes: {
    left: {
      white: whiteL,
      iris: irisL,
      shine: null,
      lashTop: lashL,
      lashBottom: null,
      closed: null,
      lidContour: deriveLidContour(eyeWhiteImg, 480, 360),
      irisRange: [23, 8],
    },
    right: {
      white: whiteR,
      iris: irisR,
      shine: null,
      lashTop: lashR,
      lashBottom: null,
      closed: null,
      lidContour: deriveLidContour(eyeWhiteImg, 330, 360),
      irisRange: [23, 8],
    },
  },
  mouth: {
    upperLip: upperLipId,
    lowerLip: lowerLipId,
    inner: ["l_mouth_back", "l_teeth_upper"],
    apertureLayer: null,
    apertureMesh: null,
    restGap: 0,
  },
};
// Aperture mesh from the lip artwork.
const aperture = buildApertureMesh(
  "m_aperture",
  upperLipImg,
  { x: 390, y: 545, width: 120, height: 30 },
  lowerLipImg,
  { x: 390, y: 563, width: 120, height: 30 },
);
if (aperture) {
  // Cavity texture: dark mouth interior with the upper teeth band.
  const cw = 130;
  const ch = 56;
  const cavity = img(cw, ch, (x, y) => (y < 16 && x > 12 && x < 118 ? [245, 245, 240, 255] : DARK));
  // Keep buildApertureMesh's parametric UVs (v=0 upper lip edge, v=1 lower)
  // so the teeth ride the lip as the aperture stretches.
  const apMinX = Math.min(...aperture.vertices.map((v) => v[0]));
  const apMinY = Math.min(...aperture.vertices.map((v) => v[1]));
  manifest.meshes.push(aperture);
  const cavityId = "l_mouth_cavity";
  pngs.set(cavityId, encodePng(cavity.width, cavity.height, cavity.data));
  manifest.layers.push({
    id: cavityId,
    name: "mouth-cavity",
    path: [],
    src: "layers/cavity.png",
    x: Math.round(apMinX),
    y: Math.round(apMinY),
    width: cw,
    height: ch,
    opacity: 1,
    visible: true,
    order: 6,
    slot: "mouth_cavity",
    side: null,
    boneId: "b_head",
    mesh: aperture.id,
    clipTo: null,
    physics: null,
  });
  aperture.weights = aperture.vertices.map(() => ({ b_head: 1 }));
  rig.mouth.apertureLayer = cavityId;
  rig.mouth.apertureMesh = aperture.id;
}
manifest.rig = rig;

const bytes = writeOar({ manifest, pngs, thumbnail: null });
writeFileSync(join(root, "sample-avatar.oar"), bytes);
console.log(`wrote sample-avatar.oar (${(bytes.length / 1024).toFixed(1)} KB, ${manifest.layers.length} layers, ${manifest.bones.length} bones)`);
