// Extension verbs: the seam for work that cannot go in a public repo.
//
// WHERE, AND WHY THERE. `~/.claude/deep-plan/ext/` — under the DATA tree, a
// sibling of state/ and keys/, never inside the skill. Three things would
// destroy an in-skill ext/:
//
//   * `install.sh --uninstall` does `rm -rf "$SKILL"`, and its "kept" list
//     names ~/.claude/deep-plan explicitly.
//   * installing with `rsync --delete` removes anything the repo does not have.
//   * a plain rsync leaves it, but then drift reporting has to learn about it.
//
// This is the same placement decision `~/.config/cmux/crew-local/` made for
// crew: a SIBLING of the synced tree, not a child. Override with $DEEP_PLAN_EXT.
//
// WHAT AN EXTENSION IS. One file per verb: `ext/<verb>.mjs`. `deep-plan <verb>`
// runs it as a subprocess when no built-in verb matches. It is a subprocess and
// not an import on purpose:
//
//   * an extension that throws, hangs or exits non-zero cannot take the engine
//     with it, and the gate runs through this same engine;
//   * a static `import` of an optional module fails at load time on every
//     machine that does not have it — which is how the older engine wired its
//     private modules, and why they could not simply be deleted;
//   * the contract is then only argv, env and an exit code, which is small
//     enough to keep stable.
//
// WHAT IT DOES NOT COVER. There is no hook that fires on a transition. The
// older engine pushed to Jira on `done` behind `state.jira.autoSync`, and that
// flag is set on 1 of 12 real plans here — real, but not enough to justify a
// second mechanism that runs inside every `done`. `deep-plan jira push <slug>
// <n>` by hand does the same thing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const EXT_DIR = process.env.DEEP_PLAN_EXT ||
  path.join(os.homedir(), ".claude", "deep-plan", "ext");

// A verb becomes a filename, so it must not be able to become a path. Without
// this, `deep-plan ../../../etc/whatever` is a file read of the caller's
// choosing — and the whole point of the seam is that the engine does not know
// what is in that directory.
const VERB = /^[a-z][a-z0-9-]*$/;

export function extPath(verb) {
  if (!VERB.test(verb || "")) return null;
  const p = path.join(EXT_DIR, verb + ".mjs");
  // Resolve and re-check containment: a symlink inside ext/ is the user's own
  // business (that is how a private repo gets mounted), but the NAME must not
  // have escaped the directory.
  if (path.dirname(p) !== EXT_DIR) return null;
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

export function listExt() {
  try {
    return fs.readdirSync(EXT_DIR)
      .filter(n => n.endsWith(".mjs") && VERB.test(n.slice(0, -4)))
      .map(n => n.slice(0, -4))
      .sort();
  } catch { return []; }
}

// argv, env, exit code — the whole contract.
//
// The env names are the ones this engine already resolves from, so an extension
// that wants the state tree reads the same variable the engine does rather than
// re-deriving the path. SKILL_DIR lets it import lib/state.mjs to parse what it
// finds there.
export function runExt(verb, args, dirs) {
  const file = extPath(verb);
  if (!file) return null;
  const r = spawnSync(process.execPath, [file, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      DEEP_PLAN_EXT: EXT_DIR,
      DEEP_PLAN_STATE_DIR: dirs.state,
      DEEP_PLAN_KEYS_DIR: dirs.keys,
      DEEP_PLAN_PLANS_DIR: dirs.plans,
      // The pre-seamux spelling too, for one release. An extension carried
      // over from that engine reads these names, and an override it ignores
      // does not error — it writes to the default tree. That is not a
      // hypothetical: the first extension ported here hardcoded the paths and
      // wrote into the real ~/.claude/plans from a throwaway test tree.
      DEEP_PLAN_STATE: dirs.state,
      DEEP_PLAN_KEYS: dirs.keys,
      DEEP_PLAN_PLANS: dirs.plans,
      DEEP_PLAN_SKILL_DIR: dirs.skill,
      DEEP_PLAN_VERB: verb,
    },
  });
  // A missing node, a permissions problem: say which file rather than letting
  // an exit code of null read as success.
  if (r.error) {
    console.error(`deep-plan: could not run extension ${file}\n  ${r.error.message}`);
    return 1;
  }
  if (r.signal) {
    console.error(`deep-plan: extension ${verb} killed by ${r.signal}`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}
