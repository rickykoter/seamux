// The gate's slow half: parse the PreToolUse payload, ask the shared decision
// function, exit 2 with the reason when refused.
//
// Also the one side effect the gate is allowed: the first permitted edit
// inside an authorized increment flips it to "working", so the board shows
// motion without anyone running `deep-plan start` by hand.
import fs from "node:fs";
import { decideToolCall, readState, writeState, log1, brokenRoots } from "../lib/state.mjs";

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
let payload = {};
try { payload = JSON.parse(raw); } catch { process.exit(0); } // fail open on garbage

const tool = payload.tool_name || "";
const input = payload.tool_input || {};
const cwd = payload.cwd || process.cwd();

const d = decideToolCall(tool, input, cwd);
if (d.allow) {
  const st = d.plan;
  if (st && st.phase === "implementing") {
    const inc = (st.increments || []).find(i => i.status === "authorized");
    if (inc && !(st.increments || []).some(i => i.status === "working")) {
      inc.status = "working"; inc.startedAt = Date.now();
      log1(st, `start (via gate): increment ${inc.n}`);
      const fresh = readState(st.slug);           // re-read: never clobber a newer write
      if (fresh) {
        const fi = (fresh.increments || []).find(i => i.n === inc.n);
        if (fi && fi.status === "authorized") { fi.status = "working"; fi.startedAt = inc.startedAt;
          log1(fresh, `start (via gate): increment ${inc.n}`); writeState(fresh); }
      }
    }
  }
  // Loud fail-open: a tracked plan whose root vanished gates nothing, and
  // that must be seen, not discovered. systemMessage warns the human without
  // touching the allow decision.
  const broken = brokenRoots();
  if (broken.length) {
    const lines = broken.map(b => `${b.slug} (root gone: ${b.root})`).join("; ");
    process.stdout.write(JSON.stringify({
      systemMessage: `deep-plan: gate is FAILING OPEN for ${lines} — ` +
        `re-render with --root, or \`deep-plan close\` the plan.`,
    }) + "\n");
  }
  process.exit(0);
}

const slug = d.plan ? d.plan.slug : "?";
process.stderr.write(
  `deep-plan gate [${slug}]: ${d.why}\n` +
  `Ask the human, then: deep-plan go ${slug} next   (or the board's "go" chip; ` +
  `deep-plan open-gate ${slug} lifts the gate entirely.)\n`);
process.exit(2);
