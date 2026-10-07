// verify init's detector: what a repo already does to prove a change works,
// read from its tracked files, turned into DRAFT recipes.
//
// Detection is a starting point, never an answer. Every draft recipe carries
// a `todo` list naming what a person still has to confirm — that the command
// is the one CI runs, that it passes twice from a clean tree, how long it
// takes — and the guided setup prompt (verify/setup-prompt.md) walks those
// with the developer. The engine ignores `todo`; it is the draft's honesty.
//
// What is read:
//   projects   every directory with a package.json, go.mod, Cargo.toml or
//              pyproject.toml (the root always counts), plus the workspace
//              globs package.json / pnpm-workspace.yaml declare
//   scripts    package.json scripts, classified by name and by what they run
//   CI         run steps in .github/workflows/*.yml and .rwx/*.yml, cited as
//              path:line; matrix jobs, composite actions and reusable
//              workflows are flagged, never expanded — a guess there is a
//              command nobody has run
//   runners    Playwright, Cypress, Vitest, Jest, Cucumber and Hurl configs
//   hosts      vercel.json, firebase.json/.firebaserc, .rwx/, netlify.toml —
//              each suggests a remote template, which is only ever copied in
//              by name (`verify init --template <name>`)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MANIFESTS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml"];

// Tracked files, so generated trees and node_modules never count. Outside a
// git repository, a bounded walk that skips the usual vendored directories.
export function trackedFiles(root) {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status === 0) return r.stdout.split("\0").filter(Boolean);
  const out = [], SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor"]);
  const walk = (dir, rel) => {
    if (out.length > 20000) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r2); else out.push(r2);
    }
  };
  try { walk(root, ""); } catch { /* unreadable: what was found stands */ }
  return out;
}

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const readText = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const dirOf = f => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");

// ------------------------------------------------------------- scripts
//
// A script's role comes from its name first and what it runs second. Dev
// servers, builds, watchers, UIs and one-off tooling are not checks.
const NOT_A_CHECK = /^(dev|start|serve|build|prebuild|postbuild|preview|prepare|postinstall|install|deploy|release|publish|clean|format|fmt|storybook|seed|db:|shop|generate|codegen)\b|:(watch|ui|dev|update|fix)$|^.*:watch$/;
const KINDS = [
  { role: "e2e", test: (n, c) => /(^|:)(e2e|a11y|integration|acceptance|smoke|playwright|cypress)\b/.test(n) ||
      /\b(playwright test|cypress run|cucumber-js|hurl)\b/.test(c) },
  { role: "type-check", test: (n, c) => /^(type-?check|types|tsc)$/.test(n) || /^tsc\b.*--noEmit/.test(c) },
  { role: "lint", test: (n, c) => /^lint(:|$)/.test(n) || /^(eslint|biome (lint|check)|stylelint)\b/.test(c) },
  { role: "test", test: (n, c) => /^(test|tests|unit|spec)(:|$)/.test(n) || /^(vitest run|jest|mocha|ava)\b/.test(c) },
];

export function classifyScript(name, command) {
  if (NOT_A_CHECK.test(name) || /\b(--watch|--ui)\b/.test(command) || /^vitest$/.test(command.trim())) return null;
  // A script that only chains others (`npm run lint && npm run test`) is an
  // aggregate: its parts become recipes, it does not become a fifth.
  const parts = command.split(/\s*&&\s*/);
  if (parts.length > 1 && parts.every(p => /^(npm|pnpm|yarn|bun) (run )?[\w:.-]+$/.test(p.trim())))
    return { role: "aggregate", runs: parts.map(p => p.trim().split(/\s+/).pop()) };
  const k = KINDS.find(k => k.test(name, command));
  return k ? { role: k.role } : null;
}

function packageManager(root, files) {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun";
  return "npm";
}
const runScript = (pm, name) => pm === "npm" ? (name === "test" ? "npm test" : `npm run ${name}`)
  : pm === "yarn" ? `yarn ${name}` : `${pm} run ${name}`;

// ------------------------------------------------------------- CI

