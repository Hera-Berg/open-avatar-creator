// Auto-rig (§16). Not a separate pipeline: it runs the same operations the
// user performs by hand and produces ordinary, editable output. Re-runnable
// with per-part checkboxes so hand edits survive regeneration.

import {
  clamp,
  newId,
  generateMesh,
  subdivideQuad,
  spineWeights,
  type OarBone,
  type OarLayer,
  type OarManifest,
  type OarPhysics,
  type PixelImage,
  type Vec2,
} from "@oar/core";
import { classifyLayer } from "../import/classify";
import { buildFaceRig, type FaceRigResult } from "../rig/faceRig";
import {
  addLayer,
  addMesh,
  bindLayers,
  composite,
  setLayerField,
  setPhysics,
  setRig,
  setRigParam,
} from "../state/ops";
import { makeCommand, type Command } from "../state/undo";

type Commandish = Command;

export interface AutoRigOptions {
  classify: boolean;
  skeleton: boolean;
  bindings: boolean;
  meshes: boolean;
  physics: boolean;
  face: boolean;
}

export interface AutoRigResult {
  cmd: Commandish;
  cavityPixels: PixelImage | null;
  warnings: string[];
  faceRig: FaceRigResult | null;
}

// §16 step 2 — the spine table. The negative hips value is the whole
// S-curve: shoulders one way, hips the other. Clamp follow to [-1, 1].
const SPINE_TABLE: { name: string; follow: number }[] = [
  { name: "root", follow: 0.0 },
  { name: "hips", follow: -0.09 },
  { name: "torso", follow: 0.1 },
  { name: "chest", follow: 0.36 },
  { name: "neck", follow: 0.64 },
  { name: "head", follow: 1.0 },
];

const BODY_SLOTS = new Set([
  "torso",
  "chest",
  "chest_accessory",
  "hips",
  "skirt",
  "neck",
  "leg",
  "arm",
]);

const HEAD_SLOTS = new Set([
  "head",
  "nose",
  "blush",
  "eye_white",
  "iris",
  "eye_shine",
  "eyelash_top",
  "eyelash_bottom",
  "eye_closed",
  "eyebrow",
  "ear_fox",
  "lip_upper",
  "lip_lower",
  "mouth_inner",
  // Hair is bound to the head bone so it rolls with the head; physics sway
  // composes on top of the bone transform.
  "hair_front",
  "hair_middle",
  "hair_back",
  "hair_side",
]);

// §16 step 5 — physics defaults per slot family.
const PHYSICS_DEFAULTS: Record<string, Omit<OarPhysics, "enabled" | "customPivot">> = {
  hair_back: { stiffness: 5.0, damping: 0.86, maxAngle: 16, inertia: 1.0, gravity: 0.5, pivot: "top" },
  hair_side: { stiffness: 6.5, damping: 0.84, maxAngle: 13, inertia: 1.0, gravity: 0.5, pivot: "top" },
  hair_front: { stiffness: 9.0, damping: 0.8, maxAngle: 7, inertia: 0.8, gravity: 0.4, pivot: "top" },
  ear_fox: { stiffness: 8.0, damping: 0.78, maxAngle: 12, inertia: 1.0, gravity: 0.2, pivot: "bottom" },
  chest: { stiffness: 7.0, damping: 0.74, maxAngle: 5, inertia: 0.9, gravity: 0.6, pivot: "top" },
  chest_accessory: { stiffness: 11.0, damping: 0.7, maxAngle: 3, inertia: 0.35, gravity: 0.4, pivot: "top" },
};

