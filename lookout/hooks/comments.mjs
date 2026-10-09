// The comments hook's slow half: find the reviews this session's cwd belongs
// to, gather what the human said on their pages since the last prompt, and
// hand it to the model as additionalContext with the commands to answer.
// Pull, never push: nothing is typed into a session (ADR 0003), and an idle
// session hears at its next prompt.
//
// The seen cursor is per review (<id>.seen.json beside the store): a message
// is delivered once, to the first session in that repository that prompts.
//
// Never fails a prompt: any error exits 0 with nothing said.
import fs from "node:fs";
import path from "node:path";
import * as S from "../lib/store.mjs";

const MAX_LINES = 20;
const MAX_TEXT = 600;
const RECENT_MS = 30 * 24 * 3600 * 1000;    // older reviews are not this session's business

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (cwd, root) => cwd === root || cwd.startsWith(root + path.sep);

function seenPath(id) { return path.join(S.REVIEWS_DIR, id + ".seen.json"); }
function readSeen(id) {
  try { return new Set(JSON.parse(fs.readFileSync(seenPath(id), "utf8")).seen || []); } catch { return new Set(); }
}

// The human's messages on one review: [{key, item, msg}].
function humanMessages(r) {
  const out = [];
  for (const f of r.findings || [])
    for (const m of f.thread || []) if (m.by === "human") out.push({ key: f.id + "/" + m.id, item: f, msg: m });
  for (const t of r.threads || [])
    for (const m of t.messages || []) if (m.by === "human") out.push({ key: t.id + "/" + m.id, item: t, msg: m });
  return out.sort((a, b) => String(a.msg.at).localeCompare(String(b.msg.at)));
}

function describe(r, news) {
  const lines = news.slice(0, MAX_LINES).map(({ item, msg }) => {
    const where = `${item.file}:${item.line}${item.side === "old" ? " (old side)" : ""}`;
    const what = item.id.startsWith("f") ? `${item.id} (${item.severity} finding, ${where})` : `${item.id} (comment on ${where})`;
    const text = String(msg.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    if (msg.kind === "status") return `- ${what}: the human marked it ${msg.to}${text ? ` — "${text}"` : ""}`;
    return `- ${what}: "${text}"`;
  });
  if (news.length > MAX_LINES) lines.push(`- …and ${news.length - MAX_LINES} more (lookout findings list ${r.id})`);
  return `[lookout ${r.id}] ${news.length} new from the human on the review page for ${r.title}:\n` +
    lines.join("\n") + "\n" +
    `Answer in the page's thread with \`lookout reply ${r.id} <f#|t#> "<text>"\`; after fixing a finding, ` +
    `\`lookout address ${r.id} <f#> "<what changed>"\`. Only the human resolves or dismisses.`;
}

try {
  const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const event = payload.hook_event_name || "UserPromptSubmit";
  const cwd = real(payload.cwd || process.cwd());
  const now = Date.now();
  const parts = [];
  for (const r of S.list()) {
    const root = r.source && r.source.root;
    if (!root || !inside(cwd, real(root))) continue;
    if (now - Date.parse(r.updatedAt || 0) > RECENT_MS) continue;
    const all = humanMessages(r);
    const seen = readSeen(r.id);
    const news = all.filter(x => !seen.has(x.key));
    if (!news.length) continue;
    parts.push(describe(r, news));
    S.writeAtomic(seenPath(r.id), JSON.stringify({ seen: all.map(x => x.key) }) + "\n");
  }
  if (parts.length)
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join("\n\n") } }) + "\n");
} catch { /* silence beats a broken prompt */ }
process.exit(0);
