// The reading layer shared by the review and working surfaces: a section rail
// (a sticky top bar when the pane is narrow), folding sections, a find widget
// (literal, whole-word, regex, fuzzy), diagrams with Overview/Detailed tabs,
// zoom, pan and a full-screen view, comments that stay highlighted where they
// were pinned (margin cards when wide, a popover on the mark when narrow), and
// drafts that survive the working page's auto-refresh.
//
// Everything here is client-side. The server half only shapes markup the
// client upgrades (section wrappers, rail, tabs, trees are built in the page),
// so the bytes on disk stay a pure function of the spec and rehydrate stays
// byte-identical. No network: the pages work over file:// and on a train.
//
// SURFACE_JS is a String.raw template: it must not contain a backtick or a
// dollar-brace, and — because validateSurface counts tags — no literal
// opening or closing tag text for pre, code, script or textarea.

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const svg = d => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">` +
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON = {
  in: svg("M3 8h10M8 3v10"),
  out: svg("M3 8h10"),
  fit: svg("M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"),
  full: svg("M9.5 2H14v4.5M14 2L9 7M6.5 14H2V9.5M2 14l5-5"),
};

// The diagrams a spec carries, flattened for the parser: each `simple`
// overview is validated like the detailed diagram it accompanies.
export function diagramsForValidation(diagrams) {
  const out = [];
  for (const dg of diagrams || []) {
    out.push(dg);
    if (dg.simple) out.push({ question: "overview of " + (dg.question || ""), mermaid: dg.simple });
  }
  return out;
}

// One diagram card. With a `simple` overview it carries Overview/Detailed
// tabs and opens on the overview; the client hides the inactive view only
// after mermaid has drawn both (a display:none diagram measures as zero).
export function diagramCardHtml(dg, i) {
  const pre = src => `<pre class="mermaid">${esc(String(src).trim())}</pre>`;
  const tabs = dg.simple
    ? `<div class="dp-dg-tabs" role="tablist" aria-label="diagram detail">` +
      `<button type="button" role="tab" data-view="simple" aria-selected="true">Overview</button>` +
      `<button type="button" role="tab" data-view="detailed" aria-selected="false">Detailed</button></div>`
    : "";
  const tool = (z, label, icon) =>
    `<button type="button" class="dp-dg-z" data-z="${z}" aria-label="${label}" title="${label}">${icon}</button>`;
  return `<figure class="dp-dg" id="dg-${i + 1}">
<h3>${esc(dg.question)}</h3>
<div class="dp-dg-bar">${tabs}<span class="dp-dg-tools">${tool("out", "zoom out", ICON.out)}${tool("in", "zoom in", ICON.in)}${tool("fit", "fit", ICON.fit)}${tool("full", "enlarge (or double-click the diagram)", ICON.full)}</span></div>
${dg.simple ? `<div class="dp-dg-view" data-view="simple">${pre(dg.simple)}</div>\n` : ""}<div class="dp-dg-view" data-view="detailed">${pre(dg.mermaid)}</div>
</figure>`;
}

// A file list as a folded directory tree: names only, the full path on hover
// and in data-file (so the served page still opens it in VS Code). Single-child
// directory chains collapse into one row, and top-level directories open with
// the tree. A lone file needs no toggle.
export function fileTreeHtml(files) {
  files = (files || []).filter(Boolean);
  if (!files.length) return "";
  const base = f => f.replace(/\/+$/, "").split("/").pop();
  const leaf = f => `<span class="dp-path" data-file="${esc(f)}" title="${esc(f)}">${esc(base(f))}</span>`;
  if (files.length === 1) {
    const dir = files[0].includes("/") ? files[0].slice(0, files[0].lastIndexOf("/") + 1) : "";
    return `<p class="dp-files1"><span class="dim">file</span> ${leaf(files[0])}${dir ? ` <span class="dim">${esc(dir)}</span>` : ""}</p>`;
  }
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split("/").filter(Boolean);
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    }
    node.files.push(f);
  }
  const count = n => n.files.length + [...n.dirs.values()].reduce((a, d) => a + count(d), 0);
  // A short list opens whole once the tree is opened; a long one opens its
  // top level only.
  const small = files.length <= 8;
  const walk = (node, depth) => {
    const rows = [];
    for (let [name, d] of node.dirs) {
      while (!d.files.length && d.dirs.size === 1) {
        const [k, v] = [...d.dirs][0];
        name += "/" + k; d = v;
      }
      rows.push(`<li><details${depth === 0 || small ? " open" : ""}><summary><span class="dp-dir">${esc(name)}/</span> <span class="dp-n">${count(d)}</span></summary>` +
        `<ul class="dp-tree">${walk(d, depth + 1)}</ul></details></li>`);
    }
    for (const f of node.files) rows.push(`<li class="dp-leaf">${leaf(f)}</li>`);
    return rows.join("");
  };
  const peek = files.slice(0, 3).map(base).join(" · ") + (files.length > 3 ? " …" : "");
  return `<details class="dp-files"><summary><span class="dp-files-n">files <span class="dp-n">${files.length}</span></span> <span class="dp-files-peek">${esc(peek)}</span></summary>` +
    `<ul class="dp-tree">${walk(root, 0)}</ul></details>`;
}

// The shell the client fills: rail, main column, comment margin. The page's
// slug and kind ride as data so drafts are kept per plan and per surface.
export function surfaceOpen(slug, kind) {
  return `<script>window.DP_PAGE=${JSON.stringify({ slug, kind }).replace(/</g, "\\u003c")};</script>
<div id="dp-shell"><nav id="dp-rail" aria-label="plan sections"></nav><main id="dp-main">`;
}
export function surfaceClose() {
  return `</main><aside id="dp-margin" aria-label="comments"></aside></div>`;
}