// Run steps, line by line. A YAML parser would accept more, but would also
// lose the line numbers that make a citation reviewable; what this misreads
// is flagged instead (see the header).
export function ciSteps(root, files) {
  const out = [];
  for (const f of files.filter(f => /^\.github\/workflows\/[^/]+\.ya?ml$|^\.rwx\/[^/]+\.ya?ml$/.test(f))) {
    const lines = readText(path.join(root, f)).split("\n");
    let job = "", jobIndent = -1, inJobs = false, matrix = false;
    const flags = [];
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i], ind = L.search(/\S/);
      if (ind < 0 || /^\s*#/.test(L)) continue;
      if (/^jobs:\s*$/.test(L) || /^tasks:\s*$/.test(L)) { inJobs = true; jobIndent = -1; continue; }
      if (inJobs && ind === 0) inJobs = false;
      if (inJobs) {
        if (jobIndent < 0) jobIndent = ind;
        if (ind === jobIndent && /^\s*-?\s*[\w.-]+:\s*$/.test(L)) { job = L.trim().replace(/^-\s*/, "").replace(/:$/, ""); matrix = false; }
        if (ind === jobIndent && /^\s*-\s*key:\s*(\S+)/.test(L)) { job = L.match(/key:\s*(\S+)/)[1]; matrix = false; }
      }
      if (/^\s*(strategy|matrix):/.test(L)) matrix = true;
      const uses = L.match(/^\s*-?\s*uses:\s*(\S+)/);
      if (uses) {
        if (uses[1].startsWith("./")) flags.push({ at: `${f}:${i + 1}`, job, flag: `composite action ${uses[1]} — its steps are not read here` });
        else if (/\/\.github\/workflows\/.+\.ya?ml@/.test(uses[1]))
          flags.push({ at: `${f}:${i + 1}`, job, flag: `reusable workflow ${uses[1]} — its steps live in another file` });
        continue;
      }
      const m = L.match(/^(\s*-?\s*)run:\s*(.*)$/);
      if (!m) continue;
      let cmd = m[2].trim();
      if (/^[|>][-+]?$/.test(cmd)) {
        const body = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bi = lines[j].search(/\S/);
          if (bi >= 0 && bi <= ind + (m[1].includes("-") ? 2 : 0)) break;
          if (bi >= 0) body.push(lines[j].trim());
        }
        cmd = body.join(" && ");
      }
      cmd = cmd.replace(/^["']|["']$/g, "");
      if (!cmd) continue;
      const notes = [];
      if (matrix) notes.push("matrix job — ${{ matrix.* }} values are not expanded");
      if (/\$\{\{/.test(cmd)) notes.push("uses CI expressions — adapt for a local run");
      out.push({ at: `${f}:${i + 1}`, file: f, job, command: cmd, notes });
    }
    out.push(...flags.map(x => ({ ...x, file: f, command: "", notes: [x.flag] })));
  }
  return out;
}

// ------------------------------------------------------------- projects

const RUNNERS = [
  { name: "playwright", re: /(^|\/)playwright\.config\.[cm]?[jt]s$/ },
  { name: "cypress", re: /(^|\/)cypress\.config\.[cm]?[jt]s$/ },
  { name: "vitest", re: /(^|\/)vitest\.config\.[cm]?[jt]s$/ },
  { name: "jest", re: /(^|\/)jest\.config\.[cm]?[jt]s$/ },
  { name: "cucumber", re: /(^|\/)(cucumber\.(js|cjs|mjs|ya?ml|json)|[^/]+\.feature)$/ },
  { name: "hurl", re: /\.hurl$/ },
];
const HOSTS = [
  { name: "vercel", re: /(^|\/)vercel\.json$/, template: "vercel-preview" },
  { name: "firebase", re: /(^|\/)(firebase\.json|\.firebaserc)$/, template: "firebase-channel" },
  { name: "rwx", re: /^\.rwx\//, template: "rwx-run" },
  { name: "netlify", re: /(^|\/)netlify\.toml$/, template: "github-deployment" },
];

const kebabId = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "check";

export function detect(root) {
  root = path.resolve(root);
  const files = trackedFiles(root);
  const pm = packageManager(root, files);
  const ci = ciSteps(root, files);
  const rootPkg = readJson(path.join(root, "package.json")) || {};
  const workspaces = [
    ...(Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces && rootPkg.workspaces.packages) || []),
    ...[...readText(path.join(root, "pnpm-workspace.yaml")).matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map(m => m[1]),
  ];
  const dirs = new Set([""]);
  for (const f of files) if (MANIFESTS.includes(path.posix.basename(f)) && !f.includes("node_modules/")) dirs.add(dirOf(f));
  // A file belongs to its nearest project directory.
  const owner = f => { let d = dirOf(f); for (;;) { if (dirs.has(d)) return d; if (!d) return ""; d = dirOf(d); } };

  const projects = [...dirs].sort().map(dir => {
    const abs = path.join(root, dir);
    const inside = files.filter(f => owner(f) === dir);
    const manifests = MANIFESTS.filter(m => inside.includes(dir ? `${dir}/${m}` : m));
    const runners = RUNNERS.filter(r => inside.some(f => r.re.test(f))).map(r => r.name);
    const hosts = HOSTS.filter(h => inside.some(f => h.re.test(f)))
      .map(h => ({ name: h.name, template: h.template }));
    const recipes = [], aggregates = [], skipped = [];
    const pkg = manifests.includes("package.json") ? readJson(path.join(abs, "package.json")) || {} : {};
    for (const [name, command] of Object.entries(pkg.scripts || {})) {
      const c = classifyScript(name, String(command));
      if (!c) { skipped.push(name); continue; }
      if (c.role === "aggregate") { aggregates.push({ name, runs: c.runs }); continue; }
      const run = runScript(pm, name);
      // Evidence: CI steps that run this script by name, or its command.
      const cited = ci.filter(s => s.command && (s.command.includes(run) ||
        new RegExp(`\\b(run|${pm})\\s+${name.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}\\b`).test(s.command) ||
        s.command.includes(String(command))));
      const e2e = c.role === "e2e";
      const todo = [
        cited.length ? `confirm it matches CI: ${cited.map(s => s.at).join(", ")}` : "no CI step runs this — confirm it is the command a reviewer would trust",
        "run it twice from a clean tree; both must pass and leave git status clean",
        `measure it and set the tier (${e2e ? "drafted expensive" : "drafted cheap"}: cheap is seconds with no build, server or container)`,
      ];
      const pwConfig = inside.find(f => /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(f));
      if (e2e && pwConfig && /webServer/.test(readText(path.join(root, pwConfig))))
        todo.push("its Playwright config starts its own webServer: a local e2e. For a deployed preview, make it honour $BASE_URL and add a remote template");
      if (e2e) todo.push("decide default: true makes every increment touching this project run it");
      recipes.push({
        id: kebabId(name.replace(/^test:/, "")) === "test" ? "unit" : kebabId(name.replace(/:/g, "-")),
        kind: e2e ? "e2e" : "test", name: `${name} (${run})`, run, tier: e2e ? "expensive" : "cheap",
        default: !e2e, todo,
        evidence: [`${dir ? dir + "/" : ""}package.json scripts.${name}`, ...cited.map(s => s.at)],
      });
    }
    // Ecosystems with one conventional command and no script to read it from.
    const convention = { "go.mod": ["go-test", "go test ./..."], "Cargo.toml": ["cargo-test", "cargo test"],
      "pyproject.toml": ["pytest", "pytest"] };
    for (const m of manifests) if (convention[m]) {
      const [id, run] = convention[m];
      const cited = ci.filter(s => s.command.includes(run.split(" ")[0] + " " + run.split(" ")[1]));
      recipes.push({ id, kind: "test", name: run, run, tier: "cheap", default: true,
        todo: [cited.length ? `confirm it matches CI: ${cited.map(s => s.at).join(", ")}`
          : `the ${m} convention, not read from this repo — confirm it is how this project tests`,
        "run it twice from a clean tree", "measure it and set the tier"],
        evidence: [`${dir ? dir + "/" : ""}${m}`, ...cited.map(s => s.at)] });
    }
    // Ids stay unique within a file.
    const seen = new Map();
    for (const r of recipes) { const k = seen.get(r.id) || 0; seen.set(r.id, k + 1); if (k) r.id = `${r.id}-${k + 1}`; }
    return { dir, manifests, runners, hosts, recipes, aggregates, skipped,
      existing: fs.existsSync(path.join(abs, ".seamux", "verify.json")) };
  }).filter(p => p.dir === "" || p.manifests.length);

  return { root, packageManager: pm, workspaces, projects, ci,
    templates: [...new Set(projects.flatMap(p => p.hosts.map(h => h.template)))] };
}

// The file a project's draft becomes. `todo` and `evidence` ride along for
// the person finishing it; the engine reads neither.
export function draftFile(project, extra = []) {
  return { recipes: [...project.recipes, ...extra] };
}
