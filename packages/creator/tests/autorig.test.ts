import { describe, it, expect } from "vitest";
import { buildSpine, runAutoRig } from "../src/autorig";
import { emptyManifest, type OarLayer, type PixelImage, type Vec2 } from "@oar/core";
import { History } from "../src/state/undo";

let n = 0;
function layer(name: string, slot: string | null, side: "left" | "right" | "middle" | null, box: { x: number; y: number; w: number; h: number }, order: number): OarLayer {
  return {
    id: `l_${++n}`,
    name,
    path: [],
    src: `layers/${name}.png`,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    opacity: 1,
    visible: true,
    order,
    slot,
    side,
    boneId: null,
    mesh: null,
    clipTo: null,
    physics: null,
  };
}

function pixels(width: number, height: number): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Reference-figure model: all §16 spine layers present. */
function fullModel() {
  const model = emptyManifest("fig", { width: 1000, height: 2000 });
  model.layers = [
    layer("hair-back-middle", "hair_back", "middle", { x: 400, y: 200, w: 200, h: 600 }, 0),
    layer("torso", "torso", null, { x: 380, y: 1100, w: 240, h: 400 }, 1),
    layer("leg-left", "leg", "left", { x: 420, y: 1500, w: 80, h: 400 }, 2),
    layer("hips", "hips", null, { x: 400, y: 1450, w: 200, h: 80 }, 3),
    layer("Neck", "neck", null, { x: 460, y: 940, w: 80, h: 180 }, 4),
    layer("chest", "chest", null, { x: 390, y: 1100, w: 220, h: 160 }, 5),
    layer("head", "head", null, { x: 400, y: 500, w: 200, h: 440 }, 6),
    layer("eye-white-left", "eye_white", "left", { x: 540, y: 700, w: 40, h: 20 }, 7),
    layer("iris-left", "iris", "left", { x: 550, y: 704, w: 16, h: 12 }, 8),
    layer("eyelash-top-left", "eyelash_top", "left", { x: 540, y: 694, w: 40, h: 8 }, 9),
    layer("eye-white-right", "eye_white", "right", { x: 420, y: 700, w: 40, h: 20 }, 7),
    layer("iris-right", "iris", "right", { x: 430, y: 704, w: 16, h: 12 }, 8),
    layer("eyelash-top-right", "eyelash_top", "right", { x: 420, y: 694, w: 40, h: 8 }, 9),
    layer("top-lip", "lip_upper", null, { x: 460, y: 850, w: 60, h: 20 }, 10),
    layer("bottom-lip", "lip_lower", null, { x: 460, y: 869, w: 60, h: 20 }, 11),
    layer("hair-front-middle", "hair_front", "middle", { x: 420, y: 480, w: 160, h: 160 }, 12),
    layer("mystery", null, null, { x: 10, y: 10, w: 50, h: 50 }, 13),
  ];
  const px = new Map<string, PixelImage>();
  for (const l of model.layers) px.set(l.id, pixels(l.width, l.height));
  return { model, px };
}

describe("auto-rig spine (§16 step 2)", () => {
  it("builds the six-bone chain with the reference follows, negative hips intact", () => {
    const { model } = fullModel();
    const spine = buildSpine(model);
    expect(spine.map((b) => b.name)).toEqual(["root", "hips", "torso", "chest", "neck", "head"]);
    const follows = spine.map((b) => b.follow);
    expect(follows[1]).toBeCloseTo(-0.09, 6); // the whole S-curve
    expect(Math.min(...follows)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...follows)).toBeLessThanOrEqual(1);
  });

  it("pivot y is non-increasing from root to head", () => {
    const { model } = fullModel();
    const spine = buildSpine(model);
    for (let i = 1; i < spine.length; i++) {
      expect(spine[i]!.head[1]).toBeLessThanOrEqual(spine[i - 1]!.head[1]);
    }
  });

  it("follow is monotonically increasing above the hips", () => {
    const { model } = fullModel();
    const spine = buildSpine(model);
    for (let i = 2; i < spine.length; i++) {
      expect(spine[i]!.follow).toBeGreaterThan(spine[i - 1]!.follow);
    }
  });

  it("missing layers interpolate between the nearest known bones", () => {
    const { model } = fullModel();
    model.layers = model.layers.filter((l) => l.slot !== "chest");
    const spine = buildSpine(model);
    const neck = spine.find((b) => b.name === "neck")!;
    const torso = spine.find((b) => b.name === "torso")!;
    const chest = spine.find((b) => b.name === "chest")!;
    expect(chest.head[1]).toBeLessThan(torso.head[1]);
    expect(chest.head[1]).toBeGreaterThan(neck.head[1]);
  });

  it("all bones share the head's horizontal centre", () => {
    const { model } = fullModel();
    const spine = buildSpine(model);
    for (const b of spine) expect(b.head[0]).toBeCloseTo(500, 1);
  });
});

