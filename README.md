# Open Avatar Creator

A browser-based rigging tool for 2D VTuber models. Import a PSD, rig it with
bones and mesh deformation, test it live against a face tracker, export a
single portable `.oar` file. No server-side rigging logic — the browser owns
the model once loaded, and the model never leaves your machine.

## Start

```bash
docker compose up --build
```

Open `http://localhost:3001` and click **Load sample** (the bundled
`sample-avatar.oar`), or **Import PSD…** to rig your own. **Naming guide**
explains the layer convention and offers a template PSD.

| Port | Service |
|---|---|
| 3000 | face tracker (open-avatar-tracker, separate repo) |
| 3001 | **creator — this app** |
| 3002 | studio (built later) |

## Layout

```
packages/
  core/        skinning, correctives, physics, eyes, mouth, head turn,
               websocket frame → parameters, .oar IO. No DOM, no React.
  renderer/    WebGL2 drawing (premultiplied alpha, stencil iris clip).
  creator/     this app — React editor UI on top of core + renderer.
scripts/
  make-sample-oar.mjs   regenerates sample-avatar.oar
```

The evaluator lives in `@oar/core` and both the creator and the future
studio import it — there is one evaluator, so a model that looks right here
looks right in the studio.

## Development

```bash
npm install
npm run dev        # vite dev server on :3001
npm test           # vitest: core (59) + creator (52)
npm run build      # type-check + production bundle
```

## Tracking input

**Connect** opens `ws://localhost:3000/ws/v1/tracking` (editable) for the
normalized parameter feed, plus an optional second socket to `/ws/v1/debug`
for the 52 raw blendshapes that drive mouth detail. Auto-reconnects with 2s
backoff. **Demo** sweeps every parameter with no camera; **Space** freezes
the pose (mesh edits while paused become pose-space correctives).

## The .oar format

A zip: `manifest.json` (format `oar`, integer `version` — unknown versions
are refused loudly), `layers/*.png` (whose dimensions must match the
manifest exactly), `thumbnail.png`. The manifest carries everything needed
to *drive* the model — bones, weighted meshes, correctives, physics, and a
`rig` block with traced eyelid contours, iris ranges and the mouth aperture
mesh — so the studio never re-derives anything from artwork it does not have.
The same file is the save file; **Export for studio** strips editor-only
data and validates that every core slot resolves.

## Rendering notes

Premultiplied alpha at all five points (context, unpack, blend func, shader,
clear colour) and a 1px transparent margin on every layer texture — this is
why traced artwork has no dark fringes and no clamp-to-edge seams. Iris
layers are clipped at render time via the stencil buffer, never baked, so
they travel with gaze and stay inside the eye white.

## License

Apache-2.0.
