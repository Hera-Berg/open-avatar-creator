import { describe, it, expect } from "vitest";
import { emptyManifest, type OarLayer, type OarManifest, type OarPhysics } from "@oar/core";
import { History } from "../src/state/undo";
import {
  paintStack,
  setBoneField,
  setCorrectiveDriver,
  setLayerField,
  setPhysics,
  stepLayer,
  unbindLayer,
} from "../src/state/ops";

function layer(id: string, order: number, extra: Partial<OarLayer> = {}): OarLayer {
  return {
    id, name: id, path: [], src: `layers/${id}.png`, x: 0, y: 0, width: 10, height: 10,
    opacity: 1, visible: true, order, slot: null, side: null, boneId: null, mesh: null,
    clipTo: null, physics: null, ...extra,
  };
}

function model(layers: OarLayer[]): OarManifest {
  const m = emptyManifest("t", { width: 100, height: 100 });
  m.layers = layers;
  return m;
}

const PHYS: OarPhysics = {
  enabled: true, stiffness: 6, damping: 0.85, maxAngle: 12, inertia: 1, gravity: 0.5,
  pivot: "top", customPivot: null,
};

describe("undo restores a prior null", () => {
  it("setLayerField: clipTo / boneId / side set from null revert to null", () => {
    const m = model([layer("a", 0)]);
    const h = new History();
    h.execute(m, setLayerField("a", "clipTo", "white", "clip"));
    h.execute(m, setLayerField("a", "boneId", "b_head", "bind"));
    h.execute(m, setLayerField("a", "side", "left", "side"));
    h.undo(m);
    h.undo(m);
    h.undo(m);
    expect(m.layers[0]!.clipTo).toBeNull();
    expect(m.layers[0]!.boneId).toBeNull();
    expect(m.layers[0]!.side).toBeNull();
  });

  it("setPhysics: enabling physics on a layer without any undoes to null", () => {
    const m = model([layer("a", 0)]);
    const h = new History();
    h.execute(m, setPhysics("a", PHYS));
    expect(m.layers[0]!.physics).not.toBeNull();
    h.undo(m);
    expect(m.layers[0]!.physics).toBeNull();
    h.redo(m);
    expect(m.layers[0]!.physics?.stiffness).toBe(6);
  });

  it("setPhysics: undo restores a custom pivot by value, not by reference", () => {
    const m = model([layer("a", 0, { physics: { ...PHYS, pivot: "custom", customPivot: [5, 5] } })]);
    const h = new History();
    h.execute(m, setPhysics("a", { ...PHYS, pivot: "custom", customPivot: [9, 9] }));
    h.undo(m);
    expect(m.layers[0]!.physics?.customPivot).toEqual([5, 5]);
  });

  it("unbindLayer and setBoneField round-trip", () => {
    const m = model([layer("a", 0, { boneId: "b1" })]);
    m.bones.push({ id: "b1", name: "x", parentId: null, head: [0, 0], tail: [0, 1], locked: false, follow: 0, rotation: 0 });
    const h = new History();
    h.execute(m, unbindLayer("a"));
    h.execute(m, setBoneField("b1", "locked", true, "lock"));
    h.undo(m);
    h.undo(m);
    expect(m.layers[0]!.boneId).toBe("b1");
    expect(m.bones[0]!.locked).toBe(false);
  });
});

describe("corrective driver edits", () => {
  it("are undoable, and a slider drag is one step", () => {
    const m = model([]);
    m.correctives.push({
      id: "c1", name: "c", meshId: "m",
      driver: { param: "head_yaw", value: 1, falloff: 1, param2: null, value2: 0, falloff2: 0.5 },
      offsets: {},
    });
    const h = new History();
    for (const f of [1.2, 1.5, 2.0]) h.execute(m, setCorrectiveDriver("c1", { falloff: f }));
    expect(h.undoStack.length).toBe(1);
    expect(m.correctives[0]!.driver.falloff).toBe(2);
    h.undo(m);
    expect(m.correctives[0]!.driver.falloff).toBe(1);
  });
});

describe("stepLayer", () => {
  const ids = (m: OarManifest) => paintStack(m).map((l) => l.id);

  it("swaps with the neighbour, so ↑ always visibly moves the layer", () => {
    const m = model([layer("a", 0), layer("b", 1), layer("c", 2)]);
    const h = new History();
    h.execute(m, stepLayer("a", 1));
    expect(ids(m)).toEqual(["b", "a", "c"]);
    h.undo(m);
    expect(ids(m)).toEqual(["a", "b", "c"]);
  });

  it("gaps and fractional orders (the mouth cavity sits at lip − 0.5) still step one place", () => {
    const m = model([layer("a", 0), layer("cav", 4.5), layer("lip", 5), layer("top", 9)]);
    new History().execute(m, stepLayer("cav", -1));
    expect(ids(m)).toEqual(["cav", "a", "lip", "top"]);
    // Only the two swapped layers changed.
    expect(m.layers.find((l) => l.id === "top")!.order).toBe(9);
  });

  it("breaks a tie instead of leaving the layers tied", () => {
    const m = model([layer("a", 3), layer("b", 3), layer("c", 4)]);
    new History().execute(m, stepLayer("a", 1));
    expect(ids(m)).toEqual(["b", "a", "c"]);
    new History().execute(m, stepLayer("a", 1));
    expect(ids(m)).toEqual(["b", "c", "a"]);
  });

  it("is a no-op at either end of the stack", () => {
    const m = model([layer("a", 0), layer("b", 1)]);
    new History().execute(m, stepLayer("b", 1));
    new History().execute(m, stepLayer("a", -1));
    expect(ids(m)).toEqual(["a", "b"]);
  });
});
