// Modal dialogs: import progress + report, naming guide, studio-export
// problems, auto-rig options.

import { useState } from "react";
import { useStore, assets } from "../state/store";
import { downloadTemplate } from "../import/template";
import { runAutoRig, type AutoRigOptions } from "../autorig";
import type { ImportReport } from "../import/psd";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ImportDialog() {
  const state = useStore((s) => s.importState);
  if (!state) return null;
  if (state.active) {
    return (
      <Modal title="Importing PSD" onClose={() => {}}>
        <div className="progress">
          <div className="bar" style={{ width: `${(state.done / Math.max(1, state.total)) * 100}%` }} />
        </div>
        <div className="hint">{state.current}</div>
      </Modal>
    );
  }
  const report = state.report as (ImportReport & { rigWarnings?: string[] }) | null;
  if (!report) return null;
  return (
    <Modal title="Import report" onClose={() => useStore.getState().setImportState(null)}>
      <Section title={`${report.imported.length} layers imported (${report.recognised} slots recognised)`} items={[]} />
      <Expandable title={`unrecognised (${report.unrecognised.length})`} items={report.unrecognised} />
      <Expandable title={`hidden layers recovered (${report.recoveredHidden.length})`} items={report.recoveredHidden} />
      <Expandable
        title={`skipped (${report.skipped.length})`}
        items={report.skipped.map((s) => `${s.name} — ${s.reason}`)}
      />
      <Expandable title={`clipping baked (${report.bakedClips.length})`} items={report.bakedClips} />
      <Expandable
        title={`clipping deferred to runtime (${report.runtimeClips.length})`}
        items={report.runtimeClips}
      />
      {report.missingCoreSlots.length > 0 && (
        <div className="warning">
          <strong>Missing core slots:</strong>
          <ul>
            {report.missingCoreSlots.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          The model will import and render, but these parts will not animate until the layers exist.
        </div>
      )}
      {(report.rigWarnings?.length ?? 0) > 0 && (
        <Expandable title={`auto-rig notes (${report.rigWarnings!.length})`} items={report.rigWarnings!} />
      )}
      <div className="hint">Downscaled by {(report.scale * 100).toFixed(0)}% to fit the 2048px target.</div>
    </Modal>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <strong>{title}</strong>
      {items.length > 0 && (
        <ul>
          {items.map((i, k) => (
            <li key={k}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Expandable({ title, items }: { title: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="expandable">
      <div onClick={() => setOpen(!open)} className="expandable-head">
        {open ? "▾" : "▸"} {title}
      </div>
      {open && (
        <ul>
          {items.map((i, k) => (
            <li key={k}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NamingGuide() {
  const open = useStore((s) => s.namingGuideOpen);
  if (!open) return null;
  return (
    <Modal title="Layer naming guide" onClose={() => useStore.getState().setNamingGuideOpen(false)}>
      <h4>The one rule that costs a redraw: draw what is underneath.</h4>
      <p>
        Every layer must be complete, including the parts nothing shows directly. Depth parallax slides
        layers against each other — the moment the head turns, hair moves relative to the face and reveals
        what is behind it. <em>Overdraw is free. Holes are not.</em>
      </p>
      <h4>Names</h4>
      <ul>
        <li>
          <code>kebab-case</code>, lowercase, with <code>-left</code> / <code>-right</code> / <code>-middle</code>{" "}
          suffixes. Matching is case- and separator-insensitive: <code>eye-white-left</code>,{" "}
          <code>Eye White Left</code> and <code>eyeWhiteLeft</code> are the same layer.
        </li>
        <li>Group names are context, not the binding: a layer called <code>iris</code> inside <code>Left Eye</code> resolves correctly.</li>
        <li>
          <strong>-left means the character's own left</strong> — the right side of the canvas as you look at
          it. Position always wins over the name for symmetric parts.
        </li>
        <li>Numbered strands are allowed where a slot accepts several layers: <code>hair-back-01</code>, <code>hair-back-02</code>.</li>
        <li>Tag throwaway layers <code>[DELETE]</code> and they are dropped at import. Empty groups are fine.</li>
      </ul>
      <h4>Canonical structure</h4>
      <pre>{`Back Hair/        hair-back-left, hair-back-middle, hair-back-right
Arms/Left Arm/    arm-left
torso
Legs/Left Leg/    leg-left
Hips/hips · Neck/Neck · Chest/chest
Head/
  head
  Inner Mouth/    Mouth_Back, Back_Teeth, Tongue, Lower_Teeth, Upper_Teeth
  Mouth/          bottom-lip, top-lip
  Nose/nose
  Eyes/Left Eye/  eye-white-left, iris-left (clipped to the white), eyelash-top-left
Blush
Mid Hair/         hair-middle-left, hair-middle-right
Bangs/            hair-front-left, hair-front-middle, hair-front-right
Eyebrows/         eyebrow-left, eyebrow-right`}</pre>
      <h4>Optional but worth it</h4>
      <ul>
        <li><code>eyelash-bottom-*</code> — lower lid; acceptable when missing.</li>
        <li><code>eye-closed-*</code> — drawn blink artwork always beats the procedural blink.</li>
        <li><code>mouth-open</code> — falls back to lip parting; usually fine.</li>
        <li><code>hair-side-*</code> — otherwise side locks bind to hair-back and inherit heavier physics.</li>
      </ul>
      <button onClick={downloadTemplate}>Download template PSD</button>
    </Modal>
  );
}

export function StudioProblemsDialog() {
  const problems = useStore((s) => s.studioProblems);
  if (!problems) return null;
  return (
    <Modal title="Cannot export for studio yet" onClose={() => useStore.getState().setStudioProblems(null)}>
      <p>The following must resolve first — nothing was exported:</p>
      <ul>
        {problems.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </Modal>
  );
}

export function AutoRigDialog() {
  const open = useStore((s) => s.autoRigOpen);
  const model = useStore((s) => s.model);
  const [opts, setOpts] = useState<AutoRigOptions>({
    classify: true,
    skeleton: true,
    bindings: true,
    meshes: true,
    physics: true,
    face: true,
  });
  if (!open) return null;
  const toggle = (key: keyof AutoRigOptions) => (
    <label className="check" key={key}>
      <input type="checkbox" checked={opts[key]} onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })} />
      {key}
    </label>
  );
  return (
    <Modal title="Re-run auto-rig" onClose={() => useStore.getState().setAutoRigOpen(false)}>
      <p>Regenerate only the parts you choose — hand edits elsewhere survive.</p>
      {toggle("classify")}
      {toggle("skeleton")}
      {toggle("bindings")}
      {toggle("meshes")}
      {toggle("physics")}
      {toggle("face")}
      <div className="row">
        <button
          onClick={() => {
            const s = useStore.getState();
            const result = runAutoRig(model, assets.pixels, opts);
            s.execute(result.cmd);
            if (result.cavityPixels && result.faceRig?.cavityLayer) {
              assets.addPixels(result.faceRig.cavityLayer.id, result.cavityPixels);
            }
            s.setAutoRigOpen(false);
            s.setToast(
              result.warnings.length > 0
                ? `auto-rig done (${result.warnings.length} notes — see console)`
                : "auto-rig done",
            );
            for (const w of result.warnings) console.warn("[auto-rig]", w);
          }}
        >
          Run
        </button>
      </div>
    </Modal>
  );
}
