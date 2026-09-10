// Slot classifier: matches PSD layer names to rig slots (§3, §16 step 1).
//
// Tokenisation splits on separators and camelCase — never on "non-ASCII",
// which would delete every Cyrillic character and classify a Russian file as
// unknown. ASCII terms match whole tokens (`ear` must not fire on `beard`,
// `arm` must not fire on `charm`). Non-ASCII terms match as substrings:
// Japanese has no word separators and Russian inflects, so the stem бров
// covers бровь/брови/бровей.

export interface Classification {
  slot: string | null;
  side: "left" | "right" | "middle" | null;
  drop: boolean;
  matched: string | null; // the term that fired, for the import report
}

const SEPARATORS = /[\s_\-/\\.,;:()\[\]{}]+/;

/** Split a name into lowercase tokens, keeping non-ASCII letters. */
export function tokenize(name: string): string[] {
  // camelCase → kebab first: eyeWhiteLeft -> eye White Left
  const deCamel = name.replace(/([a-z\p{Ll}])([A-Z\p{Lu}])/gu, "$1 $2");
  return deCamel
    .split(SEPARATORS)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

const DROP_TAGS = ["[delete]", "delete", "unused", "scrap", "wip", "ignore", "temp"];

interface Rule {
  slot: string;
  /** ASCII whole-token terms */
  terms: string[];
  /** non-ASCII substring terms */
  substrings: string[];
}

const RULES: Rule[] = [
  // Order matters: first match wins.
  { slot: "eye_closed", terms: ["eyeclosed", "closedeye", "eyeclosedlayer", "wink"], substrings: ["閉じ目", "闭 眼"] },
  { slot: "eye_shine", terms: ["eyeshine", "shine", "highlight", "eyehighlight", "sparkle", "catchlight"], substrings: ["ハイライト"] },
  { slot: "eyelash_bottom", terms: ["bottomlash", "lowerlash", "underlash", "lashbottom", "eyelashbottom"], substrings: ["下まつげ"] },
  { slot: "eyelash_top", terms: ["eyelash", "eyelashes", "lash", "lashes", "toplash", "lashtop", "eyelashtop", "eyelashline", "lidline"], substrings: ["まつげ", "睫毛", "реснич"] },
  { slot: "eye_white", terms: ["eyewhite", "white", "sclera", "eyeball"], substrings: ["白目", "белок"] },
  { slot: "iris", terms: ["iris", "pupil", "eyeiris"], substrings: ["瞳", "虹彩", "зрачок", "радужк"] },
  { slot: "eyebrow", terms: ["eyebrow", "brow"], substrings: ["眉", "бров"] },
  { slot: "lip_upper", terms: ["toplip", "upperlip", "liptop"], substrings: ["上唇"] },
  { slot: "lip_lower", terms: ["bottomlip", "lowerlip", "lipbottom"], substrings: ["下唇"] },
  { slot: "mouth_inner", terms: ["mouthback", "teeth", "tooth", "tongue", "upperteeth", "lowerteeth", "backteeth", "innermouth", "mouthinside", "cavity"], substrings: ["口内", "舌", "歯", "зуб", "язык"] },
  { slot: "mouth_open", terms: ["mouthopen", "openmouth"], substrings: ["開いた口"] },
  { slot: "nose", terms: ["nose", "nostril"], substrings: ["鼻", "нос"] },
  { slot: "blush", terms: ["blush", "cheekblush"], substrings: ["ほっぺ", "румян"] },
  { slot: "ear_fox", terms: ["ear", "ears", "foxear", "catear", "nekomimi", "animalear"], substrings: ["耳", "ухо"] },
  { slot: "hair_front", terms: ["bangs", "fringe", "hairfront", "fronthair", "forelock"], substrings: ["前髪", "челк", "чёлк"] },
  { slot: "hair_middle", terms: ["hairmiddle", "midhair", "middlehair", "hairmid"], substrings: ["中髪"] },
  { slot: "hair_side", terms: ["hairside", "sidehair", "sidelock", "sidelocks"], substrings: ["サイド", "横髪"] },
  { slot: "hair_back", terms: ["hairback", "backhair", "hairrear", "rearhair"], substrings: ["後ろ髪", "задниеволосы", "задн"] },
  { slot: "hair", terms: ["hair", "strand"], substrings: ["髪", "волос"] },
  { slot: "head", terms: ["head", "face"], substrings: ["頭", "顔", "голов", "лицо"] },
  { slot: "neck", terms: ["neck"], substrings: ["首", "шея", "шеи"] },
  { slot: "chest_accessory", terms: ["chestaccessory", "chestaccessories", "accessory", "accessories", "brooch", "necklace"], substrings: ["アクセサリ"] },
  { slot: "chest", terms: ["chest", "breast", "bust", "boob", "boobs"], substrings: ["胸", "грудь"] },
  { slot: "torso", terms: ["torso", "body", "belly", "stomach", "abdomen", "waist"], substrings: ["胴", "туловищ", "тело", "живот"] },
  { slot: "hips", terms: ["hips", "hip", "pelvis"], substrings: ["腰", "бедр", "бёдр", "таз"] },
  { slot: "arm", terms: ["arm", "shoulder", "hand", "sleeve"], substrings: ["腕", "рука", "рукав"] },
  { slot: "leg", terms: ["leg", "thigh", "knee", "foot", "feet"], substrings: ["脚", "足", "нога"] },
  { slot: "skirt", terms: ["skirt"], substrings: ["スカート", "юбк"] },
  { slot: "background", terms: ["background", "backdrop", "bg"], substrings: ["背景", "фон"] },
];

const SIDE_LEFT = new Set(["left", "l", "左", "лев", "левой", "левая"]);
const SIDE_RIGHT = new Set(["right", "r", "右", "прав", "правой", "правая"]);
const SIDE_MIDDLE = new Set(["middle", "mid", "centre", "center", "中"]);

function stripSideTokens(tokens: string[]): { rest: string[]; side: "left" | "right" | "middle" | null; hasMiddle: boolean } {
  let side: "left" | "right" | "middle" | null = null;
  let hasMiddle = false;
  const rest = tokens.filter((t) => {
    if (SIDE_LEFT.has(t)) {
      side = "left";
      return false;
    }
    if (SIDE_RIGHT.has(t)) {
      side = "right";
      return false;
    }
    if (SIDE_MIDDLE.has(t)) {
      // "middle" is both a side and slot content (hair_middle); keep it for
      // slot matching and decide the side after the slot resolves.
      hasMiddle = true;
      return true;
    }
    return true;
  });
  return { rest, side, hasMiddle };
}

function matchTokens(tokens: string[], name: string): { slot: string; matched: string } | null {
  // Candidate tokens: the tokens themselves plus adjacent joins, so
  // "eye white" also offers "eyewhite" — while "beard" offers only "beard"
  // and never matches "ear". ASCII terms match whole candidates only.
  const candidates = new Set<string>(tokens);
  for (let i = 0; i < tokens.length; i++) {
    for (let len = 2; len <= Math.min(4, tokens.length - i); len++) {
      candidates.add(tokens.slice(i, i + len).join(""));
    }
  }
  const lowerName = name.toLowerCase();
  for (const rule of RULES) {
    for (const term of rule.terms) {
      if (candidates.has(term)) {
        return { slot: rule.slot, matched: term };
      }
    }
    for (const sub of rule.substrings) {
      // Non-ASCII terms match as substrings (no word separators; inflection).
      if (lowerName.includes(sub.toLowerCase()) || tokens.some((t) => t.includes(sub.toLowerCase()))) {
        return { slot: rule.slot, matched: sub };
      }
    }
  }
  return null;
}

/**
 * Classify one layer from its name and group path. Group names are context:
 * a layer called `iris` inside `Left Eye` resolves correctly. Position
 * (canvas half) always wins over names for symmetric parts — the caller
 * passes `canvasHalf` = "left" | "right" | null based on which half of the
 * canvas the layer occupies, and it overrides a name-derived side.
 */
export function classifyLayer(
  name: string,
  groupPath: string[],
  canvasHalf: "left" | "right" | null = null,
): Classification {
  const lowerName = name.toLowerCase().trim();
  for (const tag of DROP_TAGS) {
    if (lowerName.includes(tag)) {
      return { slot: null, side: null, drop: true, matched: tag };
    }
  }

  const { rest, side: nameSide, hasMiddle } = stripSideTokens(tokenize(name));
  const context = [...groupPath].reverse();
  let hit: { slot: string; matched: string } | null = matchTokens(rest, name);
  if (!hit) {
    // Try the group path, nearest group first.
    for (const group of context) {
      const { rest: gRest } = stripSideTokens(tokenize(group));
      hit = matchTokens(gRest, group);
      if (hit) break;
    }
  }

  // Numeric strand suffixes: hair-back-01 → hair_back family.
  if (!hit) {
    const numbered = rest.filter((t) => !/^\d+$/.test(t));
    hit = matchTokens(numbered, name);
  }

  if (!hit) return { slot: null, side: null, drop: false, matched: null };

  let side = nameSide;
  // Group context can also carry the side ("Left Eye").
  if (!side) {
    for (const group of context) {
      const { side: gSide } = stripSideTokens(tokenize(group));
      if (gSide) {
        side = gSide;
        break;
      }
    }
  }
  // "middle" counts as a side unless the slot itself is the middle-hair slot.
  if (!side && hasMiddle && hit.slot !== "hair_middle") {
    side = "middle";
  }
  // Position always wins over the name for symmetric parts — the artwork
  // cannot be wrong about which half of the canvas it occupies.
  const SYMMETRIC = new Set([
    "eye_white",
    "iris",
    "eye_shine",
    "eyelash_top",
    "eyelash_bottom",
    "eye_closed",
    "eyebrow",
    "ear_fox",
    "arm",
    "leg",
    "hair_side",
  ]);
  if (canvasHalf && SYMMETRIC.has(hit.slot)) {
    side = canvasHalf;
  }
  return { slot: hit.slot, side, drop: false, matched: hit.matched };
}
