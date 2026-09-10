// Thumbnail: render the model at rest pose to a small offscreen canvas.

import { Renderer } from "@oar/renderer";
import { solveModel, createSolveContext, withDriverDefaults, deriveLashLowerEdge, type OarManifest, type PixelImage } from "@oar/core";

export async function renderThumbnail(
  model: OarManifest,
  pixels: Map<string, PixelImage>,
  width = 320,
): Promise<Uint8Array | null> {
  try {
    const scale = width / model.canvas.width;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(model.canvas.height * scale);
    const renderer = new Renderer(canvas);
    for (const [id, img] of pixels) {
      renderer.setTexture(id, new ImageData(new Uint8ClampedArray(img.data), img.width, img.height));
    }
    const ctx = createSolveContext();
    ctx.meshes = new Map(model.meshes.map((m) => [m.id, m]));
    for (const side of ["left", "right"] as const) {
      const lashId = model.rig?.eyes[side].lashTop;
      const layer = lashId ? model.layers.find((l) => l.id === lashId) : null;
      const img = lashId ? pixels.get(lashId) : null;
      if (layer && img) {
        ctx.eyeRuntime[side].lashLower = deriveLashLowerEdge(img, layer.x, layer.y);
      }
    }
    const solved = solveModel(model, withDriverDefaults({}), ctx);
    renderer.draw(solved, {
      x: model.canvas.width / 2,
      y: model.canvas.height / 2,
      zoom: scale,
    });
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch (e) {
    console.warn("thumbnail render failed", e);
    return null;
  }
}
