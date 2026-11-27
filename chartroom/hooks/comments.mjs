// The comments hook's slow half: the room for this session's cwd, what the
// person said or picked there since it was last told, as additionalContext.
// Pull, never push: nothing is typed into a session, and an idle session
// hears at its next prompt (or through a running `chartroom wait`).
// Never fails a prompt: any error exits 0 with nothing said.
import fs from "node:fs";
import path from "node:path";
import * as S from "../lib/store.mjs";
import * as N from "../lib/news.mjs";

try {
  const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const event = payload.hook_event_name || "UserPromptSubmit";
  const cwd = payload.cwd || process.cwd();
  const rooms = JSON.parse(fs.readFileSync(path.join(S.homeDir(), "rooms.json"), "utf8"));
  const loc = S.resolve(cwd);
  const room = S.roomId(loc.dir);
  if (rooms[room]) {
    const { shown, total } = N.claim(loc.dir, room);
    if (shown.length)
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: N.describe(shown, total) } }) + "\n");
  }
} catch { /* silence beats a broken prompt */ }
process.exit(0);
