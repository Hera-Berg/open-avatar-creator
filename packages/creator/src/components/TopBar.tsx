// Top bar: file operations, playback, auto-rig, undo/redo.

import { useRef } from "react";
import { assets, useStore } from "../state/store";
import { importPsd, type ImportReport } from "../import/psd";
import { downloadTemplate } from "../import/template";
import { loadOar, saveOar, exportForStudio } from "../export/oarFile";
import { renderThumbnail } from "../export/thumbnail";
import { runAutoRig } from "../autorig";
import { engineHolder } from "../playback/engine";

export function TopBar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const oarRef = useRef<HTMLInputElement>(null);
  const playback = useStore((s) => s.playback);
  const trackerUrl = useStore((s) => s.trackerUrl);
  const debugFeed = useStore((s) => s.debugFeed);
  const undoLabel = useStore((s) => s.undoLabel);
  const redoLabel = useStore((s) => s.redoLabel);
  const model = useStore((s) => s.model);

  const handlePsd = async (file: File) => {
    const s = useStore.getState();
    s.setImportState({ active: true, current: "reading…", done: 0, total: 1, report: null });
    try {
      const buffer = await file.arrayBuffer();
      const result = await importPsd(buffer, file.name, { targetSize: 2048 }, (current, done, total) => {
        useStore.getState().setImportState({ active: true, current, done, total, report: null });
      });
      s.setModel(result.manifest, result.pixels);
      // A PSD imports and animates with no manual work (§18 step 14).
      const rig = runAutoRig(result.manifest, result.pixels, {
        classify: true,
        skeleton: true,
        bindings: true,
        meshes: true,
        physics: true,
        face: true,
      });
      useStore.getState().execute(rig.cmd);
      if (rig.cavityPixels && rig.faceRig?.cavityLayer) {
        assets.addPixels(rig.faceRig.cavityLayer.id, rig.cavityPixels);
      }
      const report: ImportReport & { rigWarnings: string[] } = {
        ...result.report,
        rigWarnings: rig.warnings,
      };
      useStore.getState().setImportState({ active: false, current: "", done: 1, total: 1, report });
      useStore.getState().setPlayback({ demo: true });
    } catch (e) {
      useStore.getState().setImportState(null);
      useStore.getState().setToast(`import failed: ${(e as Error).message}`);
    }
  };

  const handleOar = async (file: File) => {
    try {
      const result = await loadOar(await file.arrayBuffer());
      useStore.getState().setModel(result.manifest, result.pixels);
      useStore.getState().setToast(`loaded ${result.manifest.name}`);
    } catch (e) {
      useStore.getState().setToast(`load failed: ${(e as Error).message}`);
    }
  };

  const handleSave = async () => {
    const thumbnail = await renderThumbnail(model, assets.pixels);
    await saveOar(model, assets.pixels, thumbnail);
    useStore.getState().setToast("saved .oar");
  };

  const handleStudioExport = async () => {
    const thumbnail = await renderThumbnail(model, assets.pixels);
    const result = await exportForStudio(model, assets.pixels, thumbnail);
    if (result.ok) {
      useStore.getState().setToast("exported for studio");
    } else {
      useStore.getState().setStudioProblems(result.problems);
    }
  };

  const connected = playback.connection === "connected" || playback.connection === "connecting";

  return (
    <div className="topbar">
      <span className="brand">Open Avatar Creator</span>
      <button onClick={() => fileRef.current?.click()}>Import PSD…</button>
      <button onClick={() => oarRef.current?.click()}>Open .oar…</button>
      <button
        onClick={async () => {
          try {
            const result = await loadOar(await (await fetch("/sample-avatar.oar")).arrayBuffer());
            useStore.getState().setModel(result.manifest, result.pixels);
            useStore.getState().setPlayback({ demo: true });
            useStore.getState().setToast("loaded the sample avatar — Demo is on");
          } catch (e) {
            useStore.getState().setToast(`sample load failed: ${(e as Error).message}`);
          }
        }}
        title="Load the bundled sample model"
      >
        Load sample
      </button>
      <button onClick={handleSave}>Save .oar</button>
      <button onClick={handleStudioExport} title="Strip editor data and validate core slots">
        Export for studio
      </button>
      <button onClick={downloadTemplate} title="Download the §3 naming-convention template">
        Template PSD
      </button>
      <button onClick={() => useStore.getState().setNamingGuideOpen(true)}>Naming guide</button>
      <span className="divider" />
      <button
        className={playback.demo ? "active" : ""}
        onClick={() => useStore.getState().setPlayback({ demo: !playback.demo })}
        title="Sweep every parameter, out of phase"
      >
        Demo
      </button>
      <button
        className={playback.paused ? "active" : ""}
        onClick={() => engineHolder.current?.togglePause()}
        title="Freeze the current pose (Space)"
      >
        {playback.paused ? "Resume" : "Pause"}
      </button>
      <input
        className="wsurl"
        value={trackerUrl}
        onChange={(e) => useStore.getState().setTrackerUrl(e.target.value)}
        title="Tracker websocket URL"
        spellCheck={false}
      />
      <label className="check" title="Second socket carrying the 52 raw blendshapes (mouth detail)">
        <input type="checkbox" checked={debugFeed} onChange={(e) => useStore.getState().setDebugFeed(e.target.checked)} />
        blendshapes
      </label>
      <button
        className={connected ? "active" : ""}
        onClick={() => {
          const engine = engineHolder.current;
          if (!engine) return;
          if (connected) engine.disconnect();
          else {
            const debugUrl = debugFeed
              ? trackerUrl.replace(/\/ws\/v1\/tracking$/, "/ws/v1/debug")
              : null;
            engine.connect(trackerUrl, debugUrl);
          }
        }}
      >
        {connected ? `Disconnect (${playback.connection})` : "Connect"}
      </button>
      <button onClick={() => useStore.getState().setAutoRigOpen(true)} title="Re-run auto-rig per part">
        Auto-rig…
      </button>
      <span className="spacer" />
      <button onClick={() => useStore.getState().undo()} disabled={!undoLabel} title={undoLabel ?? ""}>
        ↶ {undoLabel ? shorten(undoLabel) : "Undo"}
      </button>
      <button onClick={() => useStore.getState().redo()} disabled={!redoLabel} title={redoLabel ?? ""}>
        ↷ {redoLabel ? shorten(redoLabel) : "Redo"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".psd"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handlePsd(f);
          e.target.value = "";
        }}
      />
      <input
        ref={oarRef}
        type="file"
        accept=".oar,.zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleOar(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function shorten(label: string): string {
  return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}
