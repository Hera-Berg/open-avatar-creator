// Creates public/test.psd — a synthetic PSD exercising the features that
// break real imports: groups, a hidden group, a layer mask, a clipping mask,
// and a [DELETE]-tagged layer. Run: node scripts/make-test-psd.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writePsd } = require("ag-psd");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function solid(w, h, rgba) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width: w, height: h, data };
}

function circle(w, h, rgba) {
  const data = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) {
        const i = (y * w + x) * 4;
        data[i] = rgba[0];
        data[i + 1] = rgba[1];
        data[i + 2] = rgba[2];
        data[i + 3] = rgba[3];
      }
    }
  }
  return { width: w, height: h, data };
}

const layer = (name, left, top, right, bottom, imageData, extra = {}) => ({
  name,
  left,
  top,
  right,
  bottom,
  imageData,
  ...extra,
});

const psd = {
  width: 800,
  height: 600,
  children: [
    layer("Background [DELETE]", 0, 0, 800, 600, solid(800, 600, [10, 10, 10, 255])),
    {
      name: "Head",
      children: [
        layer("head", 300, 150, 500, 400, circle(200, 250, [242, 205, 178, 255])),
        {
          name: "Eyes",
          children: [
            {
              name: "Left Eye",
              // ag-psd children are bottom-first: the eye white is below the
              // iris, which clips to it.
              children: [
                layer("eye-white-left", 380, 240, 460, 270, solid(80, 30, [250, 250, 250, 255])),
                layer("iris-left", 395, 238, 435, 278, circle(40, 40, [86, 156, 214, 255]), {
                  clipping: true,
                }),
              ],
            },
          ],
        },
        // Hidden group that must be descended into.
        {
          name: "Inner Mouth",
          hidden: true,
          children: [layer("Tongue", 350, 300, 450, 340, solid(100, 40, [180, 60, 80, 255]))],
        },
      ],
    },
    {
      name: "Body",
      children: [
        // Layer with a mask: right half should be masked out.
        layer("torso", 250, 420, 550, 590, solid(300, 170, [222, 118, 118, 255]), {
          mask: {
            left: 250,
            top: 420,
            right: 400,
            bottom: 590,
            imageData: solid(150, 170, [255, 255, 255, 255]),
          },
        }),
      ],
    },
  ],
};

const buf = writePsd(psd, {});
writeFileSync(join(root, "packages/creator/public/test.psd"), Buffer.from(buf));
console.log(`wrote packages/creator/public/test.psd (${(buf.byteLength / 1024).toFixed(1)} KB)`);
