import { describe, it, expect } from "vitest";
import {
  applyKeyforms,
  bracketKeys,
  interpolatedKey,
  keyIndexAt,
  upsertKey,
} from "../src/keyforms";
import { buildBlinkKeyforms } from "../src/keyforms/blink";
import { deriveLidContour, deriveLashLowerEdge } from "../src/face/eyes";
import { sampleContour } from "../src/geometry/contour";
import { subdivideQuad } from "../src/geometry/triangulate";
import { createSolveContext, solveModel } from "../src/solve";
import { emptyRig, type OarKeyform, type OarLayer, type OarMesh, type Vec2 } from "../src/model/types";
import { stripForStudio, validateManifest } from "../src/model/oar";
import { makeBone, makeLayer, makeModel, rectImage } from "./helpers";

function kf(keys: OarKeyform["keys"], over: Partial<OarKeyform> = {}): OarKeyform {
  return { id: "k1", name: "k", layerId: "l1", meshId: "m1", param: "eye_l_open", keys, ...over };
}

describe("keyform interpolation", () => {
  const keys = [
    { value: 0, offsets: { "0": [0, 10] as Vec2 }, opacity: 0 },
    { value: 1, offsets: {}, opacity: 1 },
  ];

  it("interpolates linearly between the bracketing keys", () => {
    const r = applyKeyforms([kf(keys)], "l1", "m1", [[5, 5]], { eye_l_open: 0.25 });
    expect(r.vertices![0]).toEqual([5, 12.5]);
    expect(r.opacity).toBeCloseTo(0.25, 6);
  });

  it("holds the end keys outside their range — no extrapolation", () => {
    const lo = applyKeyforms([kf(keys)], "l1", "m1", [[5, 5]], { eye_l_open: -3 });
    expect(lo.vertices![0]).toEqual([5, 15]);
    const hi = bracketKeys(keys, 7)!;
    expect(hi.a.value).toBe(1);
    expect(hi.t).toBe(0);
  });

  it("ignores keyforms authored for a mesh the layer no longer uses", () => {
    const r = applyKeyforms([kf(keys)], "l1", "m_other", [[5, 5]], { eye_l_open: 0 });
    expect(r.vertices).toBeNull();
    expect(r.opacity).toBe(1);
  });

  it("several keyforms on one layer add offsets and multiply opacity", () => {
    const a = kf(keys);
    const b = kf([{ value: 0, offsets: { "0": [3, 0] }, opacity: 0.5 }], { id: "k2", param: "mouth_open" });
    const r = applyKeyforms([a, b], "l1", "m1", [[0, 0]], { eye_l_open: 0, mouth_open: 0 });
    expect(r.vertices![0]).toEqual([3, 10]);
    expect(r.opacity).toBe(0);
  });

  it("a key added mid-slider starts from the interpolated shape (no pop)", () => {
    const k = kf(keys);
    const mid = interpolatedKey(k, 0.5);
    expect(mid.offsets["0"]).toEqual([0, 5]);
    expect(mid.opacity).toBeCloseTo(0.5, 6);
    k.keys = upsertKey(k.keys, mid);
    expect(k.keys.map((x) => x.value)).toEqual([0, 0.5, 1]);
    const r = applyKeyforms([k], "l1", "m1", [[0, 0]], { eye_l_open: 0.5 });
    expect(r.vertices![0]).toEqual([0, 5]);
    expect(keyIndexAt(k, 0.501)).toBe(1);
    expect(keyIndexAt(k, 0.3)).toBe(-1);
  });
});

