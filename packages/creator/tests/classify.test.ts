import { describe, it, expect } from "vitest";
import { classifyLayer, tokenize } from "../src/import/classify";

describe("classifier — §3 canonical names", () => {
  const cases: [string, string, string | null, string | null][] = [
    // [name, expected slot, expected side, group]
    ["hair-back-left", "hair_back", "left", "Back Hair"],
    ["hair-back-01", "hair_back", null, "Back Hair"],
    ["arm-left", "arm", "left", "Left Arm"],
    ["torso", "torso", null, ""],
    ["leg-right", "leg", "right", "Right Leg"],
    ["hips", "hips", null, "Hips"],
    ["Neck", "neck", null, "Neck"],
    ["chest", "chest", null, "Chest"],
    ["chest-accessories", "chest_accessory", null, "Chest"],
    ["head", "head", null, "Head"],
    ["Mouth_Back", "mouth_inner", null, "Inner Mouth"],
    ["Back_Teeth", "mouth_inner", null, "Inner Mouth"],
    ["Tongue", "mouth_inner", null, "Inner Mouth"],
    ["Lower_Teeth", "mouth_inner", null, "Inner Mouth"],
    ["Upper_Teeth", "mouth_inner", null, "Inner Mouth"],
    ["bottom-lip", "lip_lower", null, "Mouth"],
    ["top-lip", "lip_upper", null, "Mouth"],
    ["nose", "nose", null, "Nose"],
    ["eye-white-left", "eye_white", "left", "Left Eye"],
    ["iris-left", "iris", "left", "Left Eye"],
    ["eyelash-top-left", "eyelash_top", "left", "Left Eye"],
    ["eye-white-right", "eye_white", "right", "Right Eye"],
    ["Blush", "blush", null, ""],
    ["hair-middle-left", "hair_middle", "left", "Mid Hair"],
    ["hair-front-middle", "hair_front", "middle", "Bangs"],
    ["eyebrow-left", "eyebrow", "left", "Eyebrows"],
    ["eyelash-bottom-left", "eyelash_bottom", "left", "Left Eye"],
    ["eye-closed-right", "eye_closed", "right", "Right Eye"],
    ["hair-side-left", "hair_side", "left", ""],
    ["mouth-open", "mouth_open", null, ""],
  ];
  for (const [name, slot, side, group] of cases) {
    it(`classifies "${name}" as ${slot}${side ? `:${side}` : ""}`, () => {
      const cls = classifyLayer(name, group ? [group] : []);
      expect(cls.slot).toBe(slot);
      if (side) expect(cls.side).toBe(side);
      expect(cls.drop).toBe(false);
    });
  }

  it("matching is case- and separator-insensitive", () => {
    expect(classifyLayer("Eye White Left", []).slot).toBe("eye_white");
    expect(classifyLayer("eye_white_left", []).slot).toBe("eye_white");
    expect(classifyLayer("eyeWhiteLeft", []).slot).toBe("eye_white");
    expect(classifyLayer("EYE-WHITE-LEFT", []).slot).toBe("eye_white");
  });

  it("group names provide context: a bare `iris` inside `Left Eye` resolves", () => {
    const cls = classifyLayer("iris", ["Head", "Eyes", "Left Eye"]);
    expect(cls.slot).toBe("iris");
    expect(cls.side).toBe("left");
  });

  it("drops layers tagged DELETE/unused/scrap/WIP/ignore", () => {
    for (const name of ["Background [DELETE]", "old mouth unused", "scrap_03", "mouth WIP", "ignore me"]) {
      expect(classifyLayer(name, []).drop, name).toBe(true);
    }
  });

  it("ASCII terms match whole tokens only: beard is not an ear, charm is not an arm", () => {
    expect(classifyLayer("beard", []).slot).not.toBe("ear_fox");
    expect(classifyLayer("charm bracelet", []).slot).not.toBe("arm");
  });
});

describe("classifier — non-English names", () => {
  it("Russian: stems match inflected forms as substrings", () => {
    expect(classifyLayer("бровь левая", []).slot).toBe("eyebrow");
    expect(classifyLayer("брови", []).slot).toBe("eyebrow");
    expect(classifyLayer("бровей", []).slot).toBe("eyebrow");
    expect(classifyLayer("голова", []).slot).toBe("head");
    expect(classifyLayer("волосы задние", []).slot).toBe("hair_back");
    expect(classifyLayer("зубы", []).slot).toBe("mouth_inner");
  });

  it("Japanese: no word separators needed", () => {
    expect(classifyLayer("前髪", []).slot).toBe("hair_front");
    expect(classifyLayer("眉", []).slot).toBe("eyebrow");
    expect(classifyLayer("白目", []).slot).toBe("eye_white");
    expect(classifyLayer("瞳", []).slot).toBe("iris");
  });

  it("tokeniser keeps Cyrillic and CJK characters", () => {
    expect(tokenize("бровь_левая")).toContain("бровь");
    expect(tokenize("前髪")).toContain("前髪");
  });
});

describe("classifier — left and right", () => {
  it("position wins over names for symmetric parts", () => {
    // A layer named -left but sitting on the character's right half is right.
    const cls = classifyLayer("eye-white-left", ["Right Eye"], "right");
    expect(cls.slot).toBe("eye_white");
    expect(cls.side).toBe("right");
  });

  it("-left is the character's own left (right side of canvas)", () => {
    const cls = classifyLayer("eyebrow", ["Eyebrows"], "left");
    expect(cls.side).toBe("left");
  });
});
