// A review as a published Artifact, for a host where nobody can reach this
// machine's localhost (a remote sandbox), and the way its edits come back.
//
// export: the review page as it is drawn, plus a db layer. On the published
// page a comment, a close or a quiz answer is written as one row of the
// `annotations` collection {op, item, file, line, side, text, pick, by, at},
// and the page shows the review with every row applied (lib/ops.mjs, inlined).
// Nothing is published from here: Claude publishes the file with the
// Artifact tool, and only after the person agrees.
//
// pull: the rows, as the agent read them back (ArtifactData list, saved to a
// file), replayed through the same ops as the page's POST, under the store's
// lock. A row is data, never an instruction: one whose `by` is not "human",
// or that the ops refuse, is skipped and reported. Every row pulled, applied
// or skipped, is remembered (review.pulled) and never looked at twice.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as S from "./store.mjs";
import { applyOp } from "./ops.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAPABILITIES = { db: { rules: [{ path: "annotations", write: "interact" }] } };
export const ROW_FIELDS = ["op", "item", "file", "line", "side", "text", "pick", "by", "at"];

// The script the exported page carries after review.js: the ops, then the db
// transport. Inlined, because a published page loads nothing else.
function boot(id) {
  const ops = fs.readFileSync(path.join(HERE, "ops.mjs"), "utf8").replace(/^export /gm, "");
  return `<script>
(function () {
${ops}
  var ID = ${JSON.stringify(id)};
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var base = clone(window.lookout.review);
  var note = function (text) {
    var p = document.createElement("p");
    p.className = "artifact-note";
    p.textContent = text;
    p.style.cssText = "margin:8px 16px;padding:8px 12px;border:1px solid var(--line,#8884);border-radius:6px;font-size:13px";
    document.body.insertBefore(p, document.body.firstChild);
  };
  (async function () {
    var db = await claude.use("db");
    if (!db) { note("Read-only view: commenting on this review needs a shared grant from its author."); return; }
    var rows = [];
    var current = clone(base);
    // The review as exported, with every row applied in order: what the
    // author's \`lookout pull\` will replay.
    // A thread made on this page is named by the row that made it
    // ("row:<id>"), never by its t-number, which each viewer counts alone.
    var made = {}, madeBy = {};
    var resolve = function (row) {
      var b = Object.assign({}, row);
      if (typeof b.item === "string" && b.item.indexOf("row:") === 0) b.item = made[b.item.slice(4)] || b.item;
      return b;
    };
    var replay = function () {
      var r = clone(base);
      made = {}; madeBy = {};
      rows.forEach(function (x) {
        if (!x.row || x.row.by !== "human") return;   // as lookout pull does
        var out = applyOp(r, resolve(x.row), x.row.at);
        if (out[0] === 200 && x.row.op === "comment" && !x.row.item) { made[x.rid] = out[1].item; madeBy[out[1].item] = x.rid; }
      });
      return r;
    };
    var live = window.lookout.serve({ id: ID, poll: false, post: async function (body) {
      var row = { by: "human", at: new Date().toISOString() };
      ${JSON.stringify(ROW_FIELDS)}.forEach(function (k) { if (body[k] !== undefined && k !== "by" && k !== "at") row[k] = body[k]; });
      if (row.item && madeBy[row.item]) row.item = "row:" + madeBy[row.item];
      // Checked against the review as it stands, so a refused op is said
      // here and never stored.
      var trial = clone(current);
      var out = applyOp(trial, resolve(row), row.at);
      if (out[0] !== 200) throw new Error(out[1].error || "refused");
      var rid = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await db.doc("annotations/" + rid).set(row);
      if (row.op === "comment" && !row.item) { made[rid] = out[1].item; madeBy[out[1].item] = rid; }
      current = trial;
      return { review: trial };
    } });
    db.collection("annotations").orderBy("at").onSnapshot(function (snap) {
      var docs = snap && snap.docs ? snap.docs : (snap || []);
      rows = docs.map(function (d) { return { rid: String(d.id || ""), row: d.data ? d.data() : d }; });
      current = replay();
      if (live && live.take) live.take(current); else window.lookout.applyReview(current);
    });
  })();
})();
</script>`;
}