describe("keyforms in solveModel", () => {
  it("apply in rest space before skinning, so the shape rides the bone", () => {
    const head = makeBone("head", 500, 1.0, null, 500);
    head.rotation = Math.PI / 2; // quarter turn about (500, 500)
    const mesh: OarMesh = { ...subdivideQuad("m1", 500, 400, 10, 10, 1, 1) };
    mesh.weights = mesh.vertices.map(() => ({ [head.id]: 1 }));
    const layer = makeLayer({ id: "l1", x: 500, y: 400, width: 10, height: 10, mesh: "m1", boneId: head.id });
    const offsets: Record<string, Vec2> = {};
    mesh.vertices.forEach((_, i) => (offsets[String(i)] = [0, 20]));
    const model = makeModel({
      bones: [head],
      layers: [layer],
      meshes: [mesh],
      keyforms: [kf([{ value: 0, offsets, opacity: 1 }])],
    });
    const ctx = createSolveContext();
    ctx.meshes = new Map([[mesh.id, mesh]]);
    // A single key holds everywhere: the vertex is +20 in rest y.
    const withKf = solveModel(model, {}, ctx).layers[0]!.positions[0]!;
    const noKf = solveModel({ ...model, keyforms: [] }, {}, ctx).layers[0]!.positions[0]!;
    // After a quarter turn, rest +y is a canvas x offset — never canvas +y.
    expect(Math.abs(withKf[0] - noKf[0])).toBeCloseTo(20, 4);
    expect(withKf[1]).toBeCloseTo(noKf[1], 4);
  });
});

// Synthetic eye as in blink.test: white 40x20 at (100,100), iris 16x12 at
// (112,104), lash 40x8 band at (100,92). All meshed, all on the head bone.
function blinkModel() {
  const head = makeBone("head", 300, 1.0, null, 120);
  const whiteImg = rectImage(40, 20, { x: 0, y: 0, width: 40, height: 20 });
  const lashImg = rectImage(40, 8, { x: 0, y: 0, width: 40, height: 8 });
  const meshFor = (l: OarLayer, cols: number, rows: number) => {
    const m = subdivideQuad(`m_${l.id}`, l.x, l.y, l.width, l.height, cols, rows);
    m.weights = m.vertices.map(() => ({ [head.id]: 1 }));
    l.mesh = m.id;
    return m;
  };
  const white = makeLayer({ id: "white", slot: "eye_white", side: "left", x: 100, y: 100, width: 40, height: 20, boneId: head.id, order: 1 });
  const iris = makeLayer({ id: "iris", slot: "iris", side: "left", x: 112, y: 104, width: 16, height: 12, boneId: head.id, order: 2, clipTo: "white" });
  const lash = makeLayer({ id: "lash", slot: "eyelash_top", side: "left", x: 100, y: 92, width: 40, height: 8, boneId: head.id, order: 3 });
  const meshes = [meshFor(white, 8, 4), meshFor(iris, 4, 3), meshFor(lash, 10, 2)];
  const rig = emptyRig();
  rig.eyes.left = {
    white: "white",
    iris: "iris",
    shine: null,
    lashTop: "lash",
    lashBottom: null,
    closed: null,
    lidContour: deriveLidContour(whiteImg, 100, 100),
    irisRange: [10, 3],
  };
  const lashLower = deriveLashLowerEdge(lashImg, 100, 92);
  const keyforms = buildBlinkKeyforms({
    eye: rig.eyes.left,
    param: "eye_l_open",
    layers: new Map([white, iris, lash].map((l) => [l.id, l])),
    meshes: new Map(meshes.map((m) => [m.id, m])),
    lashLower,
    invert: 0,
  });
  const model = makeModel({ bones: [head], layers: [white, iris, lash], meshes, keyforms, rig });
  const ctx = createSolveContext();
  ctx.meshes = new Map(meshes.map((m) => [m.id, m]));
  ctx.eyeRuntime.left.lashLower = lashLower;
  const solve = (open: number) => {
    const out = solveModel(model, { eye_l_open: open }, ctx);
    return new Map(out.layers.map((l) => [l.id, l]));
  };
  return { model, solve, rig, lashLower, meshes };
}

