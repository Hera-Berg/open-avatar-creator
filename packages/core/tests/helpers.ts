import type { PixelImage } from "../src/geometry/pixels";
import {
  emptyManifest,
  type OarBone,
  type OarLayer,
  type OarManifest,
} from "../src/model/types";

export function solidImage(
  width: number,
  height: number,
  alpha = 255,
  rgba: [number, number, number] = [255, 255, 255],
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}

/** Opaque only within a rect inside the image. */
export function rectImage(
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
): PixelImage {
  const img = solidImage(width, height, 0);
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = (y * width + x) * 4 + 3;
      img.data[i] = 255;
    }
  }
  return img;
}

/** Ellipse-ish blob (filled circle). */
export function blobImage(width: number, height: number, radius: number): PixelImage {
  const img = solidImage(width, height, 0);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) {
        img.data[(y * width + x) * 4 + 3] = 255;
      }
    }
  }
  return img;
}

let idCounter = 0;
export function testId(prefix: string): string {
  return `${prefix}_t${++idCounter}`;
}

export function makeBone(
  name: string,
  headY: number,
  follow: number,
  parentId: string | null,
  x = 0,
): OarBone {
  return {
    id: testId("b"),
    name,
    parentId,
    head: [x, headY],
    tail: [x, headY - 100],
    locked: false,
    follow,
    rotation: 0,
  };
}

/** The reference spine from the build spec §16. */
export function makeSpine(): OarBone[] {
  const root = makeBone("root", 1000, 0.0, null);
  const hips = makeBone("hips", 900, -0.09, root.id);
  const torso = makeBone("torso", 700, 0.1, hips.id);
  const chest = makeBone("chest", 500, 0.36, torso.id);
  const neck = makeBone("neck", 400, 0.64, chest.id);
  const head = makeBone("head", 300, 1.0, neck.id);
  return [root, hips, torso, chest, neck, head];
}

export function makeLayer(overrides: Partial<OarLayer>): OarLayer {
  return {
    id: testId("l"),
    name: "layer",
    path: [],
    src: "layers/x.png",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    visible: true,
    order: 0,
    slot: null,
    side: null,
    boneId: null,
    mesh: null,
    clipTo: null,
    physics: null,
    ...overrides,
  };
}

export function makeModel(overrides: Partial<OarManifest>): OarManifest {
  const m = emptyManifest("test", { width: 1000, height: 1000 });
  return { ...m, ...overrides };
}

/** Minimal valid PNG header (signature + IHDR length/type + dims). */
export function fakePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
