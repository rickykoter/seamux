import { invoke } from "@tauri-apps/api/core";

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
  list.replaceChildren();
  if (s.state === "failed") {
    status.className = "bad";
    status.textContent = `${why[s.kind] ?? "Couldn't reach cmux."} (${s.message})`;
    return;
  }
  status.className = "muted";
  const mode = s.access_mode ? `, ${s.access_mode} mode` : "";
  const n = s.workspaces.length;
  status.textContent = `Connected over the ${s.transport}${mode}: ${n} workspace${n === 1 ? "" : "s"} open.`;
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

invoke<Status>("cmux_status").then(show, (e) =>
  show({ state: "failed", kind: "app", message: String(e) }),
);
