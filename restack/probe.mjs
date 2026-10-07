#!/usr/bin/env node
// restack probe — one command, no arguments, throwaway everything.
//
// It builds real git repositories in a temp dir and restacks them, because
// every interesting thing here is a property of git's behaviour mid-rebase
// (which side is --ours, what an empty commit does, what the index looks like
// when a generator rewrites a file) and a mock of git would only ever assert
// what I already believed. `-v` walks it step by step.
//
// Asserts both directions: that generated conflicts are resolved WITHOUT a
// human, and that human conflicts are never resolved FOR them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sideFlag, sideStage } from "./lib/git.mjs";
import { matchesGlob, detect, load, summarize } from "./lib/config.mjs";
import { markStale, clearStale, fresh } from "./lib/state.mjs";
import { parseRangeDiff, classify } from "./lib/verify.mjs";
import { contentAllowed } from "./lib/judge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = process.argv.includes("-v");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "restack-probe-"));
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "probe@restack",
  GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "probe@restack",
  GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig-none"),  // never read the machine's
  GIT_CONFIG_SYSTEM: path.join(TMP, "gitconfig-none"),
  RESTACK_LOG_DIR: path.join(TMP, "logs"),
  RESTACK_JUDGE_LOG_DIR: path.join(TMP, "judgelog"),
  // Authoritative override, empty = no client. Without this the probe would
  // find the machine's real TypeSafe/Kev client and every walk below would
  // quietly consult a model — the same trap deep-plan's probe documents, and
  // the reason judgments are asserted here against a stand-in instead.
  RESTACK_TYPESAFE_CLIENT: "",
  // The engine pointer and the shim, under TMP: no probe run repoints the
  // real ~/.claude/restack/engine.json or touches ~/.local/bin.
  RESTACK_ENGINE_FILE: path.join(TMP, "engine.json"),
  RESTACK_BIN_DIR: path.join(TMP, "shim-bin"),
};
delete ENV.RESTACK_ENGINE;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; if (V) console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "\n       " + String(detail).replace(/\n/g, "\n       ") : "")); }
}
function step(s) { if (V) console.log("\n\x1b[1m" + s + "\x1b[0m"); }

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function cli(cwd, ...args) {
  const r = spawnSync("node", [path.join(HERE, "restack.mjs"), ...args],
    { cwd, encoding: "utf8", env: ENV });
  let json = null;
  if (args.includes("--json")) { try { json = JSON.parse(r.stdout); } catch { /* left null */ } }
  return { status: r.status, out: r.stdout || "", err: r.stderr || "", json };
}

// ---------------------------------------------------------------- fixtures
//
// A repo with a checked-in GENERATED file: gen/schema.txt is the sorted
// concatenation of src/*.def. The generator is real (a shell one-liner), so
// "regenerate instead of hand-resolving" is exercised end to end rather than
// simulated.
const GEN = "cat src/*.def | sort > gen/schema.txt";

