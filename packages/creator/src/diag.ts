// ?diag=1 — a live on-screen diagnostics panel that answers where the render
// pipeline stops: engine running? textures uploaded? solve producing layers?
// GL errors? and — the decisive one — does the GL canvas contain anything but
// the clear colour right after a draw?

import { assets, useStore } from "./state/store";
import type { Engine } from "./playback/engine";

export function installDiagnosticsPanel(): void {
  const el = document.createElement("pre");
  el.id = "diag-panel";
  el.style.cssText =
    "position:fixed;top:44px;left:268px;z-index:80;background:rgba(10,10,14,0.92);color:#8fe08f;" +
    "padding:10px 12px;font:11px/1.5 monospace;border:1px solid #2a2d36;border-radius:6px;pointer-events:none;white-space:pre-wrap;max-width:460px;";
  document.body.appendChild(el);

  let frame = 0;
  const update = (engine: Engine | null) => {
    frame++;
    const s = useStore.getState();
    const lines: string[] = [];
    lines.push(`frame ${frame}`);
    lines.push(`engine: ${engine ? `running fps=${engine.frame.fps.toFixed(1)}` : "MISSING"}`);
    lines.push(`model: layers=${s.model.layers.length} bones=${s.model.bones.length} meshes=${s.model.meshes.length} canvas=${s.model.canvas.width}x${s.model.canvas.height}`);
    lines.push(`pixels: ${assets.pixels.size} images`);
    if (engine) {
      const solved = engine.frame.solved;
      lines.push(
        `solved: ${solved ? `${solved.layers.length} layers, visible=${solved.layers.filter((l) => l.visible).length}` : "null (tick never reached draw)"}`,
      );
      const canvas = document.querySelector<HTMLCanvasElement>(".glcanvas");
      if (canvas) {
        lines.push(`canvas buffer: ${canvas.width}x${canvas.height}`);
        const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
        if (gl && solved) {
          // Draw and read back in the same task so the drawing buffer is valid.
          engine.renderer.draw(solved, s.camera);
          const errs: number[] = [];
          let err: number;
          while ((err = gl.getError()) !== 0) errs.push(err);
          lines.push(`gl errors: ${errs.length > 0 ? errs.join(",") : "none"}`);
          const w = Math.min(canvas.width, 256);
          const h = Math.min(canvas.height, 256);
          const px = new Uint8Array(w * h * 4);
          // Sample the framebuffer CENTRE (GL origin is lower-left).
          gl.readPixels(
            Math.floor((canvas.width - w) / 2),
            Math.floor((canvas.height - h) / 2),
            w,
            h,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            px,
          );
          let nonBg = 0;
          let maxA = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i]! > 60 || px[i + 1]! > 60 || px[i + 2]! > 70) nonBg++;
            if (px[i + 3]! > maxA) maxA = px[i + 3]!;
          }
          lines.push(`readback: nonBg=${nonBg}/${w * h} maxAlpha=${maxA}`);
          const vis = solved.layers.find((l) => l.visible);
          if (vis) {
            lines.push(
              `sample layer: ${vis.id} alpha=${vis.alpha.toFixed(2)} p0=[${vis.positions[0]![0].toFixed(0)},${vis.positions[0]![1].toFixed(0)}] tris=${vis.triangles.length}`,
            );
            const img = assets.pixels.get(vis.id);
            if (img) {
              let alpha = 0;
              for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) alpha++;
              lines.push(`sample texture: ${img.width}x${img.height} opaquePx=${alpha}`);
            } else {
              lines.push("sample texture: MISSING from store");
            }
          }
        }
      }
    }
    // Rig section: mouth path, cavity order, face-slot order table.
    const rig = s.model.rig;
    if (rig) {
      lines.push("--- rig ---");
      lines.push(
        `head: ${rig.head ? `centre=[${rig.head.centre.join(",")}] radius=[${rig.head.radius.join(",")}]` : "null"}`,
      );
      for (const side of ["left", "right"] as const) {
        const e = rig.eyes[side];
        lines.push(
          `eye ${side}: white=${!!e.white} iris=${!!e.iris} lash=${!!e.lashTop} closed=${!!e.closed} contour=${e.lidContour.length}pt range=[${e.irisRange.join(",")}]`,
        );
      }
      const m = rig.mouth;
      const lipRect = (id: string | null) => {
        const l = id ? s.model.layers.find((x) => x.id === id) : null;
        return l ? `(${l.x},${l.y} ${l.width}x${l.height} ord=${l.order})` : "null";
      };
      lines.push(`mouth upperLip: ${lipRect(m.upperLip)}`);
      lines.push(`mouth lowerLip: ${lipRect(m.lowerLip)}`);
      lines.push(
        `mouth aperture: ${m.apertureMesh ? `BUILT (${m.apertureMesh})` : "FALLBACK (no aperture mesh)"} cavityLayer=${m.apertureLayer}`,
      );
      const cav = m.apertureLayer ? s.model.layers.find((x) => x.id === m.apertureLayer) : null;
      if (cav) lines.push(`cavity order: ${cav.order}`);
      lines.push(`hair params: warpFollow=${(s.model.params.hairWarpFollow ?? 0.6).toFixed(2)} parallaxPx=${s.model.params.headParallaxPx ?? 3}`);
    }
    el.textContent = lines.join("\n");
    if (frame <= 8 || frame % 20 === 0) {
      // Headless debugging: devtools.console.stdout.content echoes this.
      console.log("[diag]\n" + lines.join("\n"));
    }
  };

  const timer = setInterval(() => {
    import("./playback/engine").then(({ engineHolder }) => update(engineHolder.current));
  }, 500);
  window.addEventListener("beforeunload", () => clearInterval(timer));
}
