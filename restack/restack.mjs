#!/usr/bin/env node
// restack — rebase a stack onto a moved base, and never hand-resolve a
// generated file again.
//
// The two failures this exists for, in the order they cost time:
//
//   1. A generated artifact conflicts on every branch of the stack. It is
//      derived data; resolving it by hand is editing the output of a program.
//      The engine resolves it to the base copy and re-derives it — or, when
//      re-deriving is expensive, records it STALE with the command that fixes
//      it, so nothing ships a half-merged schema quietly.
//   2. The base moved, your checked-in schema did not, and CI says "breaking
//      change" or "generated file is out of date" twenty minutes later.
//      `restack check` runs those same comparisons locally, against a freshly
//      fetched base, before anything is pushed.
//
// It stops before every push. Printing the push line and letting a human run
// it is the whole contract — see PUSH below.
//
// Exit codes, because the usual caller is an agent:
//   0  done, nothing needs you
//   1  refused or failed (the reason is the last line, and `error` in --json)
//   2  stopped: a human has to resolve something (`needs-human`)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  git, repoRoot, gitDir, currentBranch, isDirty, operation, conflictedPaths,
  rebaseProgress, revParse, mergeBase, countRange, changedPaths,
} from "./lib/git.mjs";
import * as cfgmod from "./lib/config.mjs";
import { resolveBase, discover, planWalk, whichSync } from "./lib/stack.mjs";
import * as S from "./lib/state.mjs";
import { resolveArtifact, regen as regenArtifact, verifyClean, runCheck, tail } from "./lib/run.mjs";
import { verifyBranch, CREATION_FACTOR } from "./lib/verify.mjs";
import { judgeState, guardArtifactPaths, judgeDropped, judgeResidue } from "./lib/judge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEEDS_HUMAN = 2;
// The engine pointer: where this engine lives, for callers outside Claude (the
// ~/.local/bin shim, crew). restack's one file under ~ (docs/SYNCING.md). The
// overrides are for the probe, so a test run never repoints the real one.
const ENGINE_FILE = process.env.RESTACK_ENGINE_FILE ||
  path.join(os.homedir(), ".claude", "restack", "engine.json");
const SHIM_DIR = process.env.RESTACK_BIN_DIR || path.join(os.homedir(), ".local", "bin");

// ---------------------------------------------------------------- argv
const argv = process.argv.slice(2);
// `--help` and `-h` are flags, so the first-non-flag rule alone read
// `restack --help` as `restack status`.
const verb = argv.includes("--help") || argv.includes("-h") ? "help"
  : argv.find(a => !a.startsWith("-")) || "status";
const rest = argv.filter(a => a !== verb);
const flag = n => rest.includes("--" + n);
const opt = (n, d = null) => {
  const i = rest.indexOf("--" + n);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : d;
};
const JSONOUT = flag("json");
const OPTS = {
  deep: flag("deep"),
  dryRun: flag("dry-run"),
  noFetch: flag("no-fetch"),
  verbose: flag("verbose"),
  noJudge: flag("no-judge"),
};

// The judgment layer is resolved once per invocation and passed down. It can
// only ever escalate (lib/judge.mjs), so "off" is never less safe than "on" —
// which is why --no-judge exists and why nothing refuses when it is absent.
let JUDGE = { on: false, content: false, client: "", safeFloor: 0 };

