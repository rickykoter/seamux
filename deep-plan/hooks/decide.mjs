// The gate's slow half: parse the PreToolUse payload, ask the shared decision
// function, exit 2 with the reason when refused.
//
// Also the one side effect the gate is allowed: the first permitted edit
// inside an authorized increment flips it to "working", so the board shows
// motion without anyone running `deep-plan start` by hand. The flip is
// status-only: `go` already recorded the increment's start sha, because the
// gate never sees a write its Bash heuristic misses and so cannot be the
// one place a base comes from.
import fs from "node:fs";
import { decideToolCall, readState, writeState, log1, brokenRoots, isOwner, ownerName,
  deepPlanCalls, humanLever, onHumansWord, markDenied, deniedThisTurn, promptApproves } from "../lib/state.mjs";
import { trespass, waitingOn, waitText, goOwner } from "../lib/family.mjs";

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
let payload = {};
try { payload = JSON.parse(raw); } catch { process.exit(0); } // fail open on garbage

const tool = payload.tool_name || "";
const input = payload.tool_input || {};
const cwd = payload.cwd || process.cwd();

// Who made this call: its pane, its session (the payload's, else the env's)
// and its workspace.
const who = {
  surface: process.env.CMUX_SURFACE_ID || "",
  session: payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "",
  workspace: process.env.CMUX_WORKSPACE_ID || "",
};

// The go is the human's (ADR 0029). This hook runs only for a Claude Code
// session's own tool calls, so whatever it refuses here stays open to the
// human's shell, the board and the plan pane, which never pass through it.
if (tool === "Bash") {
  let calls = [];
  try { calls = deepPlanCalls(input.command || ""); } catch { /* a parse failure refuses nothing */ }
  const slugOf = c => (c && c.words.find(w => !w.startsWith("-"))) || "?";
  // The human's levers, refused outright from a session.
  const lever = humanLever(calls);
  if (lever) {
    const c = calls.find(x => humanLever([x]));
    process.stderr.write(`deep-plan gate [${slugOf(c)}]: ${lever}, from their own shell, the board or the plan pane — ` +
      `not from a Claude Code session. Ask the human to do it.\n`);
    process.exit(2);
  }
  // A go (or a --force, --by human, close) in the same turn the gate refused
  // an edit is the agent answering the gate itself. The human's word in chat
  // starts a new turn, which clears it.
  const word = onHumansWord(calls);
  // Unless the human's prompt this turn plainly said go: the agent then tried
  // an edit before running the go it was given.
  if (word && deniedThisTurn(who.session) && !promptApproves(who.session)) {
    const c = calls.find(x => onHumansWord([x])) || calls[0];
    process.stderr.write(`deep-plan gate [${slugOf(c)}]: the gate refused an edit in this turn: ask the human, ` +
      `and run ${word} only after they answer. (Their reply starts a new turn; it goes through then.)\n`);
    process.exit(2);
  }
}

