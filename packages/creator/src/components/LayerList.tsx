// Layer list: the second selection surface. Layers hide behind other layers
// and often cannot be clicked on canvas at all — this list must work.

import { useStore } from "../state/store";
import { setLayerField, unbindLayer, reorderLayer } from "../state/ops";
import type { OarLayer } from "@oar/core";

function Row({ layer }: { layer: OarLayer }) {
  const selection = useStore((s) => s.selection);
  const model = useStore((s) => s.model);
  const selected = selection.layers.includes(layer.id);
  const bone = layer.boneId ? model.bones.find((b) => b.id === layer.boneId) : null;

  return (
    <div
      className={`layer-row ${selected ? "selected" : ""}`}
      onClick={(e) => useStore.getState().select("layers", [layer.id], e.shiftKey)}
      title={layer.path.length > 0 ? `${layer.path.join(" / ")} / ${layer.name}` : layer.name}
    >
      <button
        className="eye"
        onClick={(e) => {
          e.stopPropagation();
          useStore.getState().execute(setLayerField(layer.id, "visible", !layer.visible, "toggle visibility"));
        }}
        title={layer.visible ? "hide" : "show"}
      >
        {layer.visible ? "●" : "○"}
      </button>
      <span
        className="name"
        onDoubleClick={(e) => {
          e.stopPropagation();
          const next = prompt("rename layer", layer.name);
          if (next) useStore.getState().execute(setLayerField(layer.id, "name", next, "rename layer"));
        }}
      >
        {layer.name}
      </span>
      {layer.slot && <span className="chip slot">{layer.slot}{layer.side ? `:${layer.side[0]}` : ""}</span>}
      {bone && (
        <span className="chip bone">
          {bone.name}
          <button
            className="unbind"
            title="unbind"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().execute(unbindLayer(layer.id));
            }}
          >
            ×
          </button>
        </span>
      )}
      <span className="row-actions">
        <button
          title="move forward"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().execute(reorderLayer(layer.id, layer.order + 1));
          }}
        >
          ↑
        </button>
        <button
          title="move back"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().execute(reorderLayer(layer.id, layer.order - 1));
          }}
        >
          ↓
        </button>
      </span>
    </div>
  );
}

export function LayerList() {
  const model = useStore((s) => s.model);
  const ordered = [...model.layers].sort((a, b) => b.order - a.order); // top first
  return (
    <div className="layer-list">
      <div className="panel-title">Layers ({model.layers.length})</div>
      {ordered.map((layer) => (
        <Row key={layer.id} layer={layer} />
      ))}
      {model.layers.length === 0 && (
        <div className="empty">Import a PSD or open a .oar to begin.</div>
      )}
    </div>
  );
}
