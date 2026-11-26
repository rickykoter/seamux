// Which host Claude is running in, so chartroom knows where its studio can go.
//
// A copy of lookout/lib/host.mjs's detectHost, sessionIds and hostLine (ADR
// 0004 keeps plugins from importing each other); chartroom's probe checks the
// two agree on every signal. Change both together. chartroom needs none of
// seamux to run: with no SEAMUX_* or CMUX_* signal the host is terminal or
// desktop, and the studio is a URL.
//
//   SEAMUX_HOST=cmux|seamux|desktop|terminal|remote  beats every signal below
//   CMUX_WORKSPACE_ID set, SEAMUX_BACKEND not tmux    cmux
//   SEAMUX_PANE_ID set                                seamux (the app's own tmux)
//   CLAUDE_CODE_REMOTE=true                           remote (documented)
//   CLAUDE_CODE_ENTRYPOINT desktop values             desktop (undocumented; may move)
//   anything else                                     terminal

export const HOSTS = ["cmux", "seamux", "desktop", "terminal", "remote"];
export const DESKTOP_ENTRYPOINTS = ["claude-desktop", "claude-desktop-3p", "local-agent"];

// Returns { host, why }. An unknown SEAMUX_HOST is reported and ignored, so a
// typo never sends pages nowhere.
export function detectHost(env = process.env) {
  const o = (env.SEAMUX_HOST || "").trim().toLowerCase();
  const note = o && !HOSTS.includes(o) ? ` (SEAMUX_HOST=${env.SEAMUX_HOST} ignored: not one of ${HOSTS.join(", ")})` : "";
  if (HOSTS.includes(o)) return { host: o, why: "SEAMUX_HOST=" + o };
  if (env.CMUX_WORKSPACE_ID && env.SEAMUX_BACKEND !== "tmux") return { host: "cmux", why: "CMUX_WORKSPACE_ID is set" + note };
  if (env.SEAMUX_PANE_ID) return { host: "seamux", why: "SEAMUX_PANE_ID is set" + note };
  if (env.CLAUDE_CODE_REMOTE === "true") return { host: "remote", why: "CLAUDE_CODE_REMOTE=true" + note };
  const ep = env.CLAUDE_CODE_ENTRYPOINT || "";
  if (DESKTOP_ENTRYPOINTS.includes(ep)) return { host: "desktop", why: "CLAUDE_CODE_ENTRYPOINT=" + ep + note };
  return { host: "terminal", why: "no cmux, remote or desktop signal" + note };
}

// The workspace and pane this session runs in: SEAMUX_* first (set by every
// backend, cmux's own ids for a native session there), then cmux's. "" for
// none. A tmux-backend session's inherited CMUX_* ids are not read.
export function sessionIds(env = process.env) {
  const cmux = env.SEAMUX_BACKEND !== "tmux";
  return {
    workspace: env.SEAMUX_WORKSPACE_ID || (cmux && env.CMUX_WORKSPACE_ID) || "",
    pane: env.SEAMUX_PANE_ID || (cmux && env.CMUX_SURFACE_ID) || "",
  };
}

// One line for doctor-style output.
export function hostLine(env = process.env) {
  const h = detectHost(env);
  return `host: ${h.host} (${h.why})`;
}
