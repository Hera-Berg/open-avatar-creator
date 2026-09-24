// Keyforms panel — the Live2D workflow. A keyform deforms one layer's mesh
// along one parameter: pick a key (the slider jumps there), drag vertices,
// and the runtime interpolates between keys. The blink is generated as
// keyforms and refined here with the same tools.

import {
  DRIVER_DEFAULTS,
  DRIVER_SLIDERS,
  interpolatedKey,
  keyIndexAt,
  newId,
  upsertKey,
  type DriverParam,
  type OarKeyform,
  type OarKeyformKey,
} from "@oar/core";
import { useState } from "react";
import { assets, useStore } from "../state/store";
import { addKeyform, composite, deleteKeyform, setKeyformKeys } from "../state/ops";
import { buildBlinkCommands } from "../rig/blink";
import { engineHolder } from "../playback/engine";

function currentValue(param: string): number {
  const s = useStore.getState();
  const manual = s.playback.manual[param as DriverParam];
  if (manual !== undefined) return manual;
  return engineHolder.current?.frame.params[param as DriverParam] ?? DRIVER_DEFAULTS[param as DriverParam] ?? 0;
}

/** Enter editing on a keyform, optionally jumping the slider to a key. */
export function activateKeyform(kf: OarKeyform, value?: number): void {
  const s = useStore.getState();
  if (value !== undefined) s.setManualParam(kf.param as DriverParam, value);
  s.setKeyformEdit({ keyformId: kf.id });
  s.select("layers", [kf.layerId], false);
  s.setTool("editMesh");
  s.setMeshEdit({ layerId: kf.layerId, vertices: [] });
}

function exitKeyform(kf: OarKeyform | undefined): void {
  const s = useStore.getState();
  s.setKeyformEdit(null);
  if (kf) {
    const manual = { ...s.playback.manual };
    delete manual[kf.param as DriverParam];
    s.setPlayback({ manual });
  }
}

function generateBlink(): void {
  const s = useStore.getState();
  const model = s.model;
  if (!model.rig) {
    s.setToast("run Auto-rig (face) first — the blink needs the traced eye rig");
    return;
  }
  const headBone = model.bones.find((b) => b.name === "head");
  const headLayer = model.layers.find((l) => l.slot === "head");
  const build = buildBlinkCommands(model, assets.pixels, model.rig, headBone?.id ?? headLayer?.boneId ?? null);
  if (build.keyforms.length === 0) {
    s.setToast("no eye layers found (eye_white / eyelash_top slots)");
    return;
  }
  s.execute(composite("generate blink keyforms", build.cmds));
  s.setToast(
    `blink: ${build.keyforms.length} keyforms` + (build.warnings.length ? ` — ${build.warnings.join("; ")}` : ""),
  );
}

function ActiveKeyform({ kf }: { kf: OarKeyform }) {
  // Re-render on the overlay tick so the value readout follows the slider.
  useStore((s) => s.playback.manual[kf.param as DriverParam]);
  const slider = DRIVER_SLIDERS.find((d) => d.key === kf.param);
  const value = currentValue(kf.param);
  const ki = keyIndexAt(kf, value);
  const key: OarKeyformKey | undefined = ki >= 0 ? kf.keys[ki] : undefined;
  const exec = (keys: OarKeyformKey[], label: string, coalesce = false) =>
    useStore.getState().execute(setKeyformKeys(kf.id, keys, label, coalesce));

  const between = (() => {
    if (key) return `on key ${key.value.toFixed(2)} — drag vertices to shape it`;
    const lo = [...kf.keys].reverse().find((k) => k.value < value);
    const hi = kf.keys.find((k) => k.value > value);
    return `between keys ${lo?.value.toFixed(2) ?? "—"} and ${hi?.value.toFixed(2) ?? "—"} (interpolated, read-only)`;
  })();

  return (
    <div className="keyform-active">
      <div className="hint">
        <b>{kf.name}</b> · {kf.param} = {value.toFixed(2)}
        <br />
        {between}
      </div>
      <label>
        scrub {kf.param}
        <input
          type="range"
          min={slider?.min ?? 0}
          max={slider?.max ?? 1}
          step={0.01}
          value={value}
          onChange={(e) => useStore.getState().setManualParam(kf.param as DriverParam, Number(e.target.value))}
        />
      </label>
      {key && (
        <label>
          key opacity {key.opacity.toFixed(2)}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={key.opacity}
            onChange={(e) =>
              exec(
                kf.keys.map((k, i) => (i === ki ? { ...k, opacity: Number(e.target.value) } : k)),
                "key opacity",
                true,
              )
            }
          />
        </label>
      )}
      <div className="row">
        <button
          disabled={!!key}
          title="Add a key at the current value, starting from the interpolated shape"
          onClick={() => exec(upsertKey(kf.keys, interpolatedKey(kf, Math.round(value * 100) / 100)), "add key")}
        >
          Add key here
        </button>
        <button
          disabled={!key}
          title="Clear this key's deformation back to the rest shape"
          onClick={() => exec(kf.keys.map((k, i) => (i === ki ? { ...k, offsets: {} } : k)), "reset key")}
        >
          Reset key
        </button>
        <button
          disabled={!key || kf.keys.length <= 1}
          onClick={() => exec(kf.keys.filter((_, i) => i !== ki), "delete key")}
        >
          Delete key
        </button>
        <button onClick={() => exitKeyform(kf)}>Done</button>
      </div>
    </div>
  );
}

