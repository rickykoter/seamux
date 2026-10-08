// The news hook's slow half: find the family member this session's cwd
// belongs to, gather what changed since its cursor, and hand it to the model
// as additionalContext. Pull, never push: nothing is typed into a session
// (ADR 0003), and an idle session hears at its next prompt.
//
// Never fails a prompt: any error exits 0 with nothing said.
import fs from "node:fs";
import { memberAt, readSeen, writeSeen, gatherNews, newsText } from "../lib/family.mjs";

try {
  const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const event = payload.hook_event_name || "UserPromptSubmit";
  const hit = memberAt(payload.cwd || process.cwd());
  if (hit) {
    const { idx, me } = hit;
    const { lines, seen } = gatherNews(idx, me, readSeen(idx.parent, me.slug));
    if (lines.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: newsText(idx, lines) },
      }) + "\n");
    }
    // The cursor moves whether or not there was news: "since you last looked"
    // is since this prompt.
    writeSeen(idx.parent, me.slug, seen);
  }
} catch { /* silence beats a broken prompt */ }
process.exit(0);
