// The shelf sprite the person chose, and what the pane's sprite does on a
// change of state. Nothing here draws or imports: panecat.ts wires it to the
// generated sprites, and sprite_probe.ts runs it under node as it is.
//
// The choice is saved in this app's localStorage, like its appearance. The
// board hears it in the Dock's selected message; the pane peek, search and
// the Tray read it here. Outside the app, and with nothing saved, it is the
// default sprite.

/** Where the choice is saved. */
export const KEY = "seamux.sprite";

/** What a saved value means: one of `ids`, else the fallback. */
export function pick<T extends string>(saved: string | null | undefined, ids: readonly T[], fallback: T): T {
  return ids.find((i) => i === saved) ?? fallback;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The choice: read once, saved on change, told to every listener. */
export class Choice<T extends string> {
  private id: T;
  private heard = new Set<(id: T) => void>();
  // Plain fields, not parameter properties: node strips types without them.
  private ids: readonly T[];
  private fallback: T;
  private store: Store | null;

  constructor(ids: readonly T[], fallback: T, store: Store | null) {
    this.ids = ids;
    this.fallback = fallback;
    this.store = store;
    let saved: string | null = null;
    try {
      saved = store?.getItem(KEY) ?? null;
    } catch {
      // Storage refused: the default, until a choice is made.
    }
    this.id = pick(saved, ids, fallback);
  }

  get(): T {
    return this.id;
  }

  /** Save and apply a choice; one that is not a sprite is ignored. */
  set(id: string): void {
    const next = pick(id, this.ids, this.id);
    if (next !== id) return;
    try {
      if (next === this.fallback) this.store?.removeItem(KEY);
      else this.store?.setItem(KEY, next);
    } catch {
      // Storage refused: the choice lasts until the app restarts.
    }
    if (next === this.id) return;
    this.id = next;
    this.heard.forEach((f) => f(next));
  }

  /** Hear each change; returns the way to stop. */
  listen(f: (id: T) => void): () => void {
    this.heard.add(f);
    return () => this.heard.delete(f);
  }
}

/** A turn at least this long earns the hop. */
export const HOP_AFTER_MS = 60_000;

/** What the pane's sprite does on a change of state: `from` and `workedMs`
 *  describe the turn that just ended. "hop" then settles to the new state's pose. */
export function catMove(from: string, to: string, workedMs: number): "hop" | "peek" | "away" {
  if (from === "working" && to !== "working" && to !== "ended" && workedMs >= HOP_AFTER_MS) return "hop";
  return to === "needs_input" ? "peek" : "away";
}
