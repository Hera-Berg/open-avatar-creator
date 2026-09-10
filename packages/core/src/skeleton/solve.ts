// Skeleton solving: bone world transforms and linear-blend skinning.
//
// world[bone] = world[parent] ∘ rotateAbout(bone.head, localAngle)
// local[i]   = pose[i] + driver × (follow[i] − follow[parent])
//
// Locked bones take identity for their own transform (pinned in world space)
// but still compose onto their children.

import type { OarBone, OarMesh, Vec2 } from "../model/types";
import {
  type Mat2D,
  IDENTITY,
  multiply,
  rotationAbout,
  apply,
} from "../geometry/mat2d";

export interface BoneWorld {
  bone: OarBone;
  mat: Mat2D; // canvas rest space -> world
  angle: number; // cumulative world rotation
}

export function solveSkeleton(bones: OarBone[], driver: number): Map<string, BoneWorld> {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const world = new Map<string, BoneWorld>();

  const resolve = (bone: OarBone): BoneWorld => {
    const cached = world.get(bone.id);
    if (cached) return cached;
    const parent = bone.parentId ? byId.get(bone.parentId) : undefined;
    const parentWorld = parent ? resolve(parent) : null;
    let mat: Mat2D;
    let angle: number;
    if (bone.locked) {
      // Identity for its own transform; children compose from this.
      mat = IDENTITY;
      angle = 0;
    } else {
      const parentFollow = parent ? parent.follow : 0;
      const local = bone.rotation + driver * (bone.follow - parentFollow);
      const parentMat = parentWorld ? parentWorld.mat : IDENTITY;
      // The head position in world is where the parent transform puts it.
      const headWorld = parentWorld ? apply(parentMat, bone.head[0], bone.head[1]) : bone.head;
      mat = multiply(parentMat, rotationAbout(bone.head, local));
      angle = (parentWorld?.angle ?? 0) + local;
      void headWorld;
    }
    const entry: BoneWorld = { bone, mat, angle };
    world.set(bone.id, entry);
    return entry;
  };

  for (const bone of bones) resolve(bone);
  return world;
}

/** Linear-blend skinning: p' = Σ w[b] × (world[b] · p). Weights sum to 1;
 *  a vertex with no weights stays at rest. */
export function skinVertices(
  mesh: OarMesh,
  world: Map<string, BoneWorld>,
  out?: Vec2[],
): Vec2[] {
  const result = out ?? mesh.vertices.map((v) => [v[0], v[1]] as Vec2);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const w = mesh.weights[i] ?? {};
    const entries = Object.entries(w);
    if (entries.length === 0) {
      result[i] = [mesh.vertices[i]![0], mesh.vertices[i]![1]];
      continue;
    }
    let x = 0;
    let y = 0;
    let total = 0;
    for (const [boneId, weight] of entries) {
      const bw = world.get(boneId);
      if (!bw || weight === 0) continue;
      const p = apply(bw.mat, mesh.vertices[i]![0], mesh.vertices[i]![1]);
      x += weight * p[0];
      y += weight * p[1];
      total += weight;
    }
    if (total === 0) {
      result[i] = [mesh.vertices[i]![0], mesh.vertices[i]![1]];
    } else if (Math.abs(total - 1) > 1e-6) {
      result[i] = [x / total, y / total];
    } else {
      result[i] = [x, y];
    }
  }
  return result;
}

/** Rigid transform for a plain layer bound to a single bone: everything
 *  rotates about the bone's head, not the layer's own centre. */
export function rigidTransform(
  boneId: string | null,
  world: Map<string, BoneWorld>,
): Mat2D {
  if (!boneId) return IDENTITY;
  return world.get(boneId)?.mat ?? IDENTITY;
}

/** Smoothstep weights between two adjacent spine bones, blended by height:
 *  t = (pivot[i].y − y) / (pivot[i].y − pivot[i+1].y); w = t·t·(3−2t) */
export function spineWeights(
  y: number,
  bones: { id: string; pivotY: number }[],
): Record<string, number> {
  if (bones.length === 0) return {};
  const sorted = bones.slice().sort((a, b) => a.pivotY - b.pivotY);
  if (y <= sorted[0]!.pivotY) return { [sorted[0]!.id]: 1 };
  const last = sorted[sorted.length - 1]!;
  if (y >= last.pivotY) return { [last.id]: 1 };
  for (let i = 0; i < sorted.length - 1; i++) {
    const upper = sorted[i]!;
    const lower = sorted[i + 1]!;
    if (y >= upper.pivotY && y <= lower.pivotY) {
      const span = lower.pivotY - upper.pivotY;
      const t = span === 0 ? 1 : (y - upper.pivotY) / span;
      const w = t * t * (3 - 2 * t);
      return { [upper.id]: 1 - w, [lower.id]: w };
    }
  }
  return { [last.id]: 1 };
}
