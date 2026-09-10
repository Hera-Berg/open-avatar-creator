// Minimal WebDriver BiDi client: navigate, wait, evaluate live app state,
// screenshot. Used to debug rendering in a real browser headlessly.
// Usage: node scripts/bidi-shot.mjs <url> <outPng> [waitMs]

import { writeFileSync } from "node:fs";

const [url, outPng, waitMsArg] = process.argv.slice(2);
const waitMs = Number(waitMsArg ?? 4000);

const DIAG_EXPRESSION = `(() => {
  const out = [];
  const oar = window.__oar;
  if (!oar) return "no __oar handle";
  const { assets, engineHolder, useStore } = oar;
  const e = engineHolder.current;
  out.push("engine: " + (e ? "running fps=" + e.frame.fps.toFixed(1) : "MISSING"));
  out.push("model layers: " + useStore.getState().model.layers.length);
  out.push("pixel store: " + assets.pixels.size);
  out.push("solved: " + (e?.frame.solved ? e.frame.solved.layers.length + " layers" : "null"));
  const c = document.querySelector(".glcanvas");
  if (!c) return out.join("\\n") + "\\nno .glcanvas";
  out.push("canvas: " + c.width + "x" + c.height);
  const gl = c.getContext("webgl2");
  if (!gl) return out.join("\\n") + "\\nno webgl2 context on 2nd get";
  if (e && e.frame.solved) {
    e.renderer.draw(e.frame.solved, useStore.getState().camera);
  }
  const errs = [];
  let err;
  while ((err = gl.getError()) !== 0) errs.push(err);
  out.push("gl errors: " + (errs.length ? errs.join(",") : "none"));
  const px = new Uint8Array(c.width * c.height * 4);
  gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let nonBg = 0;
  let maxA = 0;
  const histo = {};
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
    if (a > maxA) maxA = a;
    if (r > 60 || g > 60 || b > 70) nonBg++;
  }
  out.push("nonBg pixels: " + nonBg + " / " + (c.width * c.height) + ", max alpha " + maxA);
  const l = e?.frame.solved?.layers.find((x) => x.visible);
  if (l) out.push("first visible layer: " + l.id + " alpha=" + l.alpha.toFixed(3) + " verts=" + l.positions.length + " p0=" + l.positions[0].map((v) => v.toFixed(1)).join(","));
  return out.join("\\n");
})()`;

async function main() {
  // Discover the BiDi websocket URL.
  let wsUrl;
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version");
    const json = await res.json();
    wsUrl = json.webSocketDebuggerUrl;
  } catch {
    wsUrl = null;
  }
  wsUrl = wsUrl ?? "ws://127.0.0.1:9222/session";
  console.log("connecting:", wsUrl);

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error} ${msg.message ?? ""}`));
        else resolve(msg.result ?? msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("session.new", { capabilities: {} });
  const tree = await send("browsingContext.getTree", {});
  const context = tree.contexts[0].context;
  await send("browsingContext.navigate", { context, url, wait: "complete" });
  await new Promise((r) => setTimeout(r, waitMs));

  const evalResult = await send("script.evaluate", {
    expression: DIAG_EXPRESSION,
    target: { context },
    resultOwnership: "none",
  });
  console.log("--- diagnostics ---");
  console.log(evalResult?.result?.value ?? JSON.stringify(evalResult).slice(0, 800));
  console.log("-------------------");

  const shot = await send("browsingContext.captureScreenshot", { context });
  if (shot?.data) {
    writeFileSync(outPng, Buffer.from(shot.data, "base64"));
    console.log("screenshot:", outPng);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