function say(s) { if (!JSONOUT) console.log(s); }
function emit(obj, humanFn) {
  if (JSONOUT) console.log(JSON.stringify(obj, null, 2));
  else humanFn ? humanFn(obj) : null;
  process.exit(obj.exit ?? 0);
}
function die(msg, extra = {}) {
  if (JSONOUT) console.log(JSON.stringify({ verb, status: "error", error: msg, exit: 1, ...extra }, null, 2));
  else console.error("restack: " + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- context
function context() {
  const at = opt("at") || process.cwd();
  const root = repoRoot(at);
  if (!root) die(`not a git repository: ${at}`);
  const gd = gitDir(at);
  const cfg = cfgmod.load(root);
  if (cfg.errors.length) die(`config ${cfg.path}:\n  - ` + cfg.errors.join("\n  - "));
  const st = S.read(gd);
  JUDGE = OPTS.noJudge ? { on: false, content: false, client: "", safeFloor: 0 } : judgeState(cfg);
  return { cwd: root, gitDirPath: gd, cfg, st, branch: currentBranch(root) };
}

// rerere is the cheapest win available to a stack: the same conflict, in the
// same generated file, reappears on every branch, and rerere replays the
// resolution it watched you make on the first one. Enabled per invocation
// with `-c` rather than written into the user's config — a tool that edits
// your git config to work is a tool you cannot try out.
function gitArgs(ctx, args) {
  return ctx.cfg.rerere ? ["-c", "rerere.enabled=true", ...args] : args;
}
function g(ctx, args, opts = {}) { return git(ctx.cwd, gitArgs(ctx, args), opts); }

// ---------------------------------------------------------------- shared reads
function baseFacts(ctx) {
  const base = resolveBase(ctx.cwd, ctx.cfg);
  if (base.error) return base;
  const b = ctx.branch;
  return {
    ...base,
    behind: b ? countRange(ctx.cwd, `${b}..${base.ref}`) : null,
    ahead: b ? countRange(ctx.cwd, `${base.ref}..${b}`) : null,
  };
}

function fetchBase(ctx, base) {
  if (OPTS.noFetch || OPTS.dryRun) return { skipped: true };
  const name = base.ref.startsWith(ctx.cfg.remote + "/")
    ? base.ref.slice(ctx.cfg.remote.length + 1) : base.ref;
  const r = git(ctx.cwd, ["fetch", "--quiet", ctx.cfg.remote, name]);
  return { skipped: false, ok: r.ok, err: r.err };
}

// What the base moved under you, intersected with what this repo generates.
// This is the drift that turns into a CI failure even when git reports no
// conflict at all: master regenerated the schema, your branch did not.
function driftReport(ctx, base) {
  const b = ctx.branch;
  if (!b || !base.sha) return { ours: [], theirs: [], collisions: [] };
  const fork = mergeBase(ctx.cwd, base.ref, b);
  if (!fork) return { ours: [], theirs: [], collisions: [] };
  const ours = changedPaths(ctx.cwd, fork, b);
  const theirs = changedPaths(ctx.cwd, fork, base.ref);
  const oursArt = cfgmod.artifactsTouching(ctx.cfg, ours);
  const theirsArt = cfgmod.artifactsTouching(ctx.cfg, theirs);
  const both = new Set(theirsArt.map(a => a.artifact.name));
  return {
    ours: oursArt.map(a => ({ artifact: a.artifact.name, paths: a.paths })),
    theirs: theirsArt.map(a => ({ artifact: a.artifact.name, paths: a.paths })),
    // Both sides touched the same generated artifact: a conflict is coming,
    // and it is one this engine can resolve without a human reading a diff.
    collisions: oursArt.filter(a => both.has(a.artifact.name)).map(a => ({
      artifact: a.artifact.name, resolve: a.artifact.resolve, tier: a.artifact.tier,
      regen: a.artifact.regen || null,
    })),
  };
}

function conflictHunks(ctx, p) {
  try {
    const txt = fs.readFileSync(path.join(ctx.cwd, p), "utf8");
    return (txt.match(/^<{7}/gm) || []).length;
  } catch { return null; }
}

// ---------------------------------------------------------------- the conflict pass
//
// The heart of it. Called wherever a rebase has stopped: group the conflicted
// paths by artifact, resolve everything derived, and hand back only what a
// human has to look at.
function conflictPass(ctx, branchName) {
  const op = operation(ctx.cwd) || "rebase";
  const paths = conflictedPaths(ctx.cwd);
  const generated = [], source = [];
  const groups = new Map();
  for (const p of paths) {
    const a = cfgmod.artifactFor(ctx.cfg, p);
    if (!a || a.resolve === "manual") { source.push(p); continue; }
    if (!groups.has(a.name)) groups.set(a.name, { artifact: a, paths: [] });
    groups.get(a.name).paths.push(p);
  }

  // The guard runs BEFORE any resolution: ask whether these files really are
  // generated, and pull any that read as hand-written out of the automatic
  // path entirely. One batched question for every artifact path in this stop.
  const guarded = guardArtifactPaths(ctx.cwd, JUDGE, [...groups.values()].flatMap(g2 => g2.paths));
  const guardedPaths = new Set(guarded.map(g2 => g2.path));
  const escalated = [];
  for (const g2 of guarded) {
    escalated.push(g2);
    source.push(g2.path);
  }
  for (const grp of groups.values()) {
    grp.paths = grp.paths.filter(p => !guardedPaths.has(p));
  }

  for (const { artifact, paths: ps } of groups.values()) {
    if (!ps.length) continue;
    const res = resolveArtifact(ctx.cwd, op, artifact, ps, OPTS);
    const entry = {
      artifact: artifact.name, paths: ps, resolve: artifact.resolve,
      tier: artifact.tier, ok: res.ok, actions: res.actions, regen: null,
    };
    if (!res.ok) {
      // A resolution that did not take leaves the path conflicted; it belongs
      // in the human pile rather than being reported as handled.
      source.push(...res.actions.filter(a => !a.ok).map(a => a.path));
      entry.ok = false;
      generated.push(entry);
      continue;
    }
    // Taking the base copy of a conflicted artifact DROPS what your branch
    // did to it — that is what "take-base" means, and for a schema or a
    // lockfile it is the right call, because the change is re-derived from
    // the source (a migration, a dependency manifest) rather than merged. It
    // is still a hole in the commit until someone re-derives it, so it is
    // recorded exactly like a deferred regen. Silence here would be the
    // "half-merged schema shipped quietly" failure wearing a different hat.
    if (artifact.resolve === "take-base" && res.ok) {
      S.markStale(ctx.st, {
        artifact: artifact.name, paths: ps, branches: branchName ? [branchName] : [],
        command: artifact.regen || "",
        why: "the base copy was kept — your branch's version of this artifact is not in the commit"
          + (artifact.note ? ` (${artifact.note})` : ""),
      });
    }
    if (res.needsRegen) {
      const r = regenArtifact(ctx.cwd, artifact, OPTS);
      entry.regen = r;
      if (r.ran && r.ok) {
        S.clearStale(ctx.st, artifact.name);
      } else {
        // Deferred (expensive) or failed: the commit will carry the base copy
        // of a file your branch changes. That is exactly the "generated file
        // is out of date" CI failure, so it is recorded, not mentioned.
        S.markStale(ctx.st, {
          artifact: artifact.name, paths: ps, branches: branchName ? [branchName] : [],
          command: artifact.regen,
          why: r.deferred ? "expensive tier — not run during the walk"
            : (r.why || "the regen command failed"),
        });
      }
    }
    generated.push(entry);
  }
  const sourceOut = [...new Set(source)].map(p => {
    const g2 = guarded.find(x => x.path === p);
    return { path: p, hunks: conflictHunks(ctx, p), ...(g2 ? { escalated: true, why: g2.why, pGenerated: g2.pGenerated ?? null } : {}) };
  });
  // Files a human has to resolve are recorded, because `verify` needs to tell
  // "you changed this patch on purpose" from "this patch changed and nobody
  // knows why".
  if (sourceOut.length) {
    ctx.st.humanResolved = [...new Set([...(ctx.st.humanResolved || []), ...sourceOut.map(x => x.path)])];
  }
  return { op, generated, source: sourceOut, escalated };
}

// A rebase can also stop with nothing conflicted: the commit became empty
// because the base already carries an equivalent change. Common with
// generated files, and `--skip` is the only correct answer.
function continueRebase(ctx) {
  const conflicted = conflictedPaths(ctx.cwd);
  if (conflicted.length) return { ok: false, why: "still conflicted", conflicted };
  const staged = git(ctx.cwd, ["diff", "--cached", "--quiet"]);
  const env = { ...process.env, GIT_EDITOR: "true" };
  if (staged.status !== 0) {
    const r = g(ctx, ["rebase", "--continue"], { env });
    return { ok: r.ok, skipped: false, err: r.err, out: r.out };
  }
  // Nothing left to commit: the base already carries an equivalent change, so
  // this commit is now empty and `--skip` is the only correct answer.
  //
  // It is also a COMMIT DISAPPEARING, and a tool that drops one silently is a
  // tool you cannot trust with a stack. Common here precisely because a commit
  // that only touched generated files has nothing left once the artifact is
  // re-derived. So it is recorded and reported, every time.
  const prog = rebaseProgress(ctx.cwd);
  const r = g(ctx, ["rebase", "--skip"], { env });
  if (prog && prog.sha) {
    ctx.st.dropped = ctx.st.dropped || [];
    ctx.st.dropped.push({ branch: prog.branch, sha: prog.sha.slice(0, 12), subject: prog.subject });
  }
  return { ok: r.ok, skipped: true, err: r.err, out: r.out };
}

// ---------------------------------------------------------------- verbs

function cmdStatus(ctx) {
  const base = baseFacts(ctx);
  const op = operation(ctx.cwd);
  const prog = op === "rebase" ? rebaseProgress(ctx.cwd) : null;
  const stack = base.error ? null : discover(ctx.cwd, ctx.cfg, ctx.branch, base, ctx.gitDirPath);
  const out = {
    verb: "status", status: "ok",
    repo: ctx.cwd, branch: ctx.branch,
    config: { present: ctx.cfg.present, path: ctx.cfg.path, artifacts: ctx.cfg.artifacts.length, checks: ctx.cfg.checks.length },
    base: base.error ? { error: base.error } : { ref: base.ref, sha: base.sha.slice(0, 12), behind: base.behind, ahead: base.ahead },
    operation: op, stopped: prog,
    run: { phase: ctx.st.phase, index: ctx.st.index, steps: (ctx.st.steps || []).map(s => ({ branch: s.branch, status: s.status })) },
    stack: stack && { tool: stack.tool, source: stack.source, branches: stack.chain.map(c => c.name) },
    stale: ctx.st.stale || [],
    exit: 0,
  };
  emit(out, o => {
    say(`${path.basename(o.repo)} · ${o.branch || "(detached)"}`);
    say(o.base.error ? `  base   ${o.base.error}` : `  base   ${o.base.ref} @ ${o.base.sha} — ${o.base.behind} behind, ${o.base.ahead} ahead`);
    if (o.stack) say(`  stack  ${o.stack.branches.join(" → ") || "(just this branch)"}  [${o.stack.source}${o.stack.tool === "graphite" ? ", graphite" : ""}]`);
    say(`  config ${o.config.present ? `${o.config.artifacts} artifacts, ${o.config.checks} checks` : "none — run `restack init`"}`);
    if (o.operation) say(`  \x1b[33mmid-${o.operation}\x1b[0m ${o.stopped ? `${o.stopped.branch} ${o.stopped.at}/${o.stopped.of} — ${o.stopped.subject}` : ""}`);
    if (o.run.phase !== "idle") say(`  run    ${o.run.phase} (${o.run.index}/${o.run.steps.length})`);
    for (const s of o.stale) say(`  \x1b[33mstale\x1b[0m  ${s.artifact}\n${staleLines(s, 9)}`);
  });
}

function cmdPlan(ctx) {
  const base = baseFacts(ctx);
  if (base.error) die(base.error);
  const f = fetchBase(ctx, base);
  if (f.ok === false) say(`  warn: could not fetch ${ctx.cfg.remote} — planning against the ref as it is on disk`);
  const base2 = baseFacts(ctx);
  const stack = discover(ctx.cwd, ctx.cfg, ctx.branch, base2, ctx.gitDirPath);
  const steps = planWalk(ctx.cwd, stack.chain, base2);
  const drift = driftReport(ctx, base2);
  const out = {
    verb: "plan", status: "ok", repo: ctx.cwd, branch: ctx.branch,
    base: { ref: base2.ref, sha: base2.sha.slice(0, 12), behind: base2.behind },
    stack: { tool: stack.tool, source: stack.source, driver: stack.driver },
    steps: steps.map(s => ({ branch: s.branch, ahead: s.ahead, onto: s.onto, upstream: s.upstream && s.upstream.slice(0, 12), pr: s.pr, error: s.error || null })),
    drift,
    expensive: ctx.cfg.artifacts.filter(a => a.tier === "expensive").map(a => ({ artifact: a.name, command: a.regen || null })),
    next: ["restack run"],
    exit: 0,
  };
  emit(out, o => {
    say(`plan · ${o.stack.driver === "gt" ? "graphite drives the rebase" : "git rebase --onto, bottom first"} · base ${o.base.ref} (${o.base.behind} behind)`);
    for (const s of o.steps)
      say(`  ${s.error ? "\x1b[31m!\x1b[0m" : "•"} ${s.branch}${s.pr ? ` (#${s.pr.number})` : ""} — ${s.ahead ?? "?"} commit(s) onto ${s.onto}${s.error ? ` — ${s.error}` : ""}`);
    if (o.drift.collisions.length) {
      say("\n  generated artifacts both sides touched (conflicts expected, and handled):");
      for (const c of o.drift.collisions)
        say(`    ${c.artifact} — resolve ${c.resolve}, ${c.tier}${c.tier === "expensive" ? " (needs --deep, else recorded stale)" : ""}`);
    } else if (o.drift.theirs.length) {
      say("\n  the base moved these generated artifacts; your branch did not touch them:");
      for (const t of o.drift.theirs) say(`    ${t.artifact}`);
    }
    say("\n  next: restack run");
  });
}

// The walk. Resumable by construction: every step's before/after tips live in
// the state file, so `continue` after a human resolution picks up mid-stack
// without re-deriving anything.
function cmdRun(ctx) {
  if (operation(ctx.cwd))
    die(`a ${operation(ctx.cwd)} is already in progress — finish it with \`restack continue\` (or \`restack abort\`)`);
  if (isDirty(ctx.cwd))
    die("the working tree has uncommitted changes — commit or stash them first");

  const base0 = baseFacts(ctx);
  if (base0.error) die(base0.error);
  const f = fetchBase(ctx, base0);
  if (f.ok === false) die(`could not fetch ${ctx.cfg.remote}: ${f.err}`);
  const base = baseFacts(ctx);

  const stack = discover(ctx.cwd, ctx.cfg, ctx.branch, base, ctx.gitDirPath);
  const only = opt("branch");
  let chain = stack.chain;
  if (only) chain = chain.filter(c => c.name === only);
  if (!chain.length) die(`no branches to restack${only ? ` matching --branch ${only}` : ""}`);

  const steps = planWalk(ctx.cwd, chain, base).map(s => ({ ...s, status: "pending", newTip: null }));
  ctx.st = { ...S.fresh(), stale: ctx.st.stale || [], phase: "walking",
             startedAt: new Date().toISOString(), base: { ref: base.ref, sha: base.sha },
             driver: stack.driver, steps, index: 0, returnTo: ctx.branch };
  S.write(ctx.gitDirPath, ctx.st);

  if (stack.driver === "gt") return walkGraphite(ctx);
  return walkGit(ctx);
}

function walkGit(ctx) {
  const st = ctx.st;
  for (; st.index < st.steps.length; st.index++) {
    const step = st.steps[st.index];
    if (step.error) { step.status = "skipped"; continue; }

    const onto = st.index === 0 ? st.base.sha : st.steps[st.index - 1].newTip;
    // Nothing to do: this branch already sits on the new parent.
    if (step.upstream === onto) {
      step.status = "already-current";
      step.newTip = revParse(ctx.cwd, step.branch);
      continue;
    }
    const co = git(ctx.cwd, ["checkout", "--quiet", step.branch]);
    if (!co.ok) { step.status = "error"; step.why = co.err; break; }

    say(`  rebasing ${step.branch} onto ${st.index === 0 ? st.base.ref : st.steps[st.index - 1].branch}`);
    if (OPTS.dryRun) { step.status = "dry-run"; continue; }
    const r = g(ctx, ["rebase", "--onto", onto, step.upstream, step.branch],
      { env: { ...process.env, GIT_EDITOR: "true" } });
    if (r.ok) { step.status = "done"; step.newTip = revParse(ctx.cwd, step.branch); continue; }

    const settled = settleConflicts(ctx, step);
    if (!settled.done) return stopForHuman(ctx, step, settled);
    step.status = "done"; step.newTip = revParse(ctx.cwd, step.branch);
  }
  return finish(ctx);
}

// Graphite owns the stack metadata, so it owns the rebase: `gt restack` walks
// and stops, we resolve between the stops. Doing our own `git rebase --onto`
// in a graphite repo leaves gt's parent pointers describing a stack that no
// longer exists.
function walkGraphite(ctx) {
  const st = ctx.st;
  if (OPTS.dryRun) { say("  dry run: gt restack"); return finish(ctx); }
  for (let guard = 0; guard < 50; guard++) {
    const r = spawnSync("gt", ["restack"], { cwd: ctx.cwd, encoding: "utf8", timeout: (ctx.cfg.timeout || 900) * 1000 });
    if (r.status === 0) { st.steps.forEach(s => { s.status = "done"; s.newTip = revParse(ctx.cwd, s.branch); }); return finish(ctx); }
    if (!operation(ctx.cwd)) {
      st.phase = "error"; S.write(ctx.gitDirPath, st);
      return die(`gt restack failed and left no rebase in progress:\n${tail((r.stdout || "") + (r.stderr || ""))}`);
    }
    const step = { branch: rebaseProgress(ctx.cwd)?.branch || "(unknown)" };
    const settled = settleConflicts(ctx, step, "gt");
    if (!settled.done) return stopForHuman(ctx, step, settled);
  }
  return die("gt restack did not converge after 50 conflict passes — stopping rather than looping");
}

// Resolve, continue, repeat, for as long as every remaining conflict is
// derived. The guard is not paranoia: a resolution that does not actually
// clear the conflict would otherwise spin.
function settleConflicts(ctx, step, driver = "git") {
  const passes = [];
  let lastPass = null;
  for (let guard = 0; guard < 100; guard++) {
    const pass = conflictPass(ctx, step.branch);
    passes.push(pass);
    lastPass = pass;
    S.write(ctx.gitDirPath, ctx.st);
    if (pass.source.length) return { done: false, passes, pass };

    const cont = driver === "gt" ? gtContinue(ctx) : continueRebase(ctx);

    // The op ending is the only success. Everything else is "look again":
    // `rebase --continue` exits non-zero when the NEXT commit conflicts, which
    // is the normal shape of a stack whose generated file collides on every
    // commit — reading that exit code as failure is how the first version of
    // this loop reported "no conflicts" while sitting on one.
    if (!operation(ctx.cwd)) return { done: true, passes };
    if (conflictedPaths(ctx.cwd).length) continue;
    if (!cont.ok) return { done: false, passes, pass: lastPass, error: cont.err || cont.why };
    // Mid-op, nothing conflicted, the continue reported success: the next
    // round's empty pass will `--skip` or `--continue` it.
  }
  return { done: false, passes, pass: lastPass, error: "did not converge after 100 conflict passes" };
}

function gtContinue(ctx) {
  const conflicted = conflictedPaths(ctx.cwd);
  if (conflicted.length) return { ok: false, why: "still conflicted", conflicted };
  const r = spawnSync("gt", ["continue"], {
    cwd: ctx.cwd, encoding: "utf8",
    env: { ...process.env, GIT_EDITOR: "true" },
    timeout: (ctx.cfg.timeout || 900) * 1000,
  });
  return { ok: r.status === 0, err: tail((r.stdout || "") + (r.stderr || "")) };
}

function stopForHuman(ctx, step, settled) {
  const st = ctx.st;
  st.phase = "conflict";
  const cur = st.steps[st.index];
  if (cur) cur.status = "conflict";
  S.write(ctx.gitDirPath, st);
  const prog = rebaseProgress(ctx.cwd);
  // The generated half is aggregated over every pass in this stop sequence,
  // not just the one that gave up. Walking a stack, the schema is resolved on
  // commit 1 and the human conflict arrives on commit 3 — reporting only the
  // last pass would say "nothing was done for you" right after doing it.
  const pass = mergePasses(settled.passes, settled.pass);
  const out = {
    verb, status: "needs-human", repo: ctx.cwd,
    stopped: {
      branch: step.branch, commit: prog ? { sha: (prog.sha || "").slice(0, 12), subject: prog.subject } : null,
      at: prog?.at ?? null, of: prog?.of ?? null,
    },
    conflicts: {
      generated: pass.generated.map(g2 => ({
        artifact: g2.artifact, paths: g2.paths, resolve: g2.resolve, ok: g2.ok,
        regen: g2.regen ? { ran: g2.regen.ran, ok: g2.regen.ok, deferred: !!g2.regen.deferred, command: g2.regen.command || null, out: g2.regen.ok ? "" : g2.regen.out } : null,
      })),
      source: pass.source,
    },
    error: settled.error || null,
    dropped: st.dropped || [],
    stale: st.stale,
    next: [
      ...pass.source.map(s => `edit ${s.path} — resolve the conflict, then \`git add ${s.path}\``),
      "restack continue",
    ],
    exit: NEEDS_HUMAN,
  };
  emit(out, o => {
    say(`\n\x1b[33mstopped\x1b[0m on ${o.stopped.branch}${o.stopped.commit ? ` at ${o.stopped.at}/${o.stopped.of} — ${o.stopped.commit.subject}` : ""}`);
    if (o.conflicts.generated.length) {
      say("  resolved for you (generated):");
      for (const gg of o.conflicts.generated) {
        const r = gg.regen;
        const how = !r ? gg.resolve : r.ok ? "regenerated" : r.deferred ? "base copy kept — \x1b[33mstale\x1b[0m" : "regen FAILED";
        say(`    ${gg.artifact} — ${how} (${gg.paths.length} file${gg.paths.length === 1 ? "" : "s"})`);
        if (r && !r.ok && !r.deferred && r.out) say(indent(r.out, 6));
      }
    }
    if (o.conflicts.source.length) {
      say("  yours to resolve:");
      for (const s of o.conflicts.source) say(`    ${s.path}${s.hunks ? ` — ${s.hunks} hunk${s.hunks === 1 ? "" : "s"}` : ""}`);
    }
    if (o.error) say(`  \x1b[31m${o.error}\x1b[0m`);
    say("\n  then: restack continue");
  });
}


// One rendering of a stale entry everywhere it is printed. An artifact with
// no regen command (a schema you re-derive by re-running your migration) has
// to be told how to get out of the refusal, or the refusal is just noise.
function staleLines(s, pad = 6) {
  const gap = " ".repeat(pad);
  const out = [`${gap}${s.why}`];
  out.push(s.command ? `${gap}run: ${s.command}`
    : `${gap}no command for this one — fix it, then: restack clear-stale --only ${s.artifact}`);
  return out.join("\n");
}

function indent(s, n) { return String(s).split("\n").map(l => " ".repeat(n) + l).join("\n"); }

// One entry per artifact across the whole stop sequence; the source list is
// the last pass's, because that is what is conflicted right now.
function mergePasses(passes = [], last = null) {
  const byArtifact = new Map();
  for (const p of passes) {
    for (const gen of p.generated || []) {
      const prev = byArtifact.get(gen.artifact);
      if (!prev) { byArtifact.set(gen.artifact, { ...gen, paths: [...gen.paths] }); continue; }
      prev.paths = [...new Set([...prev.paths, ...gen.paths])];
      prev.ok = prev.ok && gen.ok;
      // A later failed regen is the one worth reporting; a later success
      // means the artifact is fine now.
      if (gen.regen) prev.regen = gen.regen;
    }
  }
  return { generated: [...byArtifact.values()], source: (last || passes[passes.length - 1] || { source: [] }).source || [] };
}

function finish(ctx) {
  const st = ctx.st;
  // A dropped commit is always reported; this decides whether it is a line or
  // a stop. Escalation only: an answer of "regeneration_only" changes nothing.
  const alarming = judgeDropped(ctx.cwd, JUDGE, st.dropped || []);
  for (const a of alarming) {
    const d = (st.dropped || []).find(x => x.sha === a.sha);
    if (d) { d.escalated = true; d.why = a.why; d.pRegenOnly = a.pRegenOnly ?? null; }
  }
  st.phase = "done"; st.finishedAt = new Date().toISOString();
  S.write(ctx.gitDirPath, st);
  if (st.returnTo && currentBranch(ctx.cwd) !== st.returnTo && !OPTS.dryRun)
    git(ctx.cwd, ["checkout", "--quiet", st.returnTo]);

  const pushes = st.steps.filter(s => s.status === "done")
    .map(s => `${ctx.cfg.push.command} ${ctx.cfg.remote} ${s.branch}`);
  const escalatedDrops = (st.dropped || []).filter(d => d.escalated);
  const out = {
    verb, status: escalatedDrops.length ? "needs-human" : st.stale.length ? "stale" : "ok", repo: ctx.cwd,
    steps: st.steps.map(s => ({ branch: s.branch, status: s.status, tip: s.newTip && s.newTip.slice(0, 12) })),
    dropped: st.dropped || [],
    stale: st.stale,
    next: [
      ...(escalatedDrops.length ? ["restack verify   # a dropped commit claimed real work"] : []),
      ...(st.stale.length ? st.stale.map(s => s.command).filter(Boolean) : []),
      "restack verify",
      "restack check" + (st.stale.length ? " --deep" : ""),
      ...pushes,
    ],
    push: pushes,
    exit: escalatedDrops.length ? NEEDS_HUMAN : 0,
  };
  emit(out, o => {
    say("");
    for (const s of o.steps) say(`  ${s.status === "done" ? "\x1b[32mok\x1b[0m  " : s.status === "already-current" ? "—   " : "    "} ${s.branch} ${s.status === "done" ? s.tip : s.status}`);
    if (o.dropped.length) {
      say(`\n  \x1b[33m${o.dropped.length} commit(s) became empty and were dropped\x1b[0m — the base already carries the change:`);
      for (const d of o.dropped) say(`    ${d.sha} ${d.subject} (${d.branch})${d.escalated ? "  \x1b[31m← " + d.why + "\x1b[0m" : ""}`);
      say("  If that is a surprise: `git reflog <branch>` still has the pre-restack tip.");
    }
    if (o.stale.length) {
      say("\n  \x1b[33mstale generated artifacts\x1b[0m — these commits carry the base copy:");
      for (const s of o.stale) say(`    ${s.artifact} (${s.branches?.join(", ") || "?"})\n${staleLines(s)}`);
      say("  `restack check` refuses while this list is non-empty.");
    }
    say("\n  then: restack verify");
    say("        restack check");
    for (const p of o.push) say(`        ${p}`);
    say("  (push lines are printed, never run — see PUSH in the skill)");
  });
}

function cmdContinue(ctx) {
  const op = operation(ctx.cwd);
  if (!op) {
    // Nothing in flight: either the human finished the rebase by hand, or
    // there is a walk to resume.
    if (ctx.st.phase === "conflict" || ctx.st.phase === "walking") {
      const step = ctx.st.steps[ctx.st.index];
      if (step) { step.status = "done"; step.newTip = revParse(ctx.cwd, step.branch); ctx.st.index++; }
      ctx.st.phase = "walking"; S.write(ctx.gitDirPath, ctx.st);
      return ctx.st.driver === "gt" ? walkGraphite(ctx) : walkGit(ctx);
    }
    die("nothing to continue — no rebase in progress and no run to resume");
  }
  const step = ctx.st.steps[ctx.st.index] || { branch: rebaseProgress(ctx.cwd)?.branch || currentBranch(ctx.cwd) };
  const settled = settleConflicts(ctx, step, ctx.st.driver === "gt" ? "gt" : "git");
  if (!settled.done) return stopForHuman(ctx, step, settled);
  if (ctx.st.steps[ctx.st.index]) {
    ctx.st.steps[ctx.st.index].status = "done";
    ctx.st.steps[ctx.st.index].newTip = revParse(ctx.cwd, step.branch);
    ctx.st.index++;
  }
  ctx.st.phase = "walking"; S.write(ctx.gitDirPath, ctx.st);
  return ctx.st.driver === "gt" ? walkGraphite(ctx) : walkGit(ctx);
}

function cmdAbort(ctx) {
  const op = operation(ctx.cwd);
  // `git rebase --abort` whichever tool started it: graphite's restack IS a
  // git rebase underneath, and aborting it restores the refs gt will re-read.
  if (op) git(ctx.cwd, ["rebase", "--abort"]);
  if (ctx.st.returnTo) git(ctx.cwd, ["checkout", "--quiet", ctx.st.returnTo]);
  const st = S.clearRun(ctx.gitDirPath, ctx.st);
  emit({ verb: "abort", status: "ok", aborted: !!op, stale: st.stale, exit: 0 },
    o => say(o.aborted ? "  aborted; branches are back where they were" : "  nothing in progress; run state cleared"));
}

function cmdRegen(ctx) {
  const only = opt("only");
  const list = ctx.cfg.artifacts.filter(a => a.regen && (!only || a.name === only));
  if (!list.length) die(only ? `no artifact named "${only}" with a regen command` : "no artifacts have a regen command");
  const results = [];
  for (const a of list) {
    say(`  ${a.name} …`);
    const r = regenArtifact(ctx.cwd, a, OPTS);
    if (r.ran && r.ok) S.clearStale(ctx.st, a.name);
    results.push(r);
  }
  S.write(ctx.gitDirPath, ctx.st);
  const failed = results.filter(r => r.ran && !r.ok);
  emit({
    verb: "regen", status: failed.length ? "error" : "ok",
    results: results.map(r => ({ artifact: r.artifact, ran: r.ran, ok: r.ok, deferred: !!r.deferred, command: r.command || null, ms: r.ms ?? null, changed: r.changed || [], out: r.ok ? "" : (r.out || r.why || ""), log: r.log || null })),
    stale: ctx.st.stale,
    exit: failed.length ? 1 : 0,
  }, o => {
    for (const r of o.results) {
      if (!r.ran) { say(`  —   ${r.artifact} — ${r.deferred ? "deferred (expensive; pass --deep)" : r.out}`); continue; }
      say(`  ${r.ok ? "\x1b[32mok\x1b[0m  " : "\x1b[31mfail\x1b[0m"} ${r.artifact}${r.changed.length ? ` — rewrote ${r.changed.length} file(s)` : " — no change"} (${Math.round(r.ms / 1000)}s)`);
      if (!r.ok) say(indent(r.out, 6));
    }
  });
}

// The local mirror of the CI steps that fail twenty minutes after a push:
// "generated file is out of date" (regen, assert no diff) and "breaking
// change" (compare against the base). Refuses while anything is stale,
// because a green check over a known-stale artifact is worse than no check.
function cmdCheck(ctx) {
  const base = baseFacts(ctx);
  if (base.error) die(base.error);
  if (!OPTS.noFetch) fetchBase(ctx, base);
  if (isDirty(ctx.cwd) && !OPTS.dryRun)
    say("  warn: uncommitted changes — checks run against the working tree, CI will run against the commit");

  const arts = [], checks = [];
  for (const a of ctx.cfg.artifacts) {
    if (!a.regen) continue;
    say(`  staleness: ${a.name} …`);
    arts.push(verifyClean(ctx.cwd, a, OPTS));
  }
  for (const c of ctx.cfg.checks) {
    say(`  check: ${c.name} …`);
    checks.push(runCheck(ctx.cwd, c, { ...OPTS, timeout: ctx.cfg.timeout }));
  }
  const dirty = arts.filter(a => a.clean === false);
  const failed = checks.filter(c => c.ran && !c.ok);
  const deferred = [...arts.filter(a => a.deferred), ...checks.filter(c => c.deferred)];
  const stale = ctx.st.stale || [];
  const bad = dirty.length || failed.length || stale.length;
  emit({
    verb: "check", status: bad ? "fail" : deferred.length ? "partial" : "ok",
    base: { ref: base.ref, sha: base.sha.slice(0, 12) },
    staleness: arts.map(a => ({ artifact: a.artifact, clean: a.clean, dirty: a.dirty, deferred: !!a.deferred, error: a.error || null, command: a.command || null })),
    checks: checks.map(c => ({ name: c.name, ran: c.ran, ok: c.ok ?? null, deferred: !!c.deferred, command: c.command, out: c.out || "", log: c.log || null })),
    stale,
    next: bad
      ? [...dirty.map(d => `commit the regenerated ${d.artifact} (${d.dirty.join(", ")})`),
         ...stale.map(s => s.command || `restack clear-stale --only ${s.artifact}`),
         ...failed.map(f => `fix: ${f.name}`)]
      : deferred.length ? ["restack check --deep   # the expensive half has not run"] : ["restack push"],
    exit: bad ? 1 : 0,
  }, o => {
    for (const a of o.staleness)
      say(`  ${a.clean === true ? "\x1b[32mok\x1b[0m  " : a.deferred ? "—   " : "\x1b[31mfail\x1b[0m"} ${a.artifact}${a.clean === false ? ` — regen rewrote ${a.dirty.length} file(s): ${a.dirty.join(", ")}` : a.deferred ? " — deferred (expensive; pass --deep)" : a.error ? ` — ${a.error}` : ""}`);
    for (const c of o.checks) {
      say(`  ${c.ok ? "\x1b[32mok\x1b[0m  " : c.deferred ? "—   " : "\x1b[31mfail\x1b[0m"} ${c.name}${c.deferred ? " — deferred (expensive; pass --deep)" : ""}`);
      if (c.ran && !c.ok) say(indent(c.out, 6));
    }
    for (const s of o.stale) say(`  \x1b[33mstale\x1b[0m ${s.artifact}\n${staleLines(s, 8)}`);
    if (o.exit === 0) { say("\n  then:"); for (const n of o.next) say(`        ${n}`); }
  });
}

// PUSH. This verb PRINTS. It has never run a push and must not learn how.
//
// Two reasons, and the second is the real one. A restacked stack can only go
// up with a force push, and a force push is the one git operation that
// destroys work that was never on this machine — a colleague's commit on your
// branch, a review's outdated-diff anchor. And this machine's Bash guard
// blocks force pushes from an agent by design, so a tool that shelled out to
// one would be routing around a safety rail its own user installed.
function cmdPush(ctx) {
  const stack = (() => {
    const base = baseFacts(ctx);
    if (base.error) return null;
    return discover(ctx.cwd, ctx.cfg, ctx.branch, base, ctx.gitDirPath);
  })();
  const branches = (ctx.st.steps || []).filter(s => s.status === "done").map(s => s.branch);
  const names = branches.length ? branches : (stack ? stack.chain.map(c => c.name) : [ctx.branch].filter(Boolean));
  const lines = names.map(b => `${ctx.cfg.push.command} ${ctx.cfg.remote} ${b}`);
  const blocked = (ctx.st.stale || []).length > 0;
  emit({
    verb: "push", status: blocked ? "stale" : "ok",
    push: lines, stale: ctx.st.stale || [],
    note: "printed, never run — a human runs these",
    exit: blocked ? 1 : 0,
  }, o => {
    if (o.stale.length) {
      say("  \x1b[33mstale artifacts — pushing now is the CI failure you are trying to avoid:\x1b[0m");
      for (const s of o.stale) say(`    ${s.artifact}: ${s.command || s.why}`);
      say("");
    }
    say("  run these yourself (the stack must go up bottom-first):");
    for (const l of o.push) say(`    ${l}`);
  });
}

// The deliberate hatch. Some artifacts have no command to run — a database
// schema is re-derived by re-running your own migration, a lockfile by
// re-resolving dependencies — so `regen` can never clear their stale mark and
// without this the only way past `check` would be to ignore it, which is how
// a refusal stops meaning anything. Requires naming the artifact (or --all),
// and writes who cleared what into the state log.
function cmdClearStale(ctx) {
  const only = opt("only");
  const all = flag("all");
  if (!only && !all) die("name what you are clearing: `restack clear-stale --only <artifact>` (or --all)");
  const before = ctx.st.stale || [];
  if (only && !before.some(s => s.artifact === only)) die(`nothing stale named "${only}"`);
  const cleared = all ? before : before.filter(s => s.artifact === only);
  ctx.st.stale = all ? [] : before.filter(s => s.artifact !== only);
  for (const c of cleared) S.log(ctx.st, `cleared stale: ${c.artifact} (${c.why})`);
  S.write(ctx.gitDirPath, ctx.st);
  emit({ verb: "clear-stale", status: "ok", cleared: cleared.map(c => c.artifact), stale: ctx.st.stale, exit: 0 },
    o => {
      say(`  cleared: ${o.cleared.join(", ")}`);
      say("  say so to the human — this asserts the artifact is correct as committed, it does not check it.");
    });
}


// verify — the after-the-fact check: did the restack change anything of
// yours? Deterministic (git range-diff against the tips the walk recorded
// before it moved anything); the judgment layer only ranks what is left.
function cmdVerify(ctx) {
  const st = ctx.st;
  const steps = (st.steps || []).filter(s => s.newTip && s.tip && s.upstream);
  const only = opt("branch");
  const wanted = only ? steps.filter(s => s.branch === only) : steps;
  if (!wanted.length)
    die(st.steps?.length
      ? "no branch in the last run has a recorded before/after — verify only works on a walk this tool did"
      : "no run to verify — `restack run` records the tips this check needs");

  const factor = Number(ctx.cfg.verify?.creationFactor) || CREATION_FACTOR;
  const results = [];
  for (let i = 0; i < wanted.length; i++) {
    const idx = st.steps.indexOf(wanted[i]);
    const newParent = idx === 0 ? st.base.sha : st.steps[idx - 1].newTip;
    results.push(verifyBranch(ctx.cwd, ctx.cfg, wanted[i], newParent, st.humanResolved || [], factor));
  }
  const unexplained = results.flatMap(r => (r.unexplained || []).map(u => ({ branch: r.branch, ...u })));
  const vanished = results.flatMap(r => (r.vanished || []).map(v => ({ branch: r.branch, ...v })));
  const flagged = judgeResidue(JUDGE, unexplained);
  const flaggedFiles = new Set(flagged.map(f => f.file + "@" + f.commit));
  for (const u of unexplained) {
    const f = flagged.find(x => x.file === u.file && x.commit === u.commit);
    if (f) { u.judged = "semantic"; u.pBenign = f.pBenign ?? null; }
  }
  const unchecked = results.filter(r => !r.checked);
  // A check that could not run is not a pass. The first version returned 0
  // here and printed the all-clear line under it.
  const bad = unexplained.length || vanished.length || unchecked.length;
  emit({
    verb: "verify", status: bad ? "needs-review" : "ok",
    judged: { on: JUDGE.on, content: JUDGE.content },
    branches: results.map(r => ({
      branch: r.branch, checked: r.checked, why: r.why || null, note: r.note || null,
      generated: (r.generated || []).length,
      resolved: (r.resolved || []).length,
      unexplained: r.unexplained || [], vanished: r.vanished || [], added: r.added || [],
    })),
    unexplained, vanished,
    unchecked: unchecked.map(r => ({ branch: r.branch, why: r.why })),
    next: bad
      ? [...unchecked.map(u => `${u.branch} could not be checked: ${u.why}`),
         ...unexplained.map(u => `read ${u.file} in ${u.commit} (${u.branch}) — its patch changed and nothing explains it`),
         ...vanished.map(v => `commit ${v.sha} "${v.subject}" is gone from ${v.branch}`),
         "git reflog <branch>   # the pre-restack tips are still there"]
      : ["restack check"],
    exit: bad ? NEEDS_HUMAN : 0,
  }, o => {
    for (const b of o.branches) {
      if (!b.checked) { say(`  \x1b[33m??\x1b[0m  ${b.branch} — NOT CHECKED: ${b.why}`); continue; }
      const clean = !b.unexplained.length && !b.vanished.length;
      if (b.note) say(`  \x1b[31m!!\x1b[0m  ${b.branch} — ${b.note}`);
      say(`  ${clean ? "\x1b[32mok\x1b[0m  " : "\x1b[33m??\x1b[0m  "} ${b.branch} — ${b.generated} regenerated, ${b.resolved} you resolved, ${b.unexplained.length} unexplained`);
      for (const v of b.vanished) say(`       \x1b[33mcommit gone\x1b[0m ${v.sha} ${v.subject}`);
      for (const u of b.unexplained) {
        say(`       \x1b[33m${u.file}\x1b[0m in ${u.commit} — ${u.subject}${u.judged === "semantic" ? "  \x1b[31m[reads as a real change]\x1b[0m" : ""}`);
        for (const line of (u.sample || []).slice(0, 4)) say(`         ${line}`);
      }
    }
    if (o.exit === 0) say("\n  nothing of yours moved that this run does not explain.");
    else say("\n  read those before pushing — nothing has left the machine yet.");
  });
}

function cmdDoctor(ctx) {
  const base = baseFacts(ctx);
  const tracked = git(ctx.cwd, ["ls-files", "-z"]).out.split("\0").filter(Boolean);
  const arts = ctx.cfg.artifacts.map(a => {
    const hits = tracked.filter(p => a.paths.some(gl => cfgmod.matchesGlob(p, gl)));
    return { artifact: a.name, tier: a.tier, resolve: a.resolve, matches: hits.length, command: a.regen || null, note: a.note || "" };
  });
  const tools = {
    gh: !!whichSync("gh"), gt: !!whichSync("gt"),
    git: git(ctx.cwd, ["--version"]).out.replace("git version ", ""),
  };
  const rerere = git(ctx.cwd, ["config", "--get", "rerere.enabled"]).out || "(unset — restack enables it per invocation)";
  const problems = [
    ...(ctx.cfg.present ? [] : [`no config at ${ctx.cfg.path} — \`restack init\` writes a starting point`]),
    ...arts.filter(a => a.matches === 0).map(a => `artifact "${a.artifact}" matches no tracked file — the globs are wrong, or the files moved`),
    ...arts.filter(a => a.resolve === "regen" && !a.command).map(a => `artifact "${a.artifact}" resolves by regen but has no command`),
    ...(base.error ? [base.error] : []),
  ];
  emit({
    verb: "doctor", status: problems.length ? "fail" : "ok",
    repo: ctx.cwd, config: ctx.cfg.path, present: ctx.cfg.present,
    base: base.error ? { error: base.error } : { ref: base.ref },
    tools, rerere, artifacts: arts,
    checks: ctx.cfg.checks.map(c => ({ name: c.name, tier: c.tier, command: c.run })),
    problems, exit: problems.length ? 1 : 0,
  }, o => {
    say(`  config  ${o.present ? o.config : "(none)"}`);
    say(`  base    ${o.base.error || o.base.ref}`);
    say(`  tools   git ${o.tools.git}${o.tools.gh ? ", gh" : ""}${o.tools.gt ? ", gt (graphite)" : ""}`);
    say(`  rerere  ${o.rerere}`);
    for (const a of o.artifacts)
      say(`  ${a.matches ? "\x1b[32mok\x1b[0m  " : "\x1b[31mfail\x1b[0m"} ${a.artifact} — ${a.matches} file(s), ${a.resolve}/${a.tier}${a.command ? `\n         ${a.command}` : ""}`);
    for (const c of o.checks) say(`  •   ${c.name} (${c.tier}) — ${c.command}`);
    for (const p of o.problems) say(`  \x1b[33m${p}\x1b[0m`);
  });
}

function cmdInit(ctx) {
  const p = cfgmod.configPath(ctx.cwd);
  if (fs.existsSync(p) && !flag("force")) die(`${p} already exists (--force to overwrite)`);
  const tracked = git(ctx.cwd, ["ls-files", "-z"]).out.split("\0").filter(Boolean);
  const artifacts = cfgmod.detect(tracked);
  const base = resolveBase(ctx.cwd, ctx.cfg);
  const doc = {
    $comment: "seamux restack — how this repo's generated files get rebuilt. Fill in every TODO: a regen command nobody has run is worse than none.",
    remote: ctx.cfg.remote,
    base: base.ref || null,
    artifacts,
    checks: [{ name: "example-breaking-change", run: "echo 'replace me with the CI comparison, e.g. a schema diff against the base'", tier: "cheap", note: "TODO" }],
  };
  if (!OPTS.dryRun) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  }
  emit({ verb: "init", status: "ok", path: p, detected: artifacts.map(a => ({ artifact: a.name, paths: a.paths.length })), exit: 0 },
    o => {
      say(`  wrote ${o.path}`);
      for (const d of o.detected) say(`    detected ${d.artifact} (${d.paths} path pattern(s))`);
      say("\n  every entry lands with an empty regen command on purpose — fill them in, then `restack doctor`.");
    });
}

// ---------------------------------------------------------------- engine pointer

function engineVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, ".claude-plugin", "plugin.json"), "utf8")).version || "dev"; }
  catch { return "dev"; }
}

