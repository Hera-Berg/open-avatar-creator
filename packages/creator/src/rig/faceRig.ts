// Face rig construction (§10, §11, §16 step 4): trace lid contours from eye
// whites, build the mouth aperture mesh from lip inner edges, composite the
// inner mouth artwork into the cavity texture, record clipTo for irises.
// Everything derived here is written into the .oar so the studio never has
// to re-derive it from artwork it does not have.

import {
  deriveLidContour,
  buildApertureMesh,
  newId,
  emptyRig,
  type OarLayer,
  type OarManifest,
  type OarMesh,
  type OarRig,
  type PixelImage,
  type OarRigEye,
} from "@oar/core";

export interface FaceRigResult {
  rig: OarRig;
  meshes: OarMesh[];
  cavityLayer: OarLayer | null;
  cavityPixels: PixelImage | null;
  /** layer id -> clipTo id assignments to apply */
  clipAssignments: Map<string, string>;
  /** inner mouth layer ids consumed into the cavity (to be hidden) */
  consumedInner: string[];
  /** defaults the caller should apply when the rig params are unset */
  suggestedParams: Record<string, number>;
  warnings: string[];
}

function find(model: OarManifest, slot: string, side: "left" | "right"): OarLayer | undefined {
  return model.layers.find((l) => l.slot === slot && l.side === side);
}

function eyeSide(
  model: OarManifest,
  pixels: Map<string, PixelImage>,
  side: "left" | "right",
  warnings: string[],
): OarRigEye {
  const white = find(model, "eye_white", side);
  const iris = find(model, "iris", side);
  const shine = find(model, "eye_shine", side);
  const lashTop = find(model, "eyelash_top", side);
  const lashBottom = find(model, "eyelash_bottom", side);
  const closed = find(model, "eye_closed", side);

  const eye: OarRigEye = {
    white: white?.id ?? null,
    iris: iris?.id ?? null,
    shine: shine?.id ?? null,
    lashTop: lashTop?.id ?? null,
    lashBottom: lashBottom?.id ?? null,
    closed: closed?.id ?? null,
    lidContour: [],
    irisRange: [0, 0],
  };

  if (white) {
    const img = pixels.get(white.id);
    if (img) {
      // The lid contour IS the shape a closed eye should trace — it is the
      // natural lower boundary of that eye's own artwork.
      eye.lidContour = deriveLidContour(img, white.x, white.y);
    } else {
      warnings.push(`${side} eye white has no pixels — no lid contour`);
    }
    if (iris) {
      const roomX = Math.max(0, (white.width - iris.width) / 2 - 2);
      const roomY = Math.max(0, (white.height - iris.height) / 2 - 2);
      // Oversized clipped irises under-report their room (§10); fall back to
      // a share of the white so the iris can still reach the edge.
      eye.irisRange = [
        roomX > 0 ? roomX : white.width * 0.18,
        roomY > 0 ? roomY : white.height * 0.15,
      ];
    }
  } else {
    warnings.push(`${side} eye has no eye-white layer`);
  }
  return eye;
}

/** Composite the inner mouth layers (source-over, painter's order) into one
 *  cavity texture. */
function compositeInner(
  innerLayers: OarLayer[],
  pixels: Map<string, PixelImage>,
): { img: PixelImage; x: number; y: number } | null {
  if (innerLayers.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of innerLayers) {
    minX = Math.min(minX, l.x);
    minY = Math.min(minY, l.y);
    maxX = Math.max(maxX, l.x + l.width);
    maxY = Math.max(maxY, l.y + l.height);
  }
  const w = Math.max(1, Math.ceil(maxX - minX));
  const h = Math.max(1, Math.ceil(maxY - minY));
  const out = new Uint8ClampedArray(w * h * 4);
  const sorted = [...innerLayers].sort((a, b) => a.order - b.order);
  for (const layer of sorted) {
    const src = pixels.get(layer.id);
    if (!src) continue;
    const ox = Math.round(layer.x - minX);
    const oy = Math.round(layer.y - minY);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const si = (y * src.width + x) * 4;
        const sa = src.data[si + 3]! / 255;
        if (sa === 0) continue;
        const dx = ox + x;
        const dy = oy + y;
        if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
        const di = (dy * w + dx) * 4;
        const da = out[di + 3]! / 255;
        const oa = sa + da * (1 - sa);
        if (oa === 0) continue;
        out[di] = (src.data[si]! * sa + out[di]! * da * (1 - sa)) / oa;
        out[di + 1] = (src.data[si + 1]! * sa + out[di + 1]! * da * (1 - sa)) / oa;
        out[di + 2] = (src.data[si + 2]! * sa + out[di + 2]! * da * (1 - sa)) / oa;
        out[di + 3] = oa * 255;
      }
    }
  }
  return { img: { width: w, height: h, data: out }, x: minX, y: minY };
}

