// The .oar data model. Everything else is a view onto this.

export type Vec2 = [number, number];

export interface OarCanvas {
  width: number;
  height: number;
}

export interface OarPhysics {
  enabled: boolean;
  stiffness: number; // 1..20 — how hard it springs back
  damping: number; // 0.5..0.98 — energy retained per frame
  maxAngle: number; // degrees, 0..45
  inertia: number; // 0..2 — how much driver motion it picks up
  gravity: number; // 0..1 — how much it hangs
  pivot: "top" | "bottom" | "centre" | "custom";
  customPivot: Vec2 | null; // canvas space, only when pivot === "custom"
}

export interface OarLayer {
  id: string;
  name: string;
  path: string[]; // PSD group path, display only
  src: string;
  x: number;
  y: number; // top-left in canvas space
  width: number;
  height: number; // MUST equal the PNG dimensions
  opacity: number;
  visible: boolean;
  order: number; // 0 = furthest back
  slot: string | null; // rig role, or null
  side: "left" | "right" | "middle" | null;
  boneId: string | null; // primary bind, or null
  mesh: string | null; // mesh id, or null for a plain quad
  clipTo: string | null; // layer id — runtime mask (iris), or null
  physics: OarPhysics | null;
}

export interface OarBone {
  id: string;
  name: string;
  parentId: string | null; // null for root
  head: Vec2; // joint with parent — the pivot
  tail: Vec2; // free end
  locked: boolean;
  follow: number; // share of driver rotation, -1..1 (negative hips is deliberate)
  rotation: number; // user-applied pose rotation, radians
}

export interface OarMesh {
  id: string;
  vertices: Vec2[]; // rest positions, canvas space
  uvs: Vec2[]; // parallel to vertices, 0..1 across the layer rect
  triangles: [number, number, number][]; // indices into vertices
  weights: Record<string, number>[]; // parallel to vertices, values sum to 1
}

export interface OarCorrective {
  id: string;
  name: string;
  meshId: string;
  driver: {
    param: string;
    value: number;
    falloff: number;
    // optional second parameter — weights multiply
    param2: string | null;
    value2: number;
    falloff2: number;
  };
  offsets: Record<string, Vec2>; // vertex index -> offset
}

/** One key of a keyform: the layer's shape at `value` of the parameter. */
export interface OarKeyformKey {
  value: number;
  offsets: Record<string, Vec2>; // vertex index -> offset from rest, REST space
  opacity: number; // multiplies layer opacity, 0..1
}

/** Live2D-style keyform: a layer's deformation (and opacity) authored at key
 *  values of one driver parameter, linearly interpolated between neighbouring
 *  keys. Offsets are in rest space and applied BEFORE skinning, so the shape
 *  rides every bone transform. `meshId` pins the vertex numbering — a
 *  keyform whose mesh was replaced is ignored rather than scrambled. */
export interface OarKeyform {
  id: string;
  name: string;
  layerId: string;
  meshId: string;
  param: string;
  keys: OarKeyformKey[]; // sorted by value ascending
}

export interface OarRigEye {
  white: string | null;
  iris: string | null;
  shine: string | null;
  lashTop: string | null;
  lashBottom: string | null;
  closed: string | null;
  lidContour: Vec2[]; // traced from the eye white's alpha at import
  irisRange: Vec2; // px travel, x and y
}

export interface OarRigMouth {
  upperLip: string | null;
  lowerLip: string | null;
  inner: string[]; // inner mouth layer ids (teeth, tongue, back)
  apertureLayer: string | null; // synthetic cavity layer id
  apertureMesh: string | null; // mesh id of the aperture
  restGap: number;
}

export interface OarRig {
  head: { centre: Vec2; radius: Vec2 } | null;
  eyes: { left: OarRigEye; right: OarRigEye };
  mouth: OarRigMouth;
}

export interface OarManifest {
  format: "oar";
  version: number; // integer; migrations per bump; refuse unknown loudly
  name: string;
  canvas: OarCanvas;
  layers: OarLayer[];
  bones: OarBone[];
  meshes: OarMesh[];
  correctives: OarCorrective[];
  keyforms: OarKeyform[]; // absent in older files; readers default it to []
  rig: OarRig | null;
  params: Record<string, number>; // rig tuning params (blinkFloor, mouthGain, ...)
  editor?: Record<string, unknown>; // stripped by "Export for studio"
}

export const OAR_VERSION = 1;

export function emptyRig(): OarRig {
  const eye = (): OarRigEye => ({
    white: null,
    iris: null,
    shine: null,
    lashTop: null,
    lashBottom: null,
    closed: null,
    lidContour: [],
    irisRange: [0, 0],
  });
  return {
    head: null,
    eyes: { left: eye(), right: eye() },
    mouth: {
      upperLip: null,
      lowerLip: null,
      inner: [],
      apertureLayer: null,
      apertureMesh: null,
      restGap: 0,
    },
  };
}

export function emptyManifest(name: string, canvas: OarCanvas): OarManifest {
  return {
    format: "oar",
    version: OAR_VERSION,
    name,
    canvas,
    layers: [],
    bones: [],
    meshes: [],
    correctives: [],
    keyforms: [],
    rig: null,
    params: {},
  };
}
