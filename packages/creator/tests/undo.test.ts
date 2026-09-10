import { describe, it, expect } from "vitest";
import { History, makeCommand, HISTORY_CAP } from "../src/state/undo";
import { moveVertices } from "../src/state/ops";
import { emptyManifest, type OarMesh, type Vec2 } from "@oar/core";

function modelWithMesh(): { model: ReturnType<typeof emptyManifest>; mesh: OarMesh } {
  const mesh: OarMesh = {
    id: "m1",
    vertices: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    uvs: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    triangles: [[0, 1, 2]],
    weights: [{}, {}, {}, {}],
  };
  const model = emptyManifest("t", { width: 100, height: 100 });
  model.meshes.push(mesh);
  return { model, mesh };
}

describe("undo", () => {
  it("a vertex drag is one undo step (coalescing)", () => {
    const { model, mesh } = modelWithMesh();
    const history = new History();
    // Simulate ~200 pointermove events within the coalesce window.
    for (let i = 0; i < 200; i++) {
      history.execute(
        model,
        moveVertices("m1", [0, 1], [[0.5, 0.25] as Vec2, [0.5, 0.25] as Vec2]),
      );
    }
    expect(history.undoStack.length).toBe(1);
    expect(mesh.vertices[0]).toEqual([100, 50]);
    history.undo(model);
    expect(mesh.vertices[0]).toEqual([0, 0]);
    expect(mesh.vertices[1]).toEqual([10, 0]);
  });

  it("deletions never coalesce", () => {
    const model = emptyManifest("t", { width: 10, height: 10 });
    const history = new History();
    const mk = (label: string) =>
      makeCommand({
        label,
        apply: () => {},
        revert: () => {},
      });
    history.execute(model, mk("delete a"));
    history.execute(model, mk("delete b"));
    expect(history.undoStack.length).toBe(2);
  });

  it("redo is cleared on a new command", () => {
    const { model, mesh } = modelWithMesh();
    const history = new History();
    history.execute(model, moveVertices("m1", [0], [[1, 1]]));
    history.undo(model);
    expect(history.redoStack.length).toBe(1);
    history.execute(model, moveVertices("m1", [0], [[2, 2]]));
    expect(history.redoStack.length).toBe(0);
    expect(mesh.vertices[0]).toEqual([2, 2]);
  });

  it("undo/redo round-trips", () => {
    const { model, mesh } = modelWithMesh();
    const history = new History();
    history.execute(model, moveVertices("m1", [0], [[5, 5]]));
    expect(mesh.vertices[0]).toEqual([5, 5]);
    history.undo(model);
    expect(mesh.vertices[0]).toEqual([0, 0]);
    history.redo(model);
    expect(mesh.vertices[0]).toEqual([5, 5]);
  });

  it("stacks cap at HISTORY_CAP", () => {
    const model = emptyManifest("t", { width: 10, height: 10 });
    const history = new History();
    for (let i = 0; i < HISTORY_CAP + 50; i++) {
      history.execute(
        model,
        makeCommand({
          label: `op ${i}`,
          apply: () => {},
          revert: () => {},
        }),
      );
      // Move time backwards so coalescing never kicks in for unkeyed commands.
    }
    expect(history.undoStack.length).toBeLessThanOrEqual(HISTORY_CAP);
  });
});
