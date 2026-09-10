// Model operations. Every user gesture becomes a Command here — auto-rig
// runs these same operations, so generated output is indistinguishable from
// hand-made and editable with the same tools.

import {
  newId,
  type OarBone,
  type OarCorrective,
  type OarLayer,
  type OarManifest,
  type OarMesh,
  type OarPhysics,
  type Vec2,
} from "@oar/core";
import { makeCommand, type Command } from "./undo";

export function getBone(model: OarManifest, id: string): OarBone | undefined {
  return model.bones.find((b) => b.id === id);
}
export function getLayer(model: OarManifest, id: string): OarLayer | undefined {
  return model.layers.find((l) => l.id === id);
}
export function getMesh(model: OarManifest, id: string): OarMesh | undefined {
  return model.meshes.find((m) => m.id === id);
}

function insertCommand<T extends { id: string }>(
  label: string,
  arr: (model: OarManifest) => T[],
  item: T,
): Command {
  return makeCommand({
    label,
    apply: (m) => {
      arr(m).push(item);
    },
    revert: (m) => {
      const a = arr(m);
      const i = a.findIndex((x) => x.id === item.id);
      if (i >= 0) a.splice(i, 1);
    },
  });
}

function removeCommand<T extends { id: string }>(
  label: string,
  arr: (model: OarManifest) => T[],
  id: string,
  onRevert?: (m: OarManifest, item: T, index: number) => void,
  onApply?: (m: OarManifest, item: T) => void,
): Command | null {
  let saved: { item: T; index: number } | null = null;
  return makeCommand({
    label,
    apply: (m) => {
      const a = arr(m);
      const index = a.findIndex((x) => x.id === id);
      if (index < 0) return;
      saved = { item: a[index]!, index };
      a.splice(index, 1);
      onApply?.(m, saved.item);
    },
    revert: (m) => {
      if (!saved) return;
      arr(m).splice(Math.min(saved.index, arr(m).length), 0, saved.item);
      onRevert?.(m, saved.item, saved.index);
    },
  });
}

// ---------------------------------------------------------------- bones

export function addBone(head: Vec2, tail: Vec2, name?: string): { cmd: Command; bone: OarBone } {
  const bone: OarBone = {
    id: newId("b"),
    name: name ?? "bone",
    parentId: null,
    head: [...head],
    tail: [...tail],
    locked: false,
    follow: 0,
    rotation: 0,
  };
  return { cmd: insertCommand(`add bone ${bone.name}`, (m) => m.bones, bone), bone };
}

export function addChildBone(parent: OarBone, tail: Vec2): { cmd: Command; bone: OarBone } {
  const bone: OarBone = {
    id: newId("b"),
    name: `${parent.name}_child`,
    parentId: parent.id,
    head: [...parent.tail] as Vec2,
    tail: [...tail],
    locked: false,
    follow: 0,
    rotation: 0,
  };
  return { cmd: insertCommand(`add child bone`, (m) => m.bones, bone), bone };
}

export function deleteBone(id: string): Command | null {
  // Children re-parent to the deleted bone's parent.
  let saved: { bone: OarBone; index: number; children: string[] } | null = null;
  return makeCommand({
    label: "delete bone",
    apply: (m) => {
      const index = m.bones.findIndex((b) => b.id === id);
      if (index < 0) return;
      const bone = m.bones[index]!;
      saved = {
        bone: { ...bone, head: [...bone.head] as Vec2, tail: [...bone.tail] as Vec2 },
        index,
        children: m.bones.filter((b) => b.parentId === id).map((b) => b.id),
      };
      m.bones.splice(index, 1);
      for (const childId of saved.children) {
        const child = getBone(m, childId);
        if (child) child.parentId = bone.parentId;
      }
    },
    revert: (m) => {
      if (!saved) return;
      m.bones.splice(Math.min(saved.index, m.bones.length), 0, {
        ...saved.bone,
        head: [...saved.bone.head] as Vec2,
        tail: [...saved.bone.tail] as Vec2,
      });
      for (const childId of saved.children) {
        const child = getBone(m, childId);
        if (child) child.parentId = id;
      }
    },
  });
}

export function moveBone(id: string, head: Vec2, tail: Vec2, coalesce = true): Command {
  let before: { head: Vec2; tail: Vec2 } | null = null;
  return makeCommand({
    label: "move bone",
    apply: (m) => {
      const b = getBone(m, id);
      if (!b) return;
      if (!before) before = { head: [...b.head] as Vec2, tail: [...b.tail] as Vec2 };
      b.head = [...head] as Vec2;
      b.tail = [...tail] as Vec2;
    },
    revert: (m) => {
      const b = getBone(m, id);
      if (b && before) {
        b.head = [...before.head] as Vec2;
        b.tail = [...before.tail] as Vec2;
      }
    },
    ...(coalesce ? { coalesceKey: `bone-move:${id}` } : {}),
  });
}

