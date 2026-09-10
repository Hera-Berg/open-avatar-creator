// Tracker websocket client (§8, §13). Connects to the real tracker's
// normalized feed with an optional second socket for the 52 blendshapes.
// Auto-reconnects on drop with 2s backoff. WebSocket has no CORS preflight,
// so a page on :3001 may connect to :3000 freely — but if the app is ever
// served over HTTPS, browsers block plain ws:// as mixed content.

import {
  parseFrame,
  ParamSmoother,
  RIG_PARAM_DEFAULTS,
  type DriverParam,
  type TrackingInput,
} from "@oar/core";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface TrackerClientOptions {
  url: string;
  debugUrl: string | null;
  blinkFloor?: number;
  mouthGain?: number;
  smoothing?: number;
  onFrame: (params: Partial<Record<DriverParam, number>>, input: TrackingInput) => void;
  onState: (state: ConnectionState, detail?: string) => void;
}

export class TrackerClient {
  private ws: WebSocket | null = null;
  private debugWs: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private smoother = new ParamSmoother();
  private lastBlendshapes: Record<string, number> | null = null;

  constructor(private opts: TrackerClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.debugWs?.close();
    this.ws = null;
    this.debugWs = null;
    this.smoother.reset();
    this.opts.onState("disconnected");
  }

  private connect(): void {
    if (this.stopped) return;
    this.opts.onState("connecting");
    try {
      this.ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.opts.onState("error", String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => this.opts.onState("connected");
    this.ws.onclose = () => {
      this.opts.onState("disconnected");
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.opts.onState("error", "websocket error");
    this.ws.onmessage = (ev) => this.handle(ev.data as string);

    if (this.opts.debugUrl) {
      try {
        this.debugWs = new WebSocket(this.opts.debugUrl);
        this.debugWs.onmessage = (ev) => this.handle(ev.data as string);
      } catch {
        this.debugWs = null;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // 2s backoff.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private handle(text: string): void {
    const input = parseFrame(text, {
      blinkFloor: this.opts.blinkFloor ?? RIG_PARAM_DEFAULTS.blinkFloor,
      mouthGain: this.opts.mouthGain ?? RIG_PARAM_DEFAULTS.mouthGain,
    });
    if (!input) return;
    if (input.blendshapes) this.lastBlendshapes = input.blendshapes;
    if (Object.keys(input.params).length === 0 && !input.blendshapes) {
      if (!input.present) this.opts.onFrame({}, input);
      return;
    }
    const smoothed = this.smoother.update(input.params, this.opts.smoothing ?? 0.35);
    this.opts.onFrame(smoothed, { ...input, blendshapes: input.blendshapes ?? this.lastBlendshapes });
  }
}
