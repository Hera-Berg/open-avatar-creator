// Viewport: WebGL canvas (model) + SVG overlay (bones, mesh vertices,
// selection chrome). All editing gestures live here.

import { useEffect, useRef, useState } from "react";
import {
  clamp,
  dominantParam,
  invertedTriangles,
  keyIndexAt,
  newId,
  solveSkeleton,
  type OarBone,
  type OarManifest,
  type Vec2,
} from "@oar/core";
import { assets, screenToCanvas, canvasToScreen, useStore } from "../state/store";
import { Engine, engineHolder } from "../playback/engine";
import {
  addBone as opAddBone,
  addChildBone,
  bindLayers,
  centreBoneOnLayers,
  deleteBone,
  moveBoneSubtree,
  rotateBone,
  setVerticesAbsolute,
  replaceMeshGeometry,
  addCorrective,
  setKeyformKeys,
} from "../state/ops";
import { addVertexAt, deleteVertexAt } from "../state/meshOps";

type Drag =
  | { kind: "pan"; startX: number; startY: number; camX: number; camY: number }
  | { kind: "addBone"; head: Vec2; tail: Vec2; snapped: boolean }
  | { kind: "boneTail"; boneId: string; startAngle: number; startRotation: number }
  | { kind: "boneHead"; boneId: string }
  | { kind: "meshVerts"; layerId: string; indices: number[]; lastCanvas: Vec2; moved: boolean; restBefore: Vec2[]; correctiveId: string | null }
  | { kind: "meshBox"; start: Vec2; current: Vec2 }
  | { kind: "softMove"; layerId: string; lastCanvas: Vec2 };

