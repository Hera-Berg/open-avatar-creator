// Right panel: bone/layer properties, physics, driver parameters, mesh
// generation, and the §8 corrective banner.

import {
  DRIVER_SLIDERS,
  RIG_PARAM_DEFAULTS,
  rigParam,
  generateMesh,
  newId,
  radToDeg,
  type DriverParam,
  type OarPhysics,
  type Vec2,
} from "@oar/core";
import { assets, useStore } from "../state/store";
import {
  addMesh,
  deleteCorrective,
  setBoneField,
  setLayerField,
  setPhysics,
  setRigParam,
  setVerticesAbsolute,
} from "../state/ops";
import { engineHolder } from "../playback/engine";
import { useState } from "react";

const PHYSICS_DEFAULT: OarPhysics = {
  enabled: true,
  stiffness: 6,
  damping: 0.85,
  maxAngle: 12,
  inertia: 1,
  gravity: 0.5,
  pivot: "top",
  customPivot: null,
};

function BoneSection() {
  const selection = useStore((s) => s.selection);
  const model = useStore((s) => s.model);
  const bone = model.bones.find((b) => b.id === selection.bones[0]);
  if (!bone) return null;
  return (
    <section>
      <h3>Bone</h3>
      <label>
        name{" "}
        <input
          value={bone.name}
          onChange={(e) => useStore.getState().execute(setBoneField(bone.id, "name", e.target.value, "rename bone", true))}
        />
      </label>
      <label>
        follow {bone.follow.toFixed(2)}
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={bone.follow}
          onChange={(e) =>
            useStore.getState().execute(setBoneField(bone.id, "follow", Number(e.target.value), "follow", true))
          }
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={bone.locked}
          onChange={(e) => useStore.getState().execute(setBoneField(bone.id, "locked", e.target.checked, "lock bone"))}
        />
        locked (pinned in world space)
      </label>
      <div className="hint">pose rotation {(radToDeg(bone.rotation)).toFixed(1)}°</div>
    </section>
  );
}