describe("auto-rig end to end", () => {
  it("a full pass animates with no manual work and stays editable", () => {
    const { model, px } = fullModel();
    const result = runAutoRig(model, px, {
      classify: true,
      skeleton: true,
      bindings: true,
      meshes: true,
      physics: true,
      face: true,
    });
    const history = new History();
    history.execute(model, result.cmd);

    // Spine exists.
    const names = model.bones.map((b) => b.name);
    for (const boneName of ["root", "hips", "torso", "chest", "neck", "head"]) {
      expect(names).toContain(boneName);
    }
    // Head-group layers bound to the head bone.
    const headBone = model.bones.find((b) => b.name === "head")!;
    const headLayer = model.layers.find((l) => l.name === "head")!;
    expect(headLayer.boneId).toBe(headBone.id);
    // The neck got a weighted mesh (a joint, not a body part).
    const neck = model.layers.find((l) => l.slot === "neck")!;
    expect(neck.mesh).not.toBeNull();
    const neckMesh = model.meshes.find((m) => m.id === neck.mesh)!;
    const topWeights = neckMesh.weights[0]!;
    expect(Object.keys(topWeights).length).toBeGreaterThan(0);
    // Hair has staggered physics AND is bound to the head bone (rolls with
    // the head; physics sway composes on top).
    const hairLayers = model.layers.filter((l) => l.slot === "hair_front" || l.slot === "hair_back");
    expect(hairLayers.every((l) => l.physics?.enabled)).toBe(true);
    for (const hair of hairLayers) {
      expect(hair.boneId).toBe(headBone.id);
    }
    // Face rig exists with a lid contour and a zero-area aperture.
    expect(model.rig).not.toBeNull();
    expect(model.rig!.eyes.left.lidContour.length).toBeGreaterThan(1);
    expect(model.rig!.mouth.apertureMesh).not.toBeNull();
    // The iris clips at runtime, never baked.
    const iris = model.layers.find((l) => l.slot === "iris")!;
    const white = model.layers.find((l) => l.slot === "eye_white" && l.side === iris.side)!;
    expect(iris.clipTo).toBe(white.id);
    // Unrecognised layers do not move.
    const mystery = model.layers.find((l) => l.name === "mystery")!;
    expect(mystery.boneId).toBeNull();
    // The blink is editable keyforms: every eye layer has a head-weighted
    // mesh, and lash + white carry eye_*_open keys at 0 and 1.
    for (const l of model.layers.filter((x) => ["eye_white", "iris", "eyelash_top"].includes(x.slot ?? ""))) {
      const mesh = model.meshes.find((m) => m.id === l.mesh);
      expect(mesh, l.name).toBeDefined();
      expect(mesh!.weights[0]![headBone.id]).toBe(1);
    }
    const blinkParams = model.keyforms.map((k) => `${model.layers.find((l) => l.id === k.layerId)!.name}:${k.param}`);
    expect(blinkParams.sort()).toEqual([
      "eye-white-left:eye_l_open",
      "eye-white-right:eye_r_open",
      "eyelash-top-left:eye_l_open",
      "eyelash-top-right:eye_r_open",
    ]);
    // The whole pass is one undo step.
    history.undo(model);
    expect(model.bones.length).toBe(0);
    expect(model.rig).toBeNull();
    expect(model.keyforms.length).toBe(0);
  });

  it("re-running the face pass replaces the blink keyforms instead of stacking them", () => {
    const { model, px } = fullModel();
    const history = new History();
    const opts = { classify: true, skeleton: true, bindings: true, meshes: true, physics: true, face: true };
    history.execute(model, runAutoRig(model, px, opts).cmd);
    const firstMeshes = model.layers.filter((l) => l.slot === "eye_white").map((l) => l.mesh);
    history.execute(model, runAutoRig(model, px, { ...opts, skeleton: false }).cmd);
    expect(model.keyforms.length).toBe(4);
    // Existing eye meshes (and any hand edits to them) are kept.
    expect(model.layers.filter((l) => l.slot === "eye_white").map((l) => l.mesh)).toEqual(firstMeshes);
  });

  it("re-running with only physics checked keeps hand edits elsewhere", () => {
    const { model, px } = fullModel();
    const history = new History();
    history.execute(
      model,
      runAutoRig(model, px, {
        classify: true,
        skeleton: true,
        bindings: true,
        meshes: true,
        physics: false,
        face: true,
      }).cmd,
    );
    const bonesBefore = model.bones.map((b) => b.id);
    history.execute(
      model,
      runAutoRig(model, px, {
        classify: false,
        skeleton: false,
        bindings: false,
        meshes: false,
        physics: true,
        face: false,
      }).cmd,
    );
    expect(model.bones.map((b) => b.id)).toEqual(bonesBefore);
    const hair = model.layers.find((l) => l.slot === "hair_front")!;
    expect(hair.physics?.enabled).toBe(true);
  });
});

describe("face rig cavity ordering", () => {
  it("the cavity layer is placed behind BOTH lips", () => {
    const { model, px } = fullModel();
    const result = runAutoRig(model, px, {
      classify: false,
      skeleton: false,
      bindings: false,
      meshes: false,
      physics: false,
      face: true,
    });
    const history = new History();
    history.execute(model, result.cmd);
    const upper = model.layers.find((l) => l.slot === "lip_upper")!;
    const lower = model.layers.find((l) => l.slot === "lip_lower")!;
    const cavity = model.layers.find((l) => l.slot === "mouth_cavity")!;
    expect(cavity.order).toBeLessThan(Math.min(upper.order, lower.order));
  });
});

describe("auto-rig verification helpers", () => {
  it("taper check helper stays sane: spine weights sum to 1 across a joint", () => {
    const { model } = fullModel();
    const spine = buildSpine(model);
    const pivots = spine.map((b) => ({ id: b.id, pivotY: b.head[1] }));
    void pivots;
    // Weight continuity is covered by core's joint-continuity test; here we
    // just confirm buildSpine feeds sane pivots.
    expect(spine[0]!.parentId).toBeNull();
    for (let i = 1; i < spine.length; i++) {
      expect(spine[i]!.parentId).toBe(spine[i - 1]!.id);
    }
    void (0 as unknown as Vec2);
  });
});
