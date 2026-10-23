// One resize handle, used everywhere a panel resizes: the sheet's chat
// divider, the wall's agent list, a Desk card's terminal.
//
// The pointer is captured for the whole drag and framed pages stop taking
// pointer events meanwhile, so a drag across a page never drops. One range
// clamps both the drag and what is read back. The arrow keys nudge it, a
// double-click puts it back, and each zone is kept under seamux.split.<zone>.

export type Split = {
  /** The zone's name: kept as seamux.split.<zone>. */
  zone: string;
  /** A key the zone was kept under before, read when the new one is empty. */
  legacyKey?: string;
  /** "x" drags left and right, "y" up and down. */
  axis: "x" | "y";
  /** The value from a pointer position (clientX or clientY). */
  from: (at: number) => number;
  min: number;
  /** Bounds are fixed numbers: a hidden panel measures 0, so a measured
   *  bound would clamp a kept value away. Cap by layout in CSS instead. */
  max: number;
  initial: number;
  /** One arrow-key nudge. */
  step: number;
  apply: (v: number) => void;
  label: string;
};

const KEY = (zone: string) => `seamux.split.${zone}`;

function read(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null; // a private window: the size is only for now
  }
}

function write(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* a private window: the size is only for now */
  }
}

/** Make `handle` resize by `s`, and apply the kept (or initial) value now. */
export function splitter(handle: HTMLElement, s: Split): { value: () => number } {
  const lo = () => s.min;
  const hi = () => s.max;
  const clamp = (v: number) => Math.min(hi(), Math.max(lo(), v));
  let value = clamp(read(KEY(s.zone)) ?? (s.legacyKey ? read(s.legacyKey) : null) ?? s.initial);

  handle.classList.add("split-handle", s.axis === "x" ? "split-x" : "split-y");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", s.axis === "x" ? "vertical" : "horizontal");
  handle.setAttribute("aria-label", `${s.label}: drag, or use the arrow keys; double-click resets`);
  handle.title = `${s.label} (double-click resets)`;
  handle.tabIndex = 0;

  const set = (v: number, keep: boolean) => {
    value = clamp(v);
    s.apply(value);
    handle.setAttribute("aria-valuenow", String(Math.round(value * 100) / 100));
    handle.setAttribute("aria-valuemin", String(lo()));
    handle.setAttribute("aria-valuemax", String(hi()));
    if (keep) write(KEY(s.zone), value);
  };
  set(value, false);

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("splitting", s.axis === "x" ? "splitting-x" : "splitting-y");
    // By the pointer's travel from where it took hold, so grabbing never jumps.
    const at = (m: PointerEvent) => (s.axis === "x" ? m.clientX : m.clientY);
    const start = value;
    const from0 = s.from(at(e));
    const move = (m: PointerEvent) => set(start + s.from(at(m)) - from0, false);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("lostpointercapture", done);
      document.body.classList.remove("splitting", "splitting-x", "splitting-y");
      write(KEY(s.zone), value);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("lostpointercapture", done);
  });
  handle.addEventListener("dblclick", () => set(s.initial, true));
  handle.addEventListener("keydown", (e) => {
    const back = s.axis === "x" ? "ArrowLeft" : "ArrowUp";
    const fwd = s.axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    e.stopPropagation(); // the views' own arrow keys stay out of it
    set(value + (e.key === fwd ? 1 : -1) * s.step * (e.shiftKey ? 4 : 1), true);
  });
  return { value: () => value };
}