// One key per line (JSON.stringify's two-space form) is part of the contract:
// the shim reads "root" with sed. Written only when the content changes. The
// old ~/.claude/skills copy never writes it: it is the fallback the pointer
// exists to supersede.
function writeEnginePointer() {
  if (!process.env.RESTACK_ENGINE_FILE &&
      HERE === path.join(os.homedir(), ".claude", "skills", "restack")) return null;
  const body = JSON.stringify({ root: HERE, version: engineVersion() }, null, 2) + "\n";
  let cur = null;
  try { cur = fs.readFileSync(ENGINE_FILE, "utf8"); } catch { /* first write */ }
  if (cur === body) return body;
  fs.mkdirSync(path.dirname(ENGINE_FILE), { recursive: true });
  const tmp = ENGINE_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, ENGINE_FILE);
  return body;
}

// `restack setup`: what a plugin install cannot ship, the pointer and the
// ~/.local/bin shim that gives a human shell a `restack` command. Re-runnable.
function cmdSetup(body) {
  say(body ? `  ok    engine pointer -> ${ENGINE_FILE} (root ${HERE})`
           : "  skip  engine pointer: this is the old ~/.claude/skills copy");
  const want = fs.readFileSync(path.join(HERE, "lib", "restack.shim"), "utf8");
  const shim = path.join(SHIM_DIR, "restack");
  let have = null;
  try { have = fs.readFileSync(shim, "utf8"); } catch { /* not installed */ }
  if (have === want) say(`  ok    shim in place: ${shim}`);
  else {
    fs.mkdirSync(SHIM_DIR, { recursive: true });
    fs.writeFileSync(shim, want, { mode: 0o755 });
    fs.chmodSync(shim, 0o755);
    say(`  ok    ${have === null ? "installed" : "updated"} the shim: ${shim}`);
  }
  if (!(process.env.PATH || "").split(":").includes(SHIM_DIR))
    say(`  warn  ${SHIM_DIR} is not on PATH; add it to call \`restack\` from your own shell`);
}

