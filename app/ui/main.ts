import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_TAB, Tabs } from "./tabs";
import "./everforest.css";
import { DockView } from "./dock";
import "./dock.css";
import "./tray.css";
import "./newws.css";
import "./reclaim.css";
import { Wake } from "./wake";
import "./wake.css";
import "./panechips.css";
import { ReviewView } from "./review";
import "./review.css";
import { Palette } from "./palette";
import { appearanceButton } from "./appearance";

// Light, dark or the system's, before anything draws; its button sits just
// before the connection line.
document.getElementById("conn")!.before(appearanceButton());

// The shape of `backend_status` in crates/seamux-app/src/main.rs.
type Workspace = { id: string; ref: string; title: string };
type Status =
  | { state: "connected"; backend: string; transport: string; access_mode: string | null; workspaces: Workspace[] }
  | { state: "failed"; kind: string; message: string };

const why: Record<string, string> = {
  unavailable: "cmux isn't running, or its socket refused this app.",
  missing_method: "This cmux doesn't offer a method the app needs.",
  refused: "cmux refused the request.",
  cli: "The cmux CLI ran but failed.",
  protocol: "cmux answered with something the app couldn't read.",
  bad_handle: "The app asked cmux about a handle it doesn't recognize.",
  app: "The app couldn't run its backend check.",
  backend: "The app's backend isn't available.",
};

function show(s: Status): void {
  const conn = document.getElementById("conn")!;
  if (s.state === "failed") {
    conn.className = "bad";
    conn.textContent = s.kind === "backend" ? "backend unavailable" : "cmux unreachable";
    conn.title = `${why[s.kind] ?? "Couldn't reach cmux."} (${s.message})`;
    return;
  }
  const n = s.workspaces.length;
  // What only cmux can do (reply, jump, Open in cmux) hides on another backend.
  document.body.dataset.backend = s.backend;
  conn.className = "good";
  conn.title = s.backend === "cmux"
    ? `cmux, over the ${s.transport}${s.access_mode ? `, ${s.access_mode} mode` : ""}`
    : `The app's own ${s.backend} sessions`;
  conn.textContent = `${s.backend} · ${n} workspace${n === 1 ? "" : "s"}`;
}

const dockEl = document.getElementById("dock")!;
const wakeEl = document.getElementById("wake")!;
const dockView = new DockView(dockEl);
const wakeView = new Wake(wakeEl);
const reviewEl = document.getElementById("review")!;
const reviewView = new ReviewView(reviewEl);

const tabs = new Tabs(
  document.getElementById("strip")!,
  document.getElementById("stage")!,
  new Map([
    ["dock", dockEl],
    ["wake", wakeEl],
    ["review", reviewEl],
  ]),
);
tabs.onSelect = (id) => {
  if (id === "dock") dockView.shown();
  if (id === "wake") wakeView.shown();
  reviewView.setShown(id === "review");
};
// Session search (palette.ts): ⌘K, ⌥⇧Space from any app, or the Tucked chip
// at the end of the strip. Choosing a session shows it in the Dock.
const palette = new Palette();
document.getElementById("strip")!.append(palette.chip);
palette.onJump = (ws, pane) => {
  tabs.select("dock");
  dockView.jump(ws, pane);
};
tabs.select(DEFAULT_TAB);

// Every summon (the hotkey, the tray) lands on the Dock view.
void listen("app:summoned", () => tabs.select(DEFAULT_TAB));

// A click on a notification (crates/seamux-app/src/notify_app.rs) lands on
// its pane in the Dock.
// A seamux://focus link (ADR 0086) arrives the same way; one that launched
// the app came before this listened, so it is taken once listening starts.
void listen<{ ws: string; pane: string }>("notify:jump", (e) => {
  tabs.select("dock");
  dockView.jump(e.payload.ws, e.payload.pane);
}).then(async () => {
  const link = await invoke<{ ws: string; pane: string } | null>("notify_take_link").catch(() => null);
  if (link?.ws) {
    tabs.select("dock");
    dockView.jump(link.ws, link.pane);
  }
});

// A click on a PR banner (crates/seamux-app/src/pr_watch.rs) lands on its
// review in the Lookout tab, on the comment or the checks it names.
void listen<{ review: string; item: string }>("notify:review", (e) => {
  tabs.select("review");
  void reviewView.focus(e.payload.review, e.payload.item);
});

// ⌘. (a shell.rs shortcut, so it works in a framed page too): on to the next
// workspace that needs you.
void listen<string>("sheet:key", (e) => {
  if (e.payload !== "attention") return;
  tabs.select("dock");
  dockView.nextAttention();
});

// The window's own red button hides it too (shell.rs turns a close into a hide).
const hide = () => void invoke("hide_overlay");
document.addEventListener("keydown", (e) => {
  // Not an Escape something below already took: the Dock's terminal catches
  // a second Esc in a row (native.ts, so Claude's Rewind does not open) and
  // only blurs, but xterm lets the key it declined go on up to here.
  if (e.key === "Escape" && !e.defaultPrevented) hide();
  // ⌘1…⌘3 pick the views, while focus is in the shell rather than a framed page.
  if (e.metaKey && e.key >= "1" && e.key <= "9") {
    tabs.selectIndex(Number(e.key) - 1);
    e.preventDefault();
  }

});

// The count moves as workspaces come and go: asked again on a timer and on
// each summon, not only at launch.
const refreshStatus = () =>
  invoke<Status>("backend_status").then(show, (e) => show({ state: "failed", kind: "app", message: String(e) }));
void refreshStatus();
setInterval(() => void refreshStatus(), 10_000);
void listen("app:summoned", () => void refreshStatus());
dockView.start().catch((e) => console.error("dock", e));
wakeView.start().catch((e) => console.error("wake", e));
reviewView.begin().catch((e) => console.error("review", e));
palette.start().catch((e) => console.error("palette", e));