const d = decideToolCall(tool, input, cwd);
if (d.allow) {
  const st = d.plan;
  // The plan owns its worktree: only its owner's write is the plan's
  // progress. Another Claude here is a guest, told once per session.
  const owner = !st || isOwner(st.owner, who);
  let guest = "";
  if (st && !owner && st.phase === "implementing") {
    try { guest = guestNote(st); } catch { /* the warning must never break the gate */ }
  }
  if (st && owner && st.phase === "implementing") {
    const inc = (st.increments || []).find(i => i.status === "authorized");
    if (inc && !(st.increments || []).some(i => i.status === "working")) {
      const fresh = readState(st.slug);           // re-read: never clobber a newer write
      const fi = fresh && (fresh.increments || []).find(i => i.n === inc.n);
      if (fi && fi.status === "authorized") {
        fi.status = "working"; fi.startedAt = fi.changedAt = Date.now();
        log1(fresh, `start (via gate): increment ${inc.n}`);
        // Cosmetic: a busy lock must never fail the edit it rides on.
        try { writeState(fresh, { stamp: false }); } catch { /* the next edit flips it */ }
      }
    }
  }
  // One JSON object on stdout, or none: Claude Code reads a single object.
  const out = {};
  // Loud fail-open: a tracked plan whose root vanished gates nothing, and
  // that must be seen, not discovered. systemMessage warns the human without
  // touching the allow decision.
  const broken = brokenRoots();
  const said = [];
  if (broken.length) {
    const lines = broken.map(b => `${b.slug} (root gone: ${b.root})`).join("; ");
    said.push(`deep-plan: gate is FAILING OPEN for ${lines} — ` +
      `re-render with --root, or \`deep-plan close\` the plan.`);
  }
  if (guest) said.push(guest);
  if (said.length) out.systemMessage = said.join("\n");
  // The family guard: an edit into a sibling's claim goes through, and the
  // agent is told so once per session and path. additionalContext reaches the
  // model; permissionDecision is never set — "allow" would skip the session's
  // own permission prompts, and "ask" would stop for a human even in auto mode.
  // Edits only: Bash is gated by cwd and its targets are not parsed, so
  // `family check` is the backstop for what a shell writes.
  const target = input.file_path || input.notebook_path || "";
  if (tool !== "Bash" && target) {
    try {
      const t = trespass({ cwd, target, session: payload.session_id || "", tool });
      if (t) out.hookSpecificOutput = { hookEventName: "PreToolUse", additionalContext: t.note };
    } catch { /* the guard must never break the gate */ }
  }
  // The model hears it too, or it carries on as if the plan were its own.
  if (guest) {
    const ctx = [out.hookSpecificOutput && out.hookSpecificOutput.additionalContext, guest].filter(Boolean).join("\n");
    out.hookSpecificOutput = { hookEventName: "PreToolUse", additionalContext: ctx };
  }
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

// A guest's first write inside a plan's root, per session: a line in the
// plan's log (the increment's review reads it) and the warning, returned. ""
// once this session was told.
function guestNote(st) {
  const fresh = readState(st.slug) || st;
  const key = who.session || who.surface || "unknown";
  fresh.guests = fresh.guests || {};
  if (fresh.guests[key]) return "";
  fresh.guests[key] = { surface: who.surface, workspace: who.workspace, at: Date.now() };
  const inc = (fresh.increments || []).find(i => i.status === "working" || i.status === "authorized");
  const where = who.surface ? `pane ${who.surface.slice(0, 8)}` : `session ${key.slice(0, 8)}`;
  log1(fresh, `guest: ${where} wrote inside the root` + (inc ? ` during increment ${inc.n}` : "") +
    ` (the owner is ${ownerName(fresh.owner)})`);
  writeState(fresh, { stamp: false });
  return `deep-plan: ${st.slug} is owned by ${ownerName(fresh.owner)}; this Claude is a guest in its worktree. ` +
    `Its edits go through but do not start or move the plan` +
    (inc ? `, and they land in increment ${inc.n}'s diff` : "") + `. ` +
    `If the owner's pane is gone, a deep-plan command run from this pane (deep-plan start ${st.slug} <n>) makes it the owner. (Said once per session.)`;
}

const slug = d.plan ? d.plan.slug : "?";
// This turn's refusal, so a `deep-plan go` later in the same turn is refused.
markDenied(who.session, slug);
if (d.records) {
  process.stderr.write(`deep-plan gate [${slug}]: ${d.why} Ask the human.\n`);
  process.exit(2);
}
// A family child whose next go is held by its parent: say so, or the agent
// asks for a go-ahead that will only be refused.
let waits = [];
try { waits = d.plan ? waitingOn(slug) : []; } catch { /* the reason is enough */ }
if (waits.length) d.why += ` go waits on ${waitText(waits)}.`;
// A delegated child's go is its parent's: asking the human for one, or running
// it here, is the wrong move; the refusal says what is.
let own = null;
try { own = d.plan ? goOwner(slug) : null; } catch { /* the reason is enough */ }
if (own && own.hold) d.why += ` The parent is holding it: "${own.hold.reason}".`;
// The opening `deep-plan gate [<slug>]: ` is a contract: the seamux-mods band
// finds a denial by it in the tool result, and probe.mjs asserts it. Change the
// words after it freely; change the opening and update seamux-mods with it.
process.stderr.write(
  `deep-plan gate [${slug}]: ${d.why}\n` +
  (own && own.delegated
    ? `Its go is delegated to the parent (${own.parent}): do not run deep-plan go here. ` +
      `Wait for the parent's go (deep-plan await-go ${slug}); a person can also give it.\n`
    : `Ask the human. Only once they answer go: deep-plan go ${slug} next   ` +
      `(or they press the board's "go" chip).\n`));
process.exit(2);