function usage() {
  console.log(`restack — rebase a stack onto a moved base without hand-resolving generated files

  restack status [--json]              where this worktree stands
  restack plan   [--json]              what would be restacked, and which artifacts will collide
  restack run    [--deep] [--branch B] walk the stack; stop only for conflicts a human owns
  restack continue                     after you resolved one, carry on
  restack abort                        put everything back
  restack regen  [--only NAME] [--deep] rebuild generated artifacts, clear their stale marks
  restack verify [--branch B]          did the restack change anything of yours? (git range-diff)
  restack check  [--deep]              staleness + breaking-change checks, locally, before CI
  restack clear-stale --only NAME      assert an artifact is fine as committed (logged)
  restack push                         PRINT the push lines (never runs them)
  restack doctor                       config, globs, tools
  restack init   [--force]             write a starting .seamux/restack.json
  restack setup                        write the engine pointer, install the ~/.local/bin shim
  restack engine                       print the engine pointer (which copy runs)

  --json      machine-readable; exit 2 means "a human has to resolve something"
  --deep      also run the expensive tier (containers, migrations)
  --dry-run   print commands, change nothing
  --no-fetch  trust the base ref already on disk
  --at DIR    operate on that worktree
  --no-judge  skip the optional judgment layer (it can only ever escalate)

  config: .seamux/restack.json (see examples/example.restack.json)`);
}

