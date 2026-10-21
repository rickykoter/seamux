import { invoke } from "@tauri-apps/api/core";
import { Tabs } from "./tabs";
import { WallView } from "./wall";
import "./wall.css";

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

const tabs = new Tabs(
  document.getElementById("strip")!,
  document.getElementById("stage")!,
  new Map([["wall", document.getElementById("wall")!]]),
);
tabs.select("wall");

const hide = () => void invoke("hide_overlay");
document.getElementById("hide")!.addEventListener("click", hide);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hide();
  // ⌘1…⌘4 switch tabs, while focus is in the shell rather than a framed page.
  if (e.metaKey && e.key >= "1" && e.key <= "9") {
    tabs.selectIndex(Number(e.key) - 1);
    e.preventDefault();
  }
});

invoke<Status>("cmux_status").then(show, (e) => show({ state: "failed", kind: "app", message: String(e) }));
wall.start().catch((e) => wall.problem(`The wall couldn't start: ${String(e)}`));
