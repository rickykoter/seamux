import { invoke } from "@tauri-apps/api/core";
import { Tabs } from "./tabs";

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

function show(s: Status): void {
  const status = document.getElementById("status")!;
  const list = document.getElementById("workspaces")!;
  const conn = document.getElementById("conn")!;
  list.replaceChildren();
  if (s.state === "failed") {
    status.className = "bad";
    status.textContent = `${why[s.kind] ?? "Couldn't reach cmux."} (${s.message})`;
    conn.className = "bad";
    conn.textContent = "cmux unreachable";
    return;
  }
  const n = s.workspaces.length;
  status.className = "muted";
  const mode = s.access_mode ? `, ${s.access_mode} mode` : "";
  status.textContent = `Connected over the ${s.transport}${mode}: ${n} workspace${n === 1 ? "" : "s"} open.`;
  conn.className = "good";
  conn.textContent = `cmux · ${n} workspace${n === 1 ? "" : "s"}`;
  for (const w of s.workspaces) {
    const li = document.createElement("li");
    li.textContent = w.title || w.ref;
    const ref = document.createElement("code");
    ref.className = "muted";
    ref.textContent = `  ${w.ref}`;
    li.append(ref);
    list.append(li);
  }
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