// ---------------------------------------------------------------- dispatch
// Every run refreshes the pointer, so whichever copy ran last is the one the
// shim finds. Never at the cost of the command itself.
let pointerBody = null;
try { pointerBody = writeEnginePointer(); } catch { /* read-only home: the verb still runs */ }

switch (verb) {
  case "setup":    cmdSetup(pointerBody); break;
  case "engine":
    process.stdout.write(pointerBody || JSON.stringify({ root: HERE, version: engineVersion(), pointer: "not written" }, null, 2) + "\n");
    break;
  case "status":   cmdStatus(context()); break;
  case "plan":     cmdPlan(context()); break;
  case "run":      cmdRun(context()); break;
  case "continue": cmdContinue(context()); break;
  case "abort":    cmdAbort(context()); break;
  case "regen":    cmdRegen(context()); break;
  case "check":    cmdCheck(context()); break;
  case "verify":   cmdVerify(context()); break;
  case "clear-stale": cmdClearStale(context()); break;
  case "push":     cmdPush(context()); break;
  case "doctor":   cmdDoctor(context()); break;
  case "init":     cmdInit(context()); break;
  case "help": case "--help": case "-h": usage(); break;
  default:
    console.error(`restack: unknown verb "${verb}"\n`);
    usage();
    process.exit(1);
}