/** Dragging a bone's head moves the whole bone and translates its children. */
export function moveBoneSubtree(id: string, newHead: Vec2): Command {
  let before: Map<string, { head: Vec2; tail: Vec2 }> | null = null;
  return makeCommand({
    label: "move bone",
    apply: (m) => {
      const b = getBone(m, id);
      if (!b) return;
      if (!before) {
        before = new Map();
        const collect = (boneId: string) => {
          const bone = getBone(m, boneId);
          if (!bone) return;
          before!.set(boneId, { head: [...bone.head] as Vec2, tail: [...bone.tail] as Vec2 });
          for (const child of m.bones.filter((x) => x.parentId === boneId)) collect(child.id);
        };
        collect(id);
      }
      const dx = newHead[0] - b.head[0];
      const dy = newHead[1] - b.head[1];
      const shift = (boneId: string) => {
        const bone = getBone(m, boneId);
        if (!bone) return;
        bone.head = [bone.head[0] + dx, bone.head[1] + dy];
        bone.tail = [bone.tail[0] + dx, bone.tail[1] + dy];
        for (const child of m.bones.filter((x) => x.parentId === boneId)) shift(child.id);
      };
      shift(id);
    },
    revert: (m) => {
      if (!before) return;
      for (const [boneId, pos] of before) {
        const bone = getBone(m, boneId);
        if (bone) {
          bone.head = [...pos.head] as Vec2;
          bone.tail = [...pos.tail] as Vec2;
        }
      }
    },
    coalesceKey: `bone-subtree:${id}`,
  });
}

export function rotateBone(id: string, rotation: number): Command {
  let before: number | null = null;
  return makeCommand({
    label: "rotate bone",
    apply: (m) => {
      const b = getBone(m, id);
      if (!b) return;
      if (before === null) before = b.rotation;
      b.rotation = rotation;
    },
    revert: (m) => {
      const b = getBone(m, id);
      if (b && before !== null) b.rotation = before;
    },
    coalesceKey: `bone-rotate:${id}`,
  });
}

export function setBoneField(
  id: string,
  field: "locked" | "follow" | "name",
  value: boolean | number | string,
  label: string,
  coalesce = false,
): Command {
  let before: unknown = null;
  return makeCommand({
    label,
    apply: (m) => {
      const b = getBone(m, id);
      if (!b) return;
      if (before === null) before = b[field];
      (b as unknown as Record<string, unknown>)[field] = value;
    },
    revert: (m) => {
      const b = getBone(m, id);
      if (b && before !== null) (b as unknown as Record<string, unknown>)[field] = before;
    },
    ...(coalesce ? { coalesceKey: `bone-field:${id}:${field}` } : {}),
  });
}

/** Centre bone on selection: move the bone's head to the combined bbox
 *  centre of the given layers, preserving length and angle. */
export function centreBoneOnLayers(id: string, layerIds: string[]): Command {
  let before: { head: Vec2; tail: Vec2 } | null = null;
  let after: { head: Vec2; tail: Vec2 } | null = null;
  const compute = (m: OarManifest): { head: Vec2; tail: Vec2 } | null => {
    const b = getBone(m, id);
    if (!b || layerIds.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lid of layerIds) {
      const l = getLayer(m, lid);
      if (!l) continue;
      minX = Math.min(minX, l.x); minY = Math.min(minY, l.y);
      maxX = Math.max(maxX, l.x + l.width); maxY = Math.max(maxY, l.y + l.height);
    }
    if (!Number.isFinite(minX)) return null;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const dx = cx - b.head[0];
    const dy = cy - b.head[1];
    return { head: [cx, cy], tail: [b.tail[0] + dx, b.tail[1] + dy] };
  };
  return makeCommand({
    label: "centre bone on selection",
    apply: (m) => {
      const b = getBone(m, id);
      if (!b) return;
      if (!before) before = { head: [...b.head] as Vec2, tail: [...b.tail] as Vec2 };
      if (!after) after = compute(m);
      if (after) {
        b.head = [...after.head] as Vec2;
        b.tail = [...after.tail] as Vec2;
      }
    },
    revert: (m) => {
      const b = getBone(m, id);
      if (b && before) {
        b.head = [...before.head] as Vec2;
        b.tail = [...before.tail] as Vec2;
      }
    },
  });
}

