// @vitest-environment jsdom
//
// App smoke test: the React tree must mount past first render. WebGL2 does
// not exist under jsdom, so the Engine throws inside an effect and the error
// boundary shows its message — which proves first render succeeded. The
// failure mode this guards: a crash during first render (e.g. reading the
// not-yet-created engine) produced a blank page with no explanation.

import { describe, it, expect, beforeAll } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { ErrorBoundary } from "../src/components/ErrorBoundary";

beforeAll(() => {
  // jsdom lacks ResizeObserver.
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!globalThis.requestAnimationFrame) {
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
    (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
});

describe("app smoke", () => {
  it("mounts past first render without a null-engine crash", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(React.createElement(ErrorBoundary, null, React.createElement(App)));
    // Let effects flush (the Engine will fail on missing WebGL2 under jsdom).
    await new Promise((r) => setTimeout(r, 120));
    const text = container.textContent ?? "";
    // The original blank-screen bug: "Cannot read properties of null".
    expect(text).not.toContain("Cannot read properties of null");
    expect(text).not.toContain("Cannot read properties of undefined");
    // Under jsdom the error boundary should report the missing WebGL2 —
    // meaning first render and the whole UI tree mounted fine.
    if (text.includes("Something broke")) {
      expect(text).toContain("WebGL2");
    } else {
      expect(text).toContain("Open Avatar Creator");
    }
  });
});
