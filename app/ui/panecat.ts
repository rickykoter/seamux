// The Dock's sprite, peeking into a native pane: out of sight while Claude
// works, up over the bottom-right edge while Claude waits for you, and a hop
// with a heart when a long turn ends. It is the sprite chosen for the shelf
// (sprite.ts), drawn from the same grids as the board's (sprites.gen.ts,
// generated from crew/board/sprites by `seamux sprites`).
import { Choice, catMove } from "./sprite";
import { DEFAULT_SPRITE, H, SPRITES, SPRITE_IDS, W, type Frame, type SpriteId } from "./sprites.gen";

/** CSS pixels a cell, as on the board's shelf. */
const CELL = 2;

/** The person's sprite, shared by the pane peek, search and the Tray. */
export const sprite = new Choice<SpriteId>(SPRITE_IDS, DEFAULT_SPRITE, (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})());

const drawn = new Map<string, string>();

/** A frame as SVG markup, a run of same-coloured cells one rect, at `cell` px a cell. */
export function frameSvg(id: SpriteId, frame: Frame, cell = CELL): string {
  const key = `${id}/${frame}/${cell}`;
  let s = drawn.get(key);
  if (s) return s;
  const sp = SPRITES[id];
  let rects = "";
  sp.frames[frame].forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x];
      let n = 1;
      while (x + n < row.length && row[x + n] === c) n++;
      if (c !== ".") rects += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${sp.palette[c]}"/>`;
      x += n;
    }
  });
  s = `<svg viewBox="0 0 ${W} ${H}" width="${W * cell}" height="${H * cell}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
  drawn.set(key, s);
  return s;
}

/** The chosen sprite in a still pose, as SVG markup: the session search's empty state. */
export function catSvg(pose: "sit" | "perk"): string {
  return frameSvg(sprite.get(), pose);
}

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class PaneCat {
  /** The box over the pane: clips the sprite at its bottom edge. */
  el = document.createElement("div");
  private cat = document.createElement("div");
  private heart = document.createElement("div");
  private state = "";
  private since = 0;
  private timers: number[] = [];
  private blink = 0;
  private frame: Frame = "sit";

  constructor() {
    this.el.className = "pane-cat-box";
    this.el.setAttribute("aria-hidden", "true");
    this.cat.className = "pane-cat";
    this.heart.className = "pane-cat-heart";
    this.el.append(this.heart, this.cat);
    this.pose("sit");
    // A new sprite chosen on the shelf: the same pose, in the new sprite.
    sprite.listen(() => this.pose(this.frame));
  }

  /** The pane's state (wall.rs's Tile.state) and when it entered it. The
   *  first call only learns the state: a pane opened mid-wait peeks, but no
   *  turn ended in front of it, so no hop. */
  update(state: string, since: number): void {
    if (state === this.state) return;
    const first = this.state === "";
    const move = first ? (state === "needs_input" ? "peek" : "away") : catMove(this.state, state, Date.now() - this.since);
    this.state = state;
    this.since = since || Date.now();
    this.clear();
    if (move === "hop") this.hop(state === "needs_input");
    else this.place(move === "peek");
  }

  /** A different pane: forget the last one's state. */
  reset(): void {
    this.state = "";
    this.clear();
    this.place(false);
  }

  private clear(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    clearInterval(this.blink);
    this.blink = 0;
    this.heart.classList.remove("up");
  }

  private pose(f: Frame): void {
    this.frame = f;
    const id = sprite.get();
    this.cat.innerHTML = frameSvg(id, f);
    this.heart.innerHTML = frameSvg(id, "heart");
  }

  private later(ms: number, f: () => void): void {
    this.timers.push(window.setTimeout(f, ms));
  }

  private place(up: boolean): void {
    this.cat.dataset.at = up ? "peek" : "away";
    this.pose("sit");
    // Peeking, it blinks now and then and looks up at you: ears up a moment.
    if (up && !still()) {
      let n = 0;
      this.blink = window.setInterval(() => {
        if (this.cat.dataset.at !== "peek") return;
        const f: Frame = ++n % 2 ? "sit-blink" : "perk";
        this.pose(f);
        this.later(f === "perk" ? 1200 : 180, () => this.cat.dataset.at === "peek" && this.pose("sit"));
      }, 3500);
    }
  }

  /** Up, two hops with a heart rising, then settle: peeking if Claude asks
   *  for you, else back down. Reduced motion: one still pose and the heart. */
  private hop(thenPeek: boolean): void {
    this.cat.dataset.at = "up";
    this.heart.classList.add("up");
    if (still()) {
      this.pose("hop-air");
      this.later(1600, () => this.place(thenPeek));
      return;
    }
    const steps: [Frame, string][] = [["hop-crouch", "up"], ["hop-air", "air"], ["hop-crouch", "up"], ["hop-air", "air"], ["hop-crouch", "up"]];
    steps.forEach(([p, at], i) => this.later(i * 240, () => ((this.cat.dataset.at = at), this.pose(p))));
    this.later(steps.length * 240 + 500, () => {
      this.heart.classList.remove("up");
      this.place(thenPeek);
    });
  }
}