// ---------------------------------------------------------------- binding

export function bindLayers(boneId: string, layerIds: string[]): Command {
  let before: Map<string, string | null> | null = null;
  return makeCommand({
    label: `bind ${layerIds.length} layer${layerIds.length === 1 ? "" : "s"}`,
    apply: (m) => {
      if (!before) {
        before = new Map(layerIds.map((lid) => [lid, getLayer(m, lid)?.boneId ?? null]));
      }
      for (const lid of layerIds) {
        const l = getLayer(m, lid);
        if (!l) continue;
        l.boneId = boneId;
        // Meshed layers get weight 1.0 to that bone.
        if (l.mesh) {
          const mesh = getMesh(m, l.mesh);
          if (mesh) mesh.weights = mesh.vertices.map(() => ({ [boneId]: 1 }));
        }
      }
    },
    revert: (m) => {
      if (!before) return;
      for (const [lid, boneId] of before) {
        const l = getLayer(m, lid);
        if (l) l.boneId = boneId;
      }
    },
  });
}

export function unbindLayer(layerId: string): Command {
  let before: string | null | undefined = null;
  return makeCommand({
    label: "unbind layer",
    apply: (m) => {
      const l = getLayer(m, layerId);
      if (!l) return;
      if (before === null) before = l.boneId;
      l.boneId = null;
    },
    revert: (m) => {
      const l = getLayer(m, layerId);
      if (l && before !== null) l.boneId = before ?? null;
    },
  });
}

// ---------------------------------------------------------------- layers

export function setLayerField(
  id: string,
  field: "visible" | "opacity" | "name" | "slot" | "side" | "order",
  value: unknown,
  label: string,
  coalesce = false,
): Command {
  let before: unknown = null;
  return makeCommand({
    label,
    apply: (m) => {
      const l = getLayer(m, id);
      if (!l) return;
      if (before === null) before = (l as unknown as Record<string, unknown>)[field];
      (l as unknown as Record<string, unknown>)[field] = value;
    },
    revert: (m) => {
      const l = getLayer(m, id);
      if (l && before !== null) (l as unknown as Record<string, unknown>)[field] = before;
    },
    ...(coalesce ? { coalesceKey: `layer-field:${id}:${String(field)}` } : {}),
  });
}

export function reorderLayer(id: string, newOrder: number): Command {
  let before: number | null = null;
  return makeCommand({
    label: "reorder layer",
    apply: (m) => {
      const l = getLayer(m, id);
      if (!l) return;
      if (before === null) before = l.order;
      l.order = newOrder;
    },
    revert: (m) => {
      const l = getLayer(m, id);
      if (l && before !== null) l.order = before;
    },
    coalesceKey: `layer-order:${id}`,
  });
}

export function setPhysics(id: string, physics: OarPhysics | null): Command {
  let before: OarPhysics | null | undefined = null;
  return makeCommand({
    label: "physics change",
    apply: (m) => {
      const l = getLayer(m, id);
      if (!l) return;
      if (before === null) before = l.physics ? { ...l.physics } : null;
      l.physics = physics ? { ...physics } : null;
    },
    revert: (m) => {
      const l = getLayer(m, id);
      if (l && before !== null) l.physics = before ? { ...before } : null;
    },
    coalesceKey: `layer-physics:${id}`,
  });
}

// ---------------------------------------------------------------- meshes

export function addMesh(mesh: OarMesh, layerId: string): Command {
  let beforeMeshId: string | null | undefined = null;
  return makeCommand({
    label: "generate mesh",
    apply: (m) => {
      const l = getLayer(m, layerId);
      if (!l) return;
      if (beforeMeshId === null) beforeMeshId = l.mesh;
      const existing = m.meshes.findIndex((x) => x.id === mesh.id);
      if (existing >= 0) m.meshes.splice(existing, 1);
      m.meshes.push(mesh);
      l.mesh = mesh.id;
    },
    revert: (m) => {
      const l = getLayer(m, layerId);
      const i = m.meshes.findIndex((x) => x.id === mesh.id);
      if (i >= 0) m.meshes.splice(i, 1);
      if (l) l.mesh = beforeMeshId ?? null;
    },
  });
}

/** Vertex moves snapshot only the affected mesh's vertex array (a few KB),
 *  and coalesce so a drag is one undo step. */
