import { describe, it, expect } from "vitest";
import { useStore } from "../src/state/store";
import { setRigParam } from "../src/state/ops";

/** Controlled inputs (physics globals, rig tuning) read `useStore(s =>
 *  s.model)`. If execute() mutates in place without a new identity, those
 *  subscribers never re-render and range inputs snap back visually. */
describe("store model identity", () => {
  it("execute() replaces the model object so subscribers re-render", () => {
    const before = useStore.getState().model;
    useStore.getState().execute(setRigParam("bounce", 1.5, false));
    const after = useStore.getState().model;
    expect(after).not.toBe(before);
    expect(after.params.bounce).toBe(1.5);
    // Undo restores both the value and keeps identity churn consistent.
    useStore.getState().undo();
    expect(useStore.getState().model.params.bounce).toBeUndefined();
  });
});
