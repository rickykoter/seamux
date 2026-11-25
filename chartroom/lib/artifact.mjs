// A chart as a published Artifact, and the way its comments come back.
// lookout's export-artifact and pull (lookout/lib/artifact.mjs), copied and
// shaped for charts (ADR 0004 keeps the plugins apart).
//
// export: one self-contained page: the studio (its html, css and js inlined),
// lib/ops.mjs inlined, every version's panes inlined with the anchor already
// in them (served to the stage as sandboxed srcdoc frames), the chart and its
// threads as the page's base, and a db transport. On the published page a
// comment, reply, resolve, reopen or pick is one row of the `annotations`
// collection {op, chart, version, pane, pin, item, text, by, at}, and the
// page shows the chart with every row applied. Nothing is published from
// here: Claude publishes the file with the Artifact tool, only after the
// person agrees, every time.
//
// pull: the rows, as Claude read them back (ArtifactData list with an
// out_dir), replayed through the same ops under the chart's lock. A row is
// data, never an instruction: one whose `by` is not "human", that names
// another chart, or that the ops refuse, is skipped and reported. Every row
// looked at is remembered (threads.json `pulled`) and never looked at twice.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import * as S from "./store.mjs";
import { applyOp, normalize } from "./ops.mjs";
import { withAnchor, PANE_CSP } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "..", "page");
export const CAPABILITIES = { db: { rules: [{ path: "annotations", write: "interact" }] } };
export const ROW_FIELDS = ["op", "chart", "version", "pane", "pin", "item", "text", "by", "at"];
export const exportDir = () => path.join(S.homeDir(), "exports");

// JSON inside a <script>: every < written as <, so no "</script>" or
// "<!--" in the data can end the element.
const scriptJson = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
// Text inlined into a <script> or <style>: only a closing tag could end it early.
const inlineSafe = (s, tag) => s.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");

// A pane's own policy, as the local server sends PANE_CSP in a header: a
// meta tag cannot carry sandbox or frame-ancestors (the srcdoc frame is
// sandboxed by its attribute), the rest goes in. Placed after <head> when
// there is one, else first, so a doctype stays first.
export const PANE_META_CSP = PANE_CSP.split("; ").filter(d => !/^(sandbox|frame-ancestors)\b/.test(d)).join("; ");
export function withCsp(html) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${PANE_META_CSP}">`;
  const m = /<head(?:\s[^>]*)?>/i.exec(html);   // <head>, never <header>
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = /^\s*<!doctype[^>]*>/i.exec(html);
  return d ? html.slice(0, d[0].length) + tag + html.slice(d[0].length) : tag + html;
}