function LayerSection() {
  const selection = useStore((s) => s.selection);
  const model = useStore((s) => s.model);
  const layer = model.layers.find((l) => l.id === selection.layers[0]);
  const [density, setDensity] = useState<"coarse" | "medium" | "fine">("coarse");
  if (!layer) return null;
  const mesh = layer.mesh ? model.meshes.find((m) => m.id === layer.mesh) : null;
  return (
    <section>
      <h3>Layer</h3>
      <label>
        name{" "}
        <input
          value={layer.name}
          onChange={(e) => useStore.getState().execute(setLayerField(layer.id, "name", e.target.value, "rename layer", true))}
        />
      </label>
      <div className="hint">
        slot {layer.slot ?? "—"}
        {layer.side ? ` (${layer.side})` : ""} · order {layer.order}
        {layer.clipTo ? " · clipped at runtime" : ""}
      </div>
      <label>
        opacity {layer.opacity.toFixed(2)}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={layer.opacity}
          onChange={(e) => useStore.getState().execute(setLayerField(layer.id, "opacity", Number(e.target.value), "opacity", true))}
        />
      </label>
      <div className="mesh-row">
        {mesh ? (
          <span className="hint">
            mesh: {mesh.vertices.length} verts / {mesh.triangles.length} tris
          </span>
        ) : (
          <>
            <select value={density} onChange={(e) => setDensity(e.target.value as typeof density)}>
              <option value="coarse">coarse (~40 verts)</option>
              <option value="medium">medium (~120)</option>
              <option value="fine">fine (~400)</option>
            </select>
            <button
              onClick={() => {
                const img = assets.pixels.get(layer.id);
                if (!img) {
                  useStore.getState().setToast("no pixels for this layer");
                  return;
                }
                // Coarse is the right default: more vertices is more to
                // hand-edit, not better.
                const mesh = generateMesh(newId("m"), img, layer.x, layer.y, density);
                useStore.getState().execute(addMesh(mesh, layer.id));
              }}
            >
              Generate mesh
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function PhysicsSection() {
  const selection = useStore((s) => s.selection);
  const model = useStore((s) => s.model);
  const layer = model.layers.find((l) => l.id === selection.layers[0]);
  const params = model.params;
  const global = (key: keyof typeof RIG_PARAM_DEFAULTS, label: string, min = 0, max = 3, step = 0.05) => (
    <label key={key}>
      {label} {rigParam(params, key).toFixed(2)}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={rigParam(params, key)}
        onChange={(e) => useStore.getState().execute(setRigParam(key, Number(e.target.value)))}
      />
    </label>
  );
  return (
    <section>
      <h3>Physics {layer ? `— ${layer.name}` : "(globals)"}</h3>
      {layer && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={!!layer.physics?.enabled}
              onChange={(e) =>
                useStore
                  .getState()
                  .execute(
                    setPhysics(layer.id, e.target.checked ? { ...(layer.physics ?? PHYSICS_DEFAULT), enabled: true } : null),
                  )
              }
            />
            enabled
          </label>
          {layer.physics?.enabled && (
            <>
              {(
                [
                  ["stiffness", 1, 20, 0.5, "how hard it springs back"],
                  ["damping", 0.5, 0.98, 0.01, "energy retained per frame"],
                  ["maxAngle", 0, 45, 1, "clamp, degrees"],
                  ["inertia", 0, 2, 0.05, "how much driver motion it picks up"],
                  ["gravity", 0, 1, 0.05, "how much it hangs"],
                ] as const
              ).map(([key, min, max, step, hint]) => (
                <label key={key} title={hint}>
                  {key} {(layer.physics![key] as number).toFixed(2)}
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={layer.physics![key] as number}
                    onChange={(e) =>
                      useStore
                        .getState()
                        .execute(setPhysics(layer.id, { ...layer.physics!, [key]: Number(e.target.value) }))
                    }
                  />
                </label>
              ))}
              <label>
                pivot{" "}
                <select
                  value={layer.physics.pivot}
                  onChange={(e) =>
                    useStore
                      .getState()
                      .execute(
                        setPhysics(layer.id, { ...layer.physics!, pivot: e.target.value as OarPhysics["pivot"] }),
                      )
                  }
                >
                  <option value="top">top (hangs — hair)</option>
                  <option value="bottom">bottom (flicks — ears)</option>
                  <option value="centre">centre</option>
                </select>
              </label>
            </>
          )}
        </>
      )}
      <h4>Global multipliers</h4>
      {global("bounce", "bounce (master amplitude)")}
      {global("softness", "softness (master settle time)", 0.2, 3)}
      {global("hairSwayX", "hair sway — horizontal")}
      {global("hairSwayY", "hair sway — vertical")}
      {global("chestSwayX", "chest sway — horizontal")}
      {global("chestSwayY", "chest sway — vertical")}
      {global("hairJiggle", "hair jiggle (energy retention)")}
      {global("chestJiggle", "chest jiggle (energy retention)")}
    </section>
  );
}

function ParamsSection() {
  const playback = useStore((s) => s.playback);
  const model = useStore((s) => s.model);
  const [open, setOpen] = useState(false);
  const manual = playback.manual;
  return (
    <section>
      <h3 onClick={() => setOpen(!open)} className="collapsible">
        Parameters {open ? "▾" : "▸"}
      </h3>
      {open && (
        <>
          {DRIVER_SLIDERS.map((s) => {
            const value = manual[s.key] ?? engineHolder.current?.frame.params[s.key] ?? 0;
            return (
              <label key={s.key}>
                {s.label} {value.toFixed(2)}
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={0.01}
                  value={value}
                  onChange={(e) =>
                    useStore.getState().setManualParam(s.key as DriverParam, Number(e.target.value))
                  }
                />
              </label>
            );
          })}
          <button onClick={() => useStore.getState().setPlayback({ manual: {} })}>clear manual pose</button>
          <h4>Rig tuning</h4>
          {(
            [
              ["blinkFloor", "Blink sensitivity", 0, 0.8],
              ["lashInvert", "Lash inversion", 0, 1],
              ["mouthGain", "Mouth gain", 0.5, 3],
              ["mouthWidthScale", "Mouth width confinement", 1, 3],
              ["mouthCorner", "Mouth corner length", 0.4, 1.2],
              ["hairWarpFollow", "Hair warp follow", 0, 1],
              ["headPitchDeg", "Head pitch warp (deg)", 0, 20],
              ["headParallaxPx", "Hair parallax (px/step)", 0, 10],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key}>
              {label} {rigParam(model.params, key).toFixed(2)}
              <input
                type="range"
                min={min}
                max={max}
                step={0.01}
                value={rigParam(model.params, key)}
                onChange={(e) => useStore.getState().execute(setRigParam(key, Number(e.target.value)))}
              />
            </label>
          ))}
        </>
      )}
    </section>
  );
}

/** The §8 banner: paused mesh edits become a corrective keyed to the pose. */
function CorrectiveBanner() {
  const draft = useStore((s) => s.correctiveDraft);
  const model = useStore((s) => s.model);
  const corr = model.correctives.find((c) => c.id === draft?.correctiveId);
  if (!draft || !corr) return null;
  const params = engineHolder.current?.frame.params;
  const keys = params ? Object.keys(params) : [];

  const updateDriver = (patch: Partial<typeof corr.driver>) => {
    useStore.getState().execute({
      label: "edit corrective driver",
      time: Date.now(),
      apply: (m) => {
        const c = m.correctives.find((x) => x.id === corr.id);
        if (c) Object.assign(c.driver, patch);
      },
      revert: (m) => {
        void m;
      },
    });
  };

  const makePermanent = () => {
    // Bake the corrective offsets into the base mesh rest positions.
    const s = useStore.getState();
    const indices = Object.keys(corr.offsets).map(Number);
    const positions: Vec2[] = indices.map((i) => {
      const mesh = s.model.meshes.find((m) => m.id === corr.meshId);
      const v: Vec2 = mesh?.vertices[i] ? [...mesh.vertices[i]!] as Vec2 : [0, 0];
      const off = corr.offsets[String(i)] ?? [0, 0];
      return [v[0] + off[0], v[1] + off[1]] as Vec2;
    });
    s.execute(setVerticesAbsolute(corr.meshId, indices, positions, "bake corrective into base mesh"));
    const del = deleteCorrective(corr.id);
    if (del) s.execute(del);
    s.setCorrectiveDraft(null);
  };

  return (
    <section className="banner">
      <h3>Corrective</h3>
      <div className="hint">
        Editing at {corr.driver.param} = {corr.driver.value.toFixed(2)} — changes apply near this pose.
      </div>
      <label>
        driver{" "}
        <select
          value={corr.driver.param}
          onChange={(e) => {
            const key = e.target.value;
            const value = params?.[key as keyof typeof params] ?? 0;
            updateDriver({ param: key, value });
          }}
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {k} ({params?.[k as keyof typeof params]?.toFixed(2)})
            </option>
          ))}
        </select>
      </label>
      <label>
        falloff {corr.driver.falloff.toFixed(2)}
        <input
          type="range"
          min={0.1}
          max={3}
          step={0.05}
          value={corr.driver.falloff}
          onChange={(e) => updateDriver({ falloff: Number(e.target.value) })}
        />
      </label>
      <div className="row">
        <button onClick={makePermanent} title="Bake into the base mesh instead of a pose corrective">
          Make permanent
        </button>
        <button onClick={() => useStore.getState().setCorrectiveDraft(null)}>Done</button>
        <button
          onClick={() => {
            const s = useStore.getState();
            const del = deleteCorrective(corr.id);
            if (del) s.execute(del);
            s.setCorrectiveDraft(null);
          }}
        >
          Discard
        </button>
      </div>
    </section>
  );
}

function CorrectiveList() {
  const model = useStore((s) => s.model);
  if (model.correctives.length === 0) return null;
  return (
    <section>
      <h3>Correctives ({model.correctives.length})</h3>
      {model.correctives.map((c) => (
        <div key={c.id} className="corr-row">
          <span>{c.name}</span>
          <button
            onClick={() => {
              const del = deleteCorrective(c.id);
              if (del) useStore.getState().execute(del);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}

export function SidePanel() {
  return (
    <div className="side-panel">
      <CorrectiveBanner />
      <BoneSection />
      <LayerSection />
      <PhysicsSection />
      <ParamsSection />
      <CorrectiveList />
    </div>
  );
}
