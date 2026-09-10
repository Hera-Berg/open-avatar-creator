// Shared UI actions used by both the toolbar and keyboard shortcuts.

import { deleteBone, replaceMeshGeometry, setBoneField } from "../state/ops";
import { deleteVertexAt } from "../state/meshOps";
import { useStore } from "../state/store";

export function toggleMeshEdit(): void {
  const s = useStore.getState();
  if (s.tool === "editMesh") {
    s.setTool("select");
    s.setMeshEdit({ layerId: null, vertices: [] });
    return;
  }
  const layerId = s.selection.layers[0];
  if (!layerId) {
    s.setToast("select a layer to edit its mesh");
    return;
  }
  const layer = s.model.layers.find((l) => l.id === layerId);
  if (!layer?.mesh) {
    s.setToast("generate a mesh first (right panel)");
    return;
  }
  s.setTool("editMesh");
  s.setMeshEdit({ layerId, vertices: [] });
}

export function toggleLockSelected(): void {
  const s = useStore.getState();
  for (const id of s.selection.bones) {
    const bone = s.model.bones.find((b) => b.id === id);
    if (bone) s.execute(setBoneField(id, "locked", !bone.locked, bone.locked ? "unlock bone" : "lock bone"));
  }
}

export function deleteSelected(): void {
  const s = useStore.getState();
  // In mesh edit mode, delete selected vertices (never if it would orphan).
  if (s.tool === "editMesh" && s.meshEdit.layerId && s.meshEdit.vertices.length > 0) {
    const layer = s.model.layers.find((l) => l.id === s.meshEdit.layerId);
    const mesh = layer?.mesh ? s.model.meshes.find((m) => m.id === layer.mesh) : null;
    if (!mesh) return;
    const doomed = [...s.meshEdit.vertices].sort((a, b) => b - a);
    let current = mesh;
    for (const vi of doomed) {
      const next = deleteVertexAt(current, vi);
      if (!next) {
        s.setToast("cannot delete that vertex");
        return;
      }
      current = { ...current, ...next };
    }
    s.execute(
      replaceMeshGeometry(mesh.id, current, `delete ${doomed.length} vertex${doomed.length === 1 ? "" : "es"}`),
    );
    s.setMeshEdit({ vertices: [] });
    return;
  }
  if (s.selection.bones.length > 0) {
    for (const id of s.selection.bones) {
      const cmd = deleteBone(id);
      if (cmd) s.execute(cmd);
    }
    s.clearSelection();
  }
}

export function fitView(): void {
  const s = useStore.getState();
  const el = document.querySelector(".viewport");
  if (el) {
    const rect = el.getBoundingClientRect();
    s.fitCamera(rect.width, rect.height);
  }
}
