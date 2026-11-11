// The session page's drawing (crew/board/runs.html, served by crew-board's
// runs_page.rs at /runs/<session>). It lists every background run the
// session started, grouped under the prompt that launched it or under an
// adapter's own group (a plan's scouts), newest group first. A row opens in
// place to show its detail and links, and a link from there goes to its run
// page or transcript. The data is the session's report: runs in the
// seamux.run/1 model (docs/RUNS.md), notices and each adapter's summary.
//
// Everything that needs no page (grouping, order, nesting, state, counts,
// a run's page) is in `model`, which the board probe runs in node.
(function (root) {
  "use strict";

  // ---- the model: no DOM -------------------------------------------------
  // A run's state for its ring: needs you while one of its agents waits on
  // the person, else its status.
  function stateOf(run) {
    var waits = (run.agents || []).some(function (a) { return a.needsYou && a.state === "running"; });
    if (waits && run.status === "running") return "need";
    return { running: "running", done: "done", failed: "failed", cancelled: "failed" }[run.status] || "unknown";
  }
  function lone(run) { return run.kind !== "workflow" && (run.agents || []).length === 1; }
  // Groups, newest first by their time (or their newest run's start); a
  // group's runs in launch order, each child right under its parent. Runs no
  // group names go last, under OTHER.
  var OTHER = "Other background work";
  function groups(runs) {
    var by = {}, order = [];
    (runs || []).forEach(function (r) {
      var g = r.group || null, key = g ? String(g.kind || "") + ":" + g.id : "";
      if (!by[key]) {
        by[key] = { id: key, label: g ? g.label || g.id : OTHER, kind: g ? g.kind || "" : "", at: g && g.at > 0 ? g.at : 0, runs: [] };
        order.push(key);
      }
      by[key].runs.push(r);
    });
    var out = order.map(function (k) {
      var g = by[k];
      var newest = Math.max.apply(null, g.runs.map(function (r) { return r.start || 0; }).concat([0]));
      g.when = g.at || newest;
      g.rows = nest(g.runs);
      return g;
    });
    out.sort(function (a, b) {
      if (!a.id !== !b.id) return a.id ? -1 : 1;
      return b.when - a.when || (a.label < b.label ? -1 : 1);
    });
    return out;
  }
  // [{run, depth}]: by start, a run whose parent is in the list right after it.
  function nest(runs) {
    var ids = {};
    runs.forEach(function (r) { ids[r.id] = r; });
    var byStart = runs.slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0) || (a.id < b.id ? -1 : 1); });
    var out = [], placed = {};
    function put(r, depth) {
      if (placed[r.id]) return;
      placed[r.id] = 1;
      out.push({ run: r, depth: depth });
      byStart.forEach(function (c) { if (c.parent === r.id && c.id !== r.id) put(c, Math.min(depth + 1, 3)); });
    }
    byStart.forEach(function (r) { if (!r.parent || !ids[r.parent] || r.parent === r.id) put(r, 0); });
    // A loop of parents leaves runs unplaced: they go at the top level.
    byStart.forEach(function (r) { put(r, 0); });
    return out;
  }
  function counts(runs) {
    var c = { need: 0, running: 0, done: 0, failed: 0, unknown: 0, tokens: 0 };
    (runs || []).forEach(function (r) {
      c[stateOf(r)]++;
      var t = r.totals && r.totals.tokens;
      if (t > 0) c.tokens += t;
    });
    return c;
  }
  // The page a run opens: a lone agent's transcript, or a run's page. None
  // for an id the pages cannot carry, or a lone agent with no transcript.
  var PLAIN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
  function pageOf(run, session) {
    if (!PLAIN.test(String(session || ""))) return "";
    if (lone(run)) {
      var a = run.agents[0];
      return a && a.transcript && PLAIN.test(a.id) ? "/agent/" + session + "/" + a.id : "";
    }
    return PLAIN.test(run.id) ? "/run/" + session + "/" + run.id : "";
  }
  // A workflow's phases, each done (all its agents ended), running or to come.
  function phases(run) {
    var names = (run.phases || []).slice();
    (run.agents || []).forEach(function (a) { if (a.phase && names.indexOf(a.phase) < 0) names.push(a.phase); });
    return names.map(function (p) {
      var as = (run.agents || []).filter(function (a) { return a.phase === p; });
      var ended = as.length && as.every(function (a) { return a.state !== "running" && a.state !== "queued"; });
      var going = as.some(function (a) { return a.state === "running"; });
      return { name: p, state: ended ? "done" : going ? "running" : "todo" };
    });
  }
  function badgeOf(run) {
    if (lone(run)) return (run.agents[0].result && run.agents[0].result.badge) || "";
    return "";
  }
  function detailOf(run) {
    var a = lone(run) ? run.agents[0] : null;
    var d = run.summary || (a && a.result && a.result.detail) || "";
    return String(d).split("\n").slice(0, 14).join("\n");
  }
  function took(ms) {
    var s = Math.floor(Math.max(0, ms) / 1000), m = Math.floor(s / 60);
    return s < 60 ? s + "s" : m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function tokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n); }
  function span(runs, now) {
    var st = (runs || []).map(function (r) { return r.start || 0; }).filter(function (x) { return x > 0; });
    if (!st.length) return null;
    var live = (runs || []).some(function (r) { return r.status === "running"; });
    var end = live ? now : Math.max.apply(null, runs.map(function (r) { return r.end || r.start || 0; }));
    return [Math.min.apply(null, st), end];
  }
  var model = { stateOf: stateOf, groups: groups, nest: nest, counts: counts, pageOf: pageOf, phases: phases,
    badgeOf: badgeOf, detailOf: detailOf, took: took, span: span, OTHER: OTHER };
  root.__runsPage = model;
  if (typeof document === "undefined" || !document.getElementById || !document.getElementById("groups")) return;

  // ---- the page ------------------------------------------------------------
  var boot = {};
  try { boot = JSON.parse(document.getElementById("boot").textContent); } catch (e) { boot = {}; }
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // One ring per state, the card's: filled and ticked when done.
  function ring(state) {
    var col = { running: "var(--run)", need: "var(--need)", done: "var(--ok)", failed: "var(--bad)" }[state] || "var(--idle)";
    if (state === "done") return '<svg class="mk" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="' + col +
      '"/><path d="M3.6 6.2l1.6 1.6 3.2-3.5" fill="none" stroke="var(--bg)" stroke-width="1.5"/></svg>';
    if (state === "failed") return '<svg class="mk" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="' + col +
      '"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" stroke="var(--bg)" stroke-width="1.5"/></svg>';
    return '<svg class="mk" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="color-mix(in srgb,' + col +
      ' 30%,transparent)" stroke-width="1.8"/><path d="M6 1.4a4.6 4.6 0 0 1 4.6 4.6" fill="none" stroke="' + col + '" stroke-width="1.8"' +
      (state === "unknown" ? ' stroke-dasharray="2 2"' : "") + "/></svg>";
  }
  var data = null, open = {};
  function elapsed(r) {
    if (!(r.start > 0)) return "";
    return r.status === "running" ? '<span class="el" data-t0="' + Number(r.start) + '">' + took(Date.now() - r.start) + "</span>"
      : '<span class="el">' + took((r.end || r.start) - r.start) + "</span>";
  }
  // A link the server says opens is a button: a file in the session's
  // worktree opens in VS Code at its line, a web page in the browser. The
  // rest (a file outside the worktree) is plain text.
  function linksOf(r) {
    return (r.links || []).map(function (l, i) {
      var label = l.file ? l.label + (l.line ? ":" + l.line : "") : l.label;
      var tip = l.file ? l.file + (l.line ? ":" + l.line : "") : l.url || "";
      return l.opens ? '<button type="button" class="lk on" data-link="' + i + '" title="' + esc((l.file ? "Open in VS Code: " : "Open: ") + tip) + '">' + esc(label) + "</button>"
        : '<span class="lk" title="' + esc(tip + (l.file ? " (outside this session's worktree)" : "")) + '">' + esc(label) + "</span>";
    }).join("");
  }
  // What each row last heard back from an open; a link already opening
  // ignores more clicks. The button stays as drawn until the answer.
  var said = {}, opening = {};
  function openLink(id, i) {
    var r = data && (data.runs || []).filter(function (x) { return x.id === id; })[0];
    var l = r && (r.links || [])[i];
    var key = id + "#" + i;
    if (!l || opening[key]) return;
    opening[key] = 1;
    function done(msg) {
      delete opening[key];
      said[id] = msg;
      draw();
    }
    fetch("/runs/" + encodeURIComponent(boot.session || "") + "/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: boot.t || "", run: id, link: i, shown: l.shown || "" }),
    }).then(function (res) { return res.json(); }).then(function (v) {
      done(v && v.ok ? "" : "Could not open it: " + ((v && (v.detail || v.error)) || "no answer"));
    }).catch(function () { done("Could not open it: the intent server is not answering."); });
  }
  function row(x) {
    var r = x.run, st = stateOf(r), b = badgeOf(r), page = pageOf(r, boot.session);
    var chips = (r.metrics || []).map(function (m) { return '<span class="chip">' + esc(m.value) + " " + esc(m.label) + "</span>"; });
    if (!lone(r) && r.totals && r.totals.agents) chips.unshift('<span class="chip">' + (r.totals.done + r.totals.failed) + "/" + r.totals.agents + " agents</span>");
    var ph = phases(r);
    var strip = ph.length > 1 ? '<span class="strip" title="' + esc(ph.map(function (p) { return p.name + ": " + p.state; }).join(", ")) + '">' +
      ph.map(function (p) { return '<i class="' + p.state + '"></i>'; }).join("") + "</span>" : "";
    var sub = chips.join("") + strip;
    var isOpen = !!open[r.id];
    var det = "";
    if (isOpen) {
      var d = detailOf(r);
      det = '<div class="det">' + (d ? '<pre class="dt">' + esc(d) + "</pre>" : "") +
        (r.notice ? '<div class="nt">' + esc(r.notice) + "</div>" : "") +
        ((r.links || []).length ? '<div class="links">' + linksOf(r) + "</div>" : "") +
        (said[r.id] ? '<div class="say">' + esc(said[r.id]) + "</div>" : "") +
        (page ? '<a class="go" href="' + esc(page) + "?back=" + encodeURIComponent(location.pathname) + '">' + (lone(r) ? "Open transcript" : "Open run page") + "</a>" : "") +
        "</div>";
    }
    var tip = r.label || r.name;
    return '<div class="row ' + st + (x.depth ? " d" + x.depth : "") + (isOpen ? " open" : "") + '" data-id="' + esc(r.id) + '" tabindex="0" role="button" aria-expanded="' + isOpen + '" title="' + esc(tip) + '">' +
      ring(st) + '<span class="lbl">' + esc(r.name || r.id) + '<span class="kind">' + esc(r.kind) + "</span></span>" +
      '<span class="right">' + (st === "need" ? '<span class="badge need">needs you</span>' : b ? '<span class="badge">' + esc(b) + "</span>" : "") + elapsed(r) + "</span>" +
      (sub ? '<div class="sub">' + sub + "</div>" : "") + det + "</div>";
  }
  // A redraw while the person selects text in the list waits until the
  // selection ends; the focused row keeps its focus across one.
  var waiting = false;
  function selecting() {
    var sel = window.getSelection && window.getSelection();
    return !!(sel && !sel.isCollapsed && sel.anchorNode && $("groups").contains(sel.anchorNode));
  }
  document.addEventListener("selectionchange", function () { if (waiting && !selecting()) { waiting = false; draw(); } });
  function draw() {
    if (!data) return;
    if (selecting()) { waiting = true; return; }
    var focused = document.activeElement && document.activeElement.closest && document.activeElement.closest(".row");
    var keep = focused ? focused.getAttribute("data-id") : null;
    var runs = data.runs || [];
    var c = counts(runs);
    document.title = "Background work · " + String(boot.session || "").slice(0, 8);
    var bits = [];
    if (c.need) bits.push('<span class="n-need"><b>' + c.need + "</b> need" + (c.need === 1 ? "s" : "") + " you</span>");
    if (c.running) bits.push('<span class="n-run"><b>' + c.running + "</b> running</span>");
    bits.push("<span><b>" + c.done + "</b> done</span>");
    if (c.failed) bits.push('<span class="n-bad"><b>' + c.failed + "</b> failed</span>");
    if (c.tokens) bits.push("<span>" + tokens(c.tokens) + " tokens</span>");
    var sp = span(runs, Date.now());
    if (sp) bits.push("<span>" + took(sp[1] - sp[0]) + (runs.some(function (r) { return r.status === "running"; }) ? " so far" : "") + "</span>");
    $("meta").innerHTML = bits.join("");
    $("sum").innerHTML = (data.summaries || []).map(function (s) { return "<div>" + esc(s.text) + "</div>"; }).join("");
    $("sum").hidden = !(data.summaries || []).length;
    var need = runs.filter(function (r) { return stateOf(r) === "need"; });
    $("need").hidden = !need.length;
    $("need").textContent = need.length === 1 ? (need[0].name || need[0].id) + " needs you" :
      need.length ? need.length + " runs need you: " + need.map(function (r) { return r.name || r.id; }).join(", ") : "";
    $("notes").innerHTML = (data.notices || []).map(function (n) { return '<div class="' + (n.kind === "failed" ? "bad" : "") + '">' + esc(n.text) + "</div>"; }).join("");
    $("notes").hidden = !(data.notices || []).length;
    var gs = groups(runs);
    $("empty").hidden = gs.length > 0;
    $("groups").innerHTML = gs.map(function (g) {
      var tag = g.kind === "prompt" ? "you asked" : g.kind || "";
      return '<section class="group"><div class="gh">' + (tag ? '<span class="gt">' + esc(tag) + "</span>" : "") +
        (g.kind === "prompt" ? '<q class="gl">' + esc(g.label) + "</q>" : '<span class="gl">' + esc(g.label) + "</span>") + (g.when ? '<span class="gw">' + esc(new Date(g.when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) + "</span>" : "") +
        "</div>" + g.rows.map(row).join("") + "</section>";
    }).join("");
    if (keep) {
      var again = $("groups").querySelector('.row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(keep) : keep) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }
  function toggle(e) {
    if (e.target.closest("a, .lk, .det")) return;
    var el = e.target.closest(".row");
    if (!el) return;
    if (e.type === "keydown") {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
    }
    var id = el.getAttribute("data-id");
    if (open[id]) delete open[id]; else open[id] = 1;
    draw();
  }
  $("groups").addEventListener("click", function (e) {
    var b = e.target.closest(".lk.on");
    var el = b && b.closest(".row");
    if (el) openLink(el.getAttribute("data-id"), Number(b.getAttribute("data-link")));
  });
  $("groups").addEventListener("click", toggle);
  $("groups").addEventListener("keydown", toggle);
  // A running row's elapsed time ticks without a redraw.
  setInterval(function () {
    var els = document.querySelectorAll(".el[data-t0]");
    for (var i = 0; i < els.length; i++) els[i].textContent = took(Date.now() - Number(els[i].getAttribute("data-t0")));
  }, 1000);

  // ---- data: the first read, then the session's event feed ------------------
  function gone(why) { $("empty").hidden = false; $("empty").textContent = why; }
  function take(v) {
    if (v && v.error) return gone("This session could not be read: " + v.error);
    data = v;
    draw();
  }
  var base = "/runs/" + encodeURIComponent(boot.session || "");
  var tok = "?t=" + encodeURIComponent(boot.t || "");
  fetch(base + "/data" + tok, { cache: "no-store" }).then(function (r) {
    return r.json().then(function (v) { return r.ok ? take(v) : gone(v.error || "This session could not be found."); });
  }).catch(function () { gone("The intent server is not answering."); });
  if (typeof EventSource === "function") {
    var es = new EventSource(base + "/events" + tok);
    es.addEventListener("runs", function (e) { try { take(JSON.parse(e.data)); } catch (x) { /* a torn event: the next one carries it */ } });
  }
})(this);
