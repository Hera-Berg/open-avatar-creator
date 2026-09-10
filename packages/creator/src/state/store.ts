import { create } from "zustand";
import {
  createSolveContext,
  emptyManifest,
  type DriverParam,
  type OarManifest,
  type PixelImage,
  type SolveContext,
  type Vec2,
} from "@oar/core";
import { History, type Command } from "./undo";

export type Tool = "select" | "addBone" | "editMesh";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Pixel + solver assets live outside the reactive tree (they are large and
 *  mutate at 60fps); a version counter signals re-uploads. */
export const assets = {
  pixels: new Map<string, PixelImage>(),
  pixelsVersion: 0,
  solveCtx: createSolveContext() as SolveContext,
  /** per-column lower edge of each top lash, derived from pixels + rig */
  setPixels(pixels: Map<string, PixelImage>) {
    this.pixels = pixels;
    this.pixelsVersion++;
  },
  addPixels(id: string, img: PixelImage) {
    this.pixels.set(id, img);
    this.pixelsVersion++;
  },
  syncMeshes(model: OarManifest) {
    this.solveCtx.meshes = new Map(model.meshes.map((m) => [m.id, m]));
  },
  clearTransient() {
    this.solveCtx = createSolveContext();
    this.pixels = new Map();
    this.pixelsVersion++;
  },
};

interface CreatorStore {
  model: OarManifest;
  modelVersion: number;
  history: History;
  undoLabel: string | null;
  redoLabel: string | null;

  selection: { bones: string[]; layers: string[] };
  tool: Tool;
  camera: Camera;

  meshEdit: {
    layerId: string | null;
    vertices: number[];
    soft: boolean;
    softRadius: number;
  };

  playback: {
    demo: boolean;
    paused: boolean;
    frozen: Partial<Record<DriverParam, number>> | null;
    manual: Partial<Record<DriverParam, number>>;
    connection: ConnectionState;
  };
  trackerUrl: string;
  debugFeed: boolean;

  toast: string | null;
  namingGuideOpen: boolean;

  /** The §8 corrective workflow: a live corrective created by a paused mesh
   *  drag, awaiting driver confirmation in the banner. */
  correctiveDraft: {
    correctiveId: string;
    meshId: string;
    layerId: string;
    indices: number[];
    /** rest positions captured before the drag (for Make permanent baking) */
    restBefore: Vec2[];
  } | null;

  importState: {
    active: boolean;
    current: string;
    done: number;
    total: number;
    report: unknown | null;
  } | null;
  studioProblems: string[] | null;
  autoRigOpen: boolean;

  bump: () => void;
  execute: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
  setModel: (model: OarManifest, pixels: Map<string, PixelImage>) => void;
  select: (kind: "bones" | "layers", ids: string[], additive: boolean) => void;
  clearSelection: () => void;
  setTool: (tool: Tool) => void;
  setCamera: (camera: Camera) => void;
  fitCamera: (viewportWidth: number, viewportHeight: number) => void;
  setMeshEdit: (patch: Partial<CreatorStore["meshEdit"]>) => void;
  setPlayback: (patch: Partial<CreatorStore["playback"]>) => void;
  setManualParam: (key: DriverParam, value: number) => void;
  setToast: (toast: string | null) => void;
  setTrackerUrl: (url: string) => void;
  setDebugFeed: (on: boolean) => void;
  setNamingGuideOpen: (open: boolean) => void;
  setCorrectiveDraft: (draft: CreatorStore["correctiveDraft"]) => void;
  setImportState: (state: CreatorStore["importState"]) => void;
  setStudioProblems: (problems: string[] | null) => void;
  setAutoRigOpen: (open: boolean) => void;
}

