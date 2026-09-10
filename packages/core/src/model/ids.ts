// Stable, opaque ids. Never renumbered on save.

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, "0");
  return `${prefix}_${counter.toString(36)}${rand}`;
}
