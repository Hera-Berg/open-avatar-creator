// Undo: covers everything. Two stacks, cap 200, redo cleared on a new
// command. Same-type commands on the same target within ~400ms coalesce —
// without that, one vertex drag is 200 undo steps and Ctrl+Z is useless.

import type { OarManifest } from "@oar/core";

export interface Command {
  label: string;
  time: number;
  apply(model: OarManifest): void;
  revert(model: OarManifest): void;
  /** Each command type decides its own coalescing rule: rotations coalesce,
   *  deletions never do. Return the merged command or null. */
  coalesceWith?(next: Command): Command | null;
}

export const HISTORY_CAP = 200;
export const COALESCE_WINDOW_MS = 400;

export class History {
  undoStack: Command[] = [];
  redoStack: Command[] = [];

  execute(model: OarManifest, cmd: Command): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.coalesceWith && cmd.time - top.time < COALESCE_WINDOW_MS) {
      const merged = top.coalesceWith(cmd);
      if (merged) {
        merged.apply(model);
        this.undoStack[this.undoStack.length - 1] = merged;
        this.redoStack = [];
        return;
      }
    }
    cmd.apply(model);
    this.undoStack.push(cmd);
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(model: OarManifest): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.revert(model);
    this.redoStack.push(cmd);
    return cmd.label;
  }

  redo(model: OarManifest): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.apply(model);
    this.undoStack.push(cmd);
    return cmd.label;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/**
 * Before/after command. When `coalesceKey` is set, consecutive commands with
 * the same key merge: the first command's revert is kept (the drag starts
 * where the drag started) and the latest apply wins.
 */
export function makeCommand(opts: {
  label: string;
  apply: (model: OarManifest) => void;
  revert: (model: OarManifest) => void;
  coalesceKey?: string;
}): Command {
  const cmd: Command = {
    label: opts.label,
    time: Date.now(),
    apply: opts.apply,
    revert: opts.revert,
  };
  if (opts.coalesceKey) {
    const key = opts.coalesceKey;
    (cmd as Command & { __key?: string }).__key = key;
    cmd.coalesceWith = (next: Command): Command | null => {
      if ((next as Command & { __key?: string }).__key !== key) return null;
      const merged = makeCommand({
        label: next.label,
        apply: (m) => next.apply(m),
        revert: (m) => cmd.revert(m),
        coalesceKey: key,
      });
      return merged;
    };
  }
  return cmd;
}
