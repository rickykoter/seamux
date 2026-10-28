// `install-repo`: put this plugin into a repository's own .claude/, for the
// sessions that never load a repo's enabledPlugins (claude.ai/code cloud
// sessions). What carries over there is the repo's .claude/settings.json
// hooks and its .claude/skills (docs/STANDALONE.md), so:
//
//   .claude/skills/<plugin>/   the plugin, minus its probes, evals and dev
//                              tools: SKILL.md and references for the skill,
//                              the engine and bin/ beside them
//   .claude/settings.json      the plugin's hooks, with its root rewritten to
//                              that folder, and a SessionStart hook that puts
//                              its bin/ on the Bash tool's PATH (CLAUDE_ENV_FILE)
//
// The hooks run only on the remote host (CLAUDE_CODE_REMOTE=true) or with
// SEAMUX_REPO_HOOKS=1, so a local session that also has the plugin
// installed does not run them twice. The copy carries a stamp
// (.install.json: version and a hash per file); `--check` reports drift from
// the plugin it came from. Nothing is committed: the person commits .claude/.
//
// lookout/lib/install.mjs is this file's twin for lookout (ADR 0004: no
// import across plugins). Change both together.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const SKIP = new Set(["probe.mjs", "evals", "tools", "node_modules", ".DS_Store", "DEVELOPING.md", "ADAPTING.md", ".install.json"]);
const GUARD = '[ "$CLAUDE_CODE_REMOTE" = true ] || [ "$SEAMUX_REPO_HOOKS" = 1 ] || exit 0;';

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");

// Every file the copy holds, relative to the plugin root.
function walk(root, rel = "") {
  const out = [];
  for (const n of fs.readdirSync(path.join(root, rel)).sort()) {
    if (SKIP.has(n)) continue;
    const r = rel ? rel + "/" + n : n;
    const st = fs.statSync(path.join(root, r));
    if (st.isDirectory()) out.push(...walk(root, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

export function targetRoot(given) {
  if (given) return path.resolve(given);
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

// The hooks the repo's settings get: the plugin's hooks.json with its root
// rewritten, each command behind the remote guard, plus the PATH hook.
export function repoHooks(pluginRoot, name) {
  const dest = `$CLAUDE_PROJECT_DIR/.claude/skills/${name}`;
  const src = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8")).hooks || {};
  const out = {};
  for (const [event, groups] of Object.entries(src)) {
    out[event] = groups.map(g => ({ ...g, hooks: g.hooks.map(h => ({ ...h,
      command: `${GUARD} ${h.command.split("${CLAUDE_PLUGIN_ROOT}").join(dest)}` })) }));
  }
  (out.SessionStart = out.SessionStart || []).unshift({ matcher: "", hooks: [{ type: "command", timeout: 10,
    command: `${GUARD} [ -n "$CLAUDE_ENV_FILE" ] && echo "export PATH=\\"${dest}/bin:\\$PATH\\"" >> "$CLAUDE_ENV_FILE" || true` }] });
  return out;
}

// Merge: drop every hook group an earlier install of this plugin wrote (its
// commands name the plugin's folder), then add this one's.
export function mergeSettings(settings, hooks, name) {
  const mark = `/.claude/skills/${name}/`;
  const s = settings && typeof settings === "object" ? settings : {};
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  for (const ev of Object.keys(s.hooks)) {
    s.hooks[ev] = (s.hooks[ev] || []).filter(g => !(g.hooks || []).some(h => String(h.command || "").includes(mark)));
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  for (const [ev, groups] of Object.entries(hooks)) s.hooks[ev] = [...(s.hooks[ev] || []), ...groups];
  return s;
}

// Copy the plugin in, merge its hooks, write the stamp. `extra` copies more
// files in (deep-plan's pinned mermaid). Returns what it did.
export function installRepo({ pluginRoot, name, version, root, extra = [] }) {
  if (!root || !fs.existsSync(root)) throw new Error("no repository to install into (run it inside one, or pass --root DIR)");
  const dest = path.join(root, ".claude", "skills", name);
  fs.rmSync(dest, { recursive: true, force: true });
  const files = {};
  for (const rel of walk(pluginRoot)) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(pluginRoot, rel), to);
    fs.chmodSync(to, fs.statSync(path.join(pluginRoot, rel)).mode & 0o777);
    files[rel] = sha(fs.readFileSync(to));
  }
  for (const { from, rel } of extra) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    files[rel] = sha(fs.readFileSync(to));
  }
  const stamp = { plugin: name, version, source: pluginRoot, installedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(dest, ".install.json"), JSON.stringify(stamp, null, 2) + "\n");
  const sp = path.join(root, ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(sp)) {
    try { settings = JSON.parse(fs.readFileSync(sp, "utf8")); }
    catch (e) { throw new Error(`${sp} is not JSON (${e.message}); fix it, then install again`); }
  }
  fs.writeFileSync(sp, JSON.stringify(mergeSettings(settings, repoHooks(pluginRoot, name), name), null, 2) + "\n");
  return { dest, settings: sp, files: Object.keys(files).length, version };
}

// Drift between a repo's copy and this plugin: { ok, lines }.
export function checkRepo({ pluginRoot, name, version, root, extra = [] }) {
  const dest = path.join(root || "", ".claude", "skills", name);
  const lines = [];
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(path.join(dest, ".install.json"), "utf8")); } catch { /* none */ }
  if (!stamp) return { ok: false, lines: [`not installed in ${root} (${name} install-repo)`] };
  if (stamp.version !== version) lines.push(`version: the repo has ${stamp.version}, this plugin is ${version}`);
  const want = {};
  for (const rel of walk(pluginRoot)) want[rel] = sha(fs.readFileSync(path.join(pluginRoot, rel)));
  for (const { from, rel } of extra) want[rel] = sha(fs.readFileSync(from));
  for (const [rel, h] of Object.entries(want)) {
    const p = path.join(dest, rel);
    if (!fs.existsSync(p)) lines.push(`missing: ${rel}`);
    else if (sha(fs.readFileSync(p)) !== h) lines.push(`changed: ${rel}`);
  }
  for (const rel of Object.keys(stamp.files || {})) if (!(rel in want)) lines.push(`no longer in the plugin: ${rel}`);
  const sp = path.join(root, ".claude", "settings.json");
  let hooks = "";
  try { hooks = JSON.stringify(JSON.parse(fs.readFileSync(sp, "utf8")).hooks || {}); } catch { /* none */ }
  if (!hooks.includes(`/.claude/skills/${name}/`)) lines.push(`hooks: ${sp} has none of ${name}'s`);
  return { ok: lines.length === 0, lines };
}
