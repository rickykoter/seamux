// The Tray: every shelf sprite in a tile, under the board's shelf. A click on
// the shelf asks for it (the board posts {crew: "sprites"}, dock.ts opens it);
// a pick saves the choice (sprite.ts, through panecat's `sprite`) and closes
// it, and the board, the pane peek and search follow. Escape, a click
// outside, or the shelf again closes it without a change.
import { frameSvg, sprite } from "./panecat";
import { SPRITES, SPRITE_IDS, type Frame, type SpriteId } from "./sprites.gen";

/** How often one tile, in turn, blinks while the Tray is open. */
const BLINK_EVERY_MS = 900;

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Tray {
  el = document.createElement("div");
  private tiles = new Map<SpriteId, { button: HTMLButtonElement; art: HTMLElement }>();
  private idle = 0;
  private turn = 0;
  /** When the Tray last closed itself: the shelf's click that closed it (the
   *  window lost focus to the board's frame first) must not open it again. */
  private shutAt = 0;

  constructor() {
    this.el.className = "tray";
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Shelf sprite");
    for (const id of SPRITE_IDS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tray-tile";
      const art = document.createElement("span");
      art.className = "tray-art";
      const name = document.createElement("span");
      name.textContent = SPRITES[id].name;
      button.append(art, name);
      button.addEventListener("click", () => this.pick(id));
      this.tiles.set(id, { button, art });
      this.el.append(button);
    }
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.hide();
      }
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** The board asked: open under the shelf, `top` px down the board's column,
   *  or close when it is open (or just closed by that same click). */
  toggle(top: number): void {
    if (this.open || Date.now() - this.shutAt < 400) return this.hide();
    this.el.style.top = `${Math.round(top)}px`;
    this.el.hidden = false;
    const now = sprite.get();
    for (const [id, t] of this.tiles) {
      t.button.setAttribute("aria-pressed", String(id === now));
      this.draw(id, "sit");
    }
    this.tiles.get(now)?.button.focus();
    document.addEventListener("pointerdown", this.outside, true);
    window.addEventListener("blur", this.blurred);
    if (!still()) this.idle = window.setInterval(() => this.blink(), BLINK_EVERY_MS);
  }

  hide(): void {
    if (!this.open) return;
    this.el.hidden = true;
    this.shutAt = Date.now();
    clearInterval(this.idle);
    this.idle = 0;
    document.removeEventListener("pointerdown", this.outside, true);
    window.removeEventListener("blur", this.blurred);
  }

  private pick(id: SpriteId): void {
    sprite.set(id);
    this.hide();
  }

  private draw(id: SpriteId, f: Frame): void {
    const t = this.tiles.get(id);
    if (t) t.art.innerHTML = frameSvg(id, f);
  }

  /** One tile at a time shuts its eyes for a moment: they idle, not stare. */
  private blink(): void {
    const id = SPRITE_IDS[this.turn++ % SPRITE_IDS.length];
    this.draw(id, "sit-blink");
    window.setTimeout(() => this.open && this.draw(id, "sit"), 180);
  }

  private outside = (e: PointerEvent): void => {
    if (!this.el.contains(e.target as Node)) this.hide();
  };

  /** A click in the board's frame takes focus from the app's window. */
  private blurred = (): void => this.hide();
}