const SNAP_SCREEN_PX = 12;

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function boneWorlds(model: OarManifest, driverAngle: number) {
  return solveSkeleton(model.bones, driverAngle);
}

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [, setTick] = useState(0);

  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const camera = useStore((s) => s.camera);
  const meshEdit = useStore((s) => s.meshEdit);
  const playback = useStore((s) => s.playback);

  // Engine lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = new Engine(canvas);
    engineHolder.current = engine;
    engine.start();
    const onResize = () => {
      const rect = containerRef.current!.getBoundingClientRect();
      canvas.width = Math.max(64, Math.floor(rect.width * devicePixelRatio));
      canvas.height = Math.max(64, Math.floor(rect.height * devicePixelRatio));
      setSize({ w: rect.width, h: rect.height });
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(containerRef.current!);
    onResize();
    // Overlay repaints on a light interval to follow the solved frame.
    const overlayTimer = setInterval(() => setTick((v) => v + 1), 66);
    return () => {
      observer.disconnect();
      clearInterval(overlayTimer);
      engine.stop();
      engineHolder.current = null;
    };
  }, []);

  // Fit when a new model (different canvas) loads.
  useEffect(() => {
    if (model.layers.length > 0) {
      useStore.getState().fitCamera(size.w, size.h);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.canvas.width, model.canvas.height]);

  const driverAngle = () => {
    const e = engineHolder.current;
    const p = e ? e.frame.params : null;
    const rp = model.params;
    if (!p) return 0;
    return (
      p.head_roll * ((rp.bodyRollDeg ?? 12) * (Math.PI / 180)) +
      p.head_x * ((rp.bodyLeanDeg ?? 8) * (Math.PI / 180))
    );
  };

  const toCanvas = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = containerRef.current!.getBoundingClientRect();
    return screenToCanvas(camera, size.w, size.h, e.clientX - rect.left, e.clientY - rect.top);
  };

  const toScreen = (p: Vec2): Vec2 => canvasToScreen(camera, size.w, size.h, p[0], p[1]);

  const nearestBoneEndpoint = (canvasPt: Vec2): { bone: OarBone; end: "head" | "tail" } | null => {
    let best: { bone: OarBone; end: "head" | "tail"; d: number } | null = null;
    for (const bone of model.bones) {
      for (const end of ["head", "tail"] as const) {
        const sp = toScreen(bone[end]);
        const cp = toScreen(canvasPt);
        const d = Math.hypot(sp[0] - cp[0], sp[1] - cp[1]);
        if (d < SNAP_SCREEN_PX && (!best || d < best.d)) best = { bone, end, d };
      }
    }
    return best;
  };

  const hitBone = (canvasPt: Vec2): { bone: OarBone; part: "head" | "tail" | "body" } | null => {
    const worlds = boneWorlds(model, driverAngle());
    const screen = toScreen(canvasPt);
    let bodyHit: { bone: OarBone; part: "body" } | null = null;
    for (const bone of model.bones) {
      const w = worlds.get(bone.id)!;
      const headW: Vec2 = [0, 0];
      const tailW: Vec2 = [0, 0];
      const m = w.mat;
      headW[0] = m[0] * bone.head[0] + m[2] * bone.head[1] + m[4];
      headW[1] = m[1] * bone.head[0] + m[3] * bone.head[1] + m[5];
      tailW[0] = m[0] * bone.tail[0] + m[2] * bone.tail[1] + m[4];
      tailW[1] = m[1] * bone.tail[0] + m[3] * bone.tail[1] + m[5];
      const hs = toScreen(headW);
      const ts = toScreen(tailW);
      if (Math.hypot(screen[0] - hs[0], screen[1] - hs[1]) < 10) return { bone, part: "head" };
      if (Math.hypot(screen[0] - ts[0], screen[1] - ts[1]) < 10) return { bone, part: "tail" };
      if (distToSegment(screen, hs, ts) < 6) bodyHit = { bone, part: "body" };
    }
    return bodyHit;
  };

  const hitLayer = (canvasPt: Vec2): string | null => {
    const solved = engineHolder.current?.frame.solved;
    if (!solved) return null;
    for (let i = solved.layers.length - 1; i >= 0; i--) {
      const l = solved.layers[i]!;
      if (!l.visible) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of l.positions) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      if (canvasPt[0] >= minX && canvasPt[0] <= maxX && canvasPt[1] >= minY && canvasPt[1] <= maxY) {
        return l.id;
      }
    }
    return null;
  };

  const meshForEdit = () => {
    if (!meshEdit.layerId) return null;
    const layer = model.layers.find((l) => l.id === meshEdit.layerId);
    if (!layer?.mesh) return null;
    const mesh = model.meshes.find((m) => m.id === layer.mesh);
    return layer && mesh ? { layer, mesh } : null;
  };

  const solvedPositionsFor = (layerId: string): Vec2[] | null => {
    const solved = engineHolder.current?.frame.solved;
    const l = solved?.layers.find((x) => x.id === layerId);
    return l ? l.positions : null;
  };

  const hitMeshVertex = (canvasPt: Vec2): number | null => {
    const me = meshForEdit();
    if (!me) return null;
    const positions = solvedPositionsFor(me.layer.id);
    if (!positions) return null;
    const screen = toScreen(canvasPt);
    for (let i = 0; i < positions.length; i++) {
      const sp = toScreen(positions[i]!);
      if (Math.hypot(sp[0] - screen[0], sp[1] - screen[1]) < 8) return i;
    }
    return null;
  };

  // ------------------------------------------------------------- pointer

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const canvasPt = toCanvas(e);
    if (e.button === 1) {
      dragRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y };
      return;
    }
    if (e.button !== 0) return;

    if (tool === "addBone") {
      const snap = nearestBoneEndpoint(canvasPt);
      const head = snap ? ([...snap.bone[snap.end]] as Vec2) : canvasPt;
      dragRef.current = { kind: "addBone", head, tail: canvasPt, snapped: !!snap };
      return;
    }

    if (tool === "editMesh" && meshForEdit()) {
      const vi = hitMeshVertex(canvasPt);
      if (vi !== null) {
        const me = meshForEdit()!;
        let indices = meshEdit.vertices;
        if (!indices.includes(vi)) {
          indices = e.shiftKey ? [...indices, vi] : [vi];
          useStore.getState().setMeshEdit({ vertices: indices });
        }
        const restBefore = indices.map((i) => [...me.mesh.vertices[i]!] as Vec2);
        dragRef.current = {
          kind: "meshVerts",
          layerId: me.layer.id,
          indices,
          lastCanvas: canvasPt,
          moved: false,
          restBefore,
          correctiveId: null,
        };
        return;
      }
      // Soft move begins anywhere over the mesh.
      if (meshEdit.soft) {
        dragRef.current = { kind: "softMove", layerId: meshEdit.layerId!, lastCanvas: canvasPt };
        return;
      }
      dragRef.current = { kind: "meshBox", start: canvasPt, current: canvasPt };
      return;
    }

    // select tool
    const boneHit = hitBone(canvasPt);
    if (boneHit) {
      const s = useStore.getState();
      s.select("bones", [boneHit.bone.id], e.shiftKey);
      if (boneHit.part === "tail") {
        const worlds = boneWorlds(model, driverAngle());
        const w = worlds.get(boneHit.bone.id)!;
        const headW: Vec2 = [w.mat[4] + w.mat[0] * boneHit.bone.head[0] + w.mat[2] * boneHit.bone.head[1], w.mat[5] + w.mat[1] * boneHit.bone.head[0] + w.mat[3] * boneHit.bone.head[1]];
        void headW;
        const angle0 = Math.atan2(canvasPt[1] - boneHit.bone.head[1], canvasPt[0] - boneHit.bone.head[0]);
        dragRef.current = {
          kind: "boneTail",
          boneId: boneHit.bone.id,
          startAngle: angle0,
          startRotation: boneHit.bone.rotation,
        };
      } else if (boneHit.part === "head") {
        dragRef.current = { kind: "boneHead", boneId: boneHit.bone.id };
      }
      return;
    }
    const layerId = hitLayer(canvasPt);
    if (layerId) {
      useStore.getState().select("layers", [layerId], e.shiftKey);
      return;
    }
    if (!e.shiftKey) useStore.getState().clearSelection();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const canvasPt = toCanvas(e);
    const s = useStore.getState();

    switch (drag.kind) {
      case "pan": {
        s.setCamera({
          x: drag.camX - (e.clientX - drag.startX) / camera.zoom,
          y: drag.camY - (e.clientY - drag.startY) / camera.zoom,
          zoom: camera.zoom,
        });
        break;
      }
      case "addBone": {
        drag.tail = canvasPt;
        break;
      }
      case "boneTail": {
        const bone = model.bones.find((b) => b.id === drag.boneId);
        if (!bone) break;
        const angle = Math.atan2(canvasPt[1] - bone.head[1], canvasPt[0] - bone.head[0]);
        let rotation = drag.startRotation + (angle - drag.startAngle);
        if (e.shiftKey) {
          // 15° snap.
          const snap = Math.PI / 12;
          rotation = Math.round(rotation / snap) * snap;
        }
        s.execute(rotateBone(bone.id, rotation));
        break;
      }
      case "boneHead": {
        s.execute(moveBoneSubtree(drag.boneId, canvasPt));
        break;
      }
      case "meshVerts": {
        const dx = canvasPt[0] - drag.lastCanvas[0];
        const dy = canvasPt[1] - drag.lastCanvas[1];
        if (dx === 0 && dy === 0) break;
        drag.lastCanvas = canvasPt;
        drag.moved = true;
        const me = meshForEdit();
        if (!me) break;
        if (applyKeyformDeltas(drag.indices, drag.indices.map(() => [dx, dy] as Vec2))) {
          // Editing a keyform: the drag shaped the key at the current value.
        } else if (playback.paused) {
          // Paused edits become (or update) a corrective keyed to the pose.
          applyPausedDelta(me.layer.id, drag, dx, dy);
        } else {
          const positions = drag.indices.map((i) => {
            const v = me.mesh.vertices[i]!;
            return [v[0] + dx, v[1] + dy] as Vec2;
          });
          s.execute(
            setVerticesAbsolute(me.mesh.id, drag.indices, positions, `move ${drag.indices.length} vertices`, `mesh-drag:${me.mesh.id}`),
          );
        }
        break;
      }
      case "softMove": {
        const dx = canvasPt[0] - drag.lastCanvas[0];
        const dy = canvasPt[1] - drag.lastCanvas[1];
        if (dx === 0 && dy === 0) break;
        drag.lastCanvas = canvasPt;
        softMoveDelta(drag.layerId, canvasPt, dx, dy);
        break;
      }
      case "meshBox": {
        drag.current = canvasPt;
        setTick((v) => v + 1);
        break;
      }
    }
  };

  /** Paused mesh edits: deltas apply in solved (canvas) space and become a
   *  corrective keyed to whichever parameter is furthest from rest. */
  const applyPausedDelta = (layerId: string, drag: Extract<Drag, { kind: "meshVerts" }>, dx: number, dy: number) => {
    const s = useStore.getState();
    const me = meshForEdit();
    if (!me) return;
    const params = engineHolder.current!.frame.params;
    if (!drag.correctiveId) {
      // Key to the parameter furthest from its REST value — eyes rest open
      // at 1, so a closed eye (open=0) must beat one still open at 1.
      const key = dominantParam(params);
      const corrective = {
        id: newId("c"),
        name: `${me.layer.name} at ${key} = ${params[key]!.toFixed(2)}`,
        meshId: me.mesh.id,
        driver: {
          param: key,
          value: params[key]!,
          falloff: 1.0,
          param2: null,
          value2: 0,
          falloff2: 0.5,
        },
        offsets: {} as Record<string, Vec2>,
      };
      drag.correctiveId = corrective.id;
      s.execute(addCorrective(corrective));
      s.setCorrectiveDraft({
        correctiveId: corrective.id,
        meshId: me.mesh.id,
        layerId,
        indices: [...drag.indices],
        restBefore: drag.restBefore,
      });
    }
    // Accumulate offsets in canvas space.
    const corr = model.correctives.find((c) => c.id === drag.correctiveId);
    if (!corr) return;
    const offsets = { ...corr.offsets };
    for (const i of drag.indices) {
      const prev = offsets[String(i)] ?? [0, 0];
      offsets[String(i)] = [prev[0] + dx, prev[1] + dy];
    }
    s.execute({
      label: "edit corrective",
      time: Date.now(),
      apply: (m) => {
        const c = m.correctives.find((x) => x.id === drag.correctiveId);
        if (c) c.offsets = JSON.parse(JSON.stringify(offsets)) as Record<string, Vec2>;
      },
      revert: (m) => {
        const c = m.correctives.find((x) => x.id === drag.correctiveId);
        if (c) c.offsets = {};
      },
      coalesceWith: (next) => (next.label === "edit corrective" ? next : null),
    });
    void layerId;
  };

  /** Canvas-space delta → the layer's rest space at vertex `vi`: undo the
   *  linear part of its skinning, so a key drawn with the head tilted still
   *  lands where the cursor went. (Keyform offsets apply before skinning.) */
  const toRestDelta = (layerId: string, vi: number, d: Vec2): Vec2 => {
    const m = useStore.getState().model;
    const layer = m.layers.find((l) => l.id === layerId);
    const mesh = layer?.mesh ? m.meshes.find((x) => x.id === layer.mesh) : null;
    const worlds = boneWorlds(m, driverAngle());
    let a = 0, b = 0, c = 0, dd = 0, total = 0;
    const weights = mesh?.weights[vi] ?? {};
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    const blend = entries.length > 0 ? entries : layer?.boneId ? [[layer.boneId, 1] as [string, number]] : [];
    for (const [boneId, w] of blend) {
      const mat = worlds.get(boneId)?.mat;
      if (!mat) continue;
      a += w * mat[0]; b += w * mat[1]; c += w * mat[2]; dd += w * mat[3]; total += w;
    }
    if (total === 0) return d;
    a /= total; b /= total; c /= total; dd /= total;
    const det = a * dd - b * c;
    if (Math.abs(det) < 1e-9) return d;
    return [(dd * d[0] - c * d[1]) / det, (-b * d[0] + a * d[1]) / det];
  };

  /** Route vertex deltas into the active keyform's key at the current
   *  parameter value. Returns false when no keyform is being edited (the
   *  caller then edits the base mesh / corrective as before). */
  const applyKeyformDeltas = (indices: number[], deltas: Vec2[]): boolean => {
    const s = useStore.getState();
    const ke = s.keyformEdit;
    const me = meshForEdit();
    if (!ke || !me) return false;
    const kf = s.model.keyforms.find((k) => k.id === ke.keyformId);
    if (!kf || kf.layerId !== me.layer.id || kf.meshId !== me.mesh.id) return false;
    const value = engineHolder.current?.frame.params[kf.param as keyof typeof playback.manual] ?? 0;
    const ki = keyIndexAt(kf, value);
    if (ki < 0) {
      s.setToast(`${kf.param} = ${value.toFixed(2)} is between keys — click a key or "Add key here"`);
      return true;
    }
    const key = kf.keys[ki]!;
    const offsets = { ...key.offsets };
    indices.forEach((vi, k) => {
      const d = toRestDelta(me.layer.id, vi, deltas[k]!);
      const prev = offsets[String(vi)] ?? [0, 0];
      offsets[String(vi)] = [prev[0] + d[0], prev[1] + d[1]];
    });
    const keys = kf.keys.map((k, i) => (i === ki ? { ...k, offsets } : k));
    s.execute(setKeyformKeys(kf.id, keys, `shape ${kf.param} key ${key.value.toFixed(2)}`, true));
    return true;
  };

  const softMoveDelta = (layerId: string, at: Vec2, dx: number, dy: number) => {
    const s = useStore.getState();
    const me = meshForEdit();
    if (!me) return;
    const radius = meshEdit.softRadius;
    const positions = solvedPositionsFor(layerId) ?? me.mesh.vertices;
    const indices: number[] = [];
    const next: Vec2[] = [];
    const deltas: Vec2[] = [];
    for (let i = 0; i < me.mesh.vertices.length; i++) {
      const p = positions[i]!;
      const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
      if (d >= radius) continue;
      const w = 1 - d / radius;
      const k = w * w * (3 - 2 * w);
      indices.push(i);
      deltas.push([dx * k, dy * k]);
      const v = me.mesh.vertices[i]!;
      next.push([v[0] + dx * k, v[1] + dy * k]);
    }
    if (indices.length > 0 && applyKeyformDeltas(indices, deltas)) return;
    if (indices.length > 0) {
      s.execute(setVerticesAbsolute(me.mesh.id, indices, next, `soft move ${indices.length} vertices`, `soft-drag:${me.mesh.id}`));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const canvasPt = toCanvas(e);
    const s = useStore.getState();
    if (drag.kind === "addBone") {
      const { cmd } = opAddBone(drag.head, canvasPt);
      s.execute(cmd);
      s.setTool("select");
    } else if (drag.kind === "meshBox") {
      const me = meshForEdit();
      if (me) {
        const minX = Math.min(drag.start[0], canvasPt[0]);
        const maxX = Math.max(drag.start[0], canvasPt[0]);
        const minY = Math.min(drag.start[1], canvasPt[1]);
        const maxY = Math.max(drag.start[1], canvasPt[1]);
        const positions = solvedPositionsFor(me.layer.id) ?? me.mesh.vertices;
        const inside: number[] = [];
        for (let i = 0; i < positions.length; i++) {
          const [x, y] = positions[i]!;
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) inside.push(i);
        }
        s.setMeshEdit({ vertices: e.shiftKey ? [...new Set([...meshEdit.vertices, ...inside])] : inside });
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const canvasPt = toCanvas(e);
    const s = useStore.getState();
    // Double-click a bone's tail: chain a child bone, already in drag mode.
    const boneHit = hitBone(canvasPt);
    if (boneHit && boneHit.part === "tail") {
      const parent = boneHit.bone;
      const dx = parent.tail[0] - parent.head[0];
      const dy = parent.tail[1] - parent.head[1];
      const { cmd, bone } = addChildBone(parent, [parent.tail[0] + dx, parent.tail[1] + dy]);
      s.execute(cmd);
      s.select("bones", [bone.id], false);
      dragRef.current = {
        kind: "boneTail",
        boneId: bone.id,
        startAngle: Math.atan2(bone.tail[1] - bone.head[1], bone.tail[0] - bone.head[0]),
        startRotation: 0,
      };
      return;
    }
    // Double-click inside a mesh in edit mode: add a vertex.
    if (tool === "editMesh") {
      const me = meshForEdit();
      if (me) {
        const result = addVertexAt(me.mesh, canvasPt[0], canvasPt[1], me.layer);
        if (result) {
          s.execute(replaceMeshGeometry(me.mesh.id, result, "add vertex"));
          s.setMeshEdit({ vertices: [result.newIndex] });
        }
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const s = useStore.getState();
    const rect = containerRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = screenToCanvas(camera, size.w, size.h, px, py);
    const zoom = clamp(camera.zoom * factor, 0.02, 8);
    const after = screenToCanvas({ ...camera, zoom }, size.w, size.h, px, py);
    s.setCamera({ x: camera.x + (before[0] - after[0]), y: camera.y + (before[1] - after[1]), zoom });
  };

  // Bind affordance: exactly one bone + ≥1 layer selected.
  const bind = () => {
    const s = useStore.getState();
    if (selection.bones.length === 1 && selection.layers.length > 0) {
      s.execute(bindLayers(selection.bones[0]!, selection.layers));
      s.setToast(`bound ${selection.layers.length} layer(s)`);
    }
  };

  // ------------------------------------------------------------- overlay

  const overlay = () => {
    const worlds = boneWorlds(model, driverAngle());
    const childCount = new Map<string, number>();
    for (const b of model.bones) {
      if (b.parentId) childCount.set(b.parentId, (childCount.get(b.parentId) ?? 0) + 1);
    }
    const elems: React.ReactNode[] = [];
    const drag = dragRef.current;

    // Selected layer outlines.
    const solved = engineHolder.current?.frame.solved;
    for (const lid of selection.layers) {
      const l = solved?.layers.find((x) => x.id === lid);
      if (!l) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of l.positions) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      const a = toScreen([minX, minY]);
      const b = toScreen([maxX, maxY]);
      elems.push(
        <rect
          key={`sel-${lid}`}
          x={a[0]}
          y={a[1]}
          width={b[0] - a[0]}
          height={b[1] - a[1]}
          fill="none"
          stroke="#6ab0ff"
          strokeWidth={1}
          strokeDasharray="4 3"
        />,
      );
    }

    // Bones.
    for (const bone of model.bones) {
      const w = worlds.get(bone.id)!;
      const m = w.mat;
      const hx = m[0] * bone.head[0] + m[2] * bone.head[1] + m[4];
      const hy = m[1] * bone.head[0] + m[3] * bone.head[1] + m[5];
      const tx = m[0] * bone.tail[0] + m[2] * bone.tail[1] + m[4];
      const ty = m[1] * bone.tail[0] + m[3] * bone.tail[1] + m[5];
      const hs = toScreen([hx, hy]);
      const ts = toScreen([tx, ty]);
      const selected = selection.bones.includes(bone.id);
      const colour = bone.locked ? "#e0a040" : selected ? "#6ab0ff" : "#9adc90";
      elems.push(
        <g key={bone.id}>
          <line x1={hs[0]} y1={hs[1]} x2={ts[0]} y2={ts[1]} stroke={colour} strokeWidth={selected ? 3 : 2} />
          <circle cx={hs[0]} cy={hs[1]} r={5} fill={colour} stroke="#222" strokeWidth={1} />
          <circle cx={ts[0]} cy={ts[1]} r={4} fill="#fff" stroke={colour} strokeWidth={2} />
          {(childCount.get(bone.id) ?? 0) > 1 && (
            <circle cx={hs[0]} cy={hs[1]} r={9} fill="none" stroke={colour} strokeWidth={2} />
          )}
          {bone.locked && (
            <text x={hs[0] + 8} y={hs[1] - 8} fontSize={11} fill={colour}>🔒</text>
          )}
          <text x={(hs[0] + ts[0]) / 2 + 6} y={(hs[1] + ts[1]) / 2 - 4} fontSize={10} fill={colour}>
            {bone.name}
          </text>
        </g>,
      );
    }

    // Add-bone preview.
    if (drag?.kind === "addBone") {
      const h = toScreen(drag.head);
      const t = toScreen(drag.tail);
      elems.push(
        <g key="addbone">
          <line x1={h[0]} y1={h[1]} x2={t[0]} y2={t[1]} stroke="#fff" strokeWidth={2} strokeDasharray="5 4" />
          <circle cx={h[0]} cy={h[1]} r={5} fill="#fff" />
          {drag.snapped && <circle cx={h[0]} cy={h[1]} r={10} fill="none" stroke="#fff" />}
        </g>,
      );
    }

    // Mesh edit overlay.
    const me = meshForEdit();
    if (tool === "editMesh" && me) {
      const positions = solvedPositionsFor(me.layer.id) ?? me.mesh.vertices;
      const bad = invertedTriangles(me.mesh.vertices, positions, me.mesh.triangles);
      for (const ti of bad) {
        const tri = me.mesh.triangles[ti]!;
        const pts = tri.map((vi) => toScreen(positions[vi]!).join(",")).join(" ");
        elems.push(<polygon key={`bad-${ti}`} points={pts} fill="rgba(255,60,60,0.35)" stroke="#f44" />);
      }
      positions.forEach((p, i) => {
        const sp = toScreen(p);
        const selectedV = meshEdit.vertices.includes(i);
        elems.push(
          <circle
            key={`v-${i}`}
            cx={sp[0]}
            cy={sp[1]}
            r={selectedV ? 5 : 3}
            fill={selectedV ? "#ffd54a" : "#fff"}
            stroke="#333"
            strokeWidth={1}
          />,
        );
      });
      if (meshEdit.soft) {
        const centre = drag?.kind === "softMove" ? toScreen(drag.lastCanvas) : null;
        if (centre) {
          elems.push(
            <circle key="soft" cx={centre[0]} cy={centre[1]} r={meshEdit.softRadius * camera.zoom} fill="none" stroke="#ffd54a" strokeDasharray="4 3" />,
          );
        }
      }
      if (drag?.kind === "meshBox") {
        const a = toScreen(drag.start);
        const b = toScreen(drag.current);
        elems.push(
          <rect
            key="box"
            x={Math.min(a[0], b[0])}
            y={Math.min(a[1], b[1])}
            width={Math.abs(a[0] - b[0])}
            height={Math.abs(a[1] - b[1])}
            fill="rgba(106,176,255,0.15)"
            stroke="#6ab0ff"
          />,
        );
      }
    }
    return elems;
  };

  const canBind = selection.bones.length === 1 && selection.layers.length > 0;

  const keyformStatus = () => {
    const ke = useStore.getState().keyformEdit;
    const kf = ke ? model.keyforms.find((k) => k.id === ke.keyformId) : null;
    if (!kf) return null;
    const value = engineHolder.current?.frame.params[kf.param as keyof typeof playback.manual] ?? 0;
    const on = keyIndexAt(kf, value) >= 0;
    return `◆ ${kf.param} ${value.toFixed(2)}${on ? " (key)" : " (between keys)"} · `;
  };

  return (
    <div className="viewport" ref={containerRef}>
      <canvas ref={canvasRef} className="glcanvas" />
      <svg
        className="overlay"
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      >
        {overlay()}
      </svg>
      <div className="viewport-toolbar">
        <button className={tool === "select" ? "active" : ""} onClick={() => useStore.getState().setTool("select")} title="Select (V)">Select</button>
        <button className={tool === "addBone" ? "active" : ""} onClick={() => useStore.getState().setTool("addBone")} title="Add bone (B)">Add bone</button>
        <button
          disabled={!canBind}
          onClick={bind}
          title="Bind selected layers to the selected bone (shift-click both, any order)"
        >
          Bind
        </button>
        <button
          disabled={selection.bones.length !== 1 || selection.layers.length === 0}
          onClick={() => useStore.getState().execute(centreBoneOnLayers(selection.bones[0]!, selection.layers))}
          title="Move the bone's head to the selection's combined bbox centre"
        >
          Centre bone
        </button>
        <button
          className={tool === "editMesh" ? "active" : ""}
          disabled={selection.layers.length !== 1}
          onClick={() => {
            const s = useStore.getState();
            if (tool === "editMesh") {
              s.setTool("select");
              s.setMeshEdit({ layerId: null });
            } else {
              const layerId = selection.layers[0]!;
              const layer = model.layers.find((l) => l.id === layerId);
              if (layer && !layer.mesh) {
                s.setToast("generate a mesh first (right panel)");
                return;
              }
              s.setTool("editMesh");
              s.setMeshEdit({ layerId, vertices: [] });
            }
          }}
          title="Edit mesh (E)"
        >
          Edit mesh
        </button>
        <button
          disabled={selection.bones.length === 0}
          onClick={() => {
            const s = useStore.getState();
            for (const id of selection.bones) {
              const cmd = deleteBone(id);
              if (cmd) s.execute(cmd);
            }
            s.clearSelection();
          }}
          title="Delete bone (Del) — children re-parent to its parent"
        >
          Del bone
        </button>
        <span className="spacer" />
        <button onClick={() => useStore.getState().fitCamera(size.w, size.h)} title="Fit view (F)">Fit</button>
      </div>
      <div className="viewport-status">
        {keyformStatus()}
        {playback.paused ? "⏸ paused" : playback.demo ? "▶ demo" : playback.connection === "connected" ? "● live" : "idle"}
        {engineHolder.current ? ` · ${engineHolder.current.frame.fps.toFixed(0)} fps` : ""}
      </div>
    </div>
  );
}