export const SURFACE_CSS = `<style>
body{max-width:none;margin:0;padding:0}
#dp-shell{position:relative;display:grid;grid-template-columns:minmax(0,1fr)}
#dp-main{min-width:0;width:100%;max-width:820px;margin:0 auto;padding:22px 22px 120px 28px;box-sizing:border-box}
/* Prose stops near 70 characters a line; diagrams, tables, code and a check
   row carrying its live filmstrip keep the column. */
#dp-main :is(p,blockquote,dd,li:not(.dp-check)):not(td *,th *){max-width:70ch}
.dp-sec{scroll-margin-top:64px}
.dp-sec>h2{display:flex;align-items:center;gap:6px}
.dp-fold{background:none;border:0;color:var(--faint);padding:2px;margin-left:-22px;width:20px;height:20px;
  cursor:pointer;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;flex:none}
.dp-fold:hover{color:var(--fg);background:var(--card)}
.dp-fold svg{transition:transform .15s}
.dp-folded .dp-fold svg{transform:rotate(-90deg)}
.dp-folded>.dp-sec-body{display:none}
.dp-folded>h2{opacity:.75}
.dp-badge{font:600 11px/1 var(--mono);color:var(--good-t);background:var(--ef-bg-green);border-radius:999px;padding:2px 6px;margin-left:auto}

/* ---- rail: a column when wide, a sticky top bar when narrow ---- */
#dp-rail{position:sticky;top:0;z-index:30;background:var(--bg);border-bottom:1px solid var(--line);
  display:flex;align-items:center;gap:6px;padding:6px 10px;min-width:0}
.dp-rail-head{display:flex;align-items:center;gap:4px;flex:none;order:2}
.dp-rail-label{display:none}
.dp-toc{list-style:none;margin:0;padding:0;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0;order:1}
.dp-toc::-webkit-scrollbar{display:none}
.dp-toc li{flex:none;display:flex;align-items:center}
.dp-toc a{display:flex;align-items:center;gap:6px;color:var(--dim);text-decoration:none;border-radius:6px;
  padding:4px 8px;font:500 12.5px/1.3 system-ui;white-space:nowrap}
.dp-toc a:hover{color:var(--fg);background:var(--card)}
.dp-toc a[aria-current="true"]{color:var(--fg);background:var(--card3)}
.dp-toc a:focus-visible,.dp-tbtn:focus-visible,.dp-fold:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.dp-sub{list-style:none;margin:0;padding:0;display:flex;gap:1px}
.dp-sub a{padding:4px 5px;font:500 11.5px/1.2 var(--mono)}
.dp-sub .dp-sub-t{display:none}
.dp-sub-dg,.dp-sub-adr{display:none !important}
.dp-glyph{display:inline-flex;flex:none}
.dp-num{white-space:nowrap;flex:none}
.dp-mark{vertical-align:-2px}
.dp-tbtn{background:none;border:1px solid var(--line2);color:var(--dim);border-radius:6px;min-width:30px;height:28px;
  padding:0 7px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font:600 12px/1 var(--mono)}
.dp-tbtn:hover{color:var(--fg);border-color:var(--dim)}
#dp-rail #dp-mode{position:static;min-height:28px;height:28px;padding:0 8px;border-color:var(--line2);background:none;color:var(--dim)}
#dp-rail label.auto{position:static;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;font-size:11.5px}
/* Narrow, the rail is one row: the checkbox keeps a short label, not none. */
#dp-rail label.auto .auto-short{display:none}
@media (max-width:979px){#dp-rail label.auto .auto-long{display:none}#dp-rail label.auto .auto-short{display:inline}}
@media (min-width:980px){
  #dp-shell{grid-template-columns:236px minmax(0,1fr)}
  #dp-rail{height:100vh;box-sizing:border-box;flex-direction:column;align-items:stretch;gap:10px;
    border-bottom:0;border-right:1px solid var(--line);padding:14px 10px 24px;overflow-y:auto}
  .dp-rail-head{order:0;flex-wrap:wrap}
  .dp-rail-label{display:block;font:700 11px/1 system-ui;letter-spacing:.12em;text-transform:uppercase;color:var(--mark-t);padding:8px 8px 0}
  .dp-toc{flex-direction:column;overflow:visible;gap:1px}
  .dp-toc li{display:block}
  .dp-toc a{white-space:normal}
  .dp-sub{flex-direction:column;margin:1px 0 4px 10px;border-left:1px solid var(--line);padding-left:4px}
  .dp-sub a{font:500 12px/1.3 system-ui;padding:3px 8px;min-width:0}
  .dp-sub .dp-sub-t{display:block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dp-sub-dg,.dp-sub-adr{display:flex !important}
  .dp-sub .dp-num{font:500 11px/1 var(--mono);color:var(--faint)}
}
@media (min-width:1300px){
  #dp-shell{grid-template-columns:236px minmax(0,820px) minmax(280px,320px);justify-content:center;column-gap:8px}
  #dp-main{margin:0}
}

/* ---- comments: highlights, margin cards, popovers ---- */
::highlight(dp-note){background-color:var(--hl)}
::highlight(dp-note-on){background-color:var(--hl-on)}
::highlight(dp-find){background-color:var(--find)}
::highlight(dp-find-cur){background-color:var(--find-on);color:#1e2326}
#dp-margin{position:absolute;top:0;left:0;width:100%;height:0;pointer-events:none;z-index:25}
#dp-margin .dp-quote{position:absolute;display:none;pointer-events:auto;width:min(340px,calc(100vw - 24px))}
#dp-margin .dp-quote.dp-open{display:block}
.dp-dot{position:absolute;width:10px;height:10px;border-radius:50%;background:var(--good);border:2px solid var(--bg);
  pointer-events:auto;cursor:pointer;padding:0}
@media (min-width:1300px){
  #dp-margin{position:relative;height:auto;width:auto;pointer-events:auto;z-index:auto}
  #dp-margin .dp-quote{display:block;width:auto;left:0;right:12px;transition:top .12s}
  #dp-margin .dp-quote.dp-q-hidden{display:none}
  .dp-dot{display:none}
}
.dp-quote{background:var(--card2);border:1px solid var(--line2);border-left-color:var(--good);border-radius:8px;
  padding:8px 10px 6px;margin:8px 0;box-shadow:0 4px 14px rgba(0,0,0,.18);box-sizing:border-box}
.dp-quote.dp-on{border-color:var(--good);box-shadow:0 4px 18px rgba(0,0,0,.3)}
.dp-q-jump{display:block;width:100%;text-align:left;background:none;border:0;color:var(--dim);font:italic 12.5px/1.4 system-ui;
  padding:0 0 4px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dp-q-jump:hover{color:var(--fg)}
.dp-quote textarea.dp-note{margin:2px 0 4px;resize:none;overflow:hidden;min-height:30px;font-size:13.5px}
.dp-q-foot{display:flex;align-items:center;gap:6px;font:500 11px/1.2 var(--mono);color:var(--faint)}
.dp-q-foot span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dp-quote .dp-x{position:static;padding:2px 6px;min-height:0;min-width:0;font-size:14px}
.dp-q-orphan{border-left-color:var(--warn)}
.dp-q-sum{list-style:none;padding:0;margin:8px 0}
.dp-q-sum li{display:flex;gap:10px;align-items:baseline;padding:5px 8px;border-radius:6px;cursor:pointer}
.dp-q-sum li:hover{background:var(--card)}
.dp-q-sum .where{font:500 11.5px/1.3 var(--mono);color:var(--faint);flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dp-q-sum .what{flex:1;min-width:0}
.dp-q-sum q{color:var(--dim);font-style:italic}
#dp-hl-add{position:absolute;z-index:40;background:var(--good);color:var(--bg);border:0;border-radius:999px;
  padding:5px 12px 5px 10px;font:600 12.5px/1.2 system-ui;cursor:pointer;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.35)}
#dp-hl-add svg{vertical-align:-3px;margin-right:5px}
#dp-hl-add:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dp-x{background:transparent;border:0;color:inherit;opacity:.6;cursor:pointer;font:inherit}
.dp-x:hover{opacity:1}
#dp-clear{background:none;border:1px solid var(--line2);color:var(--dim);border-radius:6px;padding:8px 12px;
  font:inherit;font-size:13px;cursor:pointer;margin-left:8px;min-height:40px}
#dp-clear.sure{border-color:var(--bad);color:var(--bad-t)}

/* ---- file trees ---- */
.dp-files{margin:8px 0;font-size:13.5px}
.dp-files>summary{cursor:pointer;color:var(--dim);list-style:none;display:flex;gap:8px;align-items:baseline;padding:2px 0}
.dp-files>summary::-webkit-details-marker,.dp-tree summary::-webkit-details-marker{display:none}
.dp-files>summary::before,.dp-tree summary::before{content:"";width:5px;height:5px;border-right:1.5px solid var(--faint);
  border-bottom:1.5px solid var(--faint);transform:rotate(-45deg);margin:0 3px 2px 1px;transition:transform .12s;flex:none;align-self:center}
.dp-files[open]>summary::before,.dp-tree details[open]>summary::before{transform:rotate(45deg);margin-bottom:4px}
.dp-files-n{font:600 11px/1 system-ui;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.dp-files-peek{font:12.5px/1.3 var(--mono);color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dp-files[open] .dp-files-peek{display:none}
.dp-n{font:500 11px/1 var(--mono);color:var(--faint)}
.dp-tree{list-style:none;margin:2px 0 2px 6px;padding-left:12px;border-left:1px solid var(--line)}
.dp-tree summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;padding:1px 0}
.dp-dir{font:12.5px/1.5 var(--mono);color:var(--dim)}
.dp-leaf{font:12.5px/1.6 var(--mono)}
.dp-files1{font-size:13.5px}
.dp-files1 .dp-path{font:12.5px/1.5 var(--mono)}

/* ---- diagrams ---- */
.dp-dg{margin:14px 0 22px;border:1px solid var(--line);border-radius:10px;background:var(--card2);overflow:hidden}
.dp-dg>h3{margin:0;padding:10px 14px 0;font-size:14.5px}
.dp-dg-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line)}
.dp-dg-tabs{display:flex;gap:2px;background:var(--bg);border-radius:7px;padding:2px}
.dp-dg-tabs button{background:none;border:0;color:var(--dim);font:500 12px/1 system-ui;padding:6px 10px;border-radius:5px;cursor:pointer}
.dp-dg-tabs button[aria-selected="true"]{background:var(--card3);color:var(--fg)}
.dp-dg-tools{display:flex;gap:2px;margin-left:auto}
.dp-dg-z{background:none;border:0;color:var(--dim);width:28px;height:28px;border-radius:6px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center}
.dp-dg-z:hover{color:var(--fg);background:var(--card3)}
.dp-dg-z:focus-visible,.dp-dg-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.dp-dg-view{position:relative;overflow:hidden;touch-action:none}
.dp-dg-view[hidden]{display:none}
.dp-dg .mermaid{border:0;margin:0;border-radius:0;background:transparent;overflow:hidden;padding:14px}
.dp-dg .mermaid svg{transform-origin:0 0;display:block;margin:0 auto}
.dp-dg-view.dp-zoomed{cursor:grab}
.dp-dg-view.dp-drag{cursor:grabbing}
.dp-dg-hint{position:absolute;right:10px;bottom:8px;font:500 11px/1 var(--mono);color:var(--faint);pointer-events:none;
  background:var(--card2);padding:3px 6px;border-radius:4px;opacity:0;transition:opacity .15s}
.dp-dg-view:hover .dp-dg-hint{opacity:1}
body.dp-lb-open{overflow:hidden}
#dp-lb{position:fixed;inset:0;z-index:60;background:rgba(20,24,27,.72);display:flex;padding:24px;box-sizing:border-box}
#dp-lb[hidden]{display:none}
.dp-lb-box{flex:1;display:flex;flex-direction:column;background:var(--card2);border:1px solid var(--line2);border-radius:12px;overflow:hidden;min-width:0}
.dp-lb-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line)}
.dp-lb-title{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dp-lb-pct{font:500 11.5px/1 var(--mono);color:var(--faint);min-width:40px;text-align:right}
.dp-lb-stage{flex:1;position:relative;overflow:hidden;cursor:grab;touch-action:none}
.dp-lb-stage.dp-drag{cursor:grabbing}
.dp-lb-stage svg{position:absolute;inset:0;width:100%;height:100%;max-width:none !important;transform-origin:0 0}

/* ---- find ---- */
#dp-find{position:fixed;top:10px;right:16px;z-index:50;width:min(520px,calc(100vw - 24px));background:var(--card2);
  border:1px solid var(--line2);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);padding:6px;box-sizing:border-box}
#dp-find[hidden]{display:none}
.dp-f-row{display:flex;align-items:center;gap:3px}
#dp-f-q{flex:1;min-width:60px;background:var(--bg);color:var(--fg);border:1px solid var(--line2);border-radius:6px;
  padding:6px 8px;font:13.5px/1.3 var(--mono);outline:none}
#dp-f-q:focus{border-color:var(--accent)}
#dp-f-q.dp-f-bad{border-color:var(--bad)}
.dp-f-opt,.dp-f-btn{background:none;border:1px solid transparent;color:var(--dim);border-radius:5px;height:28px;min-width:28px;
  padding:0 5px;cursor:pointer;font:600 12px/1 var(--mono);display:inline-flex;align-items:center;justify-content:center}
.dp-f-opt:hover,.dp-f-btn:hover{color:var(--fg);background:var(--card3)}
.dp-f-opt[aria-pressed="true"]{color:var(--fg);background:var(--card3);border-color:var(--accent)}
.dp-f-opt[data-o="w"]{text-decoration:underline;text-underline-offset:3px}
.dp-f-opt:focus-visible,.dp-f-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#dp-f-n{font:500 11.5px/1 var(--mono);color:var(--faint);min-width:64px;text-align:center;white-space:nowrap}
#dp-f-err{color:var(--bad-t);font:12px/1.4 var(--mono);padding:4px 6px 0}
#dp-f-list{list-style:none;margin:6px 0 0;padding:0;max-height:min(50vh,360px);overflow-y:auto;border-top:1px solid var(--line)}
#dp-f-list li{padding:5px 8px;border-radius:6px;cursor:pointer;font-size:13px;line-height:1.4}
#dp-f-list li[aria-selected="true"]{background:var(--card3)}
#dp-f-list li:hover{background:var(--card)}
#dp-f-list .where{display:block;font:500 11px/1.3 var(--mono);color:var(--faint);text-transform:uppercase;letter-spacing:.06em}
#dp-f-list mark{background:var(--find);color:inherit;border-radius:2px}
#dp-f-ticks{position:fixed;top:0;right:0;bottom:0;width:7px;z-index:45;pointer-events:none}
#dp-f-ticks i{position:absolute;right:0;width:7px;height:3px;background:var(--find-on);opacity:.85}
#dp-f-ticks i.cur{background:var(--fg)}

/* ---- help ---- */
#dp-help{position:fixed;inset:0;z-index:70;background:rgba(20,24,27,.6);display:flex;align-items:center;justify-content:center;padding:16px}
#dp-help[hidden]{display:none}
.dp-help-box{background:var(--card2);border:1px solid var(--line2);border-radius:12px;padding:16px 20px;max-width:520px;width:100%;
  max-height:80vh;overflow:auto;box-sizing:border-box}
.dp-help-box h3{margin:10px 0 6px;font:700 11px system-ui;letter-spacing:.12em;text-transform:uppercase;color:var(--mark-t)}
.dp-help-box h3:first-child{margin-top:0}
.dp-help-box dl{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;margin:0;font-size:13.5px}
.dp-help-box dt{font:600 12px/1.6 var(--mono);color:var(--fg)}
.dp-help-box dd{margin:0;color:var(--dim)}
@media (prefers-reduced-motion:reduce){.dp-fold svg,#dp-margin .dp-quote{transition:none}}
</style>`;

