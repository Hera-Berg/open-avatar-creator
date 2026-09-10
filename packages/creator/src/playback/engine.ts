// Playback engine: the 60fps loop that resolves parameters (demo / tracker /
// frozen / manual sliders), solves the model through @oar/core and draws it
// through @oar/renderer. Lives outside React; React reads results via the
// module-level `lastFrame`.

import { Renderer } from "@oar/renderer";
import {
  demoFrame,
  deriveLashLowerEdge,
  solveModel,
  withDriverDefaults,
  type DriverParam,
  type OarManifest,
  type SolvedModel,
} from "@oar/core";
import { assets, useStore } from "../state/store";
import { TrackerClient } from "../ws/trackerClient";

export interface FrameInfo {
  fps: number;
  solved: SolvedModel | null;
  params: Record<DriverParam, number>;
  driverAngle: number;
}

/** Module-level handle so keyboard shortcuts and panels can reach the
 *  running engine without threading refs through React. */
export const engineHolder: { current: Engine | null } = { current: null };

export class Engine {
  readonly renderer: Renderer;
  private raf = 0;
  private lastTime = 0;
  private startTime = 0;
  private client: TrackerClient | null = null;
  private liveParams: Partial<Record<DriverParam, number>> = {};
  private textureVersion = -1;
  private fpsSmooth = 0;
  readonly frame: FrameInfo = {
    fps: 0,
    solved: null,
    params: withDriverDefaults({}),
    driverAngle: 0,
  };

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
  }

  start(): void {
    this.startTime = performance.now();
    this.lastTime = this.startTime;
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.client?.stop();
  }

  connect(url: string, debugUrl: string | null): void {
    this.disconnect();
    const s = useStore.getState();
    this.client = new TrackerClient({
      url,
      debugUrl,
      blinkFloor: s.model.params.blinkFloor,
      mouthGain: s.model.params.mouthGain,
      onFrame: (params, input) => {
        if (Object.keys(params).length > 0) {
          this.liveParams = { ...this.liveParams, ...params };
        }
        assets.solveCtx.blendshapes = input.blendshapes;
      },
      onState: (state) => useStore.getState().setPlayback({ connection: state }),
    });
    this.client.start();
  }

  disconnect(): void {
    this.client?.stop();
    this.client = null;
    this.liveParams = {};
    assets.solveCtx.blendshapes = null;
    useStore.getState().setPlayback({ connection: "disconnected" });
  }

  /** Params the model would be solved at right now (for pause capture). */
  private resolveParams(tSeconds: number): Record<DriverParam, number> {
    const s = useStore.getState();
    const pb = s.playback;
    let base: Partial<Record<DriverParam, number>>;
    if (pb.paused && pb.frozen) {
      base = pb.frozen;
    } else if (pb.demo) {
      base = demoFrame(tSeconds);
    } else if (pb.connection === "connected") {
      base = this.liveParams;
    } else {
      base = {};
    }
    // Manual sliders always win — they exist to dial in a precise pose.
    return withDriverDefaults({ ...base, ...pb.manual });
  }

  togglePause(): void {
    const s = useStore.getState();
    if (s.playback.paused) {
      // Resume picks up from live values without a jump.
      s.setPlayback({ paused: false, frozen: null });
    } else {
      const frozen = { ...this.frame.params };
      s.setPlayback({ paused: true, frozen });
    }
  }

  private tick(t: number): void {
    const dtRaw = (t - this.lastTime) / 1000;
    this.lastTime = t;
    const dt = Math.min(0.05, Math.max(1e-4, dtRaw));
    if (dtRaw > 0) {
      const fps = 1 / Math.max(1e-4, dtRaw);
      this.fpsSmooth = this.fpsSmooth * 0.9 + fps * 0.1;
    }
    const s = useStore.getState();
    const model = s.model;

    // Sync textures and solver meshes when assets change.
    if (this.textureVersion !== assets.pixelsVersion) {
      for (const [id, img] of assets.pixels) {
        this.renderer.setTexture(id, new ImageData(new Uint8ClampedArray(img.data), img.width, img.height));
      }
      this.textureVersion = assets.pixelsVersion;
    }
    assets.syncMeshes(model);

    // Lash lower edges derive from pixels once per model load.
    this.refreshEyeRuntime(model);

    const params = this.resolveParams((t - this.startTime) / 1000);
    assets.solveCtx.dt = s.playback.paused ? 1e-4 : dt; // physics holds still while paused
    const solved = solveModel(model, params, assets.solveCtx);
    this.renderer.draw(solved, s.camera);

    this.frame.fps = this.fpsSmooth;
    this.frame.solved = solved;
    this.frame.params = params;
  }

  private eyeRuntimeModel: OarManifest | null = null;
  private refreshEyeRuntime(model: OarManifest): void {
    if (this.eyeRuntimeModel === model && this.eyeRuntimeVersion === assets.pixelsVersion) return;
    this.eyeRuntimeModel = model;
    this.eyeRuntimeVersion = assets.pixelsVersion;
    for (const side of ["left", "right"] as const) {
      const eye = model.rig?.eyes[side];
      const lashId = eye?.lashTop;
      if (!lashId) {
        assets.solveCtx.eyeRuntime[side].lashLower = null;
        continue;
      }
      const layer = model.layers.find((l) => l.id === lashId);
      const img = layer ? assets.pixels.get(lashId) : undefined;
      if (layer && img) {
        assets.solveCtx.eyeRuntime[side].lashLower = deriveLashLowerEdge(img, layer.x, layer.y);
      } else {
        assets.solveCtx.eyeRuntime[side].lashLower = null;
      }
    }
  }
  private eyeRuntimeVersion = -1;
}