export function buildFaceRig(
  model: OarManifest,
  pixels: Map<string, PixelImage>,
): FaceRigResult {
  const warnings: string[] = [];
  const rig = emptyRig();
  const clipAssignments = new Map<string, string>();
  const meshes: OarMesh[] = [];
  const consumedInner: string[] = [];
  const suggestedParams: Record<string, number> = {};
  let cavityLayer: OarLayer | null = null;
  let cavityPixels: PixelImage | null = null;

  // Head centre/radius from the head artwork bbox.
  const headLayer = model.layers.find((l) => l.slot === "head");
  if (headLayer) {
    rig.head = {
      centre: [headLayer.x + headLayer.width / 2, headLayer.y + headLayer.height / 2],
      radius: [headLayer.width / 2, headLayer.height / 2],
    };
  } else {
    warnings.push("no head layer — head turn will not work");
  }

  rig.eyes.left = eyeSide(model, pixels, "left", warnings);
  rig.eyes.right = eyeSide(model, pixels, "right", warnings);

  // Runtime iris clipping: record clipTo, never bake (§5).
  for (const side of ["left", "right"] as const) {
    const eye = rig.eyes[side];
    if (eye.iris && eye.white) clipAssignments.set(eye.iris, eye.white);
    if (eye.shine && eye.white) clipAssignments.set(eye.shine, eye.white);
  }

  // Mouth.
  const upperLip = model.layers.find((l) => l.slot === "lip_upper");
  const lowerLip = model.layers.find((l) => l.slot === "lip_lower");
  const innerLayers = model.layers.filter((l) => l.slot === "mouth_inner");
  rig.mouth.upperLip = upperLip?.id ?? null;
  rig.mouth.lowerLip = lowerLip?.id ?? null;
  rig.mouth.inner = innerLayers.map((l) => l.id);

  if (upperLip && lowerLip) {
    const upperImg = pixels.get(upperLip.id);
    const lowerImg = pixels.get(lowerLip.id);
    const aperture =
      upperImg && lowerImg
        ? buildApertureMesh(
            newId("m"),
            upperImg,
            { x: upperLip.x, y: upperLip.y, width: upperLip.width, height: upperLip.height },
            lowerImg,
            { x: lowerLip.x, y: lowerLip.y, width: lowerLip.width, height: lowerLip.height },
          )
        : null;

    if (aperture) {
      // Cavity texture: the FULL inner-mouth composite. The aperture mesh
      // samples it by canvas position — as the mouth opens, the stretching
      // triangles reveal the teeth and tongue inside the opening (upper
      // teeth ride with the upper lip). Sizing the texture to the tiny
      // rest-gap bbox instead would discard nearly all the artwork and
      // stretch a 5px sliver into a blurry slab.
      const composite = compositeInner(innerLayers, pixels);
      const apBox = (() => {
        const xs = aperture.vertices.map((v) => v[0]);
        const ys = aperture.vertices.map((v) => v[1]);
        return {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        };
      })();
      const pad = 2;
      // The cavity rect covers both the aperture and the inner-mouth art.
      const rectX0 = composite ? Math.min(apBox.x, composite.x) : apBox.x;
      const rectY0 = composite ? Math.min(apBox.y, composite.y) : apBox.y;
      const rectX1 = composite ? Math.max(apBox.x + apBox.w, composite.x + composite.img.width) : apBox.x + apBox.w;
      const rectY1 = composite ? Math.max(apBox.y + apBox.h, composite.y + composite.img.height) : apBox.y + apBox.h;
      const cw = Math.max(2, Math.ceil(rectX1 - rectX0) + pad * 2);
      const ch = Math.max(2, Math.ceil(rectY1 - rectY0) + pad * 2);
      const cx0 = rectX0 - pad;
      const cy0 = rectY0 - pad;
      let cavityImg: PixelImage;
      const fillCavityBase = (img: PixelImage) => {
        // Dark mouth interior with a vertical gradient (lighter near the
        // teeth, darker toward the back) so it reads as depth, not a sticker.
        for (let y = 0; y < img.height; y++) {
          const t = y / Math.max(1, img.height - 1);
          const r = Math.round(92 - 48 * t);
          const g = Math.round(40 - 24 * t);
          const b = Math.round(44 - 24 * t);
          for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            img.data[i] = r;
            img.data[i + 1] = g;
            img.data[i + 2] = b;
            img.data[i + 3] = 255;
          }
        }
      };
      if (composite) {
        cavityImg = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) };
        fillCavityBase(cavityImg);
        // Paste the composite over it (simple alpha-over).
        const src = composite.img;
        const ox = Math.round(composite.x - cx0);
        const oy = Math.round(composite.y - cy0);
        for (let y = 0; y < src.height; y++) {
          for (let x = 0; x < src.width; x++) {
            const si = (y * src.width + x) * 4;
            const sa = src.data[si + 3]! / 255;
            if (sa === 0) continue;
            const dx = ox + x;
            const dy = oy + y;
            if (dx < 0 || dy < 0 || dx >= cw || dy >= ch) continue;
            const di = (dy * cw + dx) * 4;
            const da = cavityImg.data[di + 3]! / 255;
            const oa = sa + da * (1 - sa);
            cavityImg.data[di] = (src.data[si]! * sa + cavityImg.data[di]! * da * (1 - sa)) / oa;
            cavityImg.data[di + 1] = (src.data[si + 1]! * sa + cavityImg.data[di + 1]! * da * (1 - sa)) / oa;
            cavityImg.data[di + 2] = (src.data[si + 2]! * sa + cavityImg.data[di + 2]! * da * (1 - sa)) / oa;
            cavityImg.data[di + 3] = oa * 255;
          }
        }
      } else {
        cavityImg = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) };
        fillCavityBase(cavityImg);
        warnings.push("no inner mouth artwork — using a plain cavity colour");
      }
      // Fade the cavity texture's alpha fully to zero by the outer 15% at
      // each side — nothing, however the corner taper is tuned, can ever
      // render as a dark needle past the lip outline.
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const u = x / Math.max(1, cw - 1);
          const edge = Math.min(u, 1 - u);
          const k = edge >= 0.15 ? 1 : (edge / 0.15) * (edge / 0.15);
          cavityImg.data[(y * cw + x) * 4 + 3] = Math.round(cavityImg.data[(y * cw + x) * 4 + 3]! * k);
        }
      }
      // UVs stay PARAMETRIC (v=0 at the upper lip edge, v=1 at the lower)
      // exactly as buildApertureMesh emitted them. The v axis spans the
      // inner-mouth texture from teeth (top) to tongue/back (bottom), so as
      // the aperture stretches open, the teeth ride with the upper lip.
      // Mapping UVs to rest canvas positions instead would keep sampling the
      // same 2px band of texture no matter how far the mouth opens.
      meshes.push(aperture);
      cavityPixels = cavityImg;
      const maxOrder = Math.max(...model.layers.map((l) => l.order), 0);
      // Behind BOTH lips, or the slab covers the lower lip whenever the two
      // lips are not adjacent in the stack.
      const behindLips = Math.min(upperLip.order, lowerLip.order) - 0.5;
      cavityLayer = {
        id: newId("l"),
        name: "mouth-cavity",
        path: [],
        src: "layers/cavity.png",
        x: Math.round(cx0),
        y: Math.round(cy0),
        width: cw,
        height: ch,
        opacity: 1,
        visible: true,
        // Just below the lips so they cover the aperture's edges.
        order: upperLip ? behindLips : maxOrder + 1,
        slot: "mouth_cavity",
        side: null,
        boneId: upperLip?.boneId ?? null,
        mesh: aperture.id,
        clipTo: null,
        physics: null,
      };
      rig.mouth.apertureLayer = cavityLayer.id;
      rig.mouth.apertureMesh = aperture.id;
      consumedInner.push(...innerLayers.map((l) => l.id));
      // Default mouth ranges from lip heights (caller applies them via
      // commands so undo stays coherent).
      suggestedParams.mouthRangeUpper = Math.max(12, upperLip.height * 0.9);
      suggestedParams.mouthRangeLower = Math.max(18, lowerLip.height * 0.9);
    } else {
      warnings.push(
        "lip inner edges could not be traced — falling back to cavity scaling (§11)",
      );
      if (upperLip && lowerLip) {
        rig.mouth.restGap = Math.max(
          0,
          lowerLip.y - (upperLip.y + upperLip.height),
        );
      }
    }
  } else {
    warnings.push("mouth lips are not both present — mouth rig skipped");
  }

  return {
    rig,
    meshes,
    cavityLayer,
    cavityPixels,
    clipAssignments,
    consumedInner,
    suggestedParams,
    warnings,
  };
}
