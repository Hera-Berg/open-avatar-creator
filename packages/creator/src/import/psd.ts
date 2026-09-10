// PSD import (§5). The sharp edges, each one a real failure on real files:
//
// - Raw layer pixels ignore masks: composite the mask into alpha ourselves.
// - Layers with no pixels of their own (fills, adjustments, text) are
//   skipped and reported, never crashed on.
// - Clipping masks are baked — EXCEPT on layers the rig moves independently
//   (the iris): those record clipTo and clip at render time, or the iris
//   freezes in the shape of the eye at rest.
// - Hidden groups are descended into ALWAYS; hidden layers are kept only
//   when their name classifies to a rig slot. Rigs ship with mouth and blink
//   artwork switched off.
// - Process order: mask → clip → crop at FULL resolution → downscale →
//   1px transparent margin. Cropping after downscale leaves box-filter
//   halos; thresholding alpha to remove halos destroys translucent artwork.
// - One layer at a time, released after processing: decode everything first
//   and the tab dies on a 200-layer print-resolution file.

import { readPsd, type Layer } from "ag-psd";
import {
  alphaBBox,
  applyMask,
  bakeClip,
  clamp,
  cropPixels,
  padPixels,
  newId,
  emptyManifest,
  type OarManifest,
  type OarLayer,
  type PixelImage,
} from "@oar/core";
import { classifyLayer } from "./classify";

export interface ImportOptions {
  targetSize: number; // longest edge, px (1024 / 2048 / 4096)
}

export interface SkippedLayer {
  name: string;
  reason: string;
}

export interface ImportReport {
  imported: { name: string; slot: string | null }[];
  recognised: number;
  unrecognised: string[];
  recoveredHidden: string[];
  skipped: SkippedLayer[];
  bakedClips: string[];
  runtimeClips: string[];
  missingCoreSlots: string[];
  scale: number;
}

export interface ImportResult {
  manifest: OarManifest;
  /** layer id -> straight-alpha pixels (post-margin, at export resolution) */
  pixels: Map<string, PixelImage>;
  report: ImportReport;
}

/** Slots that move independently of their clip base: runtime clip (§5). */
const RUNTIME_CLIP_SLOTS = new Set(["iris", "eye_shine"]);

const CORE_SLOTS: [string, string][] = [
  ["head", "head"],
  ["eye_white", "eye white"],
  ["eyelash_top", "eyelashes"],
  ["lip_upper", "upper lip"],
  ["lip_lower", "lower lip"],
];

function toPixels(imageData: { data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array; width: number; height: number }): PixelImage {
  let data: Uint8ClampedArray;
  if (imageData.data instanceof Uint8ClampedArray) {
    data = imageData.data;
  } else if (imageData.data instanceof Uint8Array) {
    data = new Uint8ClampedArray(imageData.data.buffer.slice(0));
  } else {
    // 16/32-bit sources: normalise to 8-bit.
    data = new Uint8ClampedArray(imageData.data.length);
    for (let i = 0; i < imageData.data.length; i++) {
      data[i] = Math.min(255, Math.round(imageData.data[i]! / 257));
    }
  }
  return { width: imageData.width, height: imageData.height, data };
}

function downscalePixels(img: PixelImage, scale: number): PixelImage {
  if (scale >= 0.999) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const src = document.createElement("canvas");
  src.width = img.width;
  src.height = img.height;
  const sctx = src.getContext("2d")!;
  sctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;
  const dctx = dst.getContext("2d")!;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = "high";
  dctx.drawImage(src, 0, 0, w, h);
  const out = dctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: out.data };
}

interface Planned {
  layer: Layer;
  path: string[];
  slot: string | null;
  side: "left" | "right" | "middle" | null;
  hiddenRecovered: boolean;
  clipBase: Layer | null;
  runtimeClip: boolean;
}

