// .oar zip IO: manifest.json + layers/*.png + thumbnail.png.
// Pure Uint8Array in/out — no DOM, so it runs in the browser, node tests and
// a future CLI alike.

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { OAR_VERSION, type OarManifest } from "./types";

export interface OarPackage {
  manifest: OarManifest;
  /** layer id -> PNG bytes */
  pngs: Map<string, Uint8Array>;
  thumbnail: Uint8Array | null;
}

/** PNG dimensions from the IHDR chunk (bytes 16..24, big-endian). */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export class OarError extends Error {}

export function validateManifest(raw: unknown): OarManifest {
  if (typeof raw !== "object" || raw === null) throw new OarError("manifest is not an object");
  const m = raw as Record<string, unknown>;
  if (m.format !== "oar") throw new OarError(`unknown format: ${String(m.format)}`);
  if (typeof m.version !== "number" || !Number.isInteger(m.version)) {
    throw new OarError("manifest version must be an integer");
  }
  if (m.version > OAR_VERSION) {
    throw new OarError(
      `oar version ${m.version} is newer than this app supports (${OAR_VERSION}) — refusing to guess`,
    );
  }
  for (const key of ["name", "canvas", "layers", "bones", "meshes", "correctives", "params"]) {
    if (!(key in m)) throw new OarError(`manifest missing "${key}"`);
  }
  const manifest = m as unknown as OarManifest;
  const ids = new Set<string>();
  for (const layer of manifest.layers) {
    if (ids.has(layer.id)) throw new OarError(`duplicate layer id ${layer.id}`);
    ids.add(layer.id);
  }
  return manifest;
}

export function writeOar(pkg: OarPackage): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(pkg.manifest, null, 2)),
  };
  for (const layer of pkg.manifest.layers) {
    const bytes = pkg.pngs.get(layer.id);
    if (!bytes) throw new OarError(`missing PNG data for layer ${layer.id} (${layer.name})`);
    files[layer.src] = bytes;
  }
  if (pkg.thumbnail) files["thumbnail.png"] = pkg.thumbnail;
  return zipSync(files, { level: 6 });
}

export function readOar(bytes: Uint8Array): OarPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new OarError(`not a zip file: ${(e as Error).message}`);
  }
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new OarError("manifest.json missing from .oar");
  const manifest = validateManifest(JSON.parse(strFromU8(manifestBytes)));
  const pngs = new Map<string, Uint8Array>();
  const errors: string[] = [];
  for (const layer of manifest.layers) {
    const data = files[layer.src];
    if (!data) {
      errors.push(`${layer.name}: file ${layer.src} missing`);
      continue;
    }
    const dims = pngDimensions(data);
    // width/height must match the PNG exactly, or layers render at the wrong
    // scale with no error anywhere.
    if (!dims || dims.width !== layer.width || dims.height !== layer.height) {
      errors.push(
        `${layer.name}: manifest says ${layer.width}x${layer.height}, PNG is ${dims?.width ?? "?"}x${dims?.height ?? "?"}`,
      );
      continue;
    }
    pngs.set(layer.id, data);
  }
  if (errors.length > 0) throw new OarError(errors.join("\n"));
  return { manifest, pngs, thumbnail: files["thumbnail.png"] ?? null };
}

/** "Export for studio": identical file minus editor-only data, with every
 *  core slot checked. Returns the stripped manifest plus a list of missing
 *  pieces — reported, never silently exported. */
export function stripForStudio(manifest: OarManifest): {
  manifest: OarManifest;
  problems: string[];
} {
  const out: OarManifest = JSON.parse(JSON.stringify(manifest));
  delete out.editor;
  const problems: string[] = [];
  const layerById = new Map(out.layers.map((l) => [l.id, l]));
  const meshById = new Map(out.meshes.map((m) => [m.id, m]));
  for (const layer of out.layers) {
    if (layer.mesh && !meshById.has(layer.mesh)) {
      problems.push(`layer ${layer.name} references missing mesh ${layer.mesh}`);
    }
    if (layer.clipTo && !layerById.has(layer.clipTo)) {
      problems.push(`layer ${layer.name} clips to missing layer ${layer.clipTo}`);
    }
  }
  for (const corr of out.correctives) {
    if (!meshById.has(corr.meshId)) problems.push(`corrective ${corr.name} references missing mesh`);
  }
  if (out.rig) {
    const eyes: [string, typeof out.rig.eyes.left][] = [
      ["left", out.rig.eyes.left],
      ["right", out.rig.eyes.right],
    ];
    for (const [side, eye] of eyes) {
      if (!eye.white) problems.push(`${side} eye has no eye-white layer`);
      if (eye.iris && !eye.white) problems.push(`${side} iris without a white will not clip`);
      if (eye.lashTop && eye.lidContour.length === 0) {
        problems.push(`${side} lash has no lid contour (fallback blink will be used)`);
      }
    }
    if (!out.rig.mouth.upperLip || !out.rig.mouth.lowerLip) {
      problems.push("mouth lips are not both resolved");
    }
    if (out.rig.mouth.apertureMesh && !meshById.has(out.rig.mouth.apertureMesh)) {
      problems.push("mouth aperture mesh is missing");
    }
  } else {
    problems.push("no rig block — model will not animate");
  }
  return { manifest: out, problems };
}