export function moveVertices(
  meshId: string,
  indices: number[],
  deltas: Vec2[],
  label = `move ${indices.length} vert${indices.length === 1 ? "ex" : "ices"}`,
): Command {
  let before: Vec2[] | null = null;
  return makeCommand({
    label,
    apply: (m) => {
      const mesh = getMesh(m, meshId);
      if (!mesh) return;
      if (!before) before = indices.map((i) => [...mesh.vertices[i]!] as Vec2);
      indices.forEach((idx, k) => {
        const v = mesh.vertices[idx];
        if (v) {
          v[0] += deltas[k]![0];
          v[1] += deltas[k]![1];
        }
      });
    },
    revert: (m) => {
      const mesh = getMesh(m, meshId);
      if (!mesh || !before) return;
      indices.forEach((idx, k) => {
        if (mesh.vertices[idx]) mesh.vertices[idx] = [...before![k]!] as Vec2;
      });
    },
    coalesceKey: `mesh-move:${meshId}:${indices.join(",")}`,
  });
}

export function setVerticesAbsolute(
  meshId: string,
  indices: number[],
  positions: Vec2[],
  label: string,
  coalesceKey?: string,
): Command {
  let before: Vec2[] | null = null;
  return makeCommand({
    label,
    apply: (m) => {
      const mesh = getMesh(m, meshId);
      if (!mesh) return;
      if (!before) before = indices.map((i) => [...mesh.vertices[i]!] as Vec2);
      indices.forEach((idx, k) => {
        if (mesh.vertices[idx]) mesh.vertices[idx] = [...positions[k]!] as Vec2;
      });
    },
    revert: (m) => {
      const mesh = getMesh(m, meshId);
      if (!mesh || !before) return;
      indices.forEach((idx, k) => {
        if (mesh.vertices[idx]) mesh.vertices[idx] = [...before![k]!] as Vec2;
      });
    },
    ...(coalesceKey ? { coalesceKey } : {}),
  });
}

export function replaceMeshGeometry(
  meshId: string,
  next: { vertices: Vec2[]; uvs: Vec2[]; triangles: [number, number, number][]; weights: Record<string, number>[] },
  label: string,
): Command {
  let before: OarMesh | null = null;
  return makeCommand({
    label,
    apply: (m) => {
      const mesh = getMesh(m, meshId);
      if (!mesh) return;
      if (!before) before = JSON.parse(JSON.stringify(mesh)) as OarMesh;
      mesh.vertices = next.vertices;
      mesh.uvs = next.uvs;
      mesh.triangles = next.triangles;
      mesh.weights = next.weights;
    },
    revert: (m) => {
      const mesh = getMesh(m, meshId);
      if (!mesh || !before) return;
      mesh.vertices = before.vertices;
      mesh.uvs = before.uvs;
      mesh.triangles = before.triangles;
      mesh.weights = before.weights;
    },
  });
}

// ---------------------------------------------------------------- correctives

export function addCorrective(corrective: OarCorrective): Command {
  return insertCommand(`corrective ${corrective.name}`, (m) => m.correctives, corrective);
}

export function deleteCorrective(id: string): Command | null {
  return removeCommand("delete corrective", (m) => m.correctives, id);
}

// ---------------------------------------------------------------- rig & params

export function setRigParam(key: string, value: number, coalesce = true): Command {
  let before: number | undefined;
  let captured = false;
  return makeCommand({
    label: `set ${key}`,
    apply: (m) => {
      if (!captured) {
        before = m.params[key];
        captured = true;
      }
      m.params[key] = value;
    },
    revert: (m) => {
      if (before === undefined) delete m.params[key];
      else m.params[key] = before;
    },
    ...(coalesce ? { coalesceKey: `rigparam:${key}` } : {}),
  });
}

export function setRig(next: OarManifest["rig"], label = "build face rig"): Command {
  let before: OarManifest["rig"];
  let captured = false;
  return makeCommand({
    label,
    apply: (m) => {
      if (!captured) {
        before = m.rig ? (JSON.parse(JSON.stringify(m.rig)) as OarManifest["rig"]) : null;
        captured = true;
      }
      m.rig = next ? (JSON.parse(JSON.stringify(next)) as NonNullable<OarManifest["rig"]>) : null;
    },
    revert: (m) => {
      m.rig = before ? (JSON.parse(JSON.stringify(before)) as NonNullable<OarManifest["rig"]>) : null;
    },
  });
}

export function addLayer(layer: OarLayer): Command {
  return insertCommand(`add layer ${layer.name}`, (m) => m.layers, layer);
}

export function composite(label: string, cmds: Command[]): Command {
  return makeCommand({
    label,
    apply: (m) => cmds.forEach((c) => c.apply(m)),
    revert: (m) => {
      for (let i = cmds.length - 1; i >= 0; i--) cmds[i]!.revert(m);
    },
  });
}
