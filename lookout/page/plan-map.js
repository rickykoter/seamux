// The End state map: a plan's files in three lanes (used by | the plan | uses),
// drawn as SVG from the model deep-plan's lib/map.mjs stores in st.map.
//
// This is the one source. tools/map_sync.py copies it byte for byte into
// deep-plan/lib/plan-map.js and lookout/page/plan-map.js (plugins cannot
// import across their roots, ADR 0004); edit here and run the sync.
//
// It builds every node with DOM calls and carries its own styles, so a page
// only has to load it and call
//
//   PlanMap.mount(el, model, {
//     increments: [{ n, title, status }],  // chips; a status tints the pips
//     status: card => "ok" | "miss" | "extra" | "",  // lookout's compare
//     extra: [card],                        // cards the plan never named
//     groups: cards => [[label, cards]],    // the plan lane's sections
//     onOpen: path => {},                   // a second click on a card, or its panel button
//     canOpen: card => true,                // whether that card can be opened
//     openLabel: "Open",                    // the panel button's words
//     keep: {},                             // the reader's state, kept across mounts
//     findings: card => [{ id, severity, status, summary, line }],
//     onFinding: (card, finding) => {},     // a click on a finding in the panel
//     folded: true,                         // start each section folded (default:
//                                           // only with the default folder grouping)
//   })
//
// Hover lights a card's links (classes only, no redraw); a click or Enter
// selects it and fills the panel; chips filter by increment. Each section
// folds to one stacked row that keeps its links and badges; its header's
// chevron or the bar's Expand all opens it. The panel sits beside the map
// when the map is wide enough and pins to the bottom of the view when not,
// so the details of a card are on screen when it is clicked.
(function (root) {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var LX = 0, LW = 210, PX = 270, PW = 280, RX = 610, RW = 210, W = 820;
  var CH = 38, NH = 24, GAP = 8, TOP = 34, HH = 18, FOLD_NB = 3;

  var CSS = [
    ".pm{display:grid;gap:10px;margin:8px 0 18px;container-type:inline-size}",
    ".pm-body{display:grid;gap:10px;align-items:start;min-width:0}",
    ".pm-all{margin-left:auto}",
    ".pm-bar{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}",
    ".pm-chips{display:flex;gap:6px;flex-wrap:wrap}",
    ".pm-chip{appearance:none;border:1px solid var(--ef-line2);background:var(--ef-bg1);color:var(--ef-text-dim);font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer}",
    ".pm-chip[aria-pressed=true]{background:var(--ef-accent);border-color:var(--ef-accent);color:var(--ef-bg)}",
    ".pm-chip:focus-visible,.pm g[tabindex]:focus-visible{outline:2px solid var(--ef-accent);outline-offset:2px}",
    ".pm-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--ef-text-dim);align-items:center}",
    ".pm-legend svg{vertical-align:middle}",
    ".pm-canvas{overflow-x:auto;border:1px solid var(--ef-line2);border-radius:8px;background:var(--ef-bg1)}",
    ".pm-canvas svg{display:block;width:100%;min-width:640px;height:auto}",
    ".pm-panel{border:1px solid var(--ef-line2);border-radius:8px;padding:10px 14px 12px;display:grid;gap:8px;background:var(--ef-bg);" +
      "position:sticky;bottom:0;z-index:5;max-height:42vh;overflow:auto;box-shadow:0 -8px 18px -12px rgba(0,0,0,.55)}",
    ".pm-head{display:flex;gap:8px;align-items:flex-start;position:sticky;top:-10px;margin-top:-10px;padding-top:10px;background:var(--ef-bg)}",
    ".pm-head h3{flex:1;min-width:0}",
    ".pm-min{appearance:none;border:1px solid var(--ef-line2);background:var(--ef-bg1);color:var(--ef-text-dim);font:inherit;font-size:12px;line-height:1;padding:3px 8px;border-radius:6px;cursor:pointer;flex:none}",
    ".pm-min:hover{color:var(--ef-text)}.pm-min:focus-visible{outline:2px solid var(--ef-accent);outline-offset:2px}",
    ".pm-panel.min>:not(.pm-head){display:none}",
    "@container (min-width:960px){.pm-body{grid-template-columns:minmax(0,1fr) 320px}" +
      ".pm-panel{bottom:auto;top:12px;max-height:calc(100vh - 24px);box-shadow:none}.pm-min{display:none}.pm-panel.min>:not(.pm-head){display:revert}}",
    ".pm-panel>.pm-chip{justify-self:start}",
    ".pm-panel h3{margin:0;font:600 14px var(--ef-mono);word-break:break-all}",
    ".pm-panel h4{margin:4px 0 0;font:600 11px var(--ef-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ef-text-faint)}",
    ".pm-panel ul{margin:0;padding-left:18px;display:grid;gap:4px}",
    ".pm-panel li{color:var(--ef-text-dim)}",
    ".pm-panel .pm-ev{font:12px var(--ef-mono);color:var(--ef-text-orange)}",
    ".pm-panel .pm-ct{color:var(--ef-text-purple)}",
    ".pm-meta{display:flex;gap:6px;flex-wrap:wrap}",
    ".pm-tag{font:11px var(--ef-mono);padding:2px 7px;border-radius:4px;background:var(--ef-card);color:var(--ef-text-dim)}",
    ".pm-tag.new{color:var(--ef-text-aqua)}.pm-tag.modify{color:var(--ef-text-blue)}.pm-tag.remove{color:var(--ef-text-red)}",
    ".pm-note{font-size:12px;color:var(--ef-text-faint);margin:0}",
    ".pm-tray{border:1px dashed var(--ef-line2);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--ef-text-dim)}",
    ".pm-lane{font:600 10.5px var(--ef-mono);letter-spacing:.08em;text-transform:uppercase;fill:var(--ef-text-faint)}",
    ".pm-grp{font:600 10.5px var(--ef-mono);fill:var(--ef-text-faint)}",
    ".pm-card .box{fill:var(--ef-bg);stroke:var(--ef-line2);stroke-width:1.2}",
    ".pm-card.new .box{stroke:var(--ef-aqua);stroke-dasharray:5 4;stroke-width:1.6}",
    ".pm-card.modify .box{stroke:var(--ef-blue)}",
    ".pm-card.remove .box{stroke:var(--ef-red)}",
    ".pm-card.remove .name{text-decoration:line-through}",
    ".pm-card .name{font:600 12px var(--ef-mono);fill:var(--ef-text)}",
    ".pm-card .dir{font:10px var(--ef-mono);fill:var(--ef-text-faint)}",
    ".pm-card .glyph{font:700 13px var(--ef-mono);fill:var(--ef-text-faint)}",
    ".pm-card.new .glyph{fill:var(--ef-text-aqua)}.pm-card.modify .glyph{fill:var(--ef-text-blue)}.pm-card.remove .glyph{fill:var(--ef-text-red)}",
    ".pm-pip circle{fill:var(--ef-card);stroke:var(--ef-line2)}.pm-pip text{font:600 9px var(--ef-mono);fill:var(--ef-text-dim)}",
    ".pm-pip.authorized circle,.pm-pip.working circle{fill:var(--ef-accent);stroke:var(--ef-accent)}",
    ".pm-pip.done circle{fill:var(--ef-good);stroke:var(--ef-good)}",
    ".pm-pip.blocked circle{fill:var(--ef-bad);stroke:var(--ef-bad)}",
    ".pm-pip.authorized text,.pm-pip.working text,.pm-pip.done text,.pm-pip.blocked text{fill:var(--ef-bg)}",
    ".pm-card.st-done .box{fill:var(--ef-bg-green)}",
    ".pm-card.st-working .box{fill:var(--ef-bg-blue)}",
    ".pm-badge{font:600 10.5px var(--ef-mono)}.pm-badge.f{fill:var(--ef-text-orange)}.pm-badge.c{fill:var(--ef-text-purple)}",
    ".pm-badge.k-bad{fill:var(--ef-text-bad)}.pm-badge.k-warn{fill:var(--ef-text-warn)}.pm-badge.k-nit{fill:var(--ef-text-dim)}.pm-badge.k-done{fill:var(--ef-text-faint)}",
    ".pm-fd{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;cursor:pointer;border-radius:4px;padding:1px 3px;margin-left:-3px}",
    ".pm-fd:hover,.pm-fd:focus-visible{background:var(--ef-card);outline:none}",
    ".pm-fd.done{opacity:.6}.pm-sev{font:600 11px var(--ef-mono)}.pm-sev.k-bad{color:var(--ef-text-bad)}.pm-sev.k-warn{color:var(--ef-text-warn)}.pm-sev.k-nit{color:var(--ef-text-dim)}",
    ".pm-nb .box{fill:var(--ef-bg1);stroke:var(--ef-line)}.pm-nb .name{font:11px var(--ef-mono);fill:var(--ef-text-dim)}",
    ".pm-nb.more .box{stroke-dasharray:3 3}.pm-nb.more .name{fill:var(--ef-text-faint)}",
    ".pm-fold .box{fill:var(--ef-bg);stroke:var(--ef-line2)}.pm-fold .deck{fill:var(--ef-bg1);stroke:var(--ef-line2)}",
    ".pm-fold .name{font:600 12px var(--ef-mono);fill:var(--ef-text)}.pm-fold .dir{font:10.5px var(--ef-mono);fill:var(--ef-text-dim)}",
    ".pm-fold .chev,.pm-sec .chev{font:700 12px var(--ef-mono);fill:var(--ef-accent)}",
    ".pm-fold:hover .box,.pm-fold:focus-visible .box{stroke:var(--ef-accent)}",
    ".pm-sec .hit{fill:transparent}.pm-sec .grp{font:600 10.5px var(--ef-mono);fill:var(--ef-text-dim)}.pm-sec .cnt{font:10px var(--ef-mono);fill:var(--ef-text-faint)}",
    ".pm-sec:hover .hit,.pm-sec:focus-visible .hit{fill:var(--ef-card)}.pm-sec:hover .grp{fill:var(--ef-text)}",
    ".pm-edge{fill:none;stroke:var(--ef-line2);stroke-width:1.2}",
    ".pm-edge.planned{stroke-dasharray:4 3}",
    ".pm-edge.hot{stroke:var(--ef-accent);stroke-width:2}",
    ".pm g[tabindex]{cursor:pointer}",
    ".pm .sel .box{stroke:var(--ef-accent);stroke-width:2.4}",
    ".pm .dim{opacity:.28}",
    ".pm-card.st-ok .box{fill:var(--ef-bg-green);stroke:var(--ef-good)}",
    ".pm-card.st-miss .box{fill:var(--ef-bg-yellow);stroke:var(--ef-warn);stroke-dasharray:5 4}",
    ".pm-card.st-extra .box{fill:var(--ef-bg-red);stroke:var(--ef-bad)}",
    ".pm-card.st-ok .glyph{fill:var(--ef-text-good)}.pm-card.st-miss .glyph{fill:var(--ef-text-warn)}.pm-card.st-extra .glyph{fill:var(--ef-text-bad)}",
    "@media (prefers-reduced-motion:no-preference){.pm-edge,.pm g[tabindex]{transition:opacity .15s,stroke .15s}}",
  ].join("\n");

  function S(tag, attrs, kids) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  function T(attrs, text) { var e = S("text", attrs); e.textContent = text; return e; }
  function H(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var base = function (p) { return p.split("/").pop(); };
  var dirOf = function (p) { return p.indexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/") + 1) : ""; };
  var clip = function (s, n) { return s.length > n ? "…" + s.slice(s.length - n + 1) : s; };
  var GLYPH = { "new": "+", modify: "~", remove: "−" };
  var WORD = { "new": "new file", modify: "modified", remove: "removed" };
  // Findings: open until resolved or dismissed; the flag takes the worst open
  // severity's colour.
  var SEV = ["blocker", "major", "minor", "nit"];
  var KIND = { blocker: "k-bad", major: "k-bad", minor: "k-warn", nit: "k-nit" };
  var isOpenF = function (f) { return f.status !== "resolved" && f.status !== "dismissed"; };
  function worst(list) {
    var best = 99;
    list.forEach(function (f) { var i = SEV.indexOf(f.severity); if (i >= 0 && i < best) best = i; });
    return best === 99 ? "nit" : SEV[best];
  }

  function styleOnce(doc) {
    if (doc.getElementById("pm-style")) return;
    var st = doc.createElement("style");
    st.id = "pm-style";
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  // The plan lane's sections: by folder, two levels deep.
  function byFolder(cards) {
    var order = [], by = {};
    cards.forEach(function (c) {
      var segs = c.path.split("/");
      var g = segs.length > 2 ? segs.slice(0, 2).join("/") + "/" : segs.length > 1 ? segs[0] + "/" : "./";
      if (!by[g]) { by[g] = []; order.push(g); }
      by[g].push(c);
    });
    return order.map(function (g) { return [g, by[g]]; });
  }

  function mount(el, model, opts) {
    opts = opts || {};
    styleOnce(el.ownerDocument || document);
    var incs = opts.increments || [];
    var incStatus = {};
    incs.forEach(function (i) { incStatus[i.n] = i.status || ""; });
    var statusOf = opts.status || function () { return ""; };
    var cards = (model.cards || []).concat(opts.extra || []);
    var grouping = opts.groups || byFolder;
    var byPath = {};
    cards.forEach(function (c) { byPath[c.path] = c; });
    var sections = grouping(cards).filter(function (pair) { return pair[1].length; });
    // Folders start folded, one stacked row each, when there is more than
    // one. A caller with its own sections (lookout's compare) starts them open.
    var foldFirst = (opts.folded !== undefined ? !!opts.folded : !opts.groups) && sections.length > 1;
    // sel is what the panel shows; picked is only what the reader clicked.
    // A caller that redraws (lookout, on a fresher review) passes the same
    // keep object each time, so the selection, a first click, an open or
    // closed folder and a shrunk panel survive the redraw.
    var state = opts.keep || {};
    if (state.inc === undefined) state.inc = 0;
    if (state.picked === undefined) state.picked = null;
    if (!state.open) state.open = {};
    state.hover = null;
    if (state.sel === undefined || (state.sel !== null && !byPath[state.sel])) {
      // With the cards folded away, the panel waits for a click.
      state.sel = foldFirst || !cards.length ? null : cards[0].path;
      state.picked = null;
    }
    var isOpen = function (label) { return state.open[label] !== undefined ? state.open[label] : !foldFirst; };
    var sectionOf = function (p) {
      var hit = sections.filter(function (pair) { return pair[1].some(function (c) { return c.path === p; }); })[0];
      return hit ? hit[0] : null;
    };

    var wrap = H("div", "pm");
    var bar = H("div", "pm-bar");
    var chipBox = H("div", "pm-chips");
    chipBox.setAttribute("role", "group");
    chipBox.setAttribute("aria-label", "Filter by increment");
    bar.appendChild(chipBox);
    bar.appendChild(legend());
    var allBtn = null;
    if (sections.length > 1) {
      allBtn = H("button", "pm-chip pm-all");
      allBtn.type = "button";
      allBtn.addEventListener("click", function () {
        var to = !sections.every(function (pair) { return isOpen(pair[0]); });
        sections.forEach(function (pair) { state.open[pair[0]] = to; });
        draw();
      });
      bar.appendChild(allBtn);
    }
    // The canvas and the panel share a row when the map is wide enough (the
    // panel then stays in view beside it), and stack when not (the panel then
    // pins to the bottom of the view while the map is on screen).
    var body = H("div", "pm-body");
    var canvas = H("div", "pm-canvas");
    var panel = H("div", "pm-panel");
    panel.setAttribute("aria-live", "polite");
    body.appendChild(canvas);
    body.appendChild(panel);
    wrap.appendChild(bar);
    wrap.appendChild(body);
    var tray = H("div", "pm-tray");
    wrap.appendChild(tray);
    el.replaceChildren(wrap);

    var cur = null;

    function legend() {
      var L = H("div", "pm-legend");
      var sw = function (box, label) {
        var s = H("span");
        var svg = S("svg", { width: 24, height: 14, "aria-hidden": "true" }, box);
        s.appendChild(svg);
        s.appendChild(document.createTextNode(" " + label));
        L.appendChild(s);
      };
      sw([S("rect", { x: 1, y: 1, width: 22, height: 12, rx: 3, fill: "none", stroke: "var(--ef-aqua)", "stroke-dasharray": "4 3", "stroke-width": 1.6 })], "+ new");
      sw([S("rect", { x: 1, y: 1, width: 22, height: 12, rx: 3, fill: "none", stroke: "var(--ef-blue)" })], "~ modified");
      sw([S("rect", { x: 1, y: 1, width: 22, height: 12, rx: 3, fill: "none", stroke: "var(--ef-red)" }),
        S("line", { x1: 3, y1: 7, x2: 21, y2: 7, stroke: "var(--ef-red)" })], "− removed");
      var f = H("span", "", "● facts"); f.style.color = "var(--ef-text-orange)"; L.appendChild(f);
      var c = H("span", "", "◆ contracts"); c.style.color = "var(--ef-text-purple)"; L.appendChild(c);
      sw([S("path", { d: "M1 7 H23", stroke: "var(--ef-line2)", "stroke-dasharray": "4 3", "stroke-width": 1.4 })], "a link the plan adds");
      return L;
    }

    function chips() {
      chipBox.replaceChildren();
      if (!incs.length) return;
      [{ n: 0, title: "All increments" }].concat(incs).forEach(function (i) {
        var b = H("button", "pm-chip", i.n ? i.n + ". " + clip(String(i.title || "").split(":")[0], 34) : i.title);
        b.type = "button";
        if (i.n) b.title = i.title;
        b.setAttribute("aria-pressed", String(state.inc === i.n));
        b.addEventListener("click", function () { state.inc = i.n; chips(); paint(); });
        chipBox.appendChild(b);
      });
    }

    // Edges: used-by into a card, a card out to what it uses, and links
    // between two planned cards. A link to or from a new card is one the
    // plan adds, so it is drawn dashed.
    // A folded card's links are drawn to its folder's row: alias maps the
    // card's path to that row's id, and a link inside one folded row is dropped.
    // A folded row draws three neighbours a side and counts the rest, so a
    // folded map is short in every lane, not just the middle one.
    function edgesOf(all, alias) {
      var ids = {};
      all.forEach(function (c) { ids[c.path] = c; });
      var A = function (p) { return alias[p] || p; };
      var out = [], seen = {}, nbs = {};
      var push = function (e) {
        if (e.from === e.to) return;
        var k = e.from + "\n" + e.to;
        if (seen[k]) { if (!e.planned) seen[k].planned = false; return; }
        seen[k] = e;
        out.push(e);
      };
      var nb = function (p, side, more, of) {
        var id = more ? "more:" + side + ":" + of : p;
        if (!nbs[id]) nbs[id] = { id: id, path: more ? "" : p, side: side, more: 0, of: [] };
        nbs[id].more += more || 0;
        if (nbs[id].of.indexOf(of) < 0) nbs[id].of.push(of);
        return id;
      };
      var cap = {};
      var room = function (me, side, p) {
        if (me.indexOf("fold:") !== 0) return true;
        var k = me + "\n" + side, r = cap[k] || (cap[k] = { me: me, side: side, shown: {}, n: 0, hidden: {} });
        if (r.shown[p]) return true;
        if (r.n < FOLD_NB) { r.shown[p] = true; r.n++; return true; }
        r.hidden[p] = true;
        return false;
      };
      all.forEach(function (c) {
        var fresh = c.change === "new", me = A(c.path);
        // A neighbour that is also a card (lookout draws a touched-but-unplanned
        // file as one) keeps its line, drawn as a link inside the lane.
        var linked = c.links || [];
        ((c.usedBy && c.usedBy.paths) || []).forEach(function (p) {
          if (!ids[p]) { if (room(me, "left", p)) push({ from: nb(p, "left", 0, me), to: me, planned: fresh }); }
          else if (linked.indexOf(p) < 0) push({ from: A(p), to: me, planned: fresh, inner: true });
        });
        if (c.usedBy && c.usedBy.more) push({ from: nb("", "left", c.usedBy.more, me), to: me, planned: fresh });
        ((c.uses && c.uses.paths) || []).forEach(function (p) {
          if (!ids[p]) { if (room(me, "right", p)) push({ from: me, to: nb(p, "right", 0, me), planned: fresh }); }
          else if (linked.indexOf(p) < 0) push({ from: me, to: A(p), planned: fresh, inner: true });
        });
        if (c.uses && c.uses.more) push({ from: me, to: nb("", "right", c.uses.more, me), planned: fresh });
        (c.links || []).forEach(function (p) {
          if (ids[p] && c.path < p) push({ from: me, to: A(p), planned: fresh || ids[p].change === "new", inner: true });
        });
      });
      Object.keys(cap).forEach(function (k) {
        var r = cap[k], n = Object.keys(r.hidden).length;
        if (!n) return;
        var id = nb("", r.side, n, r.me);
        push(r.side === "left" ? { from: id, to: r.me, planned: false } : { from: r.me, to: id, planned: false });
      });
      return { edges: out, nbs: Object.keys(nbs).map(function (k) { return nbs[k]; }) };
    }

    function toggle(label) { state.open[label] = !isOpen(label); draw(); }
    function keyed(g, fn) {
      g.addEventListener("click", fn);
      g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fn(); } });
    }

    function draw() {
      var svg = S("svg", { viewBox: "0 0 " + W + " 100", role: "img", "aria-label": "End state map of " + (model.slug || "the plan") });
      var pos = {};
      var gEdges = S("g"), gCards = S("g");
      svg.appendChild(T({ x: LX + 4, y: 20, "class": "pm-lane" }, "used by"));
      svg.appendChild(T({ x: PX + 4, y: 20, "class": "pm-lane" }, opts.planLabel || "the plan's files"));
      svg.appendChild(T({ x: RX + 4, y: 20, "class": "pm-lane" }, "uses"));
      svg.appendChild(gEdges);
      svg.appendChild(gCards);

      var y = TOP, all = [], alias = {}, folds = [];
      sections.forEach(function (pair) {
        var label = pair[0], list = pair[1];
        all = all.concat(list);
        if (!isOpen(label)) {
          var id = "fold:" + label;
          list.forEach(function (c) { alias[c.path] = id; });
          pos[id] = { x: PX, y: y + 4, w: PW, h: CH, f: { label: label, list: list } };
          folds.push(id);
          y += CH + 4 + GAP + 4;
          return;
        }
        // An open section's header folds it again; a lone section has nothing
        // to fold into, so it keeps a plain label.
        if (sections.length > 1) {
          var hd = S("g", { "class": "pm-sec", tabindex: "0", role: "button", "aria-expanded": "true",
            "aria-label": "Fold " + label + " (" + list.length + " files)", transform: "translate(" + PX + "," + y + ")" });
          hd.appendChild(S("rect", { "class": "hit", x: -2, width: PW + 4, height: HH, rx: 4 }));
          hd.appendChild(T({ x: 4, y: 13, "class": "chev" }, "▾"));
          hd.appendChild(T({ x: 18, y: 13, "class": "grp" }, clip(label, 30)));
          hd.appendChild(T({ x: PW - 4, y: 13, "class": "cnt", "text-anchor": "end" }, list.length + (list.length === 1 ? " file · fold" : " files · fold")));
          keyed(hd, function () { toggle(label); });
          gCards.appendChild(hd);
        } else gCards.appendChild(T({ x: PX + 4, y: y + 12, "class": "pm-grp" }, label));
        y += HH + 2;
        list.forEach(function (c) { pos[c.path] = { x: PX, y: y, w: PW, h: CH, c: c }; y += CH + GAP; });
        y += 8;
      });
      if (allBtn) {
        var allOpen = sections.every(function (pair) { return isOpen(pair[0]); });
        allBtn.textContent = allOpen ? "▴ Fold all" : "▾ Expand all";
        allBtn.setAttribute("aria-label", allOpen ? "Fold every folder" : "Expand every folder");
      }
      var Hh = y;
      var E = edgesOf(all, alias);
      ["left", "right"].forEach(function (side) {
        var list = E.nbs.filter(function (n) { return n.side === side; }).map(function (n) {
          var ys = n.of.map(function (p) { return pos[p]; }).filter(Boolean).map(function (q) { return q.y + q.h / 2; });
          return { n: n, want: ys.length ? ys.reduce(function (a, b) { return a + b; }, 0) / ys.length : TOP };
        }).sort(function (a, b) { return a.want - b.want || (a.n.id < b.n.id ? -1 : 1); });
        var last = TOP - 4;
        list.forEach(function (it) {
          var yy = Math.max(it.want - NH / 2, last + 4);
          pos[it.n.id] = { x: side === "left" ? LX : RX, y: yy, w: side === "left" ? LW : RW, h: NH, n: it.n };
          last = yy + NH;
        });
        Hh = Math.max(Hh, last + 16);
      });
      svg.setAttribute("viewBox", "0 0 " + W + " " + Hh);

      E.edges.forEach(function (e) {
        var a = pos[e.from], b = pos[e.to];
        if (!a || !b) return;
        var d;
        if (e.inner) {
          var x = PX + PW, y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, bulge = 22 + Math.min(30, Math.abs(y2 - y1) / 10);
          d = "M" + x + " " + y1 + " C" + (x + bulge) + " " + y1 + " " + (x + bulge) + " " + y2 + " " + x + " " + y2;
        } else {
          var L = a.x < b.x ? a : b, R = a.x < b.x ? b : a;
          var x1 = L.x + L.w, yA = L.y + L.h / 2, x2 = R.x, yB = R.y + R.h / 2, mx = (x1 + x2) / 2;
          d = "M" + x1 + " " + yA + " C" + mx + " " + yA + " " + mx + " " + yB + " " + x2 + " " + yB;
        }
        var p = S("path", { d: d, "class": "pm-edge" + (e.planned ? " planned" : "") });
        p._e = e;
        gEdges.appendChild(p);
      });

      Object.keys(pos).forEach(function (id) {
        var it = pos[id];
        var g = it.c ? cardNode(it) : it.f ? foldNode(it, id) : nbNode(it);
        g._id = id;
        gCards.appendChild(g);
      });
      cur = { svg: svg, pos: pos, edges: E.edges };
      canvas.replaceChildren(svg);
      paint();
    }

    function wire(g, id) {
      g.addEventListener("mouseenter", function () { state.hover = id; paint(); });
      g.addEventListener("mouseleave", function () { state.hover = null; paint(); });
      g.addEventListener("focus", function () { state.hover = id; paint(); });
      g.addEventListener("blur", function () { state.hover = null; paint(); });
      // The first click selects a card and shows what the plan says about it
      // (its findings too); a click on the card already selected opens it.
      var pick = function () {
        var again = state.picked === id;
        state.sel = state.picked = id;
        state.min = false;
        paint();
        fill();
        if (again) openCard(id);
      };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
    }

    function openable(id) {
      var c = byPath[id];
      return !!(opts.onOpen && c && (!opts.canOpen || opts.canOpen(c)));
    }
    function openCard(id) { if (openable(id)) opts.onOpen(id); }

    function cardNode(it) {
      var c = it.c, st = statusOf(c);
      var cls = "pm-card " + (c.change || "") + (st ? " st-" + st : "");
      var mine = (c.increments || []).map(function (n) { return incStatus[n]; });
      if (!st && mine.length && mine.every(function (s) { return s === "done"; })) cls += " st-done";
      else if (!st && mine.some(function (s) { return s === "working" || s === "authorized"; })) cls += " st-working";
      var g = S("g", { "class": cls, tabindex: "0", role: "button", "aria-label": c.path + ", " + (WORD[c.change] || c.change || ""),
        transform: "translate(" + it.x + "," + it.y + ")" });
      g.appendChild(S("rect", { "class": "box", width: it.w, height: it.h, rx: 6 }));
      var glyph = st === "ok" ? "✓" : st === "miss" || st === "extra" ? "!" : GLYPH[c.change] || "·";
      g.appendChild(T({ x: 10, y: 16, "class": "glyph" }, glyph));
      g.appendChild(T({ x: 26, y: 16, "class": "name" }, clip(base(c.path), 22)));
      g.appendChild(T({ x: 26, y: 30, "class": "dir" }, clip(dirOf(c.path), 30)));
      var fs = opts.findings ? opts.findings(c) || [] : [];
      marks(g, it.w, c.increments || [], (c.facts || []).length, (c.contracts || []).length, fs);
      var title = S("title");
      title.textContent = c.path + (fs.length ? " \u00b7 " + fs.filter(isOpenF).length + " open finding(s) of " + fs.length : "");
      g.appendChild(title);
      wire(g, c.path);
      return g;
    }

    // The pips (one per increment) and the badges (facts, contracts, findings)
    // a card or a folded row carries on its right edge.
    function marks(g, w, incList, nFacts, nContracts, fs) {
      var bx = w - 8;
      incList.slice().sort(function (a, b) { return b - a; }).forEach(function (n) {
        bx -= 15;
        g.appendChild(S("g", { "class": "pm-pip " + (incStatus[n] || "") }, [
          S("circle", { cx: bx + 6, cy: 13, r: 6.5 }),
          T({ x: bx + 6, y: 16, "text-anchor": "middle" }, String(n))]));
      });
      var bx2 = w - 10;
      if (fs.length) {
        var live = fs.filter(isOpenF);
        var k = live.length ? KIND[worst(live)] : "k-done";
        g.appendChild(T({ x: bx2, y: 31, "class": "pm-badge pm-flag " + k, "text-anchor": "end" },
          "\u2691 " + (live.length || fs.length) + (live.length ? "" : "\u2713")));
        bx2 -= 34;
      }
      if (nContracts) { g.appendChild(T({ x: bx2, y: 31, "class": "pm-badge c", "text-anchor": "end" }, "◆ " + nContracts)); bx2 -= 30; }
      if (nFacts) g.appendChild(T({ x: bx2, y: 31, "class": "pm-badge f", "text-anchor": "end" }, "● " + nFacts));
    }

    // A folded folder: a short deck of cards with the folder's name, how many
    // files it holds and of what change, and the sum of its cards' marks.
    function foldNode(it, id) {
      var f = it.f, list = f.list;
      var g = S("g", { "class": "pm-fold", tabindex: "0", role: "button", "aria-expanded": "false",
        "aria-label": "Expand " + f.label + " (" + list.length + " files)", transform: "translate(" + it.x + "," + it.y + ")" });
      g.appendChild(S("rect", { "class": "deck", x: 6, y: -6, width: it.w - 6, height: it.h, rx: 6 }));
      g.appendChild(S("rect", { "class": "deck", x: 3, y: -3, width: it.w - 3, height: it.h, rx: 6 }));
      g.appendChild(S("rect", { "class": "box", width: it.w, height: it.h, rx: 6 }));
      g.appendChild(T({ x: 10, y: 16, "class": "chev" }, "▸"));
      g.appendChild(T({ x: 24, y: 16, "class": "name" }, clip(f.label, 22)));
      var kinds = {}, incSet = {}, nF = 0, nC = 0, fs = [];
      list.forEach(function (c) {
        kinds[c.change] = (kinds[c.change] || 0) + 1;
        (c.increments || []).forEach(function (n) { incSet[n] = true; });
        nF += (c.facts || []).length;
        nC += (c.contracts || []).length;
        if (opts.findings) fs = fs.concat(opts.findings(c) || []);
      });
      var mix = ["new", "modify", "remove"].filter(function (k) { return kinds[k]; })
        .map(function (k) { return GLYPH[k] + kinds[k]; }).join(" ");
      g.appendChild(T({ x: 24, y: 30, "class": "dir" }, list.length + (list.length === 1 ? " file" : " files") + (mix ? " · " + mix : "")));
      marks(g, it.w, Object.keys(incSet).map(Number), nF, nC, fs);
      var title = S("title");
      title.textContent = "Click to expand: " + list.map(function (c) { return base(c.path); }).join(", ");
      g.appendChild(title);
      g.addEventListener("mouseenter", function () { state.hover = id; paint(); });
      g.addEventListener("mouseleave", function () { state.hover = null; paint(); });
      g.addEventListener("focus", function () { state.hover = id; paint(); });
      g.addEventListener("blur", function () { state.hover = null; paint(); });
      keyed(g, function () { state.hover = null; toggle(f.label); });
      return g;
    }

    function nbNode(it) {
      var n = it.n;
      var g = S("g", { "class": "pm-nb" + (n.more ? " more" : ""), tabindex: "0", role: "button",
        "aria-label": n.more ? n.more + " more not drawn" : n.path, transform: "translate(" + it.x + "," + it.y + ")" });
      g.appendChild(S("rect", { "class": "box", width: it.w, height: it.h, rx: 5 }));
      g.appendChild(T({ x: 8, y: 16, "class": "name" }, n.more ? "+" + n.more + " more" : clip(n.path, 30)));
      var title = S("title");
      title.textContent = n.more ? n.more + " more files, past the cap of six" : n.path;
      g.appendChild(title);
      wire(g, n.id);
      return g;
    }

    function paint() {
      if (!cur) return;
      var hot = state.hover || state.sel, linked = {};
      linked[hot] = true;
      cur.edges.forEach(function (e) { if (e.from === hot) linked[e.to] = true; if (e.to === hot) linked[e.from] = true; });
      var inInc = function (id) {
        if (!state.inc) return true;
        var q = cur.pos[id];
        if (q && q.c) return (q.c.increments || []).indexOf(state.inc) >= 0;
        if (q && q.f) return q.f.list.some(function (c) { return (c.increments || []).indexOf(state.inc) >= 0; });
        return cur.edges.some(function (e) { return (e.from === id && inInc(e.to)) || (e.to === id && inInc(e.from)); });
      };
      cur.svg.querySelectorAll("path.pm-edge").forEach(function (el) {
        var e = el._e, touches = e.from === hot || e.to === hot;
        el.classList.toggle("hot", touches);
        var cardSide = function (id) { var q = cur.pos[id]; return q && (q.c || q.f) ? inInc(id) : false; };
        el.classList.toggle("dim", (!!state.inc && !(cardSide(e.from) || cardSide(e.to))) || (!!state.hover && !touches));
      });
      cur.svg.querySelectorAll("g.pm-card, g.pm-nb, g.pm-fold").forEach(function (g) {
        var id = g._id;
        g.classList.toggle("sel", id === state.sel);
        g.classList.toggle("dim", (!!state.hover && !linked[id]) || !inInc(id));
      });
    }

    function li(parts) {
      var e = H("li");
      parts.forEach(function (p) { e.appendChild(typeof p === "string" ? document.createTextNode(p) : p); });
      return e;
    }
    function codeEl(text, cls) { var c = H("span", "pm-ev" + (cls ? " " + cls : ""), text); return c; }

    // The panel's title row stays put while its body scrolls, and carries a
    // button that shrinks the panel to that row (a narrow map pins the panel
    // over its bottom edge); the next click on a card grows it again.
    function head(text) {
      var row = H("div", "pm-head");
      row.appendChild(H("h3", "", text));
      var b = H("button", "pm-min", state.min ? "▴" : "▾");
      b.type = "button";
      b.setAttribute("aria-expanded", String(!state.min));
      b.setAttribute("aria-label", state.min ? "Show the details" : "Shrink the details to their title");
      b.title = state.min ? "Show the details" : "Shrink to the title";
      b.addEventListener("click", function () { state.min = !state.min; fill(); });
      row.appendChild(b);
      panel.appendChild(row);
    }

    function fill() {
      panel.replaceChildren();
      var id = state.sel;
      var it = cur && cur.pos[id];
      var c = id ? byPath[id] : null;
      panel.classList.toggle("min", !!state.min && !!(c || it));
      if (!id || !(c || it)) { panel.appendChild(H("p", "pm-note", "Pick a card to see what the plan says about it.")); return; }
      if (!c && it.n) {
        var n = it.n;
        head(n.more ? "+" + n.more + " more" : n.path);
        var meta = H("div", "pm-meta");
        meta.appendChild(H("span", "pm-tag", "not in the plan"));
        meta.appendChild(H("span", "pm-tag", n.side === "left" ? "uses a planned file" : "used by a planned file"));
        panel.appendChild(meta);
        panel.appendChild(H("h4", "", n.more ? "Past the cap, beside" : "Linked plan files"));
        var ul = H("ul");
        n.of.forEach(function (p) { ul.appendChild(li([codeEl(p)])); });
        panel.appendChild(ul);
        panel.appendChild(H("p", "pm-note", "Found when the plan rendered and kept in its state; a re-render looks again."));
        return;
      }
      var st = statusOf(c);
      head(c.path);
      if (openable(id)) {
        var ob = H("button", "pm-chip", (opts.openLabel || "Open") + " \u2192");
        ob.type = "button";
        ob.title = "or click the card again";
        ob.addEventListener("click", function () { openCard(id); });
        panel.appendChild(ob);
      }
      var m = H("div", "pm-meta");
      if (st) m.appendChild(H("span", "pm-tag", { ok: "touched as planned", miss: "planned, not touched", extra: "touched, not planned" }[st] || st));
      if (c.change) m.appendChild(H("span", "pm-tag " + c.change, (GLYPH[c.change] || "") + " " + (WORD[c.change] || c.change)));
      (c.increments || []).forEach(function (k) { m.appendChild(H("span", "pm-tag", "increment " + k + (incStatus[k] ? " · " + incStatus[k] : ""))); });
      panel.appendChild(m);
      if (st && opts.statusNote) panel.appendChild(H("p", "pm-note", opts.statusNote(c, st)));
      (c.increments || []).forEach(function (k) {
        var i = incs.filter(function (x) { return x.n === k; })[0];
        if (i && i.title) panel.appendChild(H("p", "pm-note", k + ". " + i.title));
      });
      var fl = opts.findings ? opts.findings(c) || [] : [];
      if (fl.length) {
        var nOpen = fl.filter(isOpenF).length;
        panel.appendChild(H("h4", "", "Findings (" + nOpen + " open of " + fl.length + ")"));
        var ufd = H("ul");
        fl.slice().sort(function (a, b) {
          return (isOpenF(b) - isOpenF(a)) || SEV.indexOf(a.severity) - SEV.indexOf(b.severity);
        }).forEach(function (f) {
          var row = H("li");
          var line = H("span", "pm-fd" + (isOpenF(f) ? "" : " done"));
          line.setAttribute("role", "button");
          line.setAttribute("tabindex", "0");
          line.appendChild(H("span", "pm-sev " + (KIND[f.severity] || ""), f.id + " " + f.severity));
          line.appendChild(document.createTextNode((f.line ? "line " + f.line + " \u00b7 " : "") + (f.summary || "") +
            (f.status && f.status !== "open" ? " (" + f.status + ")" : "")));
          var go = function () { if (opts.onFinding) opts.onFinding(c, f); };
          line.addEventListener("click", go);
          line.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
          row.appendChild(line);
          ufd.appendChild(row);
        });
        panel.appendChild(ufd);
      }
      if ((c.facts || []).length) {
        panel.appendChild(H("h4", "", "Facts that cite it (" + c.facts.length + ")"));
        var uf = H("ul");
        c.facts.forEach(function (f) { uf.appendChild(li([f.claim + " ", codeEl(f.evidence)])); });
        panel.appendChild(uf);
      }
      if ((c.contracts || []).length) {
        panel.appendChild(H("h4", "", "Contracts placed on it"));
        var uc = H("ul");
        c.contracts.forEach(function (k) { uc.appendChild(li([H("span", "pm-ct", "◆ "), k.surface + " ", H("span", "pm-tag", k.kind + " · " + k.change)])); });
        panel.appendChild(uc);
      }
      var side = function (label, s) {
        if (!s || !((s.paths || []).length || s.more)) return null;
        var parts = [label + " "];
        s.paths.forEach(function (p, i) { if (i) parts.push(", "); parts.push(codeEl(base(p))); });
        if (s.more) parts.push(" +" + s.more + " more");
        return li(parts);
      };
      var nbList = [side("used by", c.usedBy), side("uses", c.uses)].filter(Boolean);
      if ((c.links || []).length) {
        var lp = ["linked in the plan to "];
        c.links.forEach(function (p, i) { if (i) lp.push(", "); lp.push(codeEl(base(p))); });
        nbList.push(li(lp));
      }
      if (nbList.length) {
        panel.appendChild(H("h4", "", "Neighbours"));
        var un = H("ul");
        nbList.forEach(function (x) { un.appendChild(x); });
        panel.appendChild(un);
      }
      if (c.change === "new" && !(c.facts || []).length)
        panel.appendChild(H("p", "pm-note", "A new file needs no citation: it is the plan's output, not its input."));
    }

    function fillTray() {
      tray.replaceChildren();
      var parts = [];
      if (model.neighbours === false && model.why) parts.push(H("p", "pm-note", "No neighbours: " + model.why + "."));
      var un = model.unplaced || [];
      var b = H("b", "", "Unplaced contracts: ");
      var p = H("p", "pm-note");
      p.appendChild(b);
      if (!un.length) p.appendChild(document.createTextNode("none; every contract names where it lives with at."));
      else un.forEach(function (k, i) {
        if (i) p.appendChild(document.createTextNode("; "));
        p.appendChild(H("span", "pm-ct", "◆ "));
        p.appendChild(document.createTextNode(k.surface + (k.at ? " (at " + k.at.join(", ") + ", which no increment lists)" : "")));
      });
      parts.push(p);
      if (opts.trayNote) parts.push(H("p", "pm-note", opts.trayNote));
      parts.forEach(function (x) { tray.appendChild(x); });
    }

    chips();
    draw();
    fill();
    fillTray();
    return { redraw: function () { draw(); fill(); }, select: function (p) {
      state.sel = p;
      var sec = sectionOf(p);
      if (sec && !isOpen(sec)) state.open[sec] = true;
      draw(); fill();
    } };
  }

  // A page draws itself when an element with class pm-mount holds a JSON
  // script element with class pm-data: { map, increments }.
  function auto(doc) {
    doc.querySelectorAll(".pm-mount").forEach(function (el) {
      var src = el.querySelector("script.pm-data") || doc.getElementById(el.getAttribute("data-src") || "");
      if (!src) return;
      var data;
      try { data = JSON.parse(src.textContent); } catch (e) { el.textContent = "The map's data could not be read."; return; }
      mount(el, data.map, { increments: data.increments || [] });
    });
  }

  var api = { mount: mount, auto: auto, version: 1 };
  root.PlanMap = api;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { auto(document); });
    else auto(document);
  }
})(typeof window !== "undefined" ? window : this);
