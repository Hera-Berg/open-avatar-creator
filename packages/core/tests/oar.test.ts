import { describe, it, expect } from "vitest";
import { strFromU8 } from "fflate";
import {
  writeOar,
  readOar,
  pngDimensions,
  stripForStudio,
  OarError,
} from "../src/model/oar";
import { padPixels, hasTransparentBorder, alphaBBox, cropPixels } from "../src/geometry/pixels";
import { makeModel, makeLayer, fakePng, solidImage, rectImage } from "./helpers";
import type { OarManifest } from "../src/model/types";

function samplePackage() {
  const layerA = makeLayer({ id: "l_a", name: "head", width: 4, height: 4, src: "layers/a.png" });
  const layerB = makeLayer({ id: "l_b", name: "hair", width: 8, height: 2, src: "layers/b.png", order: 1 });
  const manifest = makeModel({ layers: [layerA, layerB] });
  const pngs = new Map<string, Uint8Array>([
    ["l_a", fakePng(4, 4)],
    ["l_b", fakePng(8, 2)],
  ]);
  return { manifest, pngs, thumbnail: null };
}

describe(".oar IO", () => {
  it("round-trips: load → save produces a byte-comparable manifest", () => {
    const pkg = samplePackage();
    const bytes1 = writeOar(pkg);
    const loaded = readOar(bytes1);
    expect(loaded.manifest).toEqual(pkg.manifest);
    const bytes2 = writeOar(loaded);
    const m1 = JSON.parse(strFromU8(bytes1.slice(0, 0) || new Uint8Array()) || "null");
    void m1;
    // Compare the manifest JSON content of both zips.
    const man1 = readOar(bytes1).manifest;
    const man2 = readOar(bytes2).manifest;
    expect(JSON.stringify(man1)).toBe(JSON.stringify(man2));
  });

  it("reads PNG dimensions from IHDR", () => {
    expect(pngDimensions(fakePng(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("refuses width/height mismatches loudly", () => {
    const pkg = samplePackage();
    pkg.pngs.set("l_a", fakePng(99, 4)); // manifest says 4x4
    expect(() => readOar(writeOar(pkg))).toThrow(OarError);
  });

  it("refuses unknown newer versions", () => {
    const pkg = samplePackage();
    const manifest: OarManifest = { ...pkg.manifest, version: 99 };
    expect(() => readOar(writeOar({ ...pkg, manifest }))).toThrow(/newer than/);
  });

  it("rejects non-oar formats", () => {
    const pkg = samplePackage();
    const manifest = { ...pkg.manifest, format: "something" } as unknown as OarManifest;
    expect(() => readOar(writeOar({ ...pkg, manifest }))).toThrow(OarError);
  });

  it("studio export strips editor data and reports missing slots", () => {
    const pkg = samplePackage();
    const manifest: OarManifest = {
      ...pkg.manifest,
      editor: { selection: ["l_a"] },
    };
    const { manifest: stripped, problems } = stripForStudio(manifest);
    expect(stripped.editor).toBeUndefined();
    expect(problems.some((p) => p.includes("no rig block"))).toBe(true);
  });
});

describe("texture margins", () => {
  it("every padded layer has a fully transparent border", () => {
    const img = solidImage(10, 10, 255); // fully opaque to the very edge
    const padded = padPixels(img, 1);
    expect(hasTransparentBorder(padded, 1)).toBe(true);
    expect(hasTransparentBorder(img, 1)).toBe(false); // unpadded control
  });

  it("alpha bbox + crop is exact at full resolution", () => {
    const img = rectImage(20, 20, { x: 3, y: 5, width: 7, height: 9 });
    const box = alphaBBox(img)!;
    expect(box).toEqual({ x: 3, y: 5, width: 7, height: 9 });
    const cropped = cropPixels(img, box);
    expect(cropped.width).toBe(7);
    expect(cropped.height).toBe(9);
    expect(alphaBBox(cropped)).toEqual({ x: 0, y: 0, width: 7, height: 9 });
  });

  it("empty images crop to null rather than crashing", () => {
    expect(alphaBBox(solidImage(10, 10, 0))).toBeNull();
  });
});
