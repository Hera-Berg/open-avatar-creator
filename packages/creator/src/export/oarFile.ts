// .oar save / load / studio export. There is no separate project format:
// the runtime file IS the save file.

import {
  writeOar,
  readOar,
  stripForStudio,
  type OarManifest,
  type PixelImage,
} from "@oar/core";

export function downloadBytes(bytes: Uint8Array, filename: string, type = "application/zip"): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Encode straight-alpha pixels to PNG bytes via a canvas. */
export async function encodePng(img: PixelImage): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encode failed");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function decodePng(bytes: Uint8Array): Promise<PixelImage> {
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: data.width, height: data.height, data: data.data };
}

export async function saveOar(
  manifest: OarManifest,
  pixels: Map<string, PixelImage>,
  thumbnail: Uint8Array | null,
  filename?: string,
): Promise<void> {
  const pngs = new Map<string, Uint8Array>();
  for (const layer of manifest.layers) {
    const img = pixels.get(layer.id);
    if (img) pngs.set(layer.id, await encodePng(img));
  }
  const bytes = writeOar({ manifest, pngs, thumbnail });
  downloadBytes(bytes, filename ?? `${manifest.name || "avatar"}.oar`);
}

export interface StudioExportResult {
  ok: boolean;
  problems: string[];
}

/** "Export for studio": strips editor-only data and refuses to silently
 *  export a model whose core slots do not resolve. */
export async function exportForStudio(
  manifest: OarManifest,
  pixels: Map<string, PixelImage>,
  thumbnail: Uint8Array | null,
): Promise<StudioExportResult> {
  const { manifest: stripped, problems } = stripForStudio(manifest);
  if (problems.length > 0) return { ok: false, problems };
  await saveOar(stripped, pixels, thumbnail, `${manifest.name || "avatar"}-studio.oar`);
  return { ok: true, problems: [] };
}

export interface LoadResult {
  manifest: OarManifest;
  pixels: Map<string, PixelImage>;
  thumbnail: Uint8Array | null;
}

export async function loadOar(buffer: ArrayBuffer): Promise<LoadResult> {
  const pkg = readOar(new Uint8Array(buffer));
  const pixels = new Map<string, PixelImage>();
  for (const [id, bytes] of pkg.pngs) {
    pixels.set(id, await decodePng(bytes));
  }
  return { manifest: pkg.manifest, pixels, thumbnail: pkg.thumbnail };
}