export function buildSpine(model: OarManifest): OarBone[] {
  const layerBySlot = (slot: string) => model.layers.find((l) => l.slot === slot);
  const bottomOf = (l: OarLayer | undefined) => (l ? l.y + l.height : undefined);
  const topOf = (l: OarLayer | undefined) => (l ? l.y : undefined);

  const bodyLayers = model.layers.filter((l) => l.slot && BODY_SLOTS.has(l.slot));
  const lowestBodyBottom =
    bodyLayers.length > 0
      ? Math.max(...bodyLayers.map((l) => l.y + l.height))
      : model.canvas.height * 0.9;

  const known: (number | undefined)[] = [
    lowestBodyBottom, // root
    bottomOf(layerBySlot("hips")),
    bottomOf(layerBySlot("torso")),
    bottomOf(layerBySlot("chest")),
    bottomOf(layerBySlot("neck")),
    topOf(layerBySlot("neck")),
  ];
  // Fill missing pivot heights by even interpolation between the nearest
  // known bones either side.
  const ys: number[] = known.map((v, i) => {
    if (v !== undefined) return v;
    let lo = -1;
    let hi = -1;
    for (let j = i - 1; j >= 0; j--) if (known[j] !== undefined) { lo = j; break; }
    for (let j = i + 1; j < known.length; j++) if (known[j] !== undefined) { hi = j; break; }
    if (lo < 0 && hi < 0) return model.canvas.height - i * 100;
    if (lo < 0) return known[hi]! + (hi - i) * 120;
    if (hi < 0) return known[lo]! - (i - lo) * 120;
    const t = (i - lo) / (hi - lo);
    return known[lo]! + (known[hi]! - known[lo]!) * t;
  });
  // Pivot y must be non-increasing from root to head (root is the lowest).
  for (let i = 1; i < ys.length; i++) {
    ys[i] = Math.min(ys[i]!, ys[i - 1]!);
  }

  const headLayer = layerBySlot("head");
  const x = headLayer ? headLayer.x + headLayer.width / 2 : model.canvas.width / 2;

  const bones: OarBone[] = [];
  for (let i = 0; i < SPINE_TABLE.length; i++) {
    const head: Vec2 = [x, ys[i]!];
    // Tail points toward the next bone up (the head bone points straight up).
    const tailY = i + 1 < ys.length ? ys[i + 1]! : ys[i]! - Math.max(60, (ys[i - 1] ?? ys[i]! + 200) - ys[i]!);
    bones.push({
      id: newId("b"),
      name: SPINE_TABLE[i]!.name,
      parentId: i === 0 ? null : bones[i - 1]!.id,
      head,
      tail: [x, tailY],
      locked: false,
      follow: clamp(SPINE_TABLE[i]!.follow, -1, 1),
      rotation: 0,
    });
  }
  return bones;
}

