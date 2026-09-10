// solveModel: the single evaluation entry point shared by the creator and
// the studio. If the studio reimplemented any of this, they would drift
// within weeks — there is one evaluator and both apps import it.

import type {
  OarManifest,
  OarMesh,
  OarLayer,
  Vec2,
} from "./model/types";
import {
  type DriverParam,
  withDriverDefaults,
  rigParam,
} from "./model/params";
import { solveSkeleton, skinVertices, rigidTransform } from "./skeleton/solve";
import { apply as matApply, invert, IDENTITY } from "./geometry/mat2d";
import { applyCorrectives } from "./correctives";
import {
  type LayerPhysicsState,
  type PhysicsGlobals,
  createLayerPhysicsState,
  stepLayerPhysics,
} from "./physics/spring";
import { solveEye, solveBrow, type WorkingLayer, type EyeRuntime } from "./face/eyes";
import {
  shapesFromBlendshapes,
  computeMouthDeform,
  deformLipLayer,
  deformAperture,
  scaleCavityFallback,
  layerRectOf,
  APERTURE_ROWS,
} from "./face/mouth";
import { headTurnX } from "./headturn/warp";
import { subdivideQuad } from "./geometry/triangulate";
import { clamp, degToRad, radToDeg, smoothstep01 } from "./geometry/util";

export interface SolveContext {
  /** explicit meshes by id (manifest.meshes) */
  meshes: Map<string, OarMesh>;
  /** cache for render-time-subdivided plain quads, keyed by layer id */
  meshCache: Map<string, OarMesh>;
  /** pixel-derived eye data (lash lower edges) */
  eyeRuntime: { left: EyeRuntime; right: EyeRuntime };
  /** per-layer physics state, persisted across frames */
  physics: Map<string, LayerPhysicsState>;
  /** raw ARKit blendshapes for the current frame, if a debug feed is present */
  blendshapes: Record<string, number> | null;
  /** seconds since last frame (clamped inside physics to ≤50ms) */
  dt: number;
}

export interface SolvedLayer {
  id: string;
  order: number;
  meshId: string;
  positions: Vec2[];
  uvs: Vec2[];
  triangles: [number, number, number][];
  alpha: number;
  visible: boolean;
  clipTo: string | null;
}

export interface SolvedModel {
  layers: SolvedLayer[]; // painter's order, back to front
}

export const HEAD_WARP_SLOTS = new Set([
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
  "lip_upper",
  "lip_lower",
  "mouth_inner",
  "mouth_cavity",
  "ear",
  "ear_fox",
  // Hair wraps around the head volume too — without the cylinder warp it
  // slides off as a rigid cap the moment the face compresses beneath it.
  "hair_front",
  "hair_middle",
  "hair_back",
  "hair_side",
]);

// Depth parallax is for HAIR only. Face features sit ON the face — sliding
// them relative to it by layer order is exactly the "eyes cut out of the
// face" failure; hair sliding against hair is the depth look we want.
const PARALLAX_SLOTS = new Set([
  "hair_front",
  "hair_middle",
  "hair_back",
  "hair_side",
]);

/** Eye layers morph per-vertex onto traced contours (blink); a coarse grid
 *  renders that curve as a handful of hard kinks. Subdivide them finely. */
const EYE_SLOTS = new Set([
  "eye_white",
  "iris",
  "eye_shine",
  "eyelash_top",
  "eyelash_bottom",
  "eye_closed",
]);

function resolveMesh(layer: OarLayer, ctx: SolveContext): OarMesh {
  if (layer.mesh) {
    const m = ctx.meshes.get(layer.mesh);
    if (m) return m;
  }
  let grid = ctx.meshCache.get(layer.id);
  if (!grid) {
    if (layer.slot && EYE_SLOTS.has(layer.slot)) {
      const cols = clamp(Math.round(layer.width / 10), 8, 64);
      const rows = clamp(Math.round(layer.height / 10), 4, 32);
      grid = subdivideQuad(layer.id, layer.x, layer.y, layer.width, layer.height, cols, rows);
    } else {
      const n = clamp(Math.round(Math.max(layer.width, layer.height) / 140), 3, 14);
      grid = subdivideQuad(layer.id, layer.x, layer.y, layer.width, layer.height, n, n);
    }
    ctx.meshCache.set(layer.id, grid);
  }
  return grid;
}

