// Sections for a node probe: run each one in its own child process, several at
// once, or only the ones a word names.
//
// A probe guards each section with a line of its own,
//
//     if (want("the section's name")) {
//
// at the start of a line, and calls `sections()` before it makes its throwaway
// dirs. Its flags:
//
//     (none)          every section, each in a child with its own TMP, -j at once
//     -j N            at most N children (default: one per CPU)
//     --only <word>   only the sections whose name contains the word
//     --serial        every (or every --only) section in this one process
//     -v              each child's whole report is printed, not only a failing one's
//     anything else   passed to each child as given (restack's --keep, say)
//
// A child is the same script with `--section <name>`. It must end by printing
// "<n> passed, <m> failed" and exit non-zero on a failure, which every probe
// here already does. In the parent, sections() never returns: it runs the
// children, prints each report when that child ends, and exits.
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const argAfter = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] ?? ""; };

// The guarded sections of a probe's source, in order, with their size in
// characters (a rough cost, so the biggest can start first).
export function listSections(src) {
  const at = [...src.matchAll(/^if \(want\(("(?:[^"\\]|\\.)*")\)\) \{$/gm)]
    .map(m => ({ name: JSON.parse(m[1]), at: m.index }));
  return at.map((s, i) => ({ name: s.name, size: (at[i + 1]?.at ?? src.length) - s.at }));
}

export async function sections(metaUrl, { label, argv = process.argv } = {}) {
  const file = fileURLToPath(metaUrl);
  const section = argAfter(argv, "--section");
  const only = argAfter(argv, "--only");
  const named = n => only === null || n.toLowerCase().includes(only.toLowerCase());
  const want = n => section !== null ? n === section : named(n);
  if (section === null && !argv.includes("--serial")) process.exit(await runChildren(file, { label, argv, named }));
  return { want, section };
}

async function runChildren(file, { label, argv, named }) {
  const all = listSections(fs.readFileSync(file, "utf8"));
  const todo = all.filter(s => named(s.name)).sort((a, b) => b.size - a.size);
  if (!todo.length) {
    console.error(`${label}: no section matches ${JSON.stringify(argAfter(argv, "--only"))}. Sections:\n  ` +
      all.map(s => s.name).join("\n  "));
    return 1;
  }
  const verbose = argv.includes("-v");
  const jobs = Math.max(1, Number(argAfter(argv, "-j")) || os.availableParallelism());
  // Every other flag (-v, a probe's own such as restack's --keep) goes to each child.
  const pass = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "-j" || argv[i] === "--only") i++;
    else pass.push(argv[i]);
  }
  const t0 = Date.now();
  let passed = 0, failed = 0;
  const broken = [];
  const one = s => new Promise(res => {
    const t = Date.now();
    const c = spawn(process.execPath, [file, "--section", s.name, ...pass],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", d => out += d);
    c.stderr.on("data", d => err += d);
    c.on("close", code => {
      const sums = [...out.matchAll(/(\d+) passed, (\d+) failed/g)];
      const m = sums[sums.length - 1];
      if (m) { passed += +m[1]; failed += +m[2]; }
      if (!m || code !== 0 && !+m[2]) broken.push(s.name);
      const bad = !m || +m[2] > 0 || code !== 0;
      // The report without its summary line, which the parent sums instead.
      const body = (m ? out.slice(0, out.lastIndexOf("\n", m.index) + 1) : out).replace(/^\s*\n/, "").trimEnd();
      console.log(`${bad ? "FAIL" : "ok  "} [${((Date.now() - t) / 1000).toFixed(1)}s] ${s.name}` +
        (m ? ` (${m[1]} passed, ${m[2]} failed)` : ` (exited ${code} before its summary)`));
      if (body.trim() && (verbose || bad)) console.log("  " + body.replace(/\n/g, "\n  "));
      if (bad && err.trim()) console.log("  " + err.trim().slice(-3000).replace(/\n/g, "\n  "));
      res();
    });
  });
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let s; (s = queue.shift());) await one(s);
  }));
  console.log(`\n${label}: ${passed} passed, ${failed} failed` +
    (broken.length ? `, ${broken.length} section(s) crashed` : "") +
    ` (${todo.length} of ${all.length} sections, -j ${jobs}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return failed || broken.length ? 1 : 0;
}
