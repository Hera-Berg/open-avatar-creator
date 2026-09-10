import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readOar, solveModel, createSolveContext, withDriverDefaults, apertureArea, APERTURE_ROWS } from "/home/elwood/Documents/open-avatar/open-avatar-creator/packages/core/src/index";

it("sample-avatar.oar loads and solves end to end", () => {
  const pkg = readOar(new Uint8Array(readFileSync("/home/elwood/Documents/open-avatar/open-avatar-creator/sample-avatar.oar")));
  expect(pkg.manifest.layers.length).toBe(17);
  const ctx = createSolveContext();
  ctx.meshes = new Map(pkg.manifest.meshes.map((m) => [m.id, m]));
  // Closed left eye, open mouth, head turned — the full pipeline.
  const solved = solveModel(pkg.manifest, withDriverDefaults({ mouth_open: 0.9, head_yaw: 0.5, head_roll: 0.4, eye_l_open: 0, eye_r_open: 1 }), ctx);
  expect(solved.layers.length).toBe(17);
  const leftWhite = solved.layers.find((l) => l.id === "l_eye_white_left")!;
  expect(leftWhite.alpha).toBe(0); // nothing shows through a shut lid
  const leftLash = solved.layers.find((l) => l.id === "l_eyelash_top_left")!;
  expect(leftLash.alpha).toBe(1); // lash becomes the closed lid
  // Aperture opened by mouth_open.
  const cavity = solved.layers.find((l) => l.slot === undefined && l.id === "l_mouth_cavity")!;
  expect(apertureArea(cavity.positions, APERTURE_ROWS)).toBeGreaterThan(100);
  // At rest the aperture is closed.
  const rest = solveModel(pkg.manifest, withDriverDefaults({}), createSolveContextWith(pkg));
  const cavityRest = rest.layers.find((l) => l.id === "l_mouth_cavity")!;
  expect(apertureArea(cavityRest.positions, APERTURE_ROWS)).toBeLessThan(1e-6);
  expect(cavityRest.alpha).toBeLessThan(0.01);
  // Iris clip target resolved.
  const iris = solved.layers.find((l) => l.id === "l_iris_left")!;
  expect(iris.clipTo).toBe("l_eye_white_left");
});
function createSolveContextWith(pkg: ReturnType<typeof readOar>) {
  const ctx = createSolveContext();
  ctx.meshes = new Map(pkg.manifest.meshes.map((m) => [m.id, m]));
  return ctx;
}