function physicsGlobalsFor(
  slot: string | null,
  params: Record<string, number>,
): PhysicsGlobals {
  const g = (k: Parameters<typeof rigParam>[1]) => rigParam(params, k);
  if (slot && slot.startsWith("hair")) {
    return {
      bounce: g("bounce"),
      softness: g("softness"),
      swayX: g("hairSwayX"),
      swayY: g("hairSwayY"),
      jiggle: g("hairJiggle"),
    };
  }
  if (slot && slot.startsWith("chest")) {
    return {
      bounce: g("bounce"),
      softness: g("softness"),
      swayX: g("chestSwayX"),
      swayY: g("chestSwayY"),
      jiggle: g("chestJiggle"),
    };
  }
  return {
    bounce: g("bounce"),
    softness: g("softness"),
    swayX: 1,
    swayY: 0.6,
    jiggle: 1,
  };
}

function pivotOf(
  layer: OarLayer,
  positions: Vec2[],
): { x: number; y: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of positions) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const p = layer.physics;
  if (!p) return { x: cx, y: cy };
  switch (p.pivot) {
    case "top":
      return { x: cx, y: minY };
    case "bottom":
      return { x: cx, y: maxY };
    case "custom":
      return p.customPivot
        ? { x: p.customPivot[0], y: p.customPivot[1] }
        : { x: cx, y: minY };
    default:
      return { x: cx, y: cy };
  }
}

