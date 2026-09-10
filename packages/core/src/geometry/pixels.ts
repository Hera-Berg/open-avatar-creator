// DOM-free pixel helpers operating on straight (non-premultiplied) RGBA data.
// Used by PSD import, texture-margin checks, lid/lip tracing and tests.

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, straight alpha
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Exact bounding box of pixels with alpha above `threshold`. Runs at full
 *  resolution where transparent regions are exactly zero — cropping after
 *  downscale leaves box-filter halos. Never threshold alpha to "fix" halos. */
export function alphaBBox(img: PixelImage, threshold = 0): BBox | null {
  const { width, height, data } = img;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function cropPixels(img: PixelImage, box: BBox): PixelImage {
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const srcStart = ((box.y + y) * img.width + box.x) * 4;
    out.set(img.data.subarray(srcStart, srcStart + box.width * 4), y * box.width * 4);
  }
  return { width: box.width, height: box.height, data: out };
}

/** 1px transparent margin, applied after all trimming/merging. Without it
 *  CLAMP_TO_EDGE stretches the opaque edge texel into a seam. */
export function padPixels(img: PixelImage, margin = 1): PixelImage {
  const w = img.width + margin * 2;
  const h = img.height + margin * 2;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < img.height; y++) {
    const srcStart = y * img.width * 4;
    out.set(
      img.data.subarray(srcStart, srcStart + img.width * 4),
      ((y + margin) * w + margin) * 4,
    );
  }
  return { width: w, height: h, data: out };
}

/** Composite a grayscale layer mask into the layer's alpha. Mask may have its
 *  own rect (masks can be smaller than the layer); outside it, alpha is 0
 *  unless defaultValue says otherwise (PSD masks default to 255 outside? No —
 *  a layer mask confines the layer, so outside the mask rect alpha is 0). */
export function applyMask(
  img: PixelImage,
  mask: PixelImage,
  maskOffsetX = 0,
  maskOffsetY = 0,
): void {
  for (let y = 0; y < img.height; y++) {
    const my = y - maskOffsetY;
    for (let x = 0; x < img.width; x++) {
      const mx = x - maskOffsetX;
      let m = 0;
      if (mx >= 0 && my >= 0 && mx < mask.width && my < mask.height) {
        m = mask.data[(my * mask.width + mx) * 4]!; // red channel = grayscale
      }
      const i = (y * img.width + x) * 4 + 3;
      img.data[i] = Math.round((img.data[i]! * m) / 255);
    }
  }
}

/** Bake a clipping mask: multiply the clipped layer's alpha by the base
 *  layer's alpha over their intersection; zero outside it. Both rects are in
 *  the same (canvas) space via the offsets provided by the caller. */
export function bakeClip(
  clipped: PixelImage,
  clippedOffsetX: number,
  clippedOffsetY: number,
  base: PixelImage,
  baseOffsetX: number,
  baseOffsetY: number,
): void {
  for (let y = 0; y < clipped.height; y++) {
    for (let x = 0; x < clipped.width; x++) {
      const bx = clippedOffsetX + x - baseOffsetX;
      const by = clippedOffsetY + y - baseOffsetY;
      let a = 0;
      if (bx >= 0 && by >= 0 && bx < base.width && by < base.height) {
        a = base.data[(by * base.width + bx) * 4 + 3]!;
      }
      const i = (y * clipped.width + x) * 4 + 3;
      clipped.data[i] = Math.round((clipped.data[i]! * a) / 255);
    }
  }
}

/** True when every border pixel is fully transparent (texture margin test). */
export function hasTransparentBorder(img: PixelImage, margin = 1): boolean {
  const { width, height, data } = img;
  for (let m = 0; m < margin; m++) {
    for (let x = 0; x < width; x++) {
      for (const y of [m, height - 1 - m]) {
        if (data[(y * width + x) * 4 + 3] !== 0) return false;
      }
    }
    for (let y = 0; y < height; y++) {
      for (const x of [m, width - 1 - m]) {
        if (data[(y * width + x) * 4 + 3] !== 0) return false;
      }
    }
  }
  return true;
}
