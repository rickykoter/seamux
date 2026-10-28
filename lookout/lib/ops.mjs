// The human's ops on a review, as one pure function: comment, resolve,
// dismiss, reopen and a quiz answer. lookout serve runs it under the store's
// lock for the page's POST (lib/serve.mjs), `lookout pull` replays an
// exported page's rows through it (lib/artifact.mjs), and the exported page
// itself inlines this file to show its own edits. The rules are crew-board's
// review.rs apply, which this replaced.
//
// No imports and no I/O, so it runs in a browser as well as in node.
// applyOp mutates `review` and returns [code, reply]; the caller writes.

export const OPS = ["comment", "resolve", "dismiss", "reopen", "answer"];
export const MAX_TEXT = 4000;

function nextId(items, prefix) {
  let n = 0;
  for (const x of items) {
    const id = x && typeof x.id === "string" ? x.id : "";
    if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) n = Math.max(n, Number(id.slice(prefix.length)));
  }
  return prefix + (n + 1);
}

const isInt = v => typeof v === "number" && Number.isInteger(v);
const list = (o, k) => { if (!Array.isArray(o[k])) o[k] = []; return o[k]; };

export function applyOp(review, body, at = new Date().toISOString()) {
  const op = body && typeof body.op === "string" ? body.op : "";
  if (!OPS.includes(op)) return [400, { error: "unknown op" }];
  if (!review || typeof review !== "object" || Array.isArray(review)) return [409, { error: "the review record is not an object" }];
  const text = [...String(body.text ?? "").trim()].slice(0, MAX_TEXT).join("");
  const message = (msgs, t, extra = {}) => msgs.push({ id: nextId(msgs, "m"), by: "human", at, text: t, ...extra });
  let itemId = body.item == null ? "" : String(body.item);
  list(review, "findings"); list(review, "threads");
  let item = null; // [listName, index]
  if (op === "answer") {
    if (!(review.policy && review.policy.quiz)) return [400, { error: "this review has no quiz" }];
    const note = (Array.isArray(review.notes) ? review.notes : []).find(n => n && n.id === itemId);
    const quiz = note && note.quiz && typeof note.quiz === "object" && !Array.isArray(note.quiz) ? note.quiz : null;
    if (!quiz) return [404, { error: `no question on note ${itemId}` }];
    const nOpts = Array.isArray(quiz.options) ? quiz.options.length : 0;
    if (!isInt(body.pick) || body.pick < 0 || body.pick >= nOpts) return [400, { error: "pick is an option's index as written" }];
    if (quiz.answered) return [409, { error: "already answered", review }];
    quiz.answered = { pick: body.pick, correct: quiz.answer === body.pick, at, by: "human" };
  } else if (itemId) {
    let i = review.findings.findIndex(f => f && f.id === itemId);
    if (i >= 0) item = ["findings", i];
    else if ((i = review.threads.findIndex(t => t && t.id === itemId)) >= 0) item = ["threads", i];
    else return [404, { error: `no finding or thread ${itemId}` }];
  }
  if (op === "comment") {
    if (!text) return [400, { error: "an empty comment says nothing" }];
    if (item) {
      const it = review[item[0]][item[1]];
      if (!it || typeof it !== "object" || Array.isArray(it)) return [400, { error: "the item is not an object" }];
      message(list(it, item[0] === "findings" ? "thread" : "messages"), text);
    } else {
      const f = body.file == null ? "" : String(body.file);
      const side = body.side ? body.side : "new";
      if (!(review.files || []).some(x => x && x.path === f)) return [400, { error: "file is not in this review" }];
      if (!isInt(body.line) || body.line < 1 || (side !== "new" && side !== "old"))
        return [400, { error: "a comment needs a line and a side" }];
      const tid = nextId(review.threads, "t"), msgs = [];
      message(msgs, text);
      review.threads.push({ id: tid, file: f, line: body.line, side, status: "open", by: "human", createdAt: at, messages: msgs });
      itemId = tid;
    }
  } else if (op !== "answer") {
    if (!item) return [400, { error: `${op} needs an item` }];
    let to = op === "resolve" ? "resolved" : op === "dismiss" ? "dismissed" : "open";
    if (item[0] === "threads" && to === "dismissed") to = "resolved";
    const it = review[item[0]][item[1]];
    if (!it || typeof it !== "object" || Array.isArray(it)) return [400, { error: "the item is not an object" }];
    const from = it.status || "open";
    Object.assign(it, { status: to, statusBy: "human", statusAt: at });
    message(list(it, item[0] === "findings" ? "thread" : "messages"), text, { kind: "status", from, to });
  }
  review.updatedAt = at;
  return [200, { ok: true, item: itemId, review }];
}
