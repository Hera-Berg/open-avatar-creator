// Parameter registry — the single source of truth for both live driver
// parameters (transient, fed by tracker/demo/sliders) and rig settings
// (persisted in manifest.params). A test cross-references every slider key
// against the defaults table: a missing default reads back undefined and the
// first arithmetic poisons a vertex coordinate into NaN, silently deleting a
// layer.

/** Live driver parameters, normalised -1..1 or 0..1. */
export const DRIVER_DEFAULTS = {
  head_yaw: 0, // -1..1
  head_pitch: 0, // -1..1
  head_roll: 0, // -1..1
  head_x: 0, // -1..1, head position vs calibrated neutral
  head_y: 0, // -1..1, up positive
  eye_l_open: 1, // 0..1 (blink floor already applied by the source adapter)
  eye_r_open: 1,
  gaze_x: 0, // -1..1
  gaze_y: 0, // -1..1
  mouth_open: 0, // 0..1, mouth gain already applied by the source adapter
  mouth_form: 0, // -1..1 (smile - pucker)
  mouth_smile: 0, // 0..1
  mouth_pucker: 0, // 0..1
  mouth_x: 0, // -1..1
  brow_l: 0, // -1..1
  brow_r: 0, // -1..1
} as const;

export type DriverParam = keyof typeof DRIVER_DEFAULTS;

export interface SliderDef {
  key: DriverParam;
  label: string;
  min: number;
  max: number;
  group: string;
}

/** The manual parameter panel — every driver parameter, slider-addressable. */
export const DRIVER_SLIDERS: SliderDef[] = [
  { key: "head_yaw", label: "Head yaw", min: -1, max: 1, group: "Head" },
  { key: "head_pitch", label: "Head pitch", min: -1, max: 1, group: "Head" },
  { key: "head_roll", label: "Head roll", min: -1, max: 1, group: "Head" },
  { key: "head_x", label: "Head position X", min: -1, max: 1, group: "Head" },
  { key: "head_y", label: "Head position Y", min: -1, max: 1, group: "Head" },
  { key: "eye_l_open", label: "Left eye open", min: 0, max: 1, group: "Eyes" },
  { key: "eye_r_open", label: "Right eye open", min: 0, max: 1, group: "Eyes" },
  { key: "gaze_x", label: "Gaze X", min: -1, max: 1, group: "Eyes" },
  { key: "gaze_y", label: "Gaze Y", min: -1, max: 1, group: "Eyes" },
  { key: "mouth_open", label: "Mouth open", min: 0, max: 1, group: "Mouth" },
  { key: "mouth_form", label: "Mouth form", min: -1, max: 1, group: "Mouth" },
  { key: "mouth_smile", label: "Mouth smile", min: 0, max: 1, group: "Mouth" },
  { key: "mouth_pucker", label: "Mouth pucker", min: 0, max: 1, group: "Mouth" },
  { key: "mouth_x", label: "Mouth X", min: -1, max: 1, group: "Mouth" },
  { key: "brow_l", label: "Left brow", min: -1, max: 1, group: "Brows" },
  { key: "brow_r", label: "Right brow", min: -1, max: 1, group: "Brows" },
];

/** Rig settings persisted in manifest.params. */
export const RIG_PARAM_DEFAULTS = {
  blinkFloor: 0.32, // MediaPipe bottoms out ~0.1-0.2 on a full blink
  mouthGain: 1.6, // normal speech only drives jawOpen to 0.2-0.4
  headTurnDeg: 30, // cylinder warp range at head_yaw = ±1
  headTurnDepth: 0.8, // face-turn warp strength: how far features slide toward the turn (capped so it never folds)
  headPitchDeg: 10, // vertical cylinder warp at head_pitch = ±1 — far tighter than yaw; the face topology breaks past ~20°
  headParallaxPx: 3, // hair depth parallax per order step (clamped ±4)
  hairWarpFollow: 1, // how much hair follows the cylinder warp (1 = attached like the eyes)
  bodyRollDeg: 12, // spine driver at head_roll = ±1
  bodyLeanDeg: 8, // spine driver contribution from head_x = ±1
  positionRangeX: 250, // px whole-model travel at head_x = ±1
  positionRangeY: 180,
  mouthRangeUpper: 40, // px upper-lip inner-edge travel at full open
  mouthRangeLower: 60,
  mouthWidthScale: 1.3, // >1 confines the opening to the middle of the lips
  mouthCorner: 0.75, // corner step-down end point (u) — opening is fully closed by here
  browRangePx: 24, // px brow travel at brow = ±1
  lashInvert: 1, // closed-lash band: 1 = flipped below the lid line, lashes hanging down (drawn closed eyes); 0 = band above it
  // Physics globals
  bounce: 1, // master amplitude
  softness: 1, // master settle time
  hairSwayX: 1,
  hairSwayY: 0.4,
  chestSwayX: 0.5,
  chestSwayY: 1,
  hairJiggle: 1, // energy retention (0.4 dead, 1.0 smooth ~2.2s, 3.0 oscillates)
  chestJiggle: 1,
} as const;

export type RigParam = keyof typeof RIG_PARAM_DEFAULTS;

/** Read a rig param, guaranteed to return a finite number. */
export function rigParam(
  params: Record<string, number>,
  key: RigParam,
): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : RIG_PARAM_DEFAULTS[key];
}

/** Merge driver values over defaults so a missing key can never NaN. */
export function withDriverDefaults(
  values: Partial<Record<DriverParam, number>>,
): Record<DriverParam, number> {
  const out: Record<DriverParam, number> = { ...DRIVER_DEFAULTS };
  for (const k of Object.keys(DRIVER_DEFAULTS) as DriverParam[]) {
    const v = values[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
