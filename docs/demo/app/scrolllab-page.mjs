// The scroll lab, side by side (/scroll-lab on the demo server): two native
// panes on the same fake fullscreen Claude (scrollclaude.mjs), the app's
// old way on the left and its new way on the right. Each side's switches
// change only that side. Flick plays the same trackpad flick, so the two
// can be compared by number; scrolling by hand compares them by feel.
import "/everforest.css";
import { NativeTerm } from "/native.ts";
import { LabStore } from "/scrolllab.ts";

const params = new URLSearchParams(location.search);
const SIDES = [
  { title: "Before", surface: "SCROLL-LAB-BEFORE", lab: { renderer: "dom", frames: "raw", wheel: "serial" } },
  { title: "After", surface: "SCROLL-LAB-AFTER", lab: { renderer: "webgl", frames: "whole", wheel: "batch" } },
];

const grid = document.getElementById("lab-grid");
const terms = SIDES.map((s) => {
  const col = document.createElement("section");
  col.className = "lab-side";
  col.setAttribute("aria-label", s.title);
  const t = new NativeTerm({ lab: new LabStore(s.lab), labTitle: s.title });
  col.append(t.el);
  grid.append(col);
  t.show(s.surface);
  return t;
});

/** A trackpad flick as macOS sends it: wheel events a frame apart, quick at
 *  first, then the momentum's long tail of small ones. */
function flick(el, up) {
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  let d = 42;
  const step = () => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: up ? -d : d, deltaMode: 0, bubbles: true, cancelable: true, ...at }));
    d *= 0.94;
    if (d > 0.6) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const screens = () => terms.map((t) => t.el.querySelector(".xterm-screen"));
// Each side starts at the bottom: its first flick goes up, the next down.
const up = SIDES.map(() => true);
for (const [id, which] of [["flick-before", [0]], ["flick-after", [1]], ["flick-both", [0, 1]]]) {
  document.getElementById(id).addEventListener("click", () => {
    const s = screens();
    for (const i of which) {
      if (!s[i]) continue;
      flick(s[i], up[i]);
      up[i] = !up[i];
    }
  });
}

// ?ipc= and ?speed= are the mock's: a choice reloads with it.
for (const name of ["ipc", "speed"]) {
  const sel = document.getElementById(`lab-${name}`);
  sel.value = params.get(name) ?? sel.value;
  sel.addEventListener("change", () => {
    params.set(name, sel.value);
    location.search = params.toString();
  });
}
