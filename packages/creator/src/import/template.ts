// Template PSD: the §3 naming convention as an empty group structure the
// target user (not an artist) can fill in. Generated client-side with
// ag-psd's writer — no server round-trip.

import { writePsd, type Layer } from "ag-psd";

function group(name: string, children: Layer[] = []): Layer {
  return { name, children } as Layer;
}

export const TEMPLATE_STRUCTURE: Layer[] = [
  group("Background [DELETE]"),
  group("Back Hair"),
  group("Arms", [group("Left Arm"), group("Right Arm")]),
  group("Legs", [group("Left Leg"), group("Right Leg")]),
  group("Hips"),
  group("Neck"),
  group("Chest"),
  group("Head", [
    group("Inner Mouth"),
    group("Mouth"),
    group("Nose"),
    group("Eyes", [group("Left Eye"), group("Right Eye")]),
  ]),
  group("Mid Hair"),
  group("Bangs"),
  group("Eyebrows"),
];

export function templatePsdBytes(): ArrayBuffer {
  return writePsd(
    {
      width: 2048,
      height: 3072,
      children: TEMPLATE_STRUCTURE,
    } as Parameters<typeof writePsd>[0],
    {},
  );
}

export function downloadTemplate(): void {
  const bytes = templatePsdBytes();
  const blob = new Blob([bytes], { type: "image/vnd.adobe.photoshop" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "open-avatar-template.psd";
  a.click();
  URL.revokeObjectURL(url);
}