export function runAutoRig(
  model: OarManifest,
  pixels: Map<string, PixelImage>,
  options: AutoRigOptions,
): AutoRigResult {
  const warnings: string[] = [];
  const cmds: Commandish[] = [];
  let faceRig: FaceRigResult | null = null;
  let cavityPixels: PixelImage | null = null;

  // ---- step 1: classify ------------------------------------------------
  if (options.classify) {
    for (const layer of model.layers) {
      const cx = layer.x + layer.width / 2;
      const half = cx >= model.canvas.width / 2 ? "left" : "right";
      const cls = classifyLayer(layer.name, layer.path, half);
      if (cls.slot && (cls.slot !== layer.slot || cls.side !== layer.side)) {
        cmds.push(setLayerField(layer.id, "slot", cls.slot, `classify ${layer.name}`));
        cmds.push(setLayerField(layer.id, "side", cls.side, `classify ${layer.name}`));
      }
    }
  }

  // ---- step 2: spine ---------------------------------------------------
  let spine: OarBone[] = [];
  const spineByName = new Map<string, OarBone>();
  if (options.skeleton) {
    // Remove previous auto-rig spine bones by name.
    const doomed = model.bones.filter((b) => SPINE_TABLE.some((s) => s.name === b.name));
    for (const bone of doomed) {
      cmds.push(
        makeCommand({
          label: `remove ${bone.name}`,
          apply: (m) => {
            m.bones = m.bones.filter((b) => b.id !== bone.id);
          },
          revert: (m) => {
            m.bones.push(JSON.parse(JSON.stringify(bone)) as OarBone);
          },
        }),
      );
    }
    spine = buildSpine(model);
    for (const bone of spine) {
      cmds.push(
        makeCommand({
          label: `add ${bone.name}`,
          apply: (m) => {
            m.bones.push(JSON.parse(JSON.stringify(bone)) as OarBone);
          },
          revert: (m) => {
            m.bones = m.bones.filter((b) => b.id !== bone.id);
          },
        }),
      );
      spineByName.set(bone.name, bone);
    }
  } else {
    spineByName.clear();
    for (const b of model.bones) spineByName.set(b.name, b);
  }
  const headBone = spineByName.get("head");
  const chestBone = spineByName.get("chest");

  // ---- step 3: bind & weight -------------------------------------------
  const pivots = (options.skeleton ? spine : model.bones)
    .filter((b) => SPINE_TABLE.some((s) => s.name === b.name))
    .map((b) => ({ id: b.id, pivotY: b.head[1] }));

  const neckLayer = model.layers.find((l) => l.slot === "neck");
  if (options.bindings && headBone) {
    const headLayerIds: string[] = [];
    const armLayerIds: string[] = [];
    for (const layer of model.layers) {
      if (layer.slot && HEAD_SLOTS.has(layer.slot)) headLayerIds.push(layer.id);
      else if (layer.slot === "arm") armLayerIds.push(layer.id);
    }
    if (headLayerIds.length > 0) cmds.push(bindLayers(headBone.id, headLayerIds));
    // Arms → chest (rigid); the shoulder hinge comes from the spine lock.
    if (chestBone && armLayerIds.length > 0) cmds.push(bindLayers(chestBone.id, armLayerIds));

    // Body layers → weighted across the spine (needs meshes).
    if (options.meshes && pivots.length > 1) {
      for (const layer of model.layers) {
        if (!layer.slot || !BODY_SLOTS.has(layer.slot)) continue;
        if (layer.slot === "arm" || layer.slot === "leg") continue;
        let meshId = layer.mesh;
        if (!meshId) {
          const img = pixels.get(layer.id);
          const mesh = layer.slot === "neck"
            ? subdivideQuad(newId("m"), layer.x, layer.y, layer.width, layer.height, 2, 6)
            : img
              ? generateMesh(newId("m"), img, layer.x, layer.y, "coarse")
              : subdivideQuad(newId("m"), layer.x, layer.y, layer.width, layer.height, 3, 6);
          mesh.weights = mesh.vertices.map(([, y]) => spineWeights(y, pivots));
          cmds.push(addMesh(mesh, layer.id));
          meshId = mesh.id;
        } else {
          const mesh = model.meshes.find((m) => m.id === meshId);
          if (mesh) {
            const weighted = {
              vertices: mesh.vertices.map((v) => [...v] as Vec2),
              uvs: mesh.uvs,
              triangles: mesh.triangles,
              weights: mesh.vertices.map(([, y]) => spineWeights(y, pivots)),
            };
            cmds.push(
              makeCommand({
                label: `reweight ${layer.name}`,
                apply: (m) => {
                  const mm = m.meshes.find((x) => x.id === mesh.id);
                  if (mm) mm.weights = weighted.weights.map((w) => ({ ...w }));
                },
                revert: (m) => {
                  const mm = m.meshes.find((x) => x.id === mesh.id);
                  if (mm) mm.weights = mesh.weights.map((w) => ({ ...w }));
                },
              }),
            );
          }
        }
        // Weighted layers no longer need a rigid bind.
        cmds.push(setLayerField(layer.id, "boneId" as never, null, `unbind ${layer.name}`));
        void meshId;
      }
    }

    // The neck is a joint, not a body part: it must be weighted along its
    // own height, which needs a mesh even when nothing else has one.
    if (!options.meshes && neckLayer && !neckLayer.mesh && pivots.length > 1) {
      const mesh = subdivideQuad(newId("m"), neckLayer.x, neckLayer.y, neckLayer.width, neckLayer.height, 2, 6);
      mesh.weights = mesh.vertices.map(([, y]) => spineWeights(y, pivots));
      cmds.push(addMesh(mesh, neckLayer.id));
    }

    // Unrecognised layers: infer a part from name and group path — with NO
    // evidence, leave static. Wrong-and-static reads as "not rigged yet".
    for (const layer of model.layers) {
      if (layer.slot || layer.boneId) continue;
      const cls = classifyLayer(layer.name, layer.path);
      if (!cls.slot) continue;
      if (HEAD_SLOTS.has(cls.slot) && headBone) {
        cmds.push(bindLayers(headBone.id, [layer.id]));
      }
    }
  }

  // ---- step 5: physics defaults (staggered siblings) -------------------
  if (options.physics) {
    const familyCount = new Map<string, number>();
    for (const layer of model.layers) {
      const slot = layer.slot;
      if (!slot) continue;
      const family = PHYSICS_DEFAULTS[slot];
      if (!family) continue;
      const idx = familyCount.get(slot) ?? 0;
      familyCount.set(slot, idx + 1);
      // Stagger siblings ±12%: identical springs move in lockstep and read
      // as one rigid slab — the helmet look.
      const stagger = idx % 2 === 0 ? 1.12 : 0.88;
      const physics: OarPhysics = {
        enabled: true,
        stiffness: family.stiffness * (slot.startsWith("hair") ? stagger : 1),
        damping: family.damping,
        maxAngle: family.maxAngle,
        inertia: family.inertia,
        gravity: family.gravity,
        pivot: family.pivot,
        customPivot: null,
      };
      cmds.push(setPhysics(layer.id, physics));
    }
  }

  // ---- step 4: face rigging --------------------------------------------
  if (options.face) {
    faceRig = buildFaceRig(model, pixels);
    warnings.push(...faceRig.warnings);
    // The lips get fine meshes (12×3): a 3×3 auto-grid makes the mouth seam
    // a crude V that disagrees with the aperture's smooth ellipse and lets
    // cavity slivers streak past the lip edges.
    if (headBone) {
      for (const lipId of [faceRig.rig.mouth.upperLip, faceRig.rig.mouth.lowerLip]) {
        if (!lipId) continue;
        const lip = model.layers.find((l) => l.id === lipId);
        if (!lip || lip.mesh) continue;
        const lipMesh = subdivideQuad(newId("m"), lip.x, lip.y, lip.width, lip.height, 12, 3);
        lipMesh.weights = lipMesh.vertices.map(() => ({ [headBone.id]: 1 }));
        cmds.push(addMesh(lipMesh, lip.id));
      }
    }
    // Remove any previous cavity layer + aperture mesh so re-runs do not
    // leave zombie duplicates rendering.
    const oldCavityIds = model.layers.filter((l) => l.slot === "mouth_cavity").map((l) => l.id);
    const oldLayersSnapshot = model.layers
      .filter((l) => oldCavityIds.includes(l.id))
      .map((l) => JSON.parse(JSON.stringify(l)) as OarLayer);
    const oldApertureIds = new Set(
      oldLayersSnapshot.map((l) => l.mesh).filter((x): x is string => !!x),
    );
    const oldMeshesSnapshot = model.meshes
      .filter((x) => oldApertureIds.has(x.id))
      .map((x) => JSON.parse(JSON.stringify(x)) as (typeof model.meshes)[number]);
    if (oldCavityIds.length > 0) {
      cmds.push(
        makeCommand({
          label: "remove old mouth cavity",
          apply: (m) => {
            m.layers = m.layers.filter((l) => !oldCavityIds.includes(l.id));
            m.meshes = m.meshes.filter((x) => !oldApertureIds.has(x.id));
          },
          revert: (m) => {
            for (const layer of oldLayersSnapshot) {
              m.layers.push(JSON.parse(JSON.stringify(layer)) as OarLayer);
            }
            for (const mesh of oldMeshesSnapshot) {
              m.meshes.push(JSON.parse(JSON.stringify(mesh)) as typeof mesh);
            }
          },
        }),
      );
    }
    if (faceRig.cavityLayer) {
      cmds.push(addLayer(faceRig.cavityLayer));
      // The cavity must follow whatever the lips follow; buildFaceRig ran
      // before the binding commands execute, so bind it explicitly.
      if (headBone) cmds.push(bindLayers(headBone.id, [faceRig.cavityLayer.id]));
    }
    for (const mesh of faceRig.meshes) {
      cmds.push(
        makeCommand({
          label: "add aperture mesh",
          apply: (m) => {
            if (!m.meshes.some((x) => x.id === mesh.id)) {
              m.meshes.push(JSON.parse(JSON.stringify(mesh)) as typeof mesh);
            }
          },
          revert: (m) => {
            m.meshes = m.meshes.filter((x) => x.id !== mesh.id);
          },
        }),
      );
    }
    for (const innerId of faceRig.consumedInner) {
      cmds.push(setLayerField(innerId, "visible", false, "hide consumed inner mouth"));
    }
    for (const [layerId, baseId] of faceRig.clipAssignments) {
      cmds.push(setLayerField(layerId, "clipTo" as never, baseId, "runtime iris clip"));
    }
    if (model.params.mouthRangeUpper === undefined && faceRig.suggestedParams.mouthRangeUpper) {
      cmds.push(setRigParam("mouthRangeUpper", faceRig.suggestedParams.mouthRangeUpper, false));
    }
    if (model.params.mouthRangeLower === undefined && faceRig.suggestedParams.mouthRangeLower) {
      cmds.push(setRigParam("mouthRangeLower", faceRig.suggestedParams.mouthRangeLower, false));
    }
    cmds.push(setRig(faceRig.rig, "build face rig"));
    cavityPixels = faceRig.cavityPixels;
  }

  return { cmd: composite("auto-rig", cmds), cavityPixels, warnings, faceRig };
}