export const useStore = create<CreatorStore>((set, get) => ({
  model: emptyManifest("untitled", { width: 2048, height: 2048 }),
  modelVersion: 0,
  history: new History(),
  undoLabel: null,
  redoLabel: null,
  selection: { bones: [], layers: [] },
  tool: "select",
  camera: { x: 1024, y: 1024, zoom: 0.25 },
  meshEdit: { layerId: null, vertices: [], soft: false, softRadius: 60 },
  playback: {
    demo: false,
    paused: false,
    frozen: null,
    manual: {},
    connection: "disconnected",
  },
  trackerUrl: "ws://localhost:3000/ws/v1/tracking",
  debugFeed: true,
  toast: null,
  namingGuideOpen: false,
  correctiveDraft: null,
  importState: null,
  studioProblems: null,
  autoRigOpen: false,

  bump: () => set((s) => ({ modelVersion: s.modelVersion + 1 })),

  execute: (cmd) => {
    const { model, history } = get();
    history.execute(model, cmd);
    assets.syncMeshes(model);
    set((s) => ({
      // New identity so useStore(s => s.model) subscribers re-render —
      // controlled inputs (physics globals, rig tuning) otherwise snap back.
      model: { ...model },
      modelVersion: s.modelVersion + 1,
      undoLabel: history.undoStack[history.undoStack.length - 1]?.label ?? null,
      redoLabel: null,
    }));
  },

  undo: () => {
    const { model, history } = get();
    const label = history.undo(model);
    if (label) {
      assets.syncMeshes(model);
      set((s) => ({
        model: { ...model },
        modelVersion: s.modelVersion + 1,
        undoLabel: history.undoStack[history.undoStack.length - 1]?.label ?? null,
        redoLabel: history.redoStack[history.redoStack.length - 1]?.label ?? null,
        toast: `Undo: ${label}`,
      }));
    }
  },

  redo: () => {
    const { model, history } = get();
    const label = history.redo(model);
    if (label) {
      assets.syncMeshes(model);
      set((s) => ({
        model: { ...model },
        modelVersion: s.modelVersion + 1,
        undoLabel: history.undoStack[history.undoStack.length - 1]?.label ?? null,
        redoLabel: history.redoStack[history.redoStack.length - 1]?.label ?? null,
        toast: `Redo: ${label}`,
      }));
    }
  },

  setModel: (model, pixels) => {
    assets.clearTransient();
    assets.setPixels(pixels);
    assets.syncMeshes(model);
    const history = new History();
    set({
      model,
      history,
      selection: { bones: [], layers: [] },
      meshEdit: { layerId: null, vertices: [], soft: false, softRadius: 60 },
      modelVersion: get().modelVersion + 1,
      undoLabel: null,
      redoLabel: null,
      camera: {
        x: model.canvas.width / 2,
        y: model.canvas.height / 2,
        zoom: get().camera.zoom,
      },
    });
  },

  select: (kind, ids, additive) =>
    set((s) => {
      if (!additive) return { selection: { bones: [], layers: [], [kind]: ids } as CreatorStore["selection"] };
      const current = new Set(s.selection[kind]);
      for (const id of ids) {
        if (current.has(id)) current.delete(id);
        else current.add(id);
      }
      return { selection: { ...s.selection, [kind]: [...current] } };
    }),

  clearSelection: () => set({ selection: { bones: [], layers: [] } }),

  setTool: (tool) => set({ tool }),

  setCamera: (camera) => set({ camera }),

  fitCamera: (viewportWidth, viewportHeight) =>
    set((s) => ({
      camera: {
        x: s.model.canvas.width / 2,
        y: s.model.canvas.height / 2,
        zoom: Math.min(
          viewportWidth / (s.model.canvas.width * 1.15),
          viewportHeight / (s.model.canvas.height * 1.15),
        ),
      },
    })),

  setMeshEdit: (patch) => set((s) => ({ meshEdit: { ...s.meshEdit, ...patch } })),

  setPlayback: (patch) => set((s) => ({ playback: { ...s.playback, ...patch } })),

  setManualParam: (key, value) =>
    set((s) => ({
      playback: {
        ...s.playback,
        manual: { ...s.playback.manual, [key]: value },
      },
    })),

  setToast: (toast) => set({ toast }),
  setTrackerUrl: (trackerUrl) => set({ trackerUrl }),
  setDebugFeed: (debugFeed) => set({ debugFeed }),
  setNamingGuideOpen: (namingGuideOpen) => set({ namingGuideOpen }),
  setCorrectiveDraft: (correctiveDraft) => set({ correctiveDraft }),
  setImportState: (importState) => set({ importState }),
  setStudioProblems: (studioProblems) => set({ studioProblems }),
  setAutoRigOpen: (autoRigOpen) => set({ autoRigOpen }),
}));

/** Convert a viewport pixel point to canvas space. */
export function screenToCanvas(camera: Camera, viewportW: number, viewportH: number, px: number, py: number): Vec2 {
  return [
    camera.x + (px - viewportW / 2) / camera.zoom,
    camera.y + (py - viewportH / 2) / camera.zoom,
  ];
}

export function canvasToScreen(camera: Camera, viewportW: number, viewportH: number, cx: number, cy: number): Vec2 {
  return [
    viewportW / 2 + (cx - camera.x) * camera.zoom,
    viewportH / 2 + (cy - camera.y) * camera.zoom,
  ];
}
