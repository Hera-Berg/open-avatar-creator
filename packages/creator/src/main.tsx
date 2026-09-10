import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// ?sample=1 auto-loads the bundled sample. Doing it at module top level
// holds the document load event until the model is decoded — which lets
// headless screenshots and first-time users both see a working rig.
const params = new URLSearchParams(location.search);
if (params.has("sample") || params.has("diag")) {
  const { loadOar } = await import("./export/oarFile");
  const { useStore } = await import("./state/store");
  try {
    const result = await loadOar(await (await fetch("/sample-avatar.oar")).arrayBuffer());
    useStore.getState().setModel(result.manifest, result.pixels);
    useStore.getState().setPlayback({ demo: true });
  } catch (e) {
    console.error("sample load failed", e);
  }
}

if (params.has("diag")) {
  const { installDiagnosticsPanel } = await import("./diag");
  installDiagnosticsPanel();
}

// ?importtest[=file.psd] — run the real PSD import pipeline and log
// per-layer pixel statistics (headless-debuggable via console stdout).
if (params.has("importtest")) {
  const { importPsd } = await import("./import/psd");
  const { useStore } = await import("./state/store");
  const file = params.get("importtest") || "test.psd";
  try {
    const buffer = await (await fetch(`/${file}`)).arrayBuffer();
    const result = await importPsd(buffer, file, { targetSize: 2048 }, () => {});
    const lines: string[] = [];
    lines.push(`[importtest] layers=${result.manifest.layers.length} scale=${result.report.scale.toFixed(3)}`);
    for (const layer of result.manifest.layers) {
      const img = result.pixels.get(layer.id);
      let opaque = 0;
      let rgb: number[] = [0, 0, 0];
      if (img) {
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) opaque++;
        // sample centre pixel
        const cx = Math.floor(img.width / 2);
        const cy = Math.floor(img.height / 2);
        const ci = (cy * img.width + cx) * 4;
        rgb = [img.data[ci]!, img.data[ci + 1]!, img.data[ci + 2]!];
      }
      lines.push(
        `[importtest] ${layer.name} slot=${layer.slot} ${layer.width}x${layer.height} at (${layer.x},${layer.y}) opaquePx=${opaque} centre=${rgb.join(",")} clipTo=${layer.clipTo}`,
      );
    }
    lines.push(`[importtest] skipped=${result.report.skipped.map((s) => `${s.name}:${s.reason}`).join(" | ")}`);
    lines.push(`[importtest] bakedClips=${result.report.bakedClips.join(",")} runtimeClips=${result.report.runtimeClips.join(",")}`);
    console.log(lines.join("\n"));
    useStore.getState().setModel(result.manifest, result.pixels);
    useStore.getState().setPlayback({ demo: true });
    // Run the full auto-rig like the real import flow, then dump the mouth rig.
    const { runAutoRig } = await import("./autorig");
    const { assets } = await import("./state/store");
    const rig = runAutoRig(result.manifest, result.pixels, {
      classify: true, skeleton: true, bindings: true, meshes: true, physics: true, face: true,
    });
    useStore.getState().execute(rig.cmd);
    if (rig.cavityPixels && rig.faceRig?.cavityLayer) {
      assets.addPixels(rig.faceRig.cavityLayer.id, rig.cavityPixels);
    }
    const m = result.manifest;
    console.log("[importtest] rig warnings: " + rig.warnings.join(" | "));
    console.log(
      "[importtest] mouth: apertureMesh=" + m.rig?.mouth.apertureMesh +
      " apertureLayer=" + m.rig?.mouth.apertureLayer +
      " upperLip=" + m.rig?.mouth.upperLip +
      " lowerLip=" + m.rig?.mouth.lowerLip,
    );
    const lipInfo = (id: string | null | undefined) => {
      const l = id ? m.layers.find((x) => x.id === id) : null;
      return l ? `${l.name} (${l.x},${l.y} ${l.width}x${l.height} ord=${l.order} visible=${l.visible})` : "null";
    };
    console.log("[importtest] upper lip: " + lipInfo(m.rig?.mouth.upperLip));
    console.log("[importtest] lower lip: " + lipInfo(m.rig?.mouth.lowerLip));
    const cav = m.rig?.mouth.apertureLayer ? m.layers.find((x) => x.id === m.rig!.mouth.apertureLayer) : null;
    console.log("[importtest] cavity: " + (cav ? `ord=${cav.order} (${cav.x},${cav.y} ${cav.width}x${cav.height})` : "null"));
  } catch (e) {
    console.log(`[importtest] FAIL: ${(e as Error).message}\n${(e as Error).stack}`);
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Debug handle for automated checks (harmless in a local-only app).
void (async () => {
  const [{ useStore, assets }, { engineHolder }] = await Promise.all([
    import("./state/store"),
    import("./playback/engine"),
  ]);
  (window as unknown as Record<string, unknown>).__oar = { useStore, assets, engineHolder };
})();
