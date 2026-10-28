// Which host Claude is running in, so a verb knows where a page can go.
//
// The same rule lives in lookout/lib/host.mjs: ADR 0004 keeps the plugins from
// importing each other, so each carries a copy, and both probes check that
// the two copies agree. Change both together.
//
//   SEAMUX_HOST=cmux|desktop|terminal|remote  beats every signal below
//   CMUX_WORKSPACE_ID set                     cmux
//   CLAUDE_CODE_REMOTE=true                   remote (documented)
//   CLAUDE_CODE_ENTRYPOINT desktop values     desktop (undocumented; may move)
//   anything else                             terminal

export const HOSTS = ["cmux", "desktop", "terminal", "remote"];
export const DESKTOP_ENTRYPOINTS = ["claude-desktop", "claude-desktop-3p", "local-agent"];

// Returns { host, why }. An unknown SEAMUX_HOST is reported and ignored, so a
// typo never sends pages nowhere.
export function detectHost(env = process.env) {
  const o = (env.SEAMUX_HOST || "").trim().toLowerCase();
  const note = o && !HOSTS.includes(o) ? ` (SEAMUX_HOST=${env.SEAMUX_HOST} ignored: not one of ${HOSTS.join(", ")})` : "";
  if (HOSTS.includes(o)) return { host: o, why: "SEAMUX_HOST=" + o };
  if (env.CMUX_WORKSPACE_ID) return { host: "cmux", why: "CMUX_WORKSPACE_ID is set" + note };
  if (env.CLAUDE_CODE_REMOTE === "true") return { host: "remote", why: "CLAUDE_CODE_REMOTE=true" + note };
  const ep = env.CLAUDE_CODE_ENTRYPOINT || "";
  if (DESKTOP_ENTRYPOINTS.includes(ep)) return { host: "desktop", why: "CLAUDE_CODE_ENTRYPOINT=" + ep + note };
  return { host: "terminal", why: "no cmux, remote or desktop signal" + note };
}

// One line for doctor-style output.
export function hostLine(env = process.env) {
  const h = detectHost(env);
  return `host: ${h.host} (${h.why})`;
}