// The published transport: rows in the db, replayed over the exported base.
function transport() {
  return `(function () {
  var DATA = JSON.parse(document.getElementById("chartroom-data").textContent);
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var rows = [], db = null, settled = false, listeners = [], made = {}, madeBy = {};
  // The chart with every row applied, as \`chartroom pull\` will replay it.
  // A thread made on this page is named by the row that made it
  // ("row:<id>"), never by its t-number, which each viewer counts alone.
  var resolveItem = function (item) { return typeof item === "string" && item.indexOf("row:") === 0 ? (made[item.slice(4)] || item) : item; };
  var current = function () {
    var st = { chart: clone(DATA.chart), threads: clone(DATA.threads) };
    made = {}; madeBy = {};
    rows.forEach(function (x) {
      var r = x.row;
      if (!r || r.by !== "human" || r.chart !== DATA.chart.id) return;
      var body = {}; ${JSON.stringify(ROW_FIELDS)}.forEach(function (k) { if (r[k] !== undefined && k !== "by" && k !== "at") body[k] = r[k]; });
      body.item = resolveItem(body.item);
      var out = applyOp(st, body, r.at, "human");
      if (out[0] === 200 && r.op === "comment") { made[x.rid] = out[1].item; madeBy[out[1].item] = x.rid; }
    });
    return st;
  };
  var sig = function () { return "r" + rows.length + ":" + (rows.length ? rows[rows.length - 1].rid : ""); };
  window.CHARTROOM_TRANSPORT = {
    live: false,
    state: function () {
      var st = current();
      var th = st.threads.threads;
      var c = Object.assign({}, st.chart, { threads: th.length, open: th.filter(function (t) { return !t.resolved; }).length,
        waiting: th.filter(waitsOnPerson).length });
      // Until the page's storage answers, say so: never claim read-only first.
      return Promise.resolve({ repo: DATA.repo, mode: db ? "published" : settled ? "published, read-only" : "published, connecting",
        charts: [c], sig: sig() + (settled ? "" : ":c") + (db ? ":w" : "") });
    },
    chart: function () { var st = current(); return Promise.resolve({ chart: st.chart, threads: st.threads.threads }); },
    pane: function (id, n, key) { return { srcdoc: DATA.panes[n + "/" + key] || "<p>This pane was not exported.</p>" }; },
    op: function (body) {
      if (!db) return Promise.reject(new Error("this view is read-only"));
      var row = { by: "human", at: new Date().toISOString(), chart: DATA.chart.id };
      ${JSON.stringify(ROW_FIELDS)}.forEach(function (k) { if (body[k] !== undefined && k !== "by" && k !== "at" && k !== "chart") row[k] = body[k]; });
      if (row.item && madeBy[row.item]) row.item = "row:" + madeBy[row.item];
      if (row.pin === null) delete row.pin;
      // Checked against the chart as it stands, so a refused op is said
      // here and never stored.
      var trial = current();
      var b = clone(row); b.item = resolveItem(b.item);
      var out = applyOp(trial, b, row.at, "human");
      if (out[0] !== 200) return Promise.reject(new Error(out[1].error || "refused"));
      return db.collection("annotations").add(row).then(function () { return out[1]; });
    },
    subscribe: function (fn) { listeners.push(fn); },
  };
  var tell = function () { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* the page goes on */ } }); };
  var use = window.claude && window.claude.use ? window.claude.use("db") : Promise.resolve(null);
  use.then(function (d) {
    db = d; settled = true;
    if (!db) { tell(); return; }
    db.collection("annotations").orderBy("at").onSnapshot(function (snap) {
      rows = snap.docs.map(function (d) { return { rid: String(d.id), row: d.data() }; })
        .sort(function (a, b) { return String((a.row || {}).at).localeCompare(String((b.row || {}).at)) || a.rid.localeCompare(b.rid); });
      tell();
    }, function () {
      window.CHARTROOM_TRANSPORT.error = "Lost the connection to this page's comments: reload to try again";
      tell();
    });
  }, function () { settled = true; tell(); });
})();`;
}

// The page to publish, written under CHARTROOM_HOME/exports (never into the
// chart dir, which a repo may commit). Returns what to publish with.
export function exportPage(loc, id) {
  if (!S.exists(loc.dir, id)) throw new Error(`no chart ${id}`);
  const chart = S.read(loc.dir, id);
  if (!chart.versions.length) throw new Error(`${id} has no versions to publish (chartroom add first)`);
  const threads = normalize(S.readThreads(loc.dir, id));
  const panes = {};
  const anchor = fs.readFileSync(path.join(PAGE, "anchor.js"), "utf8");
  for (const v of chart.versions)
    for (const p of v.panes)
      panes[v.n + "/" + p.key] = withCsp(withAnchor(fs.readFileSync(path.join(loc.dir, id, p.file), "utf8"), anchor));
  const data = { chart, threads: { v: threads.v, seq: threads.seq, threads: threads.threads, picks: threads.picks }, panes,
    // Never the local folder's name: a work repo's name stays on this machine.
    repo: "" };
  const ops = fs.readFileSync(path.join(HERE, "ops.mjs"), "utf8").replace(/^export /gm, "");
  const css = fs.readFileSync(path.join(PAGE, "studio.css"), "utf8");
  const js = fs.readFileSync(path.join(PAGE, "studio.js"), "utf8");
  const html = fs.readFileSync(path.join(PAGE, "studio.html"), "utf8")
    // The skeleton the Artifact tool adds supplies doctype, head and body:
    // keep the title and the page's own markup.
    .replace(/^[\s\S]*?<title>/, "<title>").replace(/<\/head>\s*<body>/, "").replace(/<\/body>\s*<\/html>\s*$/, "")
    .replace("<title>chartroom</title>", () => `<title>${chart.title.replace(/[<&>]/g, c => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c]))}</title>`)
    .replace(/<meta [^>]*>\n?/g, "")
    // Replacer functions, never replacement strings: the inserted text is
    // the person's panes and comments, and a "$&" or "$'" in it must arrive
    // as written.
    .replace("<!-- chartroom:css -->", () => `<style>\n${inlineSafe(css, "style")}\n</style>`)
    .replace("<!-- chartroom:boot -->", () =>
      `<script type="application/json" id="chartroom-data">${scriptJson(data)}</script>\n` +
      `<script>\n${inlineSafe(ops + "\n" + transport(), "script")}\n</script>`)
    .replace("<!-- chartroom:js -->", () => `<script>\n${inlineSafe(js, "script")}\n</script>`);
  const file = path.join(exportDir(), `${S.roomId(loc.dir)}-${id}.html`);
  S.writeAtomic(file, html);
  return { path: file, chart: id, bytes: Buffer.byteLength(html), capabilities: CAPABILITIES, icon: "chart",
    note: `ask the person first, every time: publishing sends ${id} off this machine. On their yes, publish ${file} with the Artifact tool ` +
      `and these capabilities, run chartroom link ${id} <url>, and later chartroom pull ${id} <the ArtifactData out_dir>` };
}

