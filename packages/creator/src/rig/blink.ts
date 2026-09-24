// Blink keyform generation for the editor. Gives every eye layer an explicit
// mesh (so it is editable with the vertex tools), then writes the Live2D
// blink as ordinary keyforms on eye_l_open / eye_r_open. Re-running replaces
// only the blink keyforms of those eye layers.

import {
  buildBlinkKeyforms,
  blinkLayerIds,
  clamp,
  deriveLashLowerEdge,
  newId,
  rigParam,
  subdivideQuad,
  type OarKeyform,
  type OarLayer,
  type OarManifest,
  type OarMesh,
  type OarRig,
  type PixelImage,
} from "@oar/core";
import { addKeyform, addMesh, deleteKeyform } from "../state/ops";
import type { Command } from "../state/undo";

const EYE_PARAMS = { left: "eye_l_open", right: "eye_r_open" } as const;

/** Eye-part grid: a column every ~8px so the lid arc bends smoothly, a row
 *  every ~5px so the white folds without smearing its texture. */
export function eyeGridMesh(layer: OarLayer, headBoneId: string | null): OarMesh {
  const cols = clamp(Math.round(layer.width / 8), 8, 64);
  const rows = clamp(Math.round(layer.height / 5), 6, 32);
  const mesh = subdivideQuad(newId("m"), layer.x, layer.y, layer.width, layer.height, cols, rows);
  mesh.weights = mesh.vertices.map(() => (headBoneId ? { [headBoneId]: 1 } : {}));
  return mesh;
}

export interface BlinkBuild {
  cmds: Command[];
  keyforms: OarKeyform[];
  warnings: string[];
}

/**
 * Commands that (re)build the blink keyforms for both eyes.
 * `rig` is passed explicitly because auto-rig computes it before its own
 * commands have been applied to the model.
 */
export function buildBlinkCommands(
  model: OarManifest,
  pixels: Map<string, PixelImage>,
  rig: OarRig,
  headBoneId: string | null,
): BlinkBuild {
  const cmds: Command[] = [];
  const warnings: string[] = [];
  const keyforms: OarKeyform[] = [];
  // Planned state: layers/meshes as they will be once the mesh commands run.
  const layers = new Map(model.layers.map((l) => [l.id, { ...l }]));
  const meshes = new Map(model.meshes.map((m) => [m.id, m]));

  for (const side of ["left", "right"] as const) {
    const eye = rig.eyes[side];
    const param = EYE_PARAMS[side];
    if (!eye.white && !eye.lashTop) continue;

    // Every eye layer gets a mesh: parts that deform need vertices, and the
    // iris/shine need one so an artist can add keys to them later.
    for (const id of blinkLayerIds(eye)) {
      const layer = layers.get(id);
      if (!layer || (layer.mesh && meshes.has(layer.mesh))) continue;
      const mesh = eyeGridMesh(layer, headBoneId ?? layer.boneId);
      cmds.push(addMesh(mesh, id));
      meshes.set(mesh.id, mesh);
      layer.mesh = mesh.id;
    }

    // Replace this eye's previous blink keyforms (other parameters stay).
    const ids = new Set(blinkLayerIds(eye));
    for (const old of model.keyforms) {
      if (old.param === param && ids.has(old.layerId)) {
        const del = deleteKeyform(old.id);
        if (del) cmds.push(del);
      }
    }

    const lash = eye.lashTop ? layers.get(eye.lashTop) : undefined;
    const lashImg = eye.lashTop ? pixels.get(eye.lashTop) : undefined;
    const lashLower = lash && lashImg ? deriveLashLowerEdge(lashImg, lash.x, lash.y) : null;
    if (eye.lashTop && !lashLower) warnings.push(`${side} lash: no pixels, blink uses the layer box`);
    if (eye.lidContour.length < 2) warnings.push(`${side} eye: no lid contour, blink closes to the white's box`);

    const built = buildBlinkKeyforms({
      eye,
      param,
      layers,
      meshes,
      lashLower,
      invert: rigParam(model.params, "lashInvert"),
    });
    for (const kf of built) cmds.push(addKeyform(kf));
    keyforms.push(...built);
  }
  return { cmds, keyforms, warnings };
}