export const SURFACE_JS = String.raw`<script>
(function () {
  "use strict";
  var P = window.DP_PAGE || { slug: "", kind: "" };
  var main = document.getElementById("dp-main");
  var rail = document.getElementById("dp-rail");
  var margin = document.getElementById("dp-margin");
  if (!main || !rail || !margin) return;

  // ------------------------------------------------------------ helpers
  function jget(st, k) { try { var v = st.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function jset(st, k, v) { try { if (v === null) st.removeItem(k); else st.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var LS = (function () { try { return window.localStorage; } catch (e) { return null; } })();
  var SS = (function () { try { return window.sessionStorage; } catch (e) { return null; } })();
  function lget(k) { return LS ? jget(LS, k) : null; }
  function lset(k, v) { if (LS) jset(LS, k, v); }
  function key(name) { return "dp-" + name + ":" + P.slug + ":" + P.kind; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgIcon(d, size) {
    var s = size || 14;
    return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" aria-hidden="true" focusable="false">' +
      '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  var ICON = {
    chev: svgIcon("M4.5 6l3.5 3.5L11.5 6"),
    find: svgIcon("M7 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9zM10.4 10.4L14 14"),
    up: svgIcon("M8 13V3M4 7l4-4 4 4"),
    down: svgIcon("M8 3v10M4 9l4 4 4-4"),
    list: svgIcon("M3 4h10M3 8h10M3 12h10"),
    x: svgIcon("M4 4l8 8M12 4l-8 8"),
    note: svgIcon("M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"),
    in: svgIcon("M3 8h10M8 3v10"),
    out: svgIcon("M3 8h10"),
    fit: svgIcon("M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"),
    one: svgIcon("M5 4.5L7 3v10M5 13h4")
  };
  // Status glyphs for the rail, drawn rather than typed (no emoji).
  function glyph(status) {
    var c = { done: "var(--good)", working: "var(--accent)", authorized: "var(--warn)", blocked: "var(--bad)" }[status] || "var(--faint)";
    var inner = "";
    if (status === "done") inner = '<circle cx="6" cy="6" r="5" fill="' + c + '"/><path d="M3.6 6.2l1.6 1.6 3.2-3.4" fill="none" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    else if (status === "working") inner = '<circle cx="6" cy="6" r="4.6" fill="none" stroke="' + c + '" stroke-width="1.4"/><path d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" fill="' + c + '"/>';
    else if (status === "authorized") inner = '<circle cx="6" cy="6" r="4.6" fill="none" stroke="' + c + '" stroke-width="1.4"/><circle cx="6" cy="6" r="1.8" fill="' + c + '"/>';
    else if (status === "blocked") inner = '<circle cx="6" cy="6" r="4.6" fill="none" stroke="' + c + '" stroke-width="1.4"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" stroke="' + c + '" stroke-width="1.4" stroke-linecap="round"/>';
    else inner = '<circle cx="6" cy="6" r="4.6" fill="none" stroke="' + c + '" stroke-width="1.4"/>';
    return '<span class="dp-glyph"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' + inner + "</svg></span>";
  }
  function editable(t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }
  var WIDE = window.matchMedia ? matchMedia("(min-width: 1300px)") : { matches: true };
  var lastInput = 0;

  // ------------------------------------------------------------ sections
  // Each h2 and what follows it, up to the next h2, becomes a foldable
  // section. Scripts stay where they are; moving form controls keeps their
  // state and listeners.
  var used = {};
  function slugify(t) { return t.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section"; }
  var sections = [];
  (function sectionize() {
    var kids = Array.prototype.slice.call(main.children), body = null;
    kids.forEach(function (n) {
      if (n.tagName === "H2") {
        var title = n.textContent.trim();
        var id = "s-" + slugify(title);
        while (used[id]) id += "-2";
        used[id] = 1;
        var sec = el("section", "dp-sec");
        sec.id = id; sec.setAttribute("data-title", title);
        main.insertBefore(sec, n);
        sec.appendChild(n);
        var fold = el("button", "dp-fold");
        fold.type = "button"; fold.innerHTML = ICON.chev;
        fold.setAttribute("aria-expanded", "true");
        fold.setAttribute("aria-label", "fold " + title);
        n.insertBefore(fold, n.firstChild);
        fold.addEventListener("click", function () { setFold(sec, !sec.classList.contains("dp-folded")); });
        body = el("div", "dp-sec-body");
        sec.appendChild(body);
        sections.push(sec);
        return;
      }
      if (body && n.tagName !== "SCRIPT") body.appendChild(n);
    });
  })();
  var folds = lget(key("folds")) || {};
  function setFold(sec, on, quiet) {
    sec.classList.toggle("dp-folded", on);
    var b = sec.querySelector(".dp-fold");
    if (b) b.setAttribute("aria-expanded", on ? "false" : "true");
    if (!quiet) { if (on) folds[sec.id] = 1; else delete folds[sec.id]; lset(key("folds"), folds); }
    relayout();
  }
  sections.forEach(function (s) { if (folds[s.id]) setFold(s, true, true); });

  // Make whatever holds a node visible: its section, its folded trees, its
  // diagram tab.
  function reveal(node) {
    var e = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!e) return;
    var sec = e.closest(".dp-sec");
    if (sec && sec.classList.contains("dp-folded")) setFold(sec, false);
    for (var d = e.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
    var view = e.closest(".dp-dg-view");
    if (view && view.hidden) showView(view.closest(".dp-dg"), view.getAttribute("data-view"));
  }

  // ------------------------------------------------------------ rail
  var head = el("div", "dp-rail-head");
  function tbtn(label, html, onClick) {
    var b = el("button", "dp-tbtn"); b.type = "button";
    b.innerHTML = html; b.setAttribute("aria-label", label); b.title = label;
    b.addEventListener("click", onClick);
    head.appendChild(b);
    return b;
  }
  tbtn("find in plan (\u2318F or /)", ICON.find, function () { openFind(); });
  tbtn("keyboard shortcuts (?)", "?", function () { toggleHelp(true); });
  var mode = document.getElementById("dp-mode");
  if (mode) head.appendChild(mode);
  var auto = document.querySelector("label.auto");
  if (auto) head.appendChild(auto);
  rail.appendChild(head);
  var railLabel = el("div", "dp-rail-label", "Sections");
  rail.appendChild(railLabel);
  var toc = el("ol", "dp-toc");
  rail.appendChild(toc);
  var navLinks = [];   // {a, target}
  var badges = {};
  function link(target, html, cls) {
    var a = el("a", cls || "");
    a.href = "#" + target.id; a.innerHTML = html;
    a.addEventListener("click", function (e) { e.preventDefault(); jump(target); });
    navLinks.push({ a: a, target: target });
    return a;
  }
  function textOf(n) { return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; }
  sections.forEach(function (sec) {
    var li = el("li");
    var a = link(sec, "");
    a.appendChild(el("span", "", sec.getAttribute("data-title")));
    var bd = el("span", "dp-badge"); bd.hidden = true;
    a.appendChild(bd); badges[sec.id] = bd;
    li.appendChild(a);
    var subs = sec.querySelectorAll('.inc[id^="inc-"], .inc[id^="adr-"], figure.dp-dg');
    if (subs.length) {
      var ol = el("ol", "dp-sub");
      Array.prototype.forEach.call(subs, function (t) {
        var sli = el("li");
        var isDg = t.tagName === "FIGURE", isAdr = /^adr-/.test(t.id);
        if (isDg) sli.className = "dp-sub-dg";
        if (isAdr) sli.className = "dp-sub-adr";
        var b = t.querySelector(isDg ? "h3" : "b");
        var title = textOf(b).replace(/^(ADR )?\d+[.:]\s*/, "");
        var n = t.id.replace(/^\D+/, "");
        var html = (isDg ? "" : glyph(t.getAttribute("data-status") || "")) +
          '<span class="dp-num">' + (isAdr ? "ADR " : "") + (isDg ? "" : n) + "</span>";
        var sa = link(t, html);
        sa.title = title;
        var tt = el("span", "dp-sub-t", title);
        sa.appendChild(tt);
        sli.appendChild(sa);
        ol.appendChild(sli);
      });
      li.appendChild(ol);
    }
    toc.appendChild(li);
  });
  function stickyOffset() { return WIDE.matches || window.innerWidth >= 980 ? 12 : rail.offsetHeight + 8; }
  function jump(target, noHistory) {
    reveal(target);
    var y = target.getBoundingClientRect().top + window.scrollY - stickyOffset();
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    if (!noHistory) try { history.replaceState(null, "", "#" + target.id); } catch (e) {}
  }
  var spyQueued = false;
  function spy() {
    spyQueued = false;
    var line = stickyOffset() + 40, cur = null, curSub = null;
    navLinks.forEach(function (l) {
      var r = l.target.getBoundingClientRect();
      if (r.height === 0) return;
      var isSec = l.target.classList.contains("dp-sec");
      if (r.top <= line) { if (isSec) cur = l; else if (r.bottom > line - 40) curSub = l; }
    });
    navLinks.forEach(function (l) {
      var on = l === cur || l === curSub;
      if (on !== (l.a.getAttribute("aria-current") === "true")) l.a.setAttribute("aria-current", on ? "true" : "false");
    });
    if (cur && window.innerWidth < 980) {
      var a = cur.a, tr = toc.getBoundingClientRect(), ar = a.getBoundingClientRect();
      if (ar.left < tr.left || ar.right > tr.right) toc.scrollLeft += ar.left - tr.left - 24;
    }
  }
  window.addEventListener("scroll", function () { if (!spyQueued) { spyQueued = true; requestAnimationFrame(spy); } }, { passive: true });
  function stepSection(dir) {
    var line = stickyOffset() + 41, i;
    var vis = sections.filter(function (s) { return s.getBoundingClientRect().height > 0; });
    var idx = -1;
    for (i = 0; i < vis.length; i++) if (vis[i].getBoundingClientRect().top <= line) idx = i;
    var t = vis[Math.max(0, Math.min(vis.length - 1, idx + dir))];
    if (t) jump(t);
  }

  // ------------------------------------------------------------ text index
  // Every text node in the main column, grouped by its nearest block, so a
  // match never runs across two paragraphs. Blocks join with "\n" into one
  // global string; comment anchors are offsets into it.
  var BLOCK = /^(P|LI|DIV|H1|H2|H3|H4|H5|H6|PRE|BLOCKQUOTE|TD|TH|FIGURE|SECTION|SUMMARY|DETAILS|UL|OL|LABEL|DT|DD|FIGCAPTION|TEXT|MAIN)$/;
  function blockOf(n) {
    for (var e = n.parentElement; e && e !== main; e = e.parentElement)
      if (BLOCK.test(e.tagName.toUpperCase())) return e;
    return main;
  }
  function buildIndex() {
    var blocks = [], cur = null, text = "", map = new Map();
    var w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || !n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (p.closest("script,style,textarea,select,option,button,.dp-dg-bar,.dp-dg-hint,#dp-hl-add,.dp-q-sum")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      var b = blockOf(n);
      if (!cur || cur.el !== b) {
        if (cur) text += "\n";
        cur = { el: b, gstart: text.length, text: "", nodes: [] };
        blocks.push(cur);
      }
      var ent = { node: n, start: cur.text.length, block: cur };
      cur.nodes.push(ent); map.set(n, ent);
      cur.text += n.nodeValue; text += n.nodeValue;
    }
    return { blocks: blocks, text: text, map: map };
  }
  // A DOM point to a global offset (null if outside the index).
  function offsetOf(idx, node, off) {
    if (node.nodeType === 3) {
      var e = idx.map.get(node);
      return e ? e.block.gstart + e.start + Math.min(off, node.nodeValue.length) : null;
    }
    var child = node.childNodes[off];
    var w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    w.currentNode = child || node;
    var t = child && child.nodeType === 3 ? child : w.nextNode();
    while (t && !idx.map.get(t)) t = w.nextNode();
    if (!t) return idx.text.length;
    var en = idx.map.get(t);
    return en.block.gstart + en.start;
  }
  function blockAt(idx, g) {
    var lo = 0, hi = idx.blocks.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (idx.blocks[mid].gstart <= g) lo = mid; else hi = mid - 1; }
    return idx.blocks[lo];
  }
  function pointIn(b, local, isEnd) {
    for (var i = 0; i < b.nodes.length; i++) {
      var e = b.nodes[i], len = e.node.nodeValue.length;
      if (isEnd ? (local > e.start && local <= e.start + len) : (local >= e.start && local < e.start + len))
        return { node: e.node, off: local - e.start };
    }
    var last = b.nodes[b.nodes.length - 1];
    return { node: last.node, off: last.node.nodeValue.length };
  }
  function rangeIn(b, s, e) {
    var a = pointIn(b, s, false), z = pointIn(b, e, true), r = document.createRange();
    r.setStart(a.node, a.off); r.setEnd(z.node, z.off);
    return r;
  }
  function rangeAt(idx, s, e) {
    var b1 = blockAt(idx, s), b2 = blockAt(idx, Math.max(s, e - 1));
    var a = pointIn(b1, s - b1.gstart, false), z = pointIn(b2, e - b2.gstart, true), r = document.createRange();
    r.setStart(a.node, a.off); r.setEnd(z.node, z.off);
    return r;
  }
  var HL = window.CSS && CSS.highlights && window.Highlight ? CSS.highlights : null;
  function paint(name, ranges) {
    if (!HL) return;
    if (!ranges || !ranges.length) { HL.delete(name); return; }
    var h = new Highlight(); ranges.forEach(function (r) { h.add(r); });
    HL.set(name, h);
  }
  function rangeRect(r) {
    var rs = r.getClientRects();
    for (var i = 0; i < rs.length; i++) if (rs[i].width || rs[i].height) return rs[i];
    return null;
  }
  function labelFor(node) {
    var e = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!e) return "";
    var sec = e.closest(".dp-sec"), parts = [];
    if (sec) parts.push(sec.getAttribute("data-title"));
    var inc = e.closest('.inc[id]'), fig = e.closest("figure.dp-dg");
    if (inc) parts.push(/^adr-/.test(inc.id) ? "ADR " + inc.id.slice(4) : "increment " + inc.id.replace(/^\D+/, ""));
    else if (fig) parts.push("diagram " + fig.id.replace(/^\D+/, ""));
    return parts.join(" \u00B7 ");
  }

  // ------------------------------------------------------------ diagrams
  var dgState = new WeakMap();   // view -> {k, x, y}
  function svgOf(view) { return view.querySelector("svg"); }
  function applyView(view) {
    var s = dgState.get(view) || { k: 1, x: 0, y: 0 }, g = svgOf(view);
    if (!g) return;
    g.style.transform = s.k === 1 && !s.x && !s.y ? "" : "translate(" + s.x + "px," + s.y + "px) scale(" + s.k + ")";
    view.classList.toggle("dp-zoomed", s.k !== 1);
  }
  function zoomAt(st, f, px, py, lo, hi) {
    var k2 = Math.max(lo, Math.min(hi, st.k * f));
    st.x = px - (px - st.x) * (k2 / st.k); st.y = py - (py - st.y) * (k2 / st.k); st.k = k2;
  }
  function panZoom(area, getState, apply, opts) {
    var drag = null;
    area.addEventListener("wheel", function (e) {
      if (!opts.always && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      var st = getState(), r = area.getBoundingClientRect();
      if (!e.ctrlKey && !e.metaKey && opts.always && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.6 && !e.shiftKey) {
        st.x -= e.deltaX; st.y -= e.deltaY; apply(); return;
      }
      zoomAt(st, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX - r.left, e.clientY - r.top, 0.3, 12);
      apply();
    }, { passive: false });
    var g0 = 1;
    area.addEventListener("gesturestart", function (e) { e.preventDefault(); g0 = 1; });
    area.addEventListener("gesturechange", function (e) {
      e.preventDefault();
      var st = getState(), r = area.getBoundingClientRect();
      zoomAt(st, e.scale / g0, e.clientX - r.left, e.clientY - r.top, 0.3, 12); g0 = e.scale; apply();
    });
    area.addEventListener("pointerdown", function (e) {
      var st = getState();
      if (e.button !== 0 || (!opts.always && st.k === 1)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: st.x, sy: st.y };
      area.setPointerCapture(e.pointerId); area.classList.add("dp-drag");
    });
    area.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var st = getState(); st.x = drag.sx + e.clientX - drag.x; st.y = drag.sy + e.clientY - drag.y; apply();
    });
    function end() { drag = null; area.classList.remove("dp-drag"); }
    area.addEventListener("pointerup", end); area.addEventListener("pointercancel", end);
  }
  function activeView(fig) {
    var vs = fig.querySelectorAll(".dp-dg-view");
    for (var i = 0; i < vs.length; i++) if (!vs[i].hidden) return vs[i];
    return vs[0];
  }
  var dgPick = lget(key("dg")) || {};
  function showView(fig, name, quiet) {
    Array.prototype.forEach.call(fig.querySelectorAll(".dp-dg-view"), function (v) { v.hidden = v.getAttribute("data-view") !== name; });
    Array.prototype.forEach.call(fig.querySelectorAll(".dp-dg-tabs button"), function (b) {
      b.setAttribute("aria-selected", b.getAttribute("data-view") === name ? "true" : "false");
    });
    if (!quiet) { dgPick[fig.id] = name; lset(key("dg"), dgPick); }
    if (lb.fig === fig) lbShow(name);
    relayout();
  }
  function setupDiagrams() {
    Array.prototype.forEach.call(main.querySelectorAll("figure.dp-dg"), function (fig) {
      var views = fig.querySelectorAll(".dp-dg-view");
      if (views.length > 1) showView(fig, dgPick[fig.id] || "simple", true);
      Array.prototype.forEach.call(fig.querySelectorAll(".dp-dg-tabs button"), function (b) {
        b.addEventListener("click", function () { showView(fig, b.getAttribute("data-view")); });
      });
      Array.prototype.forEach.call(views, function (v) {
        dgState.set(v, { k: 1, x: 0, y: 0 });
        panZoom(v, function () { return dgState.get(v); }, function () { applyView(v); }, { always: false });
        v.addEventListener("dblclick", function (e) { e.preventDefault(); openLb(fig); });
        var hint = el("span", "dp-dg-hint", "\u2318-scroll or pinch to zoom \u00B7 double-click to enlarge");
        v.appendChild(hint);
      });
      Array.prototype.forEach.call(fig.querySelectorAll(".dp-dg-z"), function (b) {
        b.addEventListener("click", function () {
          var z = b.getAttribute("data-z"), v = activeView(fig), st = dgState.get(v);
          if (z === "full") return openLb(fig);
          if (z === "fit") { st.k = 1; st.x = 0; st.y = 0; }
          else { var r = v.getBoundingClientRect(); zoomAt(st, z === "in" ? 1.25 : 0.8, r.width / 2, r.height / 2, 0.3, 12); }
          applyView(v);
        });
      });
    });
  }

  // The full-screen view borrows the SVG itself (not a copy: mermaid's marker
  // ids would collide) and hands it back on close.
  var lb = { fig: null, svg: null, home: null, style: "", st: { k: 1, x: 0, y: 0 }, back: null };
  var lbEl = el("div"); lbEl.id = "dp-lb"; lbEl.hidden = true;
  lbEl.setAttribute("role", "dialog"); lbEl.setAttribute("aria-modal", "true");
  lbEl.innerHTML = '<div class="dp-lb-box"><div class="dp-lb-bar"><span class="dp-lb-title"></span>' +
    '<span class="dp-lb-tabs dp-dg-tabs" role="tablist"></span><span class="dp-lb-pct"></span>' +
    '<button type="button" class="dp-dg-z" data-l="out" aria-label="zoom out (-)">' + ICON.out + "</button>" +
    '<button type="button" class="dp-dg-z" data-l="in" aria-label="zoom in (+)">' + ICON.in + "</button>" +
    '<button type="button" class="dp-dg-z" data-l="fit" aria-label="fit (0)">' + ICON.fit + "</button>" +
    '<button type="button" class="dp-dg-z" data-l="close" aria-label="close (Esc)">' + ICON.x + "</button>" +
    '</div><div class="dp-lb-stage"></div></div>';
  document.body.appendChild(lbEl);
  var stage = lbEl.querySelector(".dp-lb-stage");
  function lbApply() {
    if (!lb.svg) return;
    lb.svg.style.transform = "translate(" + lb.st.x + "px," + lb.st.y + "px) scale(" + lb.st.k + ")";
    lbEl.querySelector(".dp-lb-pct").textContent = Math.round(lb.st.k * 100) + "%";
  }
  panZoom(stage, function () { return lb.st; }, lbApply, { always: true });
  function lbReturn() {
    if (!lb.svg) return;
    lb.svg.setAttribute("style", lb.style);
    lb.home.appendChild(lb.svg);
    applyView(lb.home.closest(".dp-dg-view"));
    lb.svg = null;
  }
  function lbShow(name) {
    lbReturn();
    var v = lb.fig.querySelector('.dp-dg-view[data-view="' + name + '"]') || activeView(lb.fig);
    var g = svgOf(v);
    Array.prototype.forEach.call(lbEl.querySelectorAll(".dp-lb-tabs button"), function (b) {
      b.setAttribute("aria-selected", b.getAttribute("data-view") === v.getAttribute("data-view") ? "true" : "false");
    });
    if (!g) return;
    lb.home = g.parentNode; lb.style = g.getAttribute("style") || ""; lb.svg = g;
    g.setAttribute("style", "");
    stage.appendChild(g);
    lb.st = { k: 1, x: 0, y: 0 }; lbApply();
  }
  function openLb(fig) {
    lb.back = document.activeElement; lb.fig = fig;
    lbEl.querySelector(".dp-lb-title").textContent = textOf(fig.querySelector("h3"));
    var tabs = lbEl.querySelector(".dp-lb-tabs"); tabs.innerHTML = "";
    var src = fig.querySelectorAll(".dp-dg-tabs button");
    Array.prototype.forEach.call(src, function (b) {
      var c = b.cloneNode(true);
      c.addEventListener("click", function () { showView(fig, c.getAttribute("data-view")); });
      tabs.appendChild(c);
    });
    tabs.hidden = !src.length;
    lbEl.hidden = false; document.body.classList.add("dp-lb-open");
    lbShow(activeView(fig).getAttribute("data-view"));
    lbEl.querySelector('[data-l="close"]').focus();
  }
  function closeLb() {
    if (lbEl.hidden) return;
    lbReturn(); lbEl.hidden = true; lb.fig = null; document.body.classList.remove("dp-lb-open");
    if (lb.back && lb.back.focus) lb.back.focus();
  }
  lbEl.addEventListener("click", function (e) {
    if (e.target === lbEl) return closeLb();
    var b = e.target.closest && e.target.closest("[data-l]");
    if (!b) return;
    var l = b.getAttribute("data-l"), r = stage.getBoundingClientRect();
    if (l === "close") return closeLb();
    if (l === "fit") lb.st = { k: 1, x: 0, y: 0 };
    else zoomAt(lb.st, l === "in" ? 1.3 : 0.77, r.width / 2, r.height / 2, 0.3, 12);
    lbApply();
  });
  lbEl.addEventListener("keydown", function (e) {
    var r = stage.getBoundingClientRect(), k = e.key;
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); return closeLb(); }
    if (k === "+" || k === "=") zoomAt(lb.st, 1.3, r.width / 2, r.height / 2, 0.3, 12);
    else if (k === "-" || k === "_") zoomAt(lb.st, 0.77, r.width / 2, r.height / 2, 0.3, 12);
    else if (k === "0") lb.st = { k: 1, x: 0, y: 0 };
    else if (k === "ArrowLeft") lb.st.x += 60; else if (k === "ArrowRight") lb.st.x -= 60;
    else if (k === "ArrowUp") lb.st.y += 60; else if (k === "ArrowDown") lb.st.y -= 60;
    else if (k === "Tab") {
      var f = lbEl.querySelectorAll("button:not([hidden])"), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    } else return;
    e.preventDefault(); lbApply();
  });

  // ------------------------------------------------------------ find
  var F = { opts: lget("dp-find-opts") || { c: false, w: false, r: false, z: false }, hits: [], cur: -1, list: lget("dp-find-list") !== false, timer: 0 };
  var fEl = el("div"); fEl.id = "dp-find"; fEl.hidden = true; fEl.setAttribute("role", "search");
  fEl.innerHTML = '<div class="dp-f-row">' +
    '<input id="dp-f-q" type="text" placeholder="Find" aria-label="find in plan" spellcheck="false" autocomplete="off">' +
    '<button type="button" class="dp-f-opt" data-o="c" title="Match case (Alt+C)" aria-label="match case">Aa</button>' +
    '<button type="button" class="dp-f-opt" data-o="w" title="Match whole word (Alt+W)" aria-label="match whole word">ab</button>' +
    '<button type="button" class="dp-f-opt" data-o="r" title="Use regular expression (Alt+R)" aria-label="regular expression">.*</button>' +
    '<button type="button" class="dp-f-opt" data-o="z" title="Fuzzy match, ranked (Alt+Z)" aria-label="fuzzy match">~</button>' +
    '<span id="dp-f-n" role="status" aria-live="polite"></span>' +
    '<button type="button" class="dp-f-btn" data-f="prev" title="Previous match (Shift+Enter)" aria-label="previous match">' + ICON.up + "</button>" +
    '<button type="button" class="dp-f-btn" data-f="next" title="Next match (Enter)" aria-label="next match">' + ICON.down + "</button>" +
    '<button type="button" class="dp-f-opt" data-f="list" title="Show results list" aria-label="results list">' + ICON.list + "</button>" +
    '<button type="button" class="dp-f-btn" data-f="close" title="Close (Esc)" aria-label="close find">' + ICON.x + "</button>" +
    '</div><div id="dp-f-err" hidden></div><ol id="dp-f-list" role="listbox" hidden></ol>';
  document.body.appendChild(fEl);
  var ticks = el("div"); ticks.id = "dp-f-ticks"; ticks.setAttribute("aria-hidden", "true");
  document.body.appendChild(ticks);
  var fq = fEl.querySelector("#dp-f-q"), fn = fEl.querySelector("#dp-f-n"),
      ferr = fEl.querySelector("#dp-f-err"), flist = fEl.querySelector("#dp-f-list");
  function syncOpts() {
    Array.prototype.forEach.call(fEl.querySelectorAll("[data-o]"), function (b) {
      b.setAttribute("aria-pressed", F.opts[b.getAttribute("data-o")] ? "true" : "false");
    });
    fEl.querySelector('[data-f="list"]').setAttribute("aria-pressed", F.list ? "true" : "false");
  }
  syncOpts();
  function toggleOpt(o) {
    F.opts[o] = !F.opts[o];
    if (o === "z" && F.opts.z) { F.opts.r = false; F.opts.w = false; }
    if ((o === "r" || o === "w") && F.opts[o]) F.opts.z = false;
    lset("dp-find-opts", F.opts); syncOpts(); search();
  }
  function placeFind() { fEl.style.top = (window.innerWidth < 980 ? rail.offsetHeight + 8 : 10) + "px"; }
  function openFind() {
    placeFind(); fEl.hidden = false;
    var sel = String(window.getSelection() || "").trim();
    if (sel && sel.length < 80 && sel.indexOf("\n") < 0) fq.value = sel;
    fq.focus(); fq.select(); search();
  }
  function closeFind() {
    fEl.hidden = true; paint("dp-find", null); paint("dp-find-cur", null);
    ticks.innerHTML = ""; F.hits = []; F.cur = -1;
  }
  function escRe(s) { return s.replace(/[.*+?^()|[\]{}\\$]/g, "\\$&"); }
  // fzf-style: per token, a subsequence match tightened from its end, scored
  // for consecutive runs and word starts; a match spread too thin is no match.
  function fuzzyTok(T, tok) {
    var m = tok.length, best = null, tries = 0;
    for (var i = T.indexOf(tok[0]); i >= 0 && tries < 40; i = T.indexOf(tok[0], i + 1), tries++) {
      var j = i, k = 0, end = -1;
      while (j < T.length && k < m) { if (T[j] === tok[k]) { k++; end = j; } j++; }
      if (k < m) break;
      var pos = new Array(m); k = m - 1;
      for (j = end; j >= i && k >= 0; j--) if (T[j] === tok[k]) pos[k--] = j;
      var span = end - pos[0] + 1;
      if (span > m * 2 + 2) continue;
      var sc = m * 10 - (span - m) * 3;
      for (var q = 0; q < m; q++) {
        var p = pos[q];
        if (p === 0 || /[^a-z0-9]/i.test(T[p - 1])) sc += q === 0 ? 10 : 5;
        if (q && pos[q - 1] === p - 1) sc += 6;
      }
      if (!best || sc > best.sc) best = { sc: sc, pos: pos };
    }
    return best;
  }
  function spansOf(pos) {
    var out = [], s = pos[0], e = pos[0] + 1;
    for (var i = 1; i < pos.length; i++) {
      if (pos[i] === e) e++; else { out.push([s, e]); s = pos[i]; e = pos[i] + 1; }
    }
    out.push([s, e]);
    return out;
  }
  function search() {
    clearTimeout(F.timer);
    var q = fq.value;
    ferr.hidden = true; fq.classList.remove("dp-f-bad");
    F.hits = []; F.cur = -1;
    if (!q) { paint("dp-find", null); paint("dp-find-cur", null); fn.textContent = ""; flist.hidden = true; ticks.innerHTML = ""; return; }
    var idx = buildIndex(), hits = [];
    if (F.opts.z) {
      var toks = (F.opts.c ? q : q.toLowerCase()).split(/\s+/).filter(Boolean);
      idx.blocks.forEach(function (b) {
        var T = F.opts.c ? b.text : b.text.toLowerCase(), total = 0, spans = [];
        for (var i = 0; i < toks.length; i++) {
          var r = fuzzyTok(T, toks[i]);
          if (!r) return;
          total += r.sc; spans = spans.concat(spansOf(r.pos));
        }
        if (/^H[1-4]$|^SUMMARY$/.test(b.el.tagName)) total += 8;
        total -= Math.min(10, b.text.length / 200);
        spans.sort(function (a, z) { return a[0] - z[0]; });
        hits.push({ b: b, spans: spans, sc: total });
      });
      hits.sort(function (a, z) { return z.sc - a.sc || a.b.gstart - z.b.gstart; });
      hits = hits.slice(0, 200);
    } else {
      var src = F.opts.r ? q : escRe(q), re;
      if (F.opts.w) src = "\\b(?:" + src + ")\\b";
      try { re = new RegExp(src, "gm" + (F.opts.c ? "" : "i")); }
      catch (e) { fq.classList.add("dp-f-bad"); ferr.textContent = String(e.message || e); ferr.hidden = false; fn.textContent = "invalid"; flist.hidden = true; return; }
      for (var bi = 0; bi < idx.blocks.length && hits.length < 2000; bi++) {
        var b = idx.blocks[bi], m;
        re.lastIndex = 0;
        while ((m = re.exec(b.text)) && hits.length < 2000) {
          if (!m[0].length) { re.lastIndex++; continue; }
          hits.push({ b: b, spans: [[m.index, m.index + m[0].length]] });
        }
      }
    }
    hits.forEach(function (h) { h.ranges = h.spans.map(function (s) { return rangeIn(h.b, s[0], s[1]); }); });
    F.hits = hits;
    var all = [];
    hits.forEach(function (h) { all = all.concat(h.ranges); });
    paint("dp-find", all);
    renderList();
    drawTicks();
    if (hits.length) go(firstAfterView(), true); else { paint("dp-find-cur", null); fn.textContent = "No results"; }
  }
  function firstAfterView() {
    if (F.opts.z) return 0;
    for (var i = 0; i < F.hits.length; i++) {
      var r = rangeRect(F.hits[i].ranges[0]);
      if (r && r.top >= stickyOffset()) return i;
    }
    return 0;
  }
  function go(i, soft) {
    if (!F.hits.length) return;
    F.cur = (i + F.hits.length) % F.hits.length;
    var h = F.hits[F.cur];
    reveal(h.b.el);
    paint("dp-find-cur", h.ranges);
    var r = rangeRect(h.ranges[0]);
    if (r && (!soft || r.top < stickyOffset() || r.bottom > window.innerHeight - 20))
      window.scrollTo({ top: Math.max(0, r.top + window.scrollY - window.innerHeight / 3) });
    fn.textContent = (F.cur + 1) + " of " + F.hits.length + (F.hits.length >= 2000 ? "+" : "");
    Array.prototype.forEach.call(flist.children, function (li, k) {
      var on = k === F.cur;
      li.setAttribute("aria-selected", on ? "true" : "false");
      if (on && !flist.hidden) {
        var lr = li.getBoundingClientRect(), fr = flist.getBoundingClientRect();
        if (lr.top < fr.top || lr.bottom > fr.bottom) flist.scrollTop += lr.top - fr.top - 40;
      }
    });
    drawTicks();
  }
  function renderList() {
    flist.innerHTML = "";
    flist.hidden = !F.list || !F.hits.length;
    if (flist.hidden) return;
    F.hits.slice(0, 300).forEach(function (h, k) {
      var li = el("li"); li.setAttribute("role", "option");
      li.appendChild(el("span", "where", labelFor(h.b.el) || "plan"));
      var t = h.b.text, a = Math.max(0, h.spans[0][0] - 40), z = Math.min(t.length, h.spans[h.spans.length - 1][1] + 60);
      if (a > 0) li.appendChild(document.createTextNode("\u2026"));
      var at = a;
      h.spans.forEach(function (s) {
        if (s[0] < at || s[1] > z) return;
        li.appendChild(document.createTextNode(t.slice(at, s[0])));
        li.appendChild(el("mark", "", t.slice(s[0], s[1])));
        at = s[1];
      });
      li.appendChild(document.createTextNode(t.slice(at, z) + (z < t.length ? "\u2026" : "")));
      li.addEventListener("mousedown", function (e) { e.preventDefault(); go(k); });
      flist.appendChild(li);
    });
  }
  function drawTicks() {
    ticks.innerHTML = "";
    var H = document.documentElement.scrollHeight, vh = window.innerHeight;
    F.hits.slice(0, 400).forEach(function (h, k) {
      var r = rangeRect(h.ranges[0]);
      if (!r) return;
      var i = el("i", k === F.cur ? "cur" : "");
      i.style.top = Math.round((r.top + window.scrollY) / H * (vh - 3)) + "px";
      ticks.appendChild(i);
    });
  }
  fq.addEventListener("input", function () { clearTimeout(F.timer); F.timer = setTimeout(search, 70); });
  fq.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); go(F.cur + (e.shiftKey ? -1 : 1)); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
    else if (e.key === "ArrowDown" && !flist.hidden) { e.preventDefault(); go(F.cur + 1); }
    else if (e.key === "ArrowUp" && !flist.hidden) { e.preventDefault(); go(F.cur - 1); }
    else if (e.altKey && { KeyC: "c", KeyW: "w", KeyR: "r", KeyZ: "z" }[e.code]) {
      e.preventDefault(); toggleOpt({ KeyC: "c", KeyW: "w", KeyR: "r", KeyZ: "z" }[e.code]);
    }
  });
  fEl.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-o")) toggleOpt(b.getAttribute("data-o"));
    var f = b.getAttribute("data-f");
    if (f === "next") go(F.cur + 1);
    else if (f === "prev") go(F.cur - 1);
    else if (f === "close") closeFind();
    else if (f === "list") { F.list = !F.list; lset("dp-find-list", F.list); syncOpts(); renderList(); go(Math.max(0, F.cur), true); }
    if (f !== "close") fq.focus();
  });

  // ------------------------------------------------------------ comments
  // A comment is an excerpt plus offsets into the index, with a little text
  // either side so it re-anchors after a re-render moves things around. Its
  // card is a .dp-note textarea like every other box, so each page's own copy
  // button carries it with no extra wiring.
  var notes = [];
  var quotes = document.getElementById("dp-quotes");
  var summary = null;
  if (quotes) { summary = el("ol", "dp-q-sum"); quotes.parentNode.insertBefore(summary, quotes); }
  var openNote = null;
  function excerptOf(t) { t = t.replace(/\s+/g, " ").trim(); return t.length > 120 ? t.slice(0, 117) + "\u2026" : t; }
  function saveNotes() {
    lset(key("hl"), notes.filter(function (c) { return c.text.trim(); }).map(function (c) {
      return { id: c.id, quote: c.quote, prefix: c.prefix, suffix: c.suffix, at: c.at, text: c.text, label: c.label };
    }));
  }
  function cardFor(c) {
    var card = el("div", "dp-quote"); card.setAttribute("data-id", c.id);
    var jumpB = el("button", "dp-q-jump", "\u201C" + excerptOf(c.quote) + "\u201D");
    jumpB.type = "button"; jumpB.title = "show where this comment was left";
    jumpB.addEventListener("click", function () { showNote(c, false); });
    var ta = document.createElement("textarea");
    ta.className = "dp-note"; ta.rows = 1;
    ta.placeholder = "comment on the highlighted text";
    ta.setAttribute("aria-label", "comment on \u201C" + excerptOf(c.quote) + "\u201D");
    ta.setAttribute("data-section", (c.label ? c.label + " \u00B7 " : "") + 'on "' + excerptOf(c.quote) + '"');
    ta.value = c.text;
    var foot = el("div", "dp-q-foot");
    foot.appendChild(el("span", "", c.label || ""));
    var rm = el("button", "dp-x", "\u00D7"); rm.type = "button";
    rm.setAttribute("aria-label", "remove this comment");
    rm.addEventListener("click", function () { removeNote(c); });
    foot.appendChild(rm);
    card.appendChild(jumpB); card.appendChild(ta); card.appendChild(foot);
    function grow() { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
    ta.addEventListener("input", function () { c.text = ta.value; grow(); saveNotes(); refreshCounts(); layoutNotes(); });
    ta.addEventListener("focus", function () { setActive(c); });
    ta.addEventListener("blur", function () {
      setTimeout(function () {
        if (!c.text.trim() && document.activeElement !== ta) removeNote(c);
        else if (!card.contains(document.activeElement)) setActive(null);
      }, 150);
    });
    c.card = card; c.ta = ta; c.grow = grow;
    if (c.range) {
      var dot = el("button", "dp-dot"); dot.type = "button";
      dot.setAttribute("aria-label", "open the comment on \u201C" + excerptOf(c.quote) + "\u201D");
      dot.addEventListener("click", function () { showNote(c, true); });
      c.dot = dot; margin.appendChild(dot); margin.appendChild(card);
    } else {
      card.classList.add("dp-q-orphan");
      foot.firstChild.textContent = "the text this was pinned to has changed" + (c.label ? " \u00B7 " + c.label : "");
      if (quotes) quotes.appendChild(card); else margin.appendChild(card);
    }
    setTimeout(grow, 0);
  }
  function removeNote(c) {
    notes = notes.filter(function (x) { return x !== c; });
    if (c.card) c.card.remove();
    if (c.dot) c.dot.remove();
    if (openNote === c) openNote = null;
    saveNotes(); paintNotes(); refreshCounts(); layoutNotes();
  }
  function paintNotes() {
    paint("dp-note", notes.filter(function (c) { return c.range; }).map(function (c) { return c.range; }));
  }
  function setActive(c) {
    notes.forEach(function (x) { if (x.card) x.card.classList.toggle("dp-on", x === c); });
    paint("dp-note-on", c && c.range ? [c.range] : null);
  }
  function showNote(c, focus) {
    if (c.range) {
      reveal(c.range.startContainer);
      var r = rangeRect(c.range);
      if (r && (r.top < stickyOffset() || r.bottom > window.innerHeight - 80))
        window.scrollTo({ top: Math.max(0, r.top + window.scrollY - window.innerHeight / 3), behavior: "smooth" });
    }
    if (!WIDE.matches && c.range) { openNote = c; layoutNotes(); }
    setActive(c);
    if (focus !== false) setTimeout(function () { c.ta.focus({ preventScroll: true }); }, focus === true ? 0 : 250);
  }
  function closePopover() { if (openNote) { openNote = null; layoutNotes(); setActive(null); } }
  var layoutQueued = false;
  function relayout() { if (!layoutQueued) { layoutQueued = true; requestAnimationFrame(function () { layoutQueued = false; layoutNotes(); spy(); }); } }
  function layoutNotes() {
    var base = margin.getBoundingClientRect(), wide = WIDE.matches;
    var items = [];
    notes.forEach(function (c) {
      if (!c.range || !c.card) return;
      var r = rangeRect(c.range);
      c.card.classList.toggle("dp-q-hidden", !r);
      if (c.dot) c.dot.style.display = r && !wide ? "" : "none";
      if (r) items.push({ c: c, r: r });
    });
    if (wide) {
      items.sort(function (a, z) { return a.r.top - z.r.top; });
      var y = 0;
      items.forEach(function (it) {
        var t = Math.max(it.r.top - base.top, y);
        it.c.card.style.top = t + "px"; it.c.card.style.left = "";
        y = t + it.c.card.offsetHeight + 8;
      });
      margin.style.minHeight = y + "px";
      return;
    }
    margin.style.minHeight = "";
    var mainR = main.getBoundingClientRect();
    items.forEach(function (it) {
      var c = it.c, open = c === openNote;
      c.card.classList.toggle("dp-open", open);
      c.dot.style.top = (it.r.top - base.top + it.r.height / 2 - 7) + "px";
      c.dot.style.left = (Math.min(mainR.right, base.right) - base.left - 14) + "px";
      if (open) {
        var w = c.card.offsetWidth || 320;
        c.card.style.top = (it.r.bottom - base.top + 8) + "px";
        c.card.style.left = Math.max(8, Math.min(it.r.left - base.left, base.width - w - 8)) + "px";
      }
    });
  }
  function refreshCounts() {
    var per = {};
    notes.forEach(function (c) {
      if (!c.text.trim() && c !== openNote) return;
      var s = c.range && c.range.startContainer.parentElement && c.range.startContainer.parentElement.closest(".dp-sec");
      if (s) per[s.id] = (per[s.id] || 0) + 1;
    });
    Array.prototype.forEach.call(main.querySelectorAll(".dp-sec textarea.dp-note"), function (t) {
      if (!t.value.trim()) return;
      var s = t.closest(".dp-sec"); per[s.id] = (per[s.id] || 0) + 1;
    });
    Object.keys(badges).forEach(function (id) {
      var b = badges[id]; b.hidden = !per[id]; b.textContent = per[id] || "";
      b.title = per[id] ? per[id] + " comment" + (per[id] === 1 ? "" : "s") : "";
    });
    if (summary) {
      summary.innerHTML = "";
      notes.filter(function (c) { return c.range && c.text.trim(); }).sort(function (a, z) { return a.at - z.at; }).forEach(function (c) {
        var li = el("li");
        li.appendChild(el("span", "where", c.label || "plan"));
        var w = el("span", "what");
        w.appendChild(el("q", "", excerptOf(c.quote).slice(0, 60)));
        w.appendChild(document.createTextNode(" " + c.text.trim()));
        li.appendChild(w);
        li.addEventListener("click", function () { showNote(c); });
        summary.appendChild(li);
      });
    }
  }
  function addNote(c) { notes.push(c); cardFor(c); }
  function resolveNote(idx, saved) {
    var hits = [], i = idx.text.indexOf(saved.quote);
    while (i >= 0 && hits.length < 60) { hits.push(i); i = idx.text.indexOf(saved.quote, i + 1); }
    if (!hits.length) return null;
    var best = -1, bestSc = -1e9;
    hits.forEach(function (h) {
      var sc = 0, pre = idx.text.slice(Math.max(0, h - saved.prefix.length), h), suf = idx.text.slice(h + saved.quote.length, h + saved.quote.length + saved.suffix.length);
      for (var k = 1; k <= pre.length && pre[pre.length - k] === saved.prefix[saved.prefix.length - k]; k++) sc++;
      for (k = 0; k < suf.length && suf[k] === saved.suffix[k]; k++) sc++;
      sc -= Math.abs(h - (saved.at || 0)) / 5000;
      if (sc > bestSc) { bestSc = sc; best = h; }
    });
    return best;
  }
  function loadNotes() {
    var saved = lget(key("hl")) || [], idx = buildIndex();
    saved.forEach(function (s) {
      var at = resolveNote(idx, s);
      var c = { id: s.id, quote: s.quote, prefix: s.prefix || "", suffix: s.suffix || "", at: at == null ? s.at : at, text: s.text || "", label: s.label || "" };
      if (at != null) { c.range = rangeAt(idx, at, at + s.quote.length); c.label = labelFor(c.range.startContainer) || c.label; }
      addNote(c);
    });
    paintNotes(); refreshCounts(); layoutNotes();
  }
  // Highlight-to-comment: select any text (mouse or keyboard), a chip
  // appears, and clicking it — or Cmd/Ctrl+M — pins a comment there.
  var chip = el("button"); chip.id = "dp-hl-add"; chip.type = "button";
  chip.innerHTML = ICON.note + "<span>comment</span>";
  chip.setAttribute("aria-label", "pin a comment to the highlighted text (or press Cmd/Ctrl+M)");
  chip.style.display = "none";
  document.body.appendChild(chip);
  function selInMain(sel) {
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var r = sel.getRangeAt(0), a = r.commonAncestorContainer;
    var e = a.nodeType === 1 ? a : a.parentElement;
    if (!main.contains(a) || (e && e.closest("textarea,input,select,button,.dp-dg-bar"))) return null;
    return r;
  }
  function placeChip() {
    var sel = window.getSelection();
    var txt = sel ? String(sel).trim() : "";
    if (!txt || !selInMain(sel) || chip.contains(sel.anchorNode)) { chip.style.display = "none"; return; }
    var r = sel.getRangeAt(0).getBoundingClientRect();
    // Measure first, then clamp inside the viewport: a selection ending near
    // the right margin used to push the chip clean off the page.
    chip.style.visibility = "hidden"; chip.style.display = "block";
    var w = chip.offsetWidth, h = chip.offsetHeight;
    var x = Math.max(8, Math.min(r.right + 6, document.documentElement.clientWidth - w - 8));
    var y = r.top - h - 6;
    if (y < stickyOffset()) y = r.bottom + 6;
    chip.style.left = (window.scrollX + x) + "px";
    chip.style.top = (window.scrollY + y) + "px";
    chip.style.visibility = "visible";
  }
  document.addEventListener("mouseup", function () { setTimeout(placeChip, 0); });
  document.addEventListener("keyup", function (e) {
    // Keyboard selection (Shift+arrows / Shift+Cmd+arrows) surfaces the chip too.
    if (e.key === "Shift" || e.shiftKey) setTimeout(placeChip, 0);
  });
  function pinComment() {
    var sel = window.getSelection(), r = selInMain(sel);
    if (!r || !String(sel).trim()) return;
    var idx = buildIndex();
    var s = offsetOf(idx, r.startContainer, r.startOffset), e = offsetOf(idx, r.endContainer, r.endOffset);
    if (s == null || e == null || e <= s) return;
    while (s < e && /\s/.test(idx.text[s])) s++;
    while (e > s && /\s/.test(idx.text[e - 1])) e--;
    if (e <= s) return;
    var c = { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), quote: idx.text.slice(s, e),
      prefix: idx.text.slice(Math.max(0, s - 32), s), suffix: idx.text.slice(e, e + 32), at: s, text: "" };
    c.range = rangeAt(idx, s, e);
    c.label = labelFor(c.range.startContainer);
    addNote(c);
    chip.style.display = "none";
    sel.removeAllRanges();
    paintNotes(); layoutNotes(); refreshCounts();
    showNote(c, true);
  }
  chip.addEventListener("mousedown", function (e) { e.preventDefault(); pinComment(); });
  chip.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pinComment(); }
  });
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) { var p = document.caretPositionFromPoint(x, y); return p && { node: p.offsetNode, off: p.offset }; }
    if (document.caretRangeFromPoint) { var r = document.caretRangeFromPoint(x, y); return r && { node: r.startContainer, off: r.startOffset }; }
    return null;
  }
  main.addEventListener("click", function (e) {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    var p = caretAt(e.clientX, e.clientY);
    if (!p) return;
    for (var i = 0; i < notes.length; i++) {
      var c = notes[i];
      try { if (c.range && c.range.isPointInRange(p.node, p.off) && c.range.toString().length) { showNote(c, true); return; } } catch (er) {}
    }
  });
  document.addEventListener("mousedown", function (e) {
    if (!openNote || WIDE.matches) return;
    if (openNote.card.contains(e.target) || (openNote.dot && openNote.dot.contains(e.target))) return;
    setTimeout(function () { if (!openNote || !openNote.card.contains(document.activeElement)) closePopover(); }, 0);
  });
  if (WIDE.addEventListener) WIDE.addEventListener("change", function () { openNote = null; relayout(); });
  window.addEventListener("resize", relayout);
  document.addEventListener("toggle", relayout, true);
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(main);

  // ------------------------------------------------------------ drafts
  // Every box, pick and edit on the page is kept per plan and per surface, so
  // the working page's auto-refresh (or a theme switch) loses nothing.
  var drafts = lget(key("drafts")) || {};
  function fieldKey(f) {
    if (f.closest(".dp-quote") || f.closest("#dp-find")) return null;
    if (f.type === "radio") return "radio:" + f.name;
    if (f.classList.contains("dp-note")) return "note:" + f.getAttribute("data-section");
    if (f.classList.contains("dp-adr-field")) return "adr:" + f.getAttribute("data-n") + ":" + f.getAttribute("data-field");
    var risk = f.closest(".dp-risk");
    if (risk) return "risk:" + risk.getAttribute("data-n") + ":" + f.className;
    return null;
  }
  function keepField(e) {
    var f = e.target, k = f && f.closest && fieldKey(f);
    lastInput = Date.now();
    if (!k) return;
    if (f.type === "radio") { if (f.checked) drafts[k] = f.value; }
    else drafts[k] = f.value;
    lset(key("drafts"), drafts);
    if (f.classList.contains("dp-note")) refreshCounts();
  }
  document.addEventListener("input", keepField, true);
  document.addEventListener("change", keepField, true);
  Array.prototype.forEach.call(main.querySelectorAll("input,textarea,select"), function (f) {
    var k = fieldKey(f);
    if (!k || !(k in drafts)) return;
    if (f.type === "radio") {
      if (f.value !== drafts[k]) return;
      f.checked = true;
      f.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (f.value !== drafts[k]) {
      f.value = drafts[k];
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  var copyBtn = document.getElementById("dp-copyback") || document.getElementById("dp-amend-copy");
  if (copyBtn) {
    var clr = el("button", "", "clear drafts"); clr.id = "dp-clear"; clr.type = "button";
    clr.title = "forget every comment, pick and edit kept for this page";
    var armed = 0;
    clr.addEventListener("click", function () {
      if (!armed) { armed = setTimeout(function () { armed = 0; clr.classList.remove("sure"); clr.textContent = "clear drafts"; }, 3000); clr.classList.add("sure"); clr.textContent = "clear all? click again"; return; }
      clearTimeout(armed); armed = 0;
      drafts = {}; lset(key("drafts"), null);
      notes.slice().forEach(removeNote); lset(key("hl"), null);
      Array.prototype.forEach.call(main.querySelectorAll("input,textarea,select"), function (f) {
        if (!fieldKey(f)) return;
        if (f.type === "radio" || f.type === "checkbox") f.checked = f.defaultChecked;
        else if (f.tagName === "SELECT") Array.prototype.forEach.call(f.options, function (o) { o.selected = o.defaultSelected; });
        else f.value = f.defaultValue;
        f.dispatchEvent(new Event("change", { bubbles: true }));
      });
      clr.classList.remove("sure"); clr.textContent = "cleared";
      setTimeout(function () { clr.textContent = "clear drafts"; }, 1500);
      refreshCounts();
    });
    copyBtn.parentNode.insertBefore(clr, copyBtn.nextSibling);
  }
  // Auto-refresh asks before it reloads: not while someone is typing or has a
  // comment open.
  window.dpBusy = function () {
    var a = document.activeElement;
    return Date.now() - lastInput < 8000 || !!openNote || !lbEl.hidden || (!fEl.hidden && fEl.contains(a)) ||
      !!(a && editable(a) && a.value);
  };

  // ------------------------------------------------------------ help + keys
  var help = el("div"); help.id = "dp-help"; help.hidden = true;
  help.setAttribute("role", "dialog"); help.setAttribute("aria-label", "keyboard shortcuts");
  help.innerHTML = '<div class="dp-help-box"><h3>Move</h3><dl>' +
    "<dt>[ / ]</dt><dd>previous / next section</dd><dt>click a heading\u2019s caret</dt><dd>fold the section</dd></dl>" +
    "<h3>Find</h3><dl><dt>\u2318F or /</dt><dd>open find</dd><dt>Enter / \u21E7Enter</dt><dd>next / previous match</dd>" +
    "<dt>Alt+C W R Z</dt><dd>match case, whole word, regex, fuzzy</dd><dt>Esc</dt><dd>close</dd></dl>" +
    "<h3>Comment</h3><dl><dt>select text, then \u2318M</dt><dd>pin a comment there (or click the chip)</dd>" +
    "<dt>click highlighted text</dt><dd>edit the comment left on it</dd></dl>" +
    "<h3>Diagrams</h3><dl><dt>\u2318-scroll or pinch</dt><dd>zoom</dd><dt>drag</dt><dd>pan once zoomed</dd>" +
    "<dt>double-click</dt><dd>enlarge; then + \u2212 0 and arrows</dd></dl></div>";
  document.body.appendChild(help);
  function toggleHelp(on) { help.hidden = !on; }
  help.addEventListener("click", function (e) { if (e.target === help) toggleHelp(false); });
  document.addEventListener("keydown", function (e) {
    var t = e.target, mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "f" || e.key === "F") && !e.shiftKey && !e.altKey) { e.preventDefault(); return openFind(); }
    if (mod && (e.key === "g" || e.key === "G") && F.hits.length) { e.preventDefault(); return go(F.cur + (e.shiftKey ? -1 : 1)); }
    if (mod && (e.key === "m" || e.key === "M")) { e.preventDefault(); return pinComment(); }
    if (e.key === "Escape") {
      if (!help.hidden) return toggleHelp(false);
      if (!fEl.hidden) return closeFind();
      if (openNote) return closePopover();
    }
    if (mod || e.altKey || editable(t)) return;
    if (e.key === "/") { e.preventDefault(); openFind(); }
    else if (e.key === "?") { e.preventDefault(); toggleHelp(help.hidden); }
    else if (e.key === "]") { e.preventDefault(); stepSection(1); }
    else if (e.key === "[") { e.preventDefault(); stepSection(-1); }
  });

  // ------------------------------------------------------------ boot
  // Mermaid draws in this palette (read from the page's own tokens), then the
  // diagrams get their controls, comments re-anchor, and a reload lands where
  // the reader was.
  var SCROLL = "dp-scroll:" + location.pathname;
  function keepScroll() { if (SS) jset(SS, SCROLL, { y: window.scrollY, t: Date.now() }); }
  window.addEventListener("pagehide", keepScroll);
  window.addEventListener("beforeunload", keepScroll);
  function restoreScroll() {
    var s = SS ? jget(SS, SCROLL) : null;
    if (location.hash && !s) {
      var t = document.getElementById(location.hash.slice(1));
      if (t) jump(t, true);
    } else if (s && Date.now() - s.t < 30 * 60 * 1000) window.scrollTo(0, s.y);
  }
  function ready() {
    setupDiagrams(); loadNotes(); restoreScroll(); spy(); refreshCounts();
  }
  var css = getComputedStyle(document.documentElement);
  function v(n) { return css.getPropertyValue(n).trim(); }
  var M = window.mermaid;
  if (!M || !main.querySelector("pre.mermaid")) return ready();
  try {
    M.initialize({ startOnLoad: false, theme: "base", themeVariables: {
      darkMode: document.documentElement.getAttribute("data-theme")==="light" ? false : true,
      fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif", fontSize: "14px",
      background: v("--card2"), primaryColor: v("--card3"), primaryTextColor: v("--fg"), primaryBorderColor: v("--line2"),
      secondaryColor: v("--card"), secondaryTextColor: v("--fg"), secondaryBorderColor: v("--line2"),
      tertiaryColor: v("--card2"), tertiaryTextColor: v("--fg"), tertiaryBorderColor: v("--line2"),
      lineColor: v("--dim"), textColor: v("--fg"), mainBkg: v("--card3"), nodeBorder: v("--line2"),
      clusterBkg: v("--card"), clusterBorder: v("--line2"), titleColor: v("--fg"), edgeLabelBackground: v("--card2"),
      noteBkgColor: v("--card"), noteTextColor: v("--fg"), noteBorderColor: v("--mark"),
      actorBkg: v("--card3"), actorBorder: v("--line2"), actorTextColor: v("--fg"), signalColor: v("--dim"), signalTextColor: v("--fg")
    } });
    Promise.resolve(M.run({ querySelector: "#dp-main pre.mermaid", suppressErrors: true }))
      .catch(function () {}).then(ready);
  } catch (e) { ready(); }
})();
</script>`;