function KeyChips({ kf }: { kf: OarKeyform }) {
  return (
    <span className="key-chips">
      {kf.keys.map((k) => (
        <button
          key={k.value}
          className="chip"
          title={`go to ${kf.param} = ${k.value.toFixed(2)} and edit this key`}
          onClick={() => activateKeyform(kf, k.value)}
        >
          {k.value.toFixed(2)}
        </button>
      ))}
    </span>
  );
}

export function KeyformPanel() {
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const keyformEdit = useStore((s) => s.keyformEdit);
  const [newParam, setNewParam] = useState<DriverParam>("eye_l_open");
  const layer = selection.layers.length === 1 ? model.layers.find((l) => l.id === selection.layers[0]) : undefined;
  const active = keyformEdit ? model.keyforms.find((k) => k.id === keyformEdit.keyformId) : undefined;
  const layerKeyforms = layer ? model.keyforms.filter((k) => k.layerId === layer.id) : [];
  const layerName = (id: string) => model.layers.find((l) => l.id === id)?.name ?? "?";

  const addNew = () => {
    if (!layer?.mesh) return;
    const def = DRIVER_SLIDERS.find((d) => d.key === newParam)!;
    const values = def.min < 0 ? [def.min, 0, def.max] : [def.min, def.max];
    const kf: OarKeyform = {
      id: newId("k"),
      name: `${layer.name} ${newParam}`,
      layerId: layer.id,
      meshId: layer.mesh,
      param: newParam,
      keys: values.map((value) => ({ value, offsets: {}, opacity: 1 })),
    };
    useStore.getState().execute(addKeyform(kf));
    activateKeyform(kf, def.min);
  };

  return (
    <section>
      <h3>Keyforms</h3>
      <div className="row">
        <button onClick={generateBlink} title="(Re)build the eye blink as keyforms on eye_l_open / eye_r_open">
          Generate blink
        </button>
      </div>

      {active && <ActiveKeyform kf={active} />}

      {layer && (
        <>
          <h4>{layer.name}</h4>
          {!layer.mesh ? (
            <div className="hint">generate a mesh for this layer (Layer section) to give it keyforms</div>
          ) : (
            <>
              {layerKeyforms.map((kf) => (
                <div key={kf.id} className={`corr-row${kf.id === active?.id ? " active" : ""}`}>
                  <span title={kf.name}>
                    {kf.param}
                    {kf.meshId !== layer.mesh ? " (stale mesh — ignored)" : ""}
                  </span>
                  <KeyChips kf={kf} />
                  <button
                    title="delete keyform"
                    onClick={() => {
                      if (kf.id === active?.id) exitKeyform(kf);
                      const del = deleteKeyform(kf.id);
                      if (del) useStore.getState().execute(del);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="row">
                <select value={newParam} onChange={(e) => setNewParam(e.target.value as DriverParam)}>
                  {DRIVER_SLIDERS.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <button onClick={addNew}>Add keyform</button>
              </div>
            </>
          )}
        </>
      )}

      {model.keyforms.length > 0 && (
        <>
          <h4>All keyforms ({model.keyforms.length})</h4>
          {model.keyforms.map((kf) => (
            <div key={kf.id} className={`corr-row${kf.id === active?.id ? " active" : ""}`}>
              <span title={kf.param}>{layerName(kf.layerId)}</span>
              <KeyChips kf={kf} />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