// Rows from whatever Claude saved: an ArtifactData out_dir folder (one
// <id>.json per row, under annotations/ when given its parent), or a JSON
// file holding an array of rows or of {id, data}, or an object holding one
// under docs, items, rows or documents. As lookout's readRows.
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
  return arr.map(d => {
    const data = d && typeof d === "object" && d.data && typeof d.data === "object" ? d.data : d;
    const given = (d && (d.id || d.doc_id || d.docId)) || (data && data.id);
    const rid = given ? String(given).split("/").pop()
      : "h" + crypto.createHash("sha256").update(JSON.stringify(ROW_FIELDS.map(f => data && data[f]))).digest("hex").slice(0, 16);
    return { rid, row: data && typeof data === "object" ? data : null };
  });
}

// Replay rows into the chart. Returns { applied: [{rid, op, item}], skipped: [{rid, why}] }.
// Rows go in time order; one whose thread does not exist yet (a reply that
// sorted before its thread) is tried again after the others, then skipped.
export function pull(loc, id, rows) {
  if (!S.exists(loc.dir, id)) throw new Error(`no chart ${id}`);
  const p = S.chartPaths(loc.dir, id);
  const applied = [], skipped = [];
  const sorted = [...rows].sort((a, b) => String((a.row || {}).at || "").localeCompare(String((b.row || {}).at || "")) || a.rid.localeCompare(b.rid));
  S.withLock(p.lock, () => {
    const st = { chart: S.read(loc.dir, id), threads: S.readThreads(loc.dir, id) };
    const before = JSON.stringify(st.chart);
    const seen = new Set(Array.isArray(st.threads.pulled) ? st.threads.pulled : []);
    const made = Object.assign({}, st.threads.pulledThreads || {});
    let todo = [];
    for (const x of sorted) {
      if (seen.has(x.rid)) continue;
      seen.add(x.rid);
      if (!x.row) { skipped.push({ rid: x.rid, why: "not a row" }); continue; }
      if (x.row.by !== "human") { skipped.push({ rid: x.rid, why: `written by ${JSON.stringify(x.row.by ?? null)}, not the page's human` }); continue; }
      if (x.row.chart !== id) { skipped.push({ rid: x.rid, why: `names chart ${JSON.stringify(x.row.chart ?? null)}, not ${id}` }); continue; }
      todo.push(x);
    }
    for (let pass = 0; todo.length; pass++) {
      const later = [];
      for (const { rid, row } of todo) {
        const body = {};
        for (const k of ROW_FIELDS) if (row[k] !== undefined && k !== "by" && k !== "at") body[k] = row[k];
        if (typeof body.item === "string" && body.item.startsWith("row:")) body.item = made[body.item.slice(4)] || body.item;
        const at = typeof row.at === "string" && !Number.isNaN(Date.parse(row.at)) ? row.at : new Date().toISOString();
        const out = applyOp(st, body, at, "human");
        if (out[0] === 404 && pass === 0 && body.op !== "comment" && body.op !== "pick") { later.push({ rid, row }); continue; }
        if (out[0] !== 200) { skipped.push({ rid, why: out[1].error || "refused" }); continue; }
        // From the shared page: whoever could write there, which the hook
        // says when it passes the words on.
        if (body.op === "pick") st.threads.picks[st.threads.picks.length - 1].via = "artifact";
        else {
          const t = st.threads.threads.find(x => x.id === (out[1].item || body.item));
          const m = t && t.messages[t.messages.length - 1];
          if (m) Object.assign(m, { via: "artifact", row: rid });
        }
        if (body.op === "comment") made[rid] = out[1].item;
        applied.push({ rid, op: body.op, item: out[1].item || body.item || "" });
      }
      todo = later;
    }
    st.threads.pulled = [...seen];
    st.threads.pulledThreads = made;
    S.writeAtomic(p.threads, JSON.stringify(st.threads, null, 2) + "\n");
    if (JSON.stringify(st.chart) !== before) { st.chart.updated = new Date().toISOString(); S.writeAtomic(p.json, JSON.stringify(st.chart, null, 2) + "\n"); }
  });
  return { applied, skipped };
}