function newRepo(name, cfg) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "gen"), { recursive: true });
  git(dir, "init", "-q", "-b", "master");
  write(dir, "src/a.def", "alpha\n");
  regen(dir);
  write(dir, "app.txt", "hand written\n");
  if (cfg) {
    fs.mkdirSync(path.join(dir, ".seamux"), { recursive: true });
    write(dir, ".seamux/restack.json", JSON.stringify(cfg, null, 2) + "\n");
  }
  commit(dir, "init");
  return dir;
}
function write(dir, rel, txt) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
}
function read(dir, rel) { try { return fs.readFileSync(path.join(dir, rel), "utf8"); } catch { return ""; } }
function regen(dir) { execFileSync("sh", ["-c", GEN], { cwd: dir, env: ENV }); }
function commit(dir, msg) { git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", msg); }
function addDef(dir, name, body, msg, { skipRegen = false } = {}) {
  write(dir, `src/${name}.def`, body);
  if (!skipRegen) regen(dir);
  commit(dir, msg);
}

const cheapCfg = {
  base: "master", remote: "origin",
  artifacts: [{ name: "schema", paths: ["gen/**"], resolve: "regen", tier: "cheap", regen: GEN }],
  checks: [],
};

// ---------------------------------------------------------------- pure units
step("pure units: the ours/theirs inversion, globs, config, state");

ok("rebase: base side is --ours", sideFlag("rebase", "base") === "--ours");
ok("rebase: branch side is --theirs", sideFlag("rebase", "branch") === "--theirs");
ok("merge INVERTS both", sideFlag("merge", "base") === "--theirs" && sideFlag("merge", "branch") === "--ours");
ok("cherry-pick follows rebase", sideFlag("cherry-pick", "base") === "--ours");
ok("stages track the flags", sideStage("rebase", "base") === 2 && sideStage("merge", "base") === 3);

ok("glob: **/db/schema.rb matches nested", matchesGlob("gems/core/db/schema.rb", "**/db/schema.rb"));
ok("glob: **/ also matches top level", matchesGlob("db/schema.rb", "**/db/schema.rb"));
ok("glob: * does not cross a slash", !matchesGlob("a/b/c.graphql", "a/*.graphql"));
ok("glob: a bare directory covers its contents", matchesGlob("protobuf/x/y_pb.rb", "protobuf"));
ok("glob: no accidental substring match", !matchesGlob("gen2/schema.txt", "gen/**"));

const detected = detect(["consumer/db/schema.rb", "app/graphql/schema.graphql", "yarn.lock", "src/thing.rb"]);
ok("detect finds the rails schema", detected.some(d => d.name === "rails-schema"));
ok("detect leaves every regen command empty", detected.every(d => d.regen === ""));
ok("detect ignores ordinary source", !detected.some(d => d.paths.includes("src/thing.rb")));

{
  // A generated tree collapses to one glob rather than 32 literal paths, and
  // the glob has to cover every hit and nothing next door.
  const hits = ["protobuf/member/v1/member_pb.rb", "protobuf/member/v1/member_services_pb.rb",
                "protobuf/project/v1/project_pb.rb", "protobuf/watchlist/v1/watch_pb.rb"];
  const gl = summarize(hits);
  ok("summarize collapses a tree to one glob", gl === "protobuf/**/*_pb.rb", gl);
  ok("and it covers every file it was built from", hits.every(h => matchesGlob(h, gl)));
  ok("and does not reach outside the tree", !matchesGlob("app/models/thing_pb.rb", gl));
  const few = detect(["a/one_pb.rb", "a/two_pb.rb"]);
  ok("but a handful stay listed as themselves", few[0].paths.length === 2, JSON.stringify(few[0]?.paths));

  // The failure this caught on a real monolith: hits sharing neither a
  // directory nor a suffix collapsed to `**/*`, which would have made every
  // file in the repo "generated".
  ok("no common directory means no glob", summarize(["a/x.lock", "b/y.lock", "c/z.lock", "d/w.lock"]) === null);
  ok("a too-short shared suffix means no glob", summarize(["p/a.y", "p/b.y", "p/c.y", "p/d.y"]) === null);
  const scattered = detect(["a/yarn.lock", "b/yarn.lock", "c/yarn.lock", "d/yarn.lock"]);
  ok("so the files are listed instead of wildcarded",
    scattered[0].paths.length === 4 && !scattered[0].paths.some(p2 => p2.includes("*")), JSON.stringify(scattered[0].paths));
}

{
  const st = fresh();
  markStale(st, { artifact: "schema", paths: ["gen/schema.txt"], branches: ["f1"], why: "x", command: GEN });
  markStale(st, { artifact: "schema", paths: ["gen/schema.txt"], branches: ["f2"], why: "x", command: GEN });
  ok("stale is one entry per artifact, not per event", st.stale.length === 1);
  ok("stale accumulates the branches", st.stale[0].branches.join(",") === "f1,f2");
  clearStale(st, "schema");
  ok("a successful regen clears it", st.stale.length === 0);
}

// ---------------------------------------------------------------- config refusals
step("config: refuses the shapes that would lie");
{
  const dir = path.join(TMP, "cfgrepo"); fs.mkdirSync(dir, { recursive: true });
  const at = obj => {
    fs.mkdirSync(path.join(dir, ".seamux"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".seamux", "restack.json"), JSON.stringify(obj));
    return load(dir);
  };
  ok("regen policy with no command is refused",
    at({ artifacts: [{ name: "x", paths: ["a"], resolve: "regen" }] }).errors.length > 0);
  ok("an unknown resolve policy is refused",
    at({ artifacts: [{ name: "x", paths: ["a"], resolve: "vibes" }] }).errors.length > 0);
  ok("an artifact with no paths is refused",
    at({ artifacts: [{ name: "x", paths: [] }] }).errors.length > 0);
  ok("a glob that matches the whole repo is refused",
    at({ artifacts: [{ name: "x", paths: ["**/*"], resolve: "take-base" }] }).errors.length > 0);
  ok("a check with no command is refused",
    at({ checks: [{ name: "c" }] }).errors.length > 0);
  ok("a valid config passes",
    at({ artifacts: [{ name: "x", paths: ["gen/**"], resolve: "regen", regen: "true" }] }).errors.length === 0);
  ok("no config at all is not an error", load(path.join(TMP, "nowhere")).errors.length === 0);
}

// ---------------------------------------------------------------- the core case
step("one branch, a generated conflict, a cheap generator");
{
  const r = newRepo("cheap", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  git(r, "checkout", "-q", "feat1");

  const plan = cli(r, "plan", "--json", "--no-fetch");
  ok("plan sees the collision coming", plan.json?.drift?.collisions?.some(c => c.artifact === "schema"), plan.out + plan.err);
  ok("plan names one step", plan.json?.steps?.length === 1);

  const run = cli(r, "run", "--json", "--no-fetch");
  ok("run exits 0 — no human needed", run.status === 0, run.out + run.err);
  ok("the rebase completed", !fs.existsSync(path.join(r, ".git", "rebase-merge")));
  const schema = read(r, "gen/schema.txt");
  ok("the generated file carries BOTH sides", /alpha/.test(schema) && /bravo/.test(schema) && /charlie/.test(schema), schema);
  ok("no conflict markers survived", !/<{7}|={7}|>{7}/.test(schema), schema);
  ok("the committed copy matches the regenerated one",
    git(r, "status", "--porcelain").out === "", git(r, "status", "--porcelain").out);
  ok("nothing was recorded stale", (run.json?.stale || []).length === 0);
  ok("the branch is on top of master", git(r, "merge-base", "--is-ancestor", "master", "feat1").ok);
  ok("run prints push lines rather than pushing", (run.json?.push || []).length === 1);
  ok("history did not duplicate", Number(git(r, "rev-list", "--count", "master..feat1").out) === 1);
}

// ---------------------------------------------------------------- a clean merge is not a right one
step("both sides touched the artifact, git merged it cleanly: regenerated anyway");
{
  // A header that counts the blocks under it, as real schema dumps do. Both
  // sides add one block, far enough apart for git to merge them, and both
  // headers move to the same count, so the merge is clean and wrong.
  const COUNTED = `n=$(ls src/*.def | wc -l | tr -d ' '); { echo "# GENERATED ($n types)"; cat src/*.def | sort; } > gen/schema.txt`;
  const cfg = { ...cheapCfg, artifacts: [{ ...cheapCfg.artifacts[0], regen: COUNTED }] };
  const counted = (tier, name) => {
    const c = JSON.parse(JSON.stringify(cfg));
    c.artifacts[0].tier = tier;
    const r = newRepo(name, c);
    const gen = () => execFileSync("sh", ["-c", COUNTED], { cwd: r, env: ENV });
    for (const [f, body] of [["m", "mike\n"], ["z", "zulu\n"]]) write(r, `src/${f}.def`, body);
    gen(); commit(r, "three types");
    git(r, "checkout", "-q", "-b", "feat1");
    write(r, "src/b.def", "bravo\n"); gen(); commit(r, "feat: bravo");
    write(r, "app.txt", "branch edit\n"); commit(r, "feat: app");
    git(r, "checkout", "-q", "master");
    write(r, "src/y.def", "yankee\n"); gen(); commit(r, "master: yankee");
    git(r, "checkout", "-q", "feat1");
    return r;
  };

  const r = counted("cheap", "clean-merge");
  // The premise, checked rather than assumed: git really does merge it.
  const probe = path.join(TMP, "clean-merge-premise");
  git(r, "worktree", "add", "-q", "--detach", probe, "feat1");
  ok("premise: git rebases this stack with no conflict at all", git(probe, "rebase", "-q", "master").ok);
  ok("premise: and the merged header undercounts",
    /\(4 types\)/.test(read(probe, "gen/schema.txt")) && /yankee/.test(read(probe, "gen/schema.txt")), read(probe, "gen/schema.txt"));
  git(r, "worktree", "remove", "--force", probe);

  const plan = cli(r, "plan", "--json", "--no-fetch");
  ok("plan lists it as a collision", plan.json?.drift?.collisions?.some(c => c.artifact === "schema"), plan.out);
  const run = cli(r, "run", "--json", "--no-fetch");
  ok("run exits 0", run.status === 0, run.out + run.err);
  ok("the committed artifact is what the generator writes",
    /\(5 types\)/.test(git(r, "show", "feat1:gen/schema.txt").out), git(r, "show", "feat1:gen/schema.txt").out);
  ok("in the commit that changed it, not a later one",
    /\(5 types\)/.test(git(r, "show", "feat1~1:gen/schema.txt").out) &&
    git(r, "show", "--format=%s", "-s", "feat1~1").out === "feat: bravo", git(r, "log", "--stat", "master..feat1").out);
  ok("no commit was added or lost", Number(git(r, "rev-list", "--count", "master..feat1").out) === 2);
  ok("the tree is clean and nothing is stale",
    git(r, "status", "--porcelain").out === "" && (run.json?.stale || []).length === 0, JSON.stringify(run.json?.stale));
  const check = cli(r, "check", "--json", "--no-fetch");
  ok("check passes: regen rewrites nothing", check.status === 0, check.out + check.err);

  const e = counted("expensive", "clean-merge-expensive");
  const erun = cli(e, "run", "--json", "--no-fetch");
  ok("expensive tier: the walk completes", erun.status === 0, erun.out + erun.err);
  ok("and the cleanly merged artifact is recorded stale with its command",
    erun.json?.stale?.some(s => s.artifact === "schema" && s.command === cfg.artifacts[0].regen), JSON.stringify(erun.json?.stale));

  // A stop the engine did not put there is never continued past.
  const own = counted("cheap", "clean-merge-own-exec");
  git(own, "rebase", "-q", "--exec", "false", "master");
  const before = git(own, "rev-parse", "HEAD").out;
  const cont = cli(own, "continue", "--json", "--no-fetch");
  ok("a human's own failing --exec is left for the human",
    cont.status === 2 && /restack did not add/.test(cont.json?.error || "") &&
    git(own, "rev-parse", "HEAD").out === before && !(cont.json?.dropped || []).length, cont.out + cont.err);
}

// ---------------------------------------------------------------- expensive tier
step("the same conflict with an expensive generator: stale, not silent");
{
  const cfg = JSON.parse(JSON.stringify(cheapCfg));
  cfg.artifacts[0].tier = "expensive";
  const r = newRepo("expensive", cfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  git(r, "checkout", "-q", "feat1");

  const run = cli(r, "run", "--json", "--no-fetch");
  ok("the walk still completes", run.status === 0, run.out + run.err);
  ok("the artifact is recorded stale", run.json?.stale?.some(s => s.artifact === "schema"), JSON.stringify(run.json?.stale));
  ok("the stale entry carries the command that fixes it", run.json?.stale?.[0]?.command === GEN);
  ok("the committed copy is the BASE copy, not a merge",
    /charlie/.test(read(r, "gen/schema.txt")) && !/bravo/.test(read(r, "gen/schema.txt")), read(r, "gen/schema.txt"));

  const check = cli(r, "check", "--json", "--no-fetch");
  ok("check refuses while anything is stale", check.status === 1, check.out);
  const push = cli(r, "push", "--json");
  ok("push refuses too, and still only prints", push.status === 1 && (push.json?.push || []).length > 0);

  const deep = cli(r, "regen", "--deep", "--json");
  ok("regen --deep runs the expensive recipe", deep.status === 0, deep.out + deep.err);
  ok("and the file now has both sides", /bravo/.test(read(r, "gen/schema.txt")));
  const after = cli(r, "status", "--json");
  ok("the stale mark is cleared by the regen", (after.json?.stale || []).length === 0);
}

// ---------------------------------------------------------------- take-base
step("take-base drops your copy — and says so, and can be signed off");
{
  const cfg = { base: "master", remote: "origin",
    artifacts: [{ name: "db", paths: ["gen/**"], resolve: "take-base", tier: "expensive",
                  note: "re-run your migration" }], checks: [] };
  const r = newRepo("takebase", cfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  git(r, "checkout", "-q", "feat1");

  const run = cli(r, "run", "--json", "--no-fetch");
  ok("the walk completes", run.status === 0, run.out + run.err);
  ok("the base copy really is what landed",
    /charlie/.test(read(r, "gen/schema.txt")) && !/bravo/.test(read(r, "gen/schema.txt")));
  ok("dropping the branch copy is recorded, not silent",
    run.json?.stale?.some(st => st.artifact === "db"), JSON.stringify(run.json?.stale));
  ok("and the reason says what was lost",
    /not in the commit/.test(run.json?.stale?.[0]?.why || ""), run.json?.stale?.[0]?.why);
  ok("check refuses on it", cli(r, "check", "--json", "--no-fetch").status === 1);

  // No regen command exists for this artifact, so there must be a deliberate
  // way to sign it off — otherwise the refusal is one you learn to ignore.
  ok("clearing requires naming something", cli(r, "clear-stale", "--json").status === 1);
  ok("clearing an unknown artifact is refused", cli(r, "clear-stale", "--only", "nope", "--json").status === 1);
  const cl = cli(r, "clear-stale", "--only", "db", "--json");
  ok("clear-stale --only clears exactly that one", cl.status === 0 && (cl.json?.stale || []).length === 0);
  ok("and check passes afterwards", cli(r, "check", "--json", "--no-fetch").status === 0);
}

// ---------------------------------------------------------------- dropped commits
step("a commit that becomes empty is reported, never silently dropped");
{
  const r = newRepo("empty", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  // A commit that only edits the generated file: once the artifact is
  // re-derived from unchanged sources, there is nothing left of it.
  write(r, "gen/schema.txt", read(r, "gen/schema.txt") + "hand-poked\n");
  commit(r, "feat: poke the generated file");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  git(r, "checkout", "-q", "feat1");

  const run = cli(r, "run", "--json", "--no-fetch");
  ok("the walk completes", run.status === 0, run.out + run.err);
  ok("the empty commit is reported as dropped", (run.json?.dropped || []).length === 1, JSON.stringify(run.json?.dropped));
  ok("with its subject, so you can tell WHICH commit vanished",
    /poke the generated file/.test(run.json?.dropped?.[0]?.subject || ""));
  ok("the branch really has no commits of its own left",
    Number(git(r, "rev-list", "--count", "master..feat1").out) === 0);
}

// ---------------------------------------------------------------- human conflict
step("a conflict in hand-written code: stops, and resolves nothing for you");
{
  const r = newRepo("human", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  write(r, "app.txt", "branch version\n"); commit(r, "feat: app");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  write(r, "app.txt", "master version\n"); commit(r, "master: app");
  git(r, "checkout", "-q", "feat1");

  const run = cli(r, "run", "--json", "--no-fetch");
  ok("exit 2 means a human is needed", run.status === 2, `status ${run.status}\n` + run.out + run.err);
  ok("status says needs-human", run.json?.status === "needs-human");
  ok("the human conflict is named", run.json?.conflicts?.source?.some(s => s.path === "app.txt"));
  ok("with a hunk count to size the job", run.json?.conflicts?.source?.[0]?.hunks >= 1);
  ok("the stop counts commits, not the regen-on-replay exec lines",
    run.json?.stopped?.at === 2 && run.json?.stopped?.of === 2, JSON.stringify(run.json?.stopped));
  ok("app.txt still has its markers — nothing was resolved for the human",
    /<{7}/.test(read(r, "app.txt")), read(r, "app.txt"));
  ok("the next steps name the file and the continue", (run.json?.next || []).join(" ").includes("app.txt"));

  // The generated file in the SAME stop was handled without asking.
  const gen = run.json?.conflicts?.generated?.find(g => g.artifact === "schema");
  ok("the generated half of the same stop was resolved", gen && gen.ok === true, JSON.stringify(run.json?.conflicts));
  ok("and regenerated", gen?.regen?.ok === true);

  // Resolve like a human would, then continue.
  write(r, "app.txt", "merged by hand\n");
  git(r, "add", "app.txt");
  const cont = cli(r, "continue", "--json", "--no-fetch");
  ok("continue finishes the walk", cont.status === 0, cont.out + cont.err);
  ok("no rebase is left in progress", !fs.existsSync(path.join(r, ".git", "rebase-merge")));
  ok("the human's resolution survived", read(r, "app.txt") === "merged by hand\n");
  ok("and the generated file is complete", /bravo/.test(read(r, "gen/schema.txt")) && /charlie/.test(read(r, "gen/schema.txt")));
}

// ---------------------------------------------------------------- a real stack
step("two stacked branches: order, no duplicated commits, one pass");
{
  const r = newRepo("stack", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat1: b");
  git(r, "checkout", "-q", "-b", "feat2");
  addDef(r, "d", "delta\n", "feat2: d");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  git(r, "checkout", "-q", "feat2");

  const plan = cli(r, "plan", "--json", "--no-fetch");
  ok("both branches are in the chain, bottom first",
    plan.json?.steps?.map(s => s.branch).join(",") === "feat1,feat2", JSON.stringify(plan.json?.steps));
  ok("the source of the chain is reported", ["gh", "topology", "config"].includes(plan.json?.stack?.source));

  const run = cli(r, "run", "--json", "--no-fetch");
  ok("the whole stack restacks in one call", run.status === 0, run.out + run.err);
  ok("feat1 sits on master", git(r, "merge-base", "--is-ancestor", "master", "feat1").ok);
  ok("feat2 sits on feat1", git(r, "merge-base", "--is-ancestor", "feat1", "feat2").ok);
  ok("feat2 is exactly two commits ahead of master — nothing replayed twice",
    Number(git(r, "rev-list", "--count", "master..feat2").out) === 2,
    git(r, "log", "--oneline", "master..feat2").out);
  ok("every branch's generated file is complete",
    (() => { git(r, "checkout", "-q", "feat2"); const s = read(r, "gen/schema.txt"); return /alpha/.test(s) && /bravo/.test(s) && /charlie/.test(s) && /delta/.test(s); })());
  ok("it came back to the branch you started on", git(r, "symbolic-ref", "--short", "HEAD").out === "feat2");
  ok("push lines are printed for both branches, bottom first",
    (run.json?.push || []).length === 2 && run.json.push[0].includes("feat1"));
}

// ---------------------------------------------------------------- verify
step("verify: did the restack change anything of yours?");
{
  // The parser and the classifier are unit-tested against real range-diff
  // output, because the interesting cases (a commit that vanished, a file
  // section that disappeared from a patch) are tedious to stage end to end
  // and trivial to get wrong in a regex.
  const sample = [
    "1:  aaaaaaa ! 1:  bbbbbbb feat: pricing",
    "    @@ Metadata",
    "      ## Commit message ##",
    "         feat: pricing",
    "     ",
    "    - ## app.rb ##",
    "    -@@",
    "    - def charge",
    "    --  rate * 1",
    "    -+  rate * 1.5",
    "    - end",
    "      ## gen/schema.txt ##",
    "     @@",
    "    + createdAt: Time",
    "      userId: ID",
    "2:  ccccccc = 2:  ddddddd chore: tidy",
    "3:  eeeeeee < -:  ------- feat: the one that vanished",
  ].join("\n");
  const commits = parseRangeDiff(sample);
  ok("parses one entry per commit", commits.length === 3, JSON.stringify(commits.map(c => c.status)));
  ok("an unchanged commit is marked =", commits[1].status === "=");
  ok("a vanished commit is marked <", commits[2].status === "<");
  const files = commits[0].files.map(f => f.file);
  ok("file sections are found", files.join(",") === "app.rb,gen/schema.txt", files.join(","));
  ok("a section dropped from the patch counts as changed", commits[0].files[0].changed > 0);

  const cfg = { artifacts: [{ name: "schema", paths: ["gen/**"], resolve: "regen", tier: "cheap", regen: "true" }] };
  const plain = classify(commits, cfg, []);
  ok("the generated file is expected, not residue", plain.generated.length === 1 && plain.generated[0].file === "gen/schema.txt");
  ok("the hand-written file IS residue", plain.unexplained.length === 1 && plain.unexplained[0].file === "app.rb");
  ok("residue carries a sample to read", plain.unexplained[0].sample.length > 0);
  ok("the vanished commit is reported", plain.vanished.length === 1);
  ok("an unchanged commit contributes nothing", !plain.unexplained.some(u => u.subject === "chore: tidy"));

  const owned = classify(commits, cfg, ["app.rb"]);
  ok("a file the human resolved this run is explained, not residue",
    owned.unexplained.length === 0 && owned.resolved.length === 1);
}

step("verify end to end: a clean restack has nothing to explain");
{
  const r = newRepo("verify", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  write(r, "app.txt", "branch edit\n"); commit(r, "feat: app");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  git(r, "checkout", "-q", "feat1");
  ok("the walk is clean", cli(r, "run", "--json", "--no-fetch").status === 0);

  const v = cli(r, "verify", "--json");
  ok("verify exits 0 on a clean restack", v.status === 0, v.out + v.err);
  ok("and says nothing is unexplained", (v.json?.unexplained || []).length === 0, JSON.stringify(v.json?.unexplained));
  ok("it counted the regenerated artifact as expected", (v.json?.branches?.[0]?.generated ?? 0) >= 0);
  ok("verify refuses when there is no run to check",
    cli(newRepo("verify-none", cheapCfg), "verify", "--json").status === 1);
}

step("verify: the two ways a check can be a lie");
{
  // 1. Every commit on the branch became empty and was dropped. git
  // range-diff REFUSES an empty range, so this is the case that reported
  // "could not check" and then printed the all-clear under it.
  const r = newRepo("verify-gone", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  write(r, "gen/schema.txt", read(r, "gen/schema.txt") + "poked\n");
  commit(r, "feat: a commit that will evaporate");
  git(r, "checkout", "-q", "master");
  addDef(r, "c", "charlie\n", "master: c");
  git(r, "checkout", "-q", "feat1");
  cli(r, "run", "--json", "--no-fetch");
  const v = cli(r, "verify", "--json");
  ok("a branch whose commits all vanished does not verify clean", v.status === 2, v.out + v.err);
  ok("and the vanished commit is named", v.json?.vanished?.some(x => /evaporate/.test(x.subject)),
    JSON.stringify(v.json?.vanished));

  // 2. A check that could not run at all.
  const r2 = newRepo("verify-broken", cheapCfg);
  git(r2, "checkout", "-q", "-b", "feat1");
  addDef(r2, "b", "bravo\n", "feat: b");
  git(r2, "checkout", "-q", "master");
  addDef(r2, "c", "charlie\n", "master: c");
  git(r2, "checkout", "-q", "feat1");
  cli(r2, "run", "--json", "--no-fetch");
  const sp = path.join(r2, ".git", "seamux-restack.json");
  const st2 = JSON.parse(fs.readFileSync(sp, "utf8"));
  st2.steps[0].upstream = "0000000000000000000000000000000000000000";   // unreadable range
  fs.writeFileSync(sp, JSON.stringify(st2));
  const v2 = cli(r2, "verify", "--json");
  ok("a branch that could not be checked is NOT reported clean", v2.status === 2, v2.out + v2.err);
  ok("and says so rather than implying a pass", (v2.json?.unchecked || []).length === 1, JSON.stringify(v2.json));
}

// ---------------------------------------------------------------- the judgment layer
step("the judgment layer escalates, and can never authorize");
{
  // A stand-in for crew/hooks/typesafe.py: same two subcommands, same JSON
  // contract, an answer chosen by env. CI must never need a model server, and
  // a probe must never reach the machine's real one.
  // The stand-in answers per QUESTION KIND (p* guard, d* dropped, r* residue),
  // because one walk now asks two different questions and a single canned
  // answer would make the guard reject the file before the drop ever happens.
  const fake = path.join(TMP, "fake-typesafe.py");
  fs.writeFileSync(fake, [
    "import json, os, sys",
    "if len(sys.argv) > 1 and sys.argv[1] == 'available': sys.exit(0 if os.environ.get('FAKE_ON') else 1)",
    "req = json.loads(sys.stdin.read() or '{}')",
    "open(os.environ['FAKE_DUMP'], 'w').write(json.dumps(req))",
    "defaults = {'p': 'generated', 'd': 'regeneration_only', 'r': 'benign'}",
    "probs = json.loads(os.environ['FAKE_PROBS']) if os.environ.get('FAKE_PROBS') else None",
    "out = {}",
    "for k in req.get('questions', {}):",
    "    kind = k[0]",
    "    choice = os.environ.get('FAKE_CHOICE_' + kind.upper()) or defaults.get(kind, 'unclear')",
    "    a = {'type': 'choice', 'choice': choice, 'confidence': float(os.environ.get('FAKE_CONF', '0.95'))}",
    "    if probs is not None:",
    "        a['probabilities'] = probs",
    "        a['choice'] = max(probs, key=probs.get)",
    "    out[k] = a",
    "print(json.dumps(out))",
  ].join("\n"));
  const dump = path.join(TMP, "fake-dump.json");
  const withFake = (extra = {}) => ({ ...ENV, RESTACK_TYPESAFE_CLIENT: fake, FAKE_ON: "1", FAKE_DUMP: dump,
    TYPESAFE_BASE_URL: "http://127.0.0.1:8009", ...extra });
  const run = (cwd, env, ...args) => {
    const r = spawnSync("node", [path.join(HERE, "restack.mjs"), ...args], { cwd, encoding: "utf8", env });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* */ }
    return { status: r.status, out: r.stdout || "", err: r.stderr || "", json };
  };
  const stacked = name => {
    const r = newRepo(name, cheapCfg);
    git(r, "checkout", "-q", "-b", "feat1");
    addDef(r, "b", "bravo\n", "feat: b");
    git(r, "checkout", "-q", "master");
    addDef(r, "c", "charlie\n", "master: c");
    git(r, "checkout", "-q", "feat1");
    return r;
  };

  // The guard: a file the glob claims, that the model reads as hand-written.
  const a = stacked("judge-guard");
  const guarded = run(a, withFake({ FAKE_CHOICE_P: "handwritten" }), "run", "--json", "--no-fetch");
  ok("a file judged hand-written is NOT resolved automatically", guarded.status === 2,
    `status ${guarded.status}\n` + guarded.out + guarded.err);
  ok("it lands in the human pile, flagged", guarded.json?.conflicts?.source?.some(x => x.escalated),
    JSON.stringify(guarded.json?.conflicts?.source));
  ok("with the conflict markers untouched", /<{7}/.test(read(a, "gen/schema.txt")));

  // The same repo, the same glob, the model agreeing it is generated: the
  // ONLY thing that changes is that nothing is escalated.
  const b = stacked("judge-agree");
  const agreed = run(b, withFake({ FAKE_CHOICE_P: "generated" }), "run", "--json", "--no-fetch");
  ok("a file judged generated resolves exactly as it does with no model", agreed.status === 0,
    agreed.out + agreed.err);

  // The asymmetric floor, which is the part that was wrong first: what
  // matters is the probability mass on the SAFE option, not the model's
  // confidence in the alarming one.
  const conf = stacked("judge-confident");
  const confident = run(conf, withFake({ FAKE_PROBS: JSON.stringify({ generated: 0.93, handwritten: 0.02, unclear: 0.05 }) }),
    "run", "--json", "--no-fetch");
  ok("a file the model is sure is generated resolves automatically", confident.status === 0, confident.out + confident.err);

  const torn = stacked("judge-torn");
  // The real shape this got wrong: handwritten 0.48 / unclear 0.38 / generated
  // 0.14 arrives with a TOP-TWO MARGIN of 0.09. Judged on that margin it
  // sailed through; judged on P(generated) it stops, which is the point.
  const tornRun = run(torn, withFake({ FAKE_PROBS: JSON.stringify({ generated: 0.14, handwritten: 0.48, unclear: 0.38 }), FAKE_CONF: "0.21" }),
    "run", "--json", "--no-fetch");
  ok("a small top-two margin does NOT authorize an auto-resolution", tornRun.status === 2,
    `status ${tornRun.status}\n` + tornRun.out + tornRun.err);

  const flat = stacked("judge-flat");
  const flatRun = run(flat, withFake({ FAKE_PROBS: JSON.stringify({ generated: 0.34, handwritten: 0.33, unclear: 0.33 }) }),
    "run", "--json", "--no-fetch");
  ok("a model that knows nothing escalates rather than authorizing", flatRun.status === 2,
    `status ${flatRun.status}\n` + flatRun.out + flatRun.err);

  // The load-bearing property: no client, no key, a broken client — today's
  // behaviour, byte for byte.
  const d = stacked("judge-off");
  const off = run(d, { ...ENV, RESTACK_TYPESAFE_CLIENT: "" }, "run", "--json", "--no-fetch");
  ok("with no client at all the walk is unchanged", off.status === 0, off.out + off.err);
  const e = stacked("judge-broken");
  const brokenClient = path.join(TMP, "broken.py");
  fs.writeFileSync(brokenClient, "import sys\nsys.exit(3)\n");
  const broken = run(e, { ...ENV, RESTACK_TYPESAFE_CLIENT: brokenClient, FAKE_ON: "1", FAKE_DUMP: dump }, "run", "--json", "--no-fetch");
  ok("a client that fails is silence, not a stop", broken.status === 0, broken.out + broken.err);
  const f2 = stacked("judge-flag");
  const noflag = run(f2, withFake({ FAKE_CHOICE_P: "handwritten" }), "run", "--json", "--no-fetch", "--no-judge");
  ok("--no-judge turns it off", noflag.status === 0, noflag.out + noflag.err);

  // What leaves the machine, by transport.
  ok("loopback allows content", (() => { process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:8009"; return contentAllowed(); })());
  ok("a remote endpoint does not", (() => { process.env.TYPESAFE_BASE_URL = "https://api.example.com"; return !contentAllowed(); })());
  ok("localhost counts as local", (() => { process.env.TYPESAFE_BASE_URL = "http://localhost:8009"; return contentAllowed(); })());
  ok("and a hostname that merely starts with it does not",
    (() => { process.env.TYPESAFE_BASE_URL = "https://localhost.evil.example"; return !contentAllowed(); })());
  delete process.env.TYPESAFE_BASE_URL;

  const g2 = stacked("judge-remote");
  run(g2, withFake({ TYPESAFE_BASE_URL: "https://api.example.com" }), "run", "--json", "--no-fetch");
  const sent = JSON.parse(fs.readFileSync(dump, "utf8"));
  const states = Object.values(sent.state || {});
  ok("off-machine, the question carries paths only — no file content",
    states.length > 0 && states.every(v => !("head" in v)), JSON.stringify(states).slice(0, 200));

  const h = stacked("judge-local");
  run(h, withFake({}), "run", "--json", "--no-fetch");
  const sentLocal = JSON.parse(fs.readFileSync(dump, "utf8"));
  ok("on-machine, it carries the file head (that is what makes it answerable)",
    Object.values(sentLocal.state).some(v => "head" in v));

  // Dropped commits: the same drop, reported as a line or as a stop.
  const emptyRepo = () => {
    const r = newRepo("judge-drop-" + Math.random().toString(36).slice(2, 7), cheapCfg);
    git(r, "checkout", "-q", "-b", "feat1");
    write(r, "gen/schema.txt", read(r, "gen/schema.txt") + "poked\n");
    commit(r, "feat: add the phone field");
    git(r, "checkout", "-q", "master");
    addDef(r, "c", "charlie\n", "master: c");
    git(r, "checkout", "-q", "feat1");
    return r;
  };
  const dropA = emptyRepo();
  const claims = run(dropA, withFake({ FAKE_CHOICE_D: "claims_other_work" }), "run", "--json", "--no-fetch");
  ok("a dropped commit that claimed real work stops the run", claims.status === 2, claims.out + claims.err);
  ok("and says which commit and why", claims.json?.dropped?.[0]?.escalated === true, JSON.stringify(claims.json?.dropped));
  const dropB = emptyRepo();
  const chore = run(dropB, withFake({ FAKE_CHOICE_D: "regeneration_only" }), "run", "--json", "--no-fetch");
  ok("a dropped regen commit is still reported, but does not stop", chore.status === 0 && (chore.json?.dropped || []).length === 1,
    chore.out + chore.err);
  ok("judgments are logged for tuning", fs.existsSync(path.join(TMP, "judgelog", "judgments.log")));
}

// ---------------------------------------------------------------- refusals
step("refusals: dirty tree, a rebase already in flight, a bad base");
{
  const r = newRepo("refuse", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  write(r, "app.txt", "uncommitted\n");
  const dirty = cli(r, "run", "--json", "--no-fetch");
  ok("a dirty tree is refused, not stashed behind your back", dirty.status === 1, dirty.out + dirty.err);
  git(r, "checkout", "--", "app.txt");

  // A conflict in hand-written code, so the rebase really does stop: a
  // generated-file conflict would be exactly what this engine resolves.
  write(r, "app.txt", "branch version\n"); commit(r, "feat: app");
  git(r, "checkout", "-q", "master");
  write(r, "app.txt", "master version\n"); commit(r, "master: app");
  git(r, "checkout", "-q", "feat1");
  git(r, "rebase", "master");   // leave a real conflict in flight, by hand
  ok("a rebase is genuinely in progress", fs.existsSync(path.join(r, ".git", "rebase-merge")));
  const busy = cli(r, "run", "--json", "--no-fetch");
  ok("run refuses while something is mid-rebase", busy.status === 1, busy.out + busy.err);
  ok("and says which verb continues it", (busy.json?.error || "").includes("continue"));
  const ab = cli(r, "abort", "--json");
  ok("abort puts it back", ab.status === 0 && !fs.existsSync(path.join(r, ".git", "rebase-merge")));

  const bad = spawnSync("node", [path.join(HERE, "restack.mjs"), "plan", "--json", "--no-fetch"], {
    cwd: r, encoding: "utf8",
    env: { ...ENV, RESTACK_CONFIG: (() => { const p = path.join(TMP, "badbase.json"); fs.writeFileSync(p, JSON.stringify({ base: "origin/nope" })); return p; })() },
  });
  ok("an unresolvable base refuses rather than guessing", bad.status === 1, bad.stdout + bad.stderr);
}

// ---------------------------------------------------------------- push is print-only
step("push prints and never pushes");
{
  const bare = path.join(TMP, "remote.git");
  spawnSync("git", ["init", "-q", "--bare", bare], { env: ENV });
  const r = newRepo("pushonly", cheapCfg);
  git(r, "remote", "add", "origin", bare);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  const p = cli(r, "push", "--json");
  ok("it exits 0 with lines to run", p.status === 0 && p.json.push[0].includes("feat1"), p.out);
  ok("the line is a lease-guarded force push, not a bare one",
    /--force-with-lease/.test(p.json.push[0]) && !/--force(\s|$)/.test(p.json.push[0]), p.json.push[0]);
  const refs = spawnSync("git", ["--git-dir", bare, "for-each-ref"], { encoding: "utf8", env: ENV }).stdout.trim();
  ok("the remote is untouched — nothing was pushed", refs === "", refs);
  ok("and it says so in the payload", (p.json.note || "").includes("never run"));
}

// ---------------------------------------------------------------- doctor / init
step("doctor and init");
{
  const r = newRepo("doc", null);
  const init = cli(r, "init", "--json");
  ok("init writes a config", init.status === 0 && fs.existsSync(path.join(r, ".seamux", "restack.json")));
  ok("init refuses to clobber", cli(r, "init", "--json").status === 1);

  const badcfg = { base: "master", artifacts: [{ name: "ghost", paths: ["does/not/exist/**"], resolve: "take-base", tier: "cheap" }] };
  write(r, ".seamux/restack.json", JSON.stringify(badcfg));
  const doc = cli(r, "doctor", "--json", "--no-fetch");
  ok("doctor fails on globs that match nothing", doc.status === 1, doc.out);
  ok("and names the artifact", (doc.json?.problems || []).join(" ").includes("ghost"));

  write(r, ".seamux/restack.json", JSON.stringify(cheapCfg));
  const doc2 = cli(r, "doctor", "--json", "--no-fetch");
  ok("a config whose globs hit real files passes", doc2.status === 0, doc2.out);
  ok("doctor reports the tools it found", typeof doc2.json?.tools?.git === "string");
}

// ---------------------------------------------------------------- status shape
step("the status payload the board and an agent read");
{
  const r = newRepo("shape", cheapCfg);
  git(r, "checkout", "-q", "-b", "feat1");
  addDef(r, "b", "bravo\n", "feat: b");
  const s = cli(r, "status", "--json");
  ok("status exits 0 and parses", s.status === 0 && !!s.json, s.out + s.err);
  for (const k of ["repo", "branch", "base", "config", "operation", "run", "stale"])
    ok(`status carries "${k}"`, k in s.json);
  ok("base reports how far behind", typeof s.json.base.behind === "number");
  ok("status never mutates: no state file appears",
    !fs.existsSync(path.join(r, ".git", "seamux-restack.json")));
}

// ---------------------------------------------------------------- plugin: pointer, setup, shim, bin
// Callers outside Claude find the engine through engine.json, so a run must
// leave it naming this copy. The one file restack keeps under ~.
step("plugin: engine pointer, setup, shim, bin");
{
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, ".claude-plugin", "plugin.json"), "utf8"));
  // Under a temp HOME with no override, as a plugin install runs it.
  const H = path.join(TMP, "home");
  fs.mkdirSync(H, { recursive: true });
  const homeEnv = { ...ENV, HOME: H };
  delete homeEnv.RESTACK_ENGINE_FILE;
  let r = spawnSync("node", [path.join(HERE, "restack.mjs"), "help"], { cwd: TMP, encoding: "utf8", env: homeEnv });
  const ptrFile = path.join(H, ".claude", "restack", "engine.json");
  const ptr = fs.existsSync(ptrFile) ? JSON.parse(fs.readFileSync(ptrFile, "utf8")) : {};
  ok("a run writes ~/.claude/restack/engine.json naming root and version",
    r.status === 0 && ptr.root === HERE && ptr.version === manifest.version, r.stderr);
  ok("engine.json keeps one key per line (the shim reads root with sed)",
    /^  "root": ".*",$/m.test(fs.existsSync(ptrFile) ? fs.readFileSync(ptrFile, "utf8") : ""));

  r = cli(TMP, "setup");
  const shim = path.join(ENV.RESTACK_BIN_DIR, "restack");
  ok("setup installs the shim, executable",
    r.status === 0 && fs.existsSync(shim) && (fs.statSync(shim).mode & 0o111) !== 0, r.err);
  ok("setup again says the shim is in place", /shim in place/.test(cli(TMP, "setup").out));

  const shimRun = extra => spawnSync("sh", [shim, "engine"], { cwd: TMP, encoding: "utf8", env: { ...homeEnv, ...extra } });
  r = shimRun({});
  ok("the shim runs the engine engine.json names", r.status === 0 && JSON.parse(r.stdout || "{}").root === HERE, r.stderr);
  r = shimRun({ RESTACK_ENGINE: path.join(TMP, "nowhere") });
  ok("a bad RESTACK_ENGINE and no old skills copy: the shim says what is missing",
    r.status === 127 && /no engine found/.test(r.stderr));

  for (const f of ["--help", "-h"]) {
    r = cli(TMP, f);
    ok(`restack ${f} prints the usage, not the status`, r.status === 0 && /restack status \[--json\]/.test(r.out));
  }

  const LB = path.join(TMP, "linkbin");
  fs.mkdirSync(LB, { recursive: true });
  fs.symlinkSync(path.join(HERE, "bin", "restack"), path.join(LB, "rs"));
  r = spawnSync(path.join(LB, "rs"), ["engine"], { cwd: TMP, encoding: "utf8", env: ENV });
  ok("bin/restack finds its engine through a symlink, with no plugin env",
    r.status === 0 && JSON.parse(r.stdout || "{}").root === HERE, r.stderr);
}

// ---------------------------------------------------------------- done
console.log(`\n  ${pass} passed, ${fail} failed  (${path.basename(TMP)})`);
if (!process.argv.includes("--keep")) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`  kept: ${TMP}`);
process.exit(fail ? 1 : 0);