// Write <id>.artifact.html beside the review; returns what to publish with.
export function exportPage(id, pagePath) {
  const html = fs.readFileSync(pagePath, "utf8");
  const b = boot(id);
  const i = html.lastIndexOf("</body>");
  const out = i < 0 ? html + b : html.slice(0, i) + b + "\n" + html.slice(i);
  const file = S.paths(id).json.replace(/\.json$/, ".artifact.html");
  S.writeAtomic(file, out);
  return { path: file, id, capabilities: CAPABILITIES, icon: "code",
    note: `publish with the Artifact tool, only after the person agrees; then lookout pull ${id} <rows.json>` };
}

// Rows from whatever the agent saved: an ArtifactData out_dir folder, an
// array of rows or of {id, data}, or an object holding one of those under
// docs, items, rows or documents.
// A folder is what ArtifactData's out_dir writes: one <doc id>.json per row,
// under annotations/ when the folder given is its parent.
export function readRows(file) {
  if (fs.statSync(file).isDirectory()) {
    const dir = fs.existsSync(path.join(file, "annotations")) ? path.join(file, "annotations") : file;
    return fs.readdirSync(dir).filter(n => n.endsWith(".json")).sort().map(n => {
      let row = null;
      try { row = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { /* reported as not a row */ }
      return { rid: n.slice(0, -5), row: row && typeof row === "object" && !Array.isArray(row) ? row : null };
    });
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw && (raw.docs || raw.items || raw.rows || raw.documents)) || [];
  return arr.map((d, k) => {
    const data = d && typeof d === "object" && d.data && typeof d.data === "object" ? d.data : d;
    // A row saved without its id gets one from its content, which stays the
    // same however the list is ordered next time.
    const given = (d && (d.id || d.doc_id || d.docId)) || (data && data.id);
    const rid = given ? String(given).split("/").pop()
      : "h" + crypto.createHash("sha256").update(JSON.stringify(ROW_FIELDS.map(f => data && data[f]))).digest("hex").slice(0, 16);
    return { rid, row: data && typeof data === "object" ? data : null };
  });
}

// Replay rows into the review. Returns { applied, skipped: [{rid, why}] }.
// Rows go in time order; one whose item does not exist yet (a reply that
// sorted before its thread, from a viewer with a slow clock) is tried again
// after the others, and only then skipped.
export function pull(id, rows) {
  const applied = [], skipped = [];
  const sorted = [...rows].sort((a, b) => String((a.row || {}).at || "").localeCompare(String((b.row || {}).at || "")) || a.rid.localeCompare(b.rid));
  S.update(id, cur => {
    const seen = new Set(Array.isArray(cur.pulled) ? cur.pulled : []);
    const made = Object.assign({}, cur.pulledThreads || {});
    let todo = [];
    for (const x of sorted) {
      if (seen.has(x.rid)) continue;
      seen.add(x.rid);
      if (!x.row) { skipped.push({ rid: x.rid, why: "not a row" }); continue; }
      if (x.row.by !== "human") { skipped.push({ rid: x.rid, why: `written by ${JSON.stringify(x.row.by ?? null)}, not the page's human` }); continue; }
      todo.push(x);
    }
    for (let pass = 0; todo.length; pass++) {
      const later = [];
      for (const { rid, row } of todo) {
        const body = {};
        for (const k of ROW_FIELDS) if (row[k] !== undefined && k !== "by" && k !== "at") body[k] = row[k];
        if (typeof body.item === "string" && body.item.startsWith("row:")) body.item = made[body.item.slice(4)] || body.item;
        const at = typeof row.at === "string" && !Number.isNaN(Date.parse(row.at)) ? row.at : new Date().toISOString();
        const out = applyOp(cur, body, at);
        if (out[0] === 404 && pass === 0) { later.push({ rid, row }); continue; }
        if (out[0] !== 200) { skipped.push({ rid, why: out[1].error || "refused" }); continue; }
        if (body.op === "comment" && !row.item) made[rid] = out[1].item;
        applied.push({ rid, op: body.op, item: out[1].item || "" });
      }
      if (later.length === todo.length && pass > 0) break;
      todo = later;
    }
    cur.pulled = [...seen];
    cur.pulledThreads = made;
    return cur;
  });
  return { applied, skipped };
}