export async function importPsd(
  buffer: ArrayBuffer,
  name: string,
  opts: ImportOptions,
  onProgress: (current: string, done: number, total: number) => void,
): Promise<ImportResult> {
  const psd = readPsd(buffer, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const scale = Math.min(1, opts.targetSize / Math.max(psd.width, psd.height));
  const report: ImportReport = {
    imported: [],
    recognised: 0,
    unrecognised: [],
    recoveredHidden: [],
    skipped: [],
    bakedClips: [],
    runtimeClips: [],
    missingCoreSlots: [],
    scale,
  };

  // ---- plan: walk groups, classify, resolve clip bases ----------------
  // ag-psd children are BOTTOM-FIRST (its reader unshifts file records into
  // children): children[0] is the furthest back. Painter's order is the walk
  // order; the clip base of a clipped layer is the nearest non-clipping
  // sibling BELOW it — an earlier sibling in this order.
  const planned: Planned[] = [];
  const walk = (layers: Layer[], path: string[], groupHidden: boolean) => {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      const layerName = layer.name ?? "layer";
      const isGroup = !!layer.children;
      const hidden = groupHidden || !!layer.hidden;
      if (isGroup) {
        // Descend into hidden groups ALWAYS. Empty groups are fine.
        walk(layer.children!, [...path, layerName], hidden);
        continue;
      }
      const cls = classifyLayer(layerName, path);
      if (cls.drop) {
        report.skipped.push({ name: layerName, reason: `tagged "${cls.matched}"` });
        continue;
      }
      if (hidden && !cls.slot) {
        report.skipped.push({ name: layerName, reason: "hidden, no rig slot" });
        continue;
      }
      if (!layer.imageData || layer.imageData.width === 0 || layer.imageData.height === 0) {
        report.skipped.push({ name: layerName, reason: "no pixels of its own (fill/adjustment/text)" });
        continue;
      }
      let clipBase: Layer | null = null;
      if (layer.clipping) {
        for (let j = i - 1; j >= 0; j--) {
          const candidate = layers[j]!;
          if (!candidate.clipping && candidate.imageData) {
            clipBase = candidate;
            break;
          }
        }
      }
      const runtimeClip = !!clipBase && !!cls.slot && RUNTIME_CLIP_SLOTS.has(cls.slot);
      planned.push({
        layer,
        path,
        slot: cls.slot,
        side: cls.side,
        hiddenRecovered: hidden,
        clipBase,
        runtimeClip,
      });
    }
  };
  walk(psd.children ?? [], [], false);

  // ---- process: one layer at a time, released after use ----------------
  const manifest = emptyManifest(name.replace(/\.psd$/i, ""), {
    width: Math.round(psd.width * scale),
    height: Math.round(psd.height * scale),
  });
  const pixels = new Map<string, PixelImage>();
  const entryByLayer = new Map<Layer, { planned: Planned; layer: OarLayer; fullPixels: PixelImage; fullX: number; fullY: number }>();
  const total = planned.length;

  // Painter's order: last sibling (bottom of the stack) is furthest back.
  for (let k = 0; k < planned.length; k++) {
    const p = planned[k]!;
    const layerName = p.layer.name ?? "layer";
    onProgress(layerName, k, total);
    const full = toPixels(p.layer.imageData!);
    const fullX = p.layer.left ?? 0;
    const fullY = p.layer.top ?? 0;

    // 1. apply layer mask
    if (p.layer.mask?.imageData) {
      const mask = toPixels(p.layer.mask.imageData);
      const maskX = p.layer.mask.positionRelativeToLayer ? 0 : (p.layer.mask.left ?? 0) - fullX;
      const maskY = p.layer.mask.positionRelativeToLayer ? 0 : (p.layer.mask.top ?? 0) - fullY;
      applyMask(full, mask, maskX, maskY);
    }

    // Defer crop/downscale until clip baking below (needs full-res pixels).
    // Yield so the progress bar paints and the tab stays responsive.
    entryByLayer.set(p.layer, { planned: p, layer: null as unknown as OarLayer, fullPixels: full, fullX, fullY });
    if (k % 5 === 4) await new Promise((r) => setTimeout(r, 0));
  }

  // 2. apply or record clipping masks (needs the base layer's full pixels)
  for (const entry of entryByLayer.values()) {
    const p = entry.planned;
    if (!p.clipBase || p.runtimeClip) continue;
    const base = entryByLayer.get(p.clipBase);
    if (base) {
      bakeClip(entry.fullPixels, entry.fullX, entry.fullY, base.fullPixels, base.fullX, base.fullY);
      report.bakedClips.push(p.layer.name ?? "layer");
    }
  }

  // 3+4+5: crop at full resolution, downscale, margin — then drop the big one.
  // Walk order is already back-to-front (ag-psd children are bottom-first).
  let order = 0;
  for (const entry of entryByLayer.values()) {
    const p = entry.planned;
    const layerName = p.layer.name ?? "layer";
    const box = alphaBBox(entry.fullPixels);
    const id = newId("l");
    if (!box) {
      report.skipped.push({ name: layerName, reason: "fully transparent after mask/clip" });
      continue;
    }
    const cropped = cropPixels(entry.fullPixels, box);
    entry.fullPixels = null as unknown as PixelImage; // release the full-res copy
    const scaled = downscalePixels(cropped, scale);
    const padded = padPixels(scaled, 1);

    const layer: OarLayer = {
      id,
      name: layerName,
      path: p.path,
      src: `layers/${String(order).padStart(3, "0")}_${layerName.replace(/[^\p{L}\p{N}_-]/gu, "_")}.png`,
      x: Math.round((entry.fullX + box.x) * scale) - 1,
      y: Math.round((entry.fullY + box.y) * scale) - 1,
      width: padded.width,
      height: padded.height,
      // ag-psd normalizes layer opacity to 0..1 — dividing again by 255
      // makes every layer invisible.
      opacity: clamp(p.layer.opacity ?? 1, 0, 1),
      visible: true,
      order: order++,
      slot: p.slot,
      side: p.side,
      boneId: null,
      mesh: null,
      clipTo: null, // resolved below
      physics: null,
    };
    manifest.layers.push(layer);
    pixels.set(id, padded);
    entry.layer = layer;
    report.imported.push({ name: layerName, slot: p.slot });
    if (p.slot) report.recognised++;
    else report.unrecognised.push(layerName);
    if (p.hiddenRecovered) report.recoveredHidden.push(layerName);
  }

  // Resolve runtime clipTo references to layer ids.
  for (const entry of entryByLayer.values()) {
    const p = entry.planned;
    if (!p.runtimeClip || !p.clipBase || !entry.layer) continue;
    const base = entryByLayer.get(p.clipBase);
    if (base?.layer) {
      entry.layer.clipTo = base.layer.id;
      report.runtimeClips.push(entry.layer.name);
    }
  }

  // Missing core slots must be visible immediately, not discovered on camera.
  const haveSlots = new Set(manifest.layers.map((l) => l.slot).filter(Boolean));
  for (const [slot, label] of CORE_SLOTS) {
    if (!haveSlots.has(slot)) report.missingCoreSlots.push(label);
  }

  onProgress("done", total, total);
  return { manifest, pixels, report };
}
