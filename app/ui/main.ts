import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_TAB, Tabs } from "./tabs";
import { WallView } from "./wall";
import "./wall.css";
// Desk's styles stay: Mosaic's cards and buttons wear them.
import "./desk.css";
import { DockView } from "./dock";
import "./dock.css";
import { Mosaic } from "./mosaic";
import "./mosaic.css";
import { Wake } from "./wake";
import "./wake.css";
import { Timeline } from "./timeline";
import "./timeline.css";
import { ReviewView } from "./review";
import "./review.css";
import { Palette } from "./palette";

// The shape of `cmux_status` in crates/seamux-app/src/main.rs.
type Workspace = { id: string; ref: string; title: string };
type Status =
  | { state: "connected"; transport: string; access_mode: string | null; workspaces: Workspace[] }
  | { state: "failed"; kind: string; message: string };

const why: Record<string, string> = {
  unavailable: "cmux isn't running, or its socket refused this app.",
  missing_method: "This cmux doesn't offer a method the app needs.",
  refused: "cmux refused the request.",
  cli: "The cmux CLI ran but failed.",
  protocol: "cmux answered with something the app couldn't read.",
  bad_handle: "The app asked cmux about a handle it doesn't recognize.",
  app: "The app couldn't run its cmux check.",
};

const wall = new WallView(document.getElementById("wall")!);

function show(s: Status): void {
  const conn = document.getElementById("conn")!;
  if (s.state === "failed") {
    conn.className = "bad";
    conn.textContent = "cmux unreachable";
    wall.problem(`${why[s.kind] ?? "Couldn't reach cmux."} (${s.message})`);
    return;
  }
  const n = s.workspaces.length;
  conn.className = "good";
  conn.title = `Connected over the ${s.transport}${s.access_mode ? `, ${s.access_mode} mode` : ""}`;
  conn.textContent = `cmux · ${n} workspace${n === 1 ? "" : "s"}`;
}

const dockEl = document.getElementById("dock")!;
const timeline = document.getElementById("timeline")!;
const wakeEl = document.getElementById("wake")!;
const dockView = new DockView(dockEl);
const mosaicEl = document.getElementById("mosaic")!;
const mosaic = new Mosaic(mosaicEl, document.getElementById("wall")!, wall);
const timelineView = new Timeline(timeline);
const wakeView = new Wake(wakeEl);
const reviewEl = document.getElementById("review")!;
const reviewView = new ReviewView(reviewEl);

const tabs = new Tabs(
  document.getElementById("strip")!,
  document.getElementById("stage")!,
  new Map([
    ["dock", dockEl],
    ["mosaic", mosaicEl],
    ["timeline", timeline],
    ["wake", wakeEl],
    ["review", reviewEl],
  ]),
);
tabs.onSelect = (id) => {
  if (id === "dock") dockView.shown();
  if (id === "wake") wakeView.shown();
  if (id === "timeline") timelineView.shown();
};
// A Timeline lane's name opens its pane in Mosaic.
timelineView.onOpen = (ws) => {
  tabs.select("mosaic");
  mosaic.openWorkspace(ws);
};
// The Tucked chip sits at the end of the strip; Command-K opens the same palette.
const palette = new Palette();
document.getElementById("strip")!.append(palette.chip);
tabs.select(DEFAULT_TAB);

// Every summon (the hotkey, the tray) lands on the Dock view.
void listen("app:summoned", () => tabs.select(DEFAULT_TAB));

// The window's own red button hides it too (shell.rs turns a close into a hide).
const hide = () => void invoke("hide_overlay");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hide();
  // ⌘1…⌘5 pick the views, while focus is in the shell rather than a framed page.
  if (e.metaKey && e.key >= "1" && e.key <= "9") {
    tabs.selectIndex(Number(e.key) - 1);
    e.preventDefault();
  }
});

invoke<Status>("cmux_status").then(show, (e) => show({ state: "failed", kind: "app", message: String(e) }));
wall.start().catch((e) => wall.problem(`The wall couldn't start: ${String(e)}`));
dockView.start().catch((e) => console.error("dock", e));
mosaic.start().catch((e) => console.error("mosaic", e));
wakeView.start().catch((e) => console.error("wake", e));
timelineView.start().catch((e) => console.error("timeline", e));
reviewView.begin().catch((e) => console.error("review", e));
palette.start().catch((e) => console.error("palette", e));