describe("blink as keyforms", () => {
  it("generates lash + white keyforms and none for the clipped iris", () => {
    const { model } = blinkModel();
    expect(model.keyforms.map((k) => k.layerId).sort()).toEqual(["lash", "white"]);
    const keysOf = (id: string) => model.keyforms.find((k) => k.layerId === id)!.keys.map((x) => x.value);
    expect(keysOf("lash")).toEqual([0, 0.35, 1]); // in-between key keeps the lid upright
    expect(keysOf("white")).toEqual([0, 1]);
  });

  it("mid-blink the lash keeps its full thickness (no hairline lash)", () => {
    const { solve, meshes } = blinkModel();
    const rest = meshes.find((m) => m.id === "m_lash")!.vertices;
    const restH = Math.max(...rest.map((v) => v[1])) - Math.min(...rest.map((v) => v[1]));
    for (const open of [0.35, 0.5, 0.7]) {
      const p = solve(open).get("lash")!.positions;
      const h = Math.max(...p.map((v) => v[1])) - Math.min(...p.map((v) => v[1]));
      expect(h, `open ${open}`).toBeCloseTo(restH, 4);
    }
  });

  it("closed: the lash's lower edge lands on the lid contour", () => {
    const { solve, rig, lashLower, meshes } = blinkModel();
    const lash = solve(0).get("lash")!;
    const rest = meshes.find((m) => m.id === "m_lash")!.vertices;
    let checked = 0;
    rest.forEach(([x, y], i) => {
      if (Math.abs(y - sampleContour(lashLower, x)!) > 1.5) return;
      expect(Math.abs(lash.positions[i]![1] - sampleContour(rig.eyes.left.lidContour, x)!)).toBeLessThan(1);
      checked++;
    });
    expect(checked).toBeGreaterThan(4);
  });

  it("closed: the white folds to zero height on the contour (nothing shows through)", () => {
    const { solve, rig } = blinkModel();
    const white = solve(0).get("white")!;
    for (const [x, y] of white.positions) {
      expect(y).toBeCloseTo(sampleContour(rig.eyes.left.lidContour, x)!, 4);
    }
  });

  it("half-blink deforms — no fading, and the iris is not shrunk", () => {
    const { solve, meshes } = blinkModel();
    const half = solve(0.5);
    expect(half.get("white")!.alpha).toBe(1);
    expect(half.get("iris")!.alpha).toBe(1);
    expect(half.get("lash")!.alpha).toBe(1);
    const irisRest = meshes.find((m) => m.id === "m_iris")!.vertices;
    half.get("iris")!.positions.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(irisRest[i]![0], 6);
      expect(p[1]).toBeCloseTo(irisRest[i]![1], 6);
    });
    // The white's top has come half-way down, its bottom row stayed on the
    // contour line it folds toward.
    const whiteRest = meshes.find((m) => m.id === "m_white")!.vertices;
    const top = Math.min(...half.get("white")!.positions.map((p) => p[1]));
    expect(top).toBeGreaterThan(Math.min(...whiteRest.map((v) => v[1])) + 5);
  });

  it("the white's top stays under the lash band all the way down", () => {
    const { solve } = blinkModel();
    for (const open of [0.9, 0.7, 0.5, 0.3, 0.1]) {
      const s = solve(open);
      const whiteTop = Math.min(...s.get("white")!.positions.map((p) => p[1]));
      const lashBottom = Math.max(...s.get("lash")!.positions.map((p) => p[1]));
      expect(whiteTop).toBeLessThanOrEqual(lashBottom + 1e-6);
    }
  });

  it("keyformed eyes skip the procedural blink (gaze still works)", () => {
    const { solve, meshes } = blinkModel();
    const irisRest = meshes.find((m) => m.id === "m_iris")!.vertices;
    const s = solve(0.2);
    // Procedural blink would fade the interior at 0.2 and move the lash by
    // smoothstep; keyforms keep alpha 1 and move the lash linearly.
    expect(s.get("iris")!.alpha).toBe(1);
    expect(s.get("iris")!.positions[0]![1]).toBeCloseTo(irisRest[0]![1], 6);
  });
});

describe(".oar keyform IO", () => {
  it("older files without keyforms load with an empty list", () => {
    const raw = JSON.parse(JSON.stringify(makeModel({}))) as Record<string, unknown>;
    delete raw.keyforms;
    expect(validateManifest(raw).keyforms).toEqual([]);
  });

  it("studio export flags a keyform whose mesh was replaced", () => {
    const layer = makeLayer({ id: "l1", mesh: "m2" });
    const model = makeModel({
      layers: [layer],
      meshes: [{ ...subdivideQuad("m2", 0, 0, 10, 10, 1, 1) }],
      keyforms: [kf([{ value: 0, offsets: {}, opacity: 1 }])],
    });
    const { problems } = stripForStudio(model);
    expect(problems.some((p) => p.includes("no longer uses"))).toBe(true);
  });
});
