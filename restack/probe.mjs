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
};

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

// ---------------------------------------------------------------- done
console.log(`\n  ${pass} passed, ${fail} failed  (${path.basename(TMP)})`);
if (!process.argv.includes("--keep")) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`  kept: ${TMP}`);
process.exit(fail ? 1 : 0);
