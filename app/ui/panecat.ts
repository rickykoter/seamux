// The Dock's cat, peeking into a native pane: out of sight while Claude
// works, up over the bottom-right edge while Claude waits for you, and a hop
// with a heart when a long turn ends. Same animal as the board's and the
// sidebar's: these grids are crew/board/cat_poses.py's (and crew.swift's
// palette), copied, so a change to that cat should be copied here too.

/** catColor() in crew.swift: body, bib, open eye, nose and heart, shut eye, inner ear. */
const COLOR: Record<string, string> = { "1": "#36363F", "2": "#F5F5F7", "3": "#8BE07C", "4": "#F4A6B8", "5": "#5A5A62", "6": "#22222A" };

/** One row per "|", a digit per 3px cell, "." for empty: all in one 22×13 frame. */
const POSES = {
  peek: "|.....11.....11|....1611111161|...111111111111|...1133111155111|..11111222211111|..111112421111111|.11122222222111112|.11222222222211122|..122222222221112|...111111111111",
  perk: "....1........1|....11......11|....161....161|...111111111111|...113111111311|...111112211111|..11111242211111|..11122222222111|.1112222222222111|.1122222222222211|..11222222222211|...22........22",
  "hop-a": "||....11......11|....161....161|...111111111111|...115111111511|..11111242211111|.1112222222222111|.1122222222222211|.1122222222222211|..11222222222211|..222........222",
  "hop-b": "....11......11|....161....161|...111111111111|...115111111511|...111112211111|..11111242211111|..11122222222111|..1112222222211|...1122222222111|...11.......11|...22.......22",
  heart: "||||.............4.4|............44444|.............444|..............4",
};
type Pose = keyof typeof POSES;

const CELL = 3;
const COLS = 22;
const ROWS = 13;

const drawn = new Map<Pose, string>();
function svg(pose: Pose): string {
  let s = drawn.get(pose);
  if (s) return s;
  let rects = "";
  POSES[pose].split("|").forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (COLOR[c]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${COLOR[c]}"/>`;
    });
  });
  s = `<svg viewBox="0 0 ${COLS} ${ROWS}" width="${COLS * CELL}" height="${ROWS * CELL}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
  drawn.set(pose, s);
  return s;
}

/** A turn at least this long earns the hop. */
export const HOP_AFTER_MS = 60_000;

/** What the cat does on a change of state: `from` and `workedMs` describe
 *  the turn that just ended. "hop" then settles to the new state's pose. */
export function catMove(from: string, to: string, workedMs: number): "hop" | "peek" | "away" {
  if (from === "working" && to !== "working" && to !== "ended" && workedMs >= HOP_AFTER_MS) return "hop";
  return to === "needs_input" ? "peek" : "away";
}

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class PaneCat {
  /** The box over the pane: clips the cat at its bottom edge. */
  el = document.createElement("div");
  private cat = document.createElement("div");
  private heart = document.createElement("div");
  private state = "";
  private since = 0;
  private timers: number[] = [];
  private blink = 0;

  constructor() {
    this.el.className = "pane-cat-box";
    this.el.setAttribute("aria-hidden", "true");
    this.cat.className = "pane-cat";
    this.heart.className = "pane-cat-heart";
    this.heart.innerHTML = svg("heart");
    this.el.append(this.heart, this.cat);
    this.pose("peek");
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

  private pose(p: Pose): void {
    this.cat.innerHTML = svg(p);
  }

  private place(up: boolean): void {
    this.cat.dataset.at = up ? "peek" : "away";
    this.pose("peek");
    // Peeking, it looks up at you now and then: ears up for a moment.
    if (up && !still()) {
      this.blink = window.setInterval(() => {
        this.pose("perk");
        this.timers.push(window.setTimeout(() => this.cat.dataset.at === "peek" && this.pose("peek"), 1200));
      }, 7000);
    }
  }

  /** Up, two hops with a heart rising, then settle: peeking if Claude asks
   *  for you, else back down. Reduced motion: one still pose and the heart. */
  private hop(thenPeek: boolean): void {
    const later = (ms: number, f: () => void) => this.timers.push(window.setTimeout(f, ms));
    this.cat.dataset.at = "up";
    this.heart.classList.add("up");
    if (still()) {
      this.pose("hop-b");
      later(1600, () => this.place(thenPeek));
      return;
    }
    const steps: [Pose, string][] = [["hop-a", "up"], ["hop-b", "air"], ["hop-a", "up"], ["hop-b", "air"], ["hop-a", "up"]];
    steps.forEach(([p, at], i) => later(i * 240, () => ((this.cat.dataset.at = at), this.pose(p))));
    later(steps.length * 240 + 500, () => {
      this.heart.classList.remove("up");
      this.place(thenPeek);
    });
  }
}