export function solveModel(
  model: OarManifest,
  paramsIn: Partial<Record<DriverParam, number>>,
  ctx: SolveContext,
): SolvedModel {
  const p = withDriverDefaults(paramsIn);
  const rp = model.params;

  // 1. Spine driver: head roll + horizontal lean bend the chain.
  const driverAngle =
    p.head_roll * degToRad(rigParam(rp, "bodyRollDeg")) +
    p.head_x * degToRad(rigParam(rp, "bodyLeanDeg"));
  const world = solveSkeleton(model.bones, driverAngle);

  // 2. Skin every layer.
  const working = new Map<string, WorkingLayer>();
  const meshByLayer = new Map<string, OarMesh>();
  for (const layer of model.layers) {
    const mesh = resolveMesh(layer, ctx);
    meshByLayer.set(layer.id, mesh);
    const rest = mesh.vertices;
    let positions: Vec2[];
    const hasWeights = mesh.weights.some((w) => Object.keys(w).length > 0);
    if (hasWeights) {
      positions = skinVertices(mesh, world);
    } else if (layer.boneId) {
      const mat = rigidTransform(layer.boneId, world);
      positions = rest.map((v) => matApply(mat, v[0], v[1]));
    } else {
      // A layer with no boneId and no weights does not move. Correct default
      // for anything unrecognised: wrong-and-static reads as "not rigged
      // yet"; wrong-and-moving reads as broken.
      positions = rest.map((v) => [v[0], v[1]] as Vec2);
    }
    working.set(layer.id, {
      layer,
      restVerts: rest,
      positions,
      alpha: layer.visible ? layer.opacity : 0,
    });
  }

  // 3. Correctives — after skinning, in canvas space.
  for (const layer of model.layers) {
    if (!layer.mesh) continue;
    const wl = working.get(layer.id)!;
    applyCorrectives(model.correctives, layer.mesh, wl.positions, p);
  }

  // Head local frame, shared by the eye solve (step 4) and the head-turn
  // warp (step 6). The exact local frame is the head bone's inverse world
  // matrix — a rotation-about-the-pivot approximation is wrong whenever the
  // spine chain rotates, which is always with roll.
  const headLayer = model.layers.find((l) => l.slot === "head");
  const headBoneId = headLayer?.boneId ?? null;
  const headBoneWorld = headBoneId ? world.get(headBoneId) : null;
  const headMat = headBoneWorld ? headBoneWorld.mat : IDENTITY;
  const headFrame = { pre: invert(headMat), post: headMat };

  // 4. Face: eyes and brows.
  if (model.rig) {
    const eyeOpts = { invert: rigParam(rp, "lashInvert"), frame: headFrame };
    solveEye(
      model.rig.eyes.left,
      ctx.eyeRuntime.left,
      working,
      p.eye_l_open,
      p.gaze_x,
      p.gaze_y,
      eyeOpts,
    );
    solveEye(
      model.rig.eyes.right,
      ctx.eyeRuntime.right,
      working,
      p.eye_r_open,
      p.gaze_x,
      p.gaze_y,
      eyeOpts,
    );
  }
  for (const layer of model.layers) {
    if (layer.slot !== "eyebrow") continue;
    const wl = working.get(layer.id)!;
    const brow = layer.side === "left" ? p.brow_l : p.brow_r;
    solveBrow(wl, brow, rigParam(rp, "browRangePx"));
  }

  // 5. Mouth.
  if (model.rig && (model.rig.mouth.upperLip || model.rig.mouth.lowerLip)) {
    const mouth = model.rig.mouth;
    const upperLayer = mouth.upperLip ? model.layers.find((l) => l.id === mouth.upperLip) : null;
    const lowerLayer = mouth.lowerLip ? model.layers.find((l) => l.id === mouth.lowerLip) : null;
    const upperRect = upperLayer ? layerRectOf(upperLayer) : null;
    const lowerRect = lowerLayer ? layerRectOf(lowerLayer) : null;
    // Shaping is anatomically about the mouth itself — the lip rect centre.
    // (Anchoring to the head bbox centre skewed the mouth sideways whenever
    // the two disagreed.) The head-turn warp handles global placement.
    const cx =
      ((upperRect ? upperRect.x + upperRect.width / 2 : 0) +
        (lowerRect ? lowerRect.x + lowerRect.width / 2 : 0)) /
      ((upperRect ? 1 : 0) + (lowerRect ? 1 : 0) || 1);

    const shapes = shapesFromBlendshapes(
      p.mouth_open,
      ctx.blendshapes,
      p.mouth_smile,
      p.mouth_pucker,
    );
    const state = computeMouthDeform(
      shapes,
      rigParam(rp, "mouthRangeUpper"),
      rigParam(rp, "mouthRangeLower"),
      cx,
      p.mouth_x,
      rigParam(rp, "mouthWidthScale"),
      rigParam(rp, "mouthCorner"),
    );

    if (upperLayer) deformLipLayer(working.get(upperLayer.id)!, "upper", state);
    if (lowerLayer) deformLipLayer(working.get(lowerLayer.id)!, "lower", state);

    const apertureMesh = mouth.apertureMesh ? ctx.meshes.get(mouth.apertureMesh) : null;
    const apertureWl = mouth.apertureLayer ? working.get(mouth.apertureLayer) : null;
    if (apertureMesh && apertureWl && upperRect && lowerRect) {
      deformAperture(
        apertureWl.positions,
        apertureWl.restVerts,
        APERTURE_ROWS,
        upperRect,
        lowerRect,
        state,
      );
      // Geometry is the guarantee; the alpha fade is a secondary guard.
      apertureWl.alpha *= clamp(shapes.jawOpen * 4);
    } else {
      // Fallback: scale the cavity layers about the lip meeting point.
      const centreY =
        upperRect && lowerRect
          ? (upperRect.y + upperRect.height + lowerRect.y) / 2
          : cy0(model.canvas.height);
      for (const innerId of mouth.inner) {
        const wl = working.get(innerId);
        if (!wl) continue;
        scaleCavityFallback(wl, centreY, shapes.jawOpen);
        wl.alpha *= clamp(shapes.jawOpen * 4);
      }
    }
  }

  // 6. Head turn: parabolic cylinder warp + depth parallax from layer order.
  const headRig = model.rig?.head ?? null;
  if (headRig) {
    const yawAngle = p.head_yaw * degToRad(rigParam(rp, "headTurnDeg"));
    const pitchAngle = p.head_pitch * degToRad(rigParam(rp, "headPitchDeg"));
    const headOrder = headLayer ? headLayer.order : 0;
    const hairFollow = rigParam(rp, "hairWarpFollow");
    // The cylinder warp must be applied in the head's LOCAL frame. When the
    // head is rolled, a canvas-axis warp both rotates and compresses on the
    // wrong axis — the yaw+roll shear. The exact local frame is the head
    // bone's inverse world matrix: map each vertex back to rest, warp there,
    // then map forward again. (A rotation-about-the-pivot approximation is
    // wrong whenever the spine chain rotates, which is always with roll.)
    const hasHeadTransform = (layer: OarLayer): boolean => {
      if (!headBoneId) return false;
      if (layer.boneId === headBoneId) return true;
      const mesh = layer.mesh ? ctx.meshes.get(layer.mesh) : ctx.meshCache.get(layer.id);
      return !!mesh?.weights.some((w) => (w[headBoneId] ?? 0) > 0);
    };
    const warpInFrame = (pt: Vec2, layer: OarLayer, fn: (p: Vec2) => Vec2): void => {
      if (headBoneId && hasHeadTransform(layer)) {
        const local = matApply(headFrame.pre, pt[0], pt[1]);
        const out = fn(local);
        const back = matApply(headFrame.post, out[0], out[1]);
        pt[0] = back[0];
        pt[1] = back[1];
      } else {
        const out = fn(pt);
        pt[0] = out[0];
        pt[1] = out[1];
      }
    };
    for (const layer of model.layers) {
      const slot = layer.slot;
      if (!slot) continue;
      const wl = working.get(layer.id)!;
      if (HEAD_WARP_SLOTS.has(slot) && Math.abs(yawAngle) > 1e-6) {
        const isHair = slot.startsWith("hair");
        for (const pt of wl.positions) {
          warpInFrame(pt, layer, (p) => {
            const u = clamp((p[0] - headRig.centre[0]) / headRig.radius[0], -3, 3);
            const warped = headTurnX(u, yawAngle, headRig.centre[0], headRig.radius[0], 1);
            if (isHair && hairFollow < 0.999) {
              // Optional blend for rigs that want hair to keep more volume.
              return [p[0] + (warped - p[0]) * hairFollow, p[1]];
            }
            // Hair is attached to the head and takes the same warp as the
            // eyes — anything less reads as the face sliding inside a helmet.
            return [warped, p[1]];
          });
        }
      }
      if (HEAD_WARP_SLOTS.has(slot) && Math.abs(pitchAngle) > 1e-6) {
        // The nod is the same cylinder warp as the yaw turn, applied to y
        // about the head's HORIZONTAL axis — full sweep, every head layer
        // alike (the yaw helmet rule: less reads as the face sliding inside
        // a helmet). Separable from yaw: yaw moves x, pitch moves y, so a
        // diagonal pose is exactly post(yawWarp, pitchWarp)pre — no shear.
        for (const pt of wl.positions) {
          warpInFrame(pt, layer, (p2) => {
            const v = clamp((p2[1] - headRig.centre[1]) / headRig.radius[1], -3, 3);
            const warped = headTurnX(v, pitchAngle, headRig.centre[1], headRig.radius[1], 1);
            return [p2[0], warped];
          });
        }
      }
      if (PARALLAX_SLOTS.has(slot) && Math.abs(yawAngle) > 1e-6) {
        // Tightly clamped order delta: subtle strand depth without the hair
        // mass detaching from the head silhouette.
        const orderDelta = clamp(layer.order - headOrder, -4, 4);
        const dx =
          orderDelta *
          Math.sin(yawAngle) *
          rigParam(rp, "headParallaxPx");
        if (dx !== 0) for (const pt of wl.positions) pt[0] += dx;
      }
      // The neck is a joint, not a body part — for the warp too. The
      // cylinder map slides the whole head sideways; if the neck does not
      // follow, a gap opens at the jaw. Fade the same warp from full at the
      // neck's top to zero at its base (its mesh is vertically subdivided
      // for exactly this).
      if (slot === "neck") {
        const restTop = layer.y;
        const restBottom = layer.y + layer.height;
        const span = Math.max(1, restBottom - restTop);
        for (let i = 0; i < wl.positions.length; i++) {
          const pt = wl.positions[i]!;
          const t = smoothstep01(clamp((restBottom - wl.restVerts[i]![1]) / span));
          if (t <= 0) continue;
          if (Math.abs(yawAngle) > 1e-6) {
            warpInFrame(pt, layer, (p) => {
              const u = clamp((p[0] - headRig.centre[0]) / headRig.radius[0], -3, 3);
              const warped = headTurnX(u, yawAngle, headRig.centre[0], headRig.radius[0], 1);
              return [p[0] + (warped - p[0]) * t, p[1]];
            });
          }
          if (Math.abs(pitchAngle) > 1e-6) {
            warpInFrame(pt, layer, (p2) => {
              const v = clamp((p2[1] - headRig.centre[1]) / headRig.radius[1], -3, 3);
              const warped = headTurnX(v, pitchAngle, headRig.centre[1], headRig.radius[1], 1);
              return [p2[0], p2[1] + (warped - p2[1]) * t];
            });
          }
        }
      }
    }
  }

  // 7. Whole-model translation — head position moves all of you.
  const tx = p.head_x * rigParam(rp, "positionRangeX");
  const ty = -p.head_y * rigParam(rp, "positionRangeY");

  // 8. Physics per layer (driven by pivot velocity, incl. translation).
  const leanDeg = radToDeg(driverAngle);
  for (const layer of model.layers) {
    const cfg = layer.physics;
    if (!cfg || !cfg.enabled) continue;
    const wl = working.get(layer.id)!;
    const pivot = pivotOf(layer, wl.positions);
    let state = ctx.physics.get(layer.id);
    if (!state) {
      state = createLayerPhysicsState();
      ctx.physics.set(layer.id, state);
    }
    const globals = physicsGlobalsFor(layer.slot, rp);
    const step = stepLayerPhysics(
      state,
      cfg,
      globals,
      pivot.x + tx,
      pivot.y + ty,
      leanDeg,
      ctx.dt,
    );
    if (step.angle !== 0 || step.offsetY !== 0) {
      const rad = degToRad(step.angle);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      for (const pt of wl.positions) {
        const dx = pt[0] - pivot.x;
        const dy = pt[1] - pivot.y;
        pt[0] = pivot.x + dx * cos - dy * sin;
        pt[1] = pivot.y + dx * sin + dy * cos + step.offsetY;
      }
    }
  }

  // 9. Apply translation to everything.
  if (tx !== 0 || ty !== 0) {
    for (const wl of working.values()) {
      for (const pt of wl.positions) {
        pt[0] += tx;
        pt[1] += ty;
      }
    }
  }

  // 10. Assemble in painter's order.
  const layers: SolvedLayer[] = model.layers
    .map((layer) => {
      const wl = working.get(layer.id)!;
      const mesh = meshByLayer.get(layer.id)!;
      return {
        id: layer.id,
        order: layer.order,
        meshId: mesh.id,
        positions: wl.positions,
        uvs: mesh.uvs,
        triangles: mesh.triangles,
        alpha: clamp(wl.alpha),
        visible: layer.visible && wl.alpha > 0.001,
        clipTo: layer.clipTo,
      };
    })
    .sort((a, b) => a.order - b.order);
  return { layers };
}

function cy0(canvasHeight: number): number {
  return canvasHeight / 2;
}

export function createSolveContext(): SolveContext {
  return {
    meshes: new Map(),
    meshCache: new Map(),
    eyeRuntime: { left: { lashLower: null }, right: { lashLower: null } },
    physics: new Map(),
    blendshapes: null,
    dt: 1 / 60,
  };
}
