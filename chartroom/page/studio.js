// chartroom's studio: the register on the left, one chart on the stage, its
// threads and notes on the right. The same file runs on the local server and
// on a published Artifact; only the transport differs.
//
//   transport.state()            every chart in the room, and a signature
//   transport.chart(id)          { chart, threads }
//   transport.pane(id, n, key)   { src } or { srcdoc } for the stage's iframe
//   transport.live               true when state() is worth polling
(function () {
  "use strict";
  var BOOT = window.CHARTROOM_BOOT || {};
  var $ = function (id) { return document.getElementById(id); };
  var h = function (tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "text") el.textContent = v;
      else if (k === "on") Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === "cls") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  };

  // ---------------------------------------------------------- transports

  function localTransport(boot) {
    var base = "/room/" + boot.room;
    var get = function (p) {
      var sep = p.indexOf("?") < 0 ? "?" : "&";
      return fetch(base + p + sep + "t=" + encodeURIComponent(boot.token) + (document.hidden ? "&bg=1" : ""), { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    };
    return {
      live: true,
      state: function () { return get("/api/state"); },
      chart: function (id) { return get("/api/chart/" + encodeURIComponent(id)); },
      pane: function (id, n, key) { return { src: base + "/pane/" + id + "/" + n + "/" + key }; },
      op: function (body) {
        body = Object.assign({}, body, { t: boot.token });
        return fetch(base + "/api/op", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); });
      },
    };
  }
  var T = window.CHARTROOM_TRANSPORT || localTransport(BOOT);

  // ---------------------------------------------------------- state

  var S = {
    room: null,          // state(): { charts, repo, mode, sig }
    id: "",              // the chart on the stage
    detail: null,        // { chart, threads }
    n: 0,                // its version on the stage
    key: "",             // its pane on the stage
    flipping: false,
    frames: new Map(),   // "id/n/key" -> { el, hashes }
    seenLatest: {},      // chart id -> latest version number seen
  };
  var KIND_NAMES = { ux: "UX mocks", arch: "Architecture", domain: "Domains" };
  var KIND_ORDER = ["ux", "arch", "domain"];

  var latest = function (c) { return c && c.versions.length ? c.versions[c.versions.length - 1] : null; };
  var version = function (c, n) { return c ? c.versions.filter(function (v) { return v.n === n; })[0] || null : null; };
  var prevVersion = function (c, n) {
    var older = c ? c.versions.filter(function (v) { return v.n < n; }) : [];
    return older.length ? older[older.length - 1] : null;
  };
  var paneIn = function (v, key, index) {
    if (!v) return null;
    return v.panes.filter(function (p) { return p.key === key; })[0] || v.panes[Math.min(index, v.panes.length - 1)] || null;
  };

  // ---------------------------------------------------------- the hash

  var readHash = function () {
    var m = /^#([a-z0-9-]+)(?:\/v(\d+))?(?:\/([a-z0-9-]+))?$/.exec(location.hash || "");
    return m ? { id: m[1], n: m[2] ? Number(m[2]) : 0, key: m[3] || "" } : { id: "", n: 0, key: "" };
  };
  var writeHash = function () {
    var want = S.id ? "#" + S.id + (S.n ? "/v" + S.n : "") + (S.key ? "/" + S.key : "") : "";
    if (location.hash !== want) history.replaceState(null, "", want || location.pathname + location.search);
  };

  // ---------------------------------------------------------- register

  function renderRegister() {
    var list = $("register-list");
    list.textContent = "";
    var charts = (S.room && S.room.charts) || [];
    if (!charts.length) { list.appendChild(h("p", { cls: "quiet small pad", text: "No charts yet." })); return; }
    KIND_ORDER.forEach(function (kind) {
      var mine = charts.filter(function (c) { return c.kind === kind; });
      if (!mine.length) return;
      list.appendChild(h("h2", { cls: "group", text: KIND_NAMES[kind] + " (" + mine.length + ")" }));
      mine.forEach(function (c) {
        var v = latest(c);
        var row = h("button", { cls: "row" + (c.id === S.id ? " sel" : ""), "data-id": c.id, "aria-current": c.id === S.id ? "true" : null,
          on: { click: function () { select(c.id); } } }, [
          h("span", { cls: "row-title", text: c.title }),
          h("span", { cls: "row-meta" }, [
            h("span", { cls: "dot st-" + c.status, title: c.status }),
            h("span", { text: c.status }),
            v ? h("span", { text: "v" + v.n }) : h("span", { cls: "quiet", text: "no versions" }),
            c.open ? h("span", { cls: "count", title: c.open + " open threads", text: String(c.open) }) : null,
          ]),
        ]);
        list.appendChild(row);
      });
    });
  }

  // ---------------------------------------------------------- the chart

  function renderChart() {
    var c = S.detail && S.detail.chart;
    $("empty").hidden = !!c || !!(S.room && S.room.charts.length && S.id);
    $("chart").hidden = !c;
    if (!c) { renderRail(); return; }
    $("title").textContent = c.title;
    $("kind").textContent = c.kind;
    var st = $("status");
    st.textContent = c.status + (c.chosen ? " · " + c.chosen.pane.toUpperCase() : "");
    st.className = "chip st-" + c.status;
    $("purpose").textContent = c.purpose || "";
    $("purpose").hidden = !c.purpose;

    var vs = $("versions");
    vs.textContent = "";
    c.versions.forEach(function (v) {
      vs.appendChild(h("button", { cls: "ver" + (v.n === S.n ? " on" : ""), role: "tab", "aria-selected": v.n === S.n ? "true" : "false",
        title: v.note || ("version " + v.n), text: "v" + v.n, on: { click: function () { showVersion(v.n); } } }));
    });
    if (!c.versions.length) vs.appendChild(h("span", { cls: "quiet small", text: "No versions yet: chartroom add " + c.id + " <file.html>" }));

    var tabs = $("tabs");
    tabs.textContent = "";
    var v = version(c, S.n);
    if (v && v.panes.length > 1) v.panes.forEach(function (p, i) {
      tabs.appendChild(h("button", { cls: "tab" + (p.key === S.key ? " on" : "") + (p.role === "option" ? " opt" : ""), role: "tab",
        "aria-selected": p.key === S.key ? "true" : "false", title: (i < 9 ? "key " + (i + 1) + ": " : "") + p.label,
        on: { click: function () { showPane(p.key); } } }, [
        i < 9 ? h("kbd", { text: String(i + 1) }) : null,
        h("span", { text: p.label }),
        c.chosen && c.chosen.version === v.n && c.chosen.pane === p.key ? h("span", { cls: "chosen-mark", title: "chosen", text: "chosen" }) : null,
      ]));
    });
    renderStage();
    renderRail();
  }

  function frameKey(n, key) { return S.id + "/" + n + "/" + key; }

  function ensureFrame(n, key) {
    var k = frameKey(n, key);
    var f = S.frames.get(k);
    if (f) return f;
    var spec = T.pane(S.id, n, key);
    var el = h("iframe", { sandbox: "allow-scripts", title: S.id + " v" + n + " " + key, referrerpolicy: "no-referrer", loading: "eager" });
    if (spec.srcdoc !== undefined) el.srcdoc = spec.srcdoc; else el.src = spec.src;
    f = { el: el, hashes: null, n: n, key: key };
    S.frames.set(k, f);
    $("frames").appendChild(el);
    return f;
  }

  function renderStage() {
    var c = S.detail.chart;
    var v = version(c, S.n);
    var p = v && paneIn(v, S.key, 0);
    var prev = v && prevVersion(c, v.n);
    var pp = prev && paneIn(prev, p ? p.key : "", v.panes.indexOf(p));
    var want = new Set();
    if (p) want.add(frameKey(v.n, p.key));
    if (pp) want.add(frameKey(prev.n, pp.key));
    // Frames for other charts or far versions go; the two in use stay mounted,
    // so a flip shows a page already drawn.
    S.frames.forEach(function (f, k) { if (!want.has(k)) { f.el.remove(); S.frames.delete(k); } });
    var cur = p ? ensureFrame(v.n, p.key) : null;
    var old = pp ? ensureFrame(prev.n, pp.key) : null;
    S.frames.forEach(function (f) { f.el.classList.toggle("shown", f === (S.flipping && old ? old : cur)); });
    var badge = $("flip-badge");
    badge.hidden = !(S.flipping && old);
    if (S.flipping && old) badge.textContent = "v" + prev.n + " (previous) · release Space for v" + v.n;
  }

  function renderRail() {
    var notes = $("notes");
    notes.textContent = "";
    var c = S.detail && S.detail.chart;
    if (!c) { notes.appendChild(h("p", { cls: "quiet small", text: "Pick a chart on the left." })); return; }
    if (c.decision) notes.appendChild(h("div", { cls: "note" }, [h("div", { cls: "note-k", text: "Decision" }), h("div", { text: c.decision })]));
    var v = version(c, S.n);
    if (v) {
      var p = paneIn(v, S.key, 0);
      notes.appendChild(h("div", { cls: "note" }, [h("div", { cls: "note-k", text: "v" + v.n + " · " + new Date(v.at).toLocaleString() }),
        h("div", { text: v.note || "No note on this version." }),
        p ? h("div", { cls: "quiet small", text: (p.role === "option" ? "Option " : "View ") + p.label }) : null]));
    }
    // chart.json can come from a commit anyone made: only a claude.ai https
    // link becomes a link, anything else is shown as text.
    (c.published || []).forEach(function (pub) {
      var url = String(pub && pub.url || "");
      var safe = /^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+\/?$/.test(url);
      notes.appendChild(h("div", { cls: "note" }, [h("div", { cls: "note-k", text: "Published (v" + pub.version + ")" }),
        safe ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: url }) : h("span", { cls: "quiet", text: url })]));
    });
    if (window.chartroomThreads) window.chartroomThreads.render(S, T);
  }

  // ---------------------------------------------------------- moves

  function select(id, n, key) {
    if (!id) { S.id = ""; S.detail = null; renderRegister(); renderChart(); writeHash(); return Promise.resolve(); }
    var same = id === S.id;
    S.id = id;
    return T.chart(id).then(function (d) {
      if (S.id !== id) return;
      S.detail = d;
      var lv = latest(d.chart);
      S.seenLatest[id] = lv ? lv.n : 0;
      S.n = n && version(d.chart, n) ? n : (same && version(d.chart, S.n) ? S.n : (lv ? lv.n : 0));
      var v = version(d.chart, S.n);
      var p = v && paneIn(v, key || (same ? S.key : ""), 0);
      S.key = p ? p.key : "";
      renderRegister(); renderChart(); writeHash();
    }).catch(function (e) { toast("Could not load " + id + ": " + e.message); });
  }

  function showVersion(n) {
    var c = S.detail && S.detail.chart;
    var v = version(c, n);
    if (!v) return;
    var cur = version(c, S.n);
    var idx = cur ? Math.max(0, cur.panes.map(function (p) { return p.key; }).indexOf(S.key)) : 0;
    S.n = n;
    var p = paneIn(v, S.key, idx);
    S.key = p ? p.key : "";
    renderChart(); writeHash();
  }

  function showPane(key) { S.key = key; renderChart(); writeHash(); }

  function step(dir) {
    var c = S.detail && S.detail.chart;
    if (!c) return;
    var ns = c.versions.map(function (v) { return v.n; });
    var i = ns.indexOf(S.n) + dir;
    if (i >= 0 && i < ns.length) showVersion(ns[i]);
  }

  function stepChart(dir) {
    var rows = Array.prototype.slice.call(document.querySelectorAll("#register-list .row"));
    if (!rows.length) return;
    var i = rows.map(function (r) { return r.getAttribute("data-id"); }).indexOf(S.id) + dir;
    var row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    select(row.getAttribute("data-id"));
    row.focus();
  }

  // Holding Space shows the previous version; what differs is outlined on
  // whichever page is in view, against the other one's hashes.
  function flip(down) {
    if (S.flipping === down) return;
    var c = S.detail && S.detail.chart;
    var v = c && version(c, S.n);
    // A release always ends a flip, even when the stage has since moved to a
    // version with nothing before it.
    if (down && (!v || !prevVersion(c, v.n))) { toast("v" + (v ? v.n : "?") + " has no previous version"); return; }
    S.flipping = down;
    if (!down && (!v || !prevVersion(c, v.n))) { renderStage(); return; }
    renderStage();
    var shown = null, other = null;
    S.frames.forEach(function (f) { if (f.el.classList.contains("shown")) shown = f; else other = f; });
    if (shown && other && other.hashes && shown.el.contentWindow)
      shown.el.contentWindow.postMessage({ chartroom: 1, type: "outline", against: other.hashes }, "*");
  }

  var toastTimer = null;
  function toast(text) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------- keys

  function key(k, down) {
    if (k === " ") { flip(down); return true; }
    if (!down) return false;
    if (k === "?") { toggleKeys(); return true; }
    if (k === "Escape") { toggleKeys(false); return true; }
    if (k === "[") { step(-1); return true; }
    if (k === "]") { step(1); return true; }
    if (k === "j") { stepChart(1); return true; }
    if (k === "k") { stepChart(-1); return true; }
    if (/^[1-9]$/.test(k)) {
      var v = S.detail && version(S.detail.chart, S.n);
      var p = v && v.panes[Number(k) - 1];
      if (p) showPane(p.key);
      return true;
    }
    return false;
  }
  var typing = function (t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };
  ["keydown", "keyup"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (type === "keydown" && e.repeat) { if (e.key === " ") e.preventDefault(); return; }
      if (key(e.key, type === "keydown")) e.preventDefault();
    });
  });
  // Letting go of Space anywhere (even outside the window) ends a flip.
  window.addEventListener("blur", function () { if (S.flipping) flip(false); });

  function toggleKeys(open) {
    var k = $("keys"), b = $("keys-btn");
    var want = open === undefined ? k.hidden : open;
    k.hidden = !want; b.setAttribute("aria-expanded", want ? "true" : "false");
  }
  $("keys-btn").addEventListener("click", function () { toggleKeys(); });

  // ---------------------------------------------------------- frames talk

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.chartroom !== 1) return;
    var from = null;
    S.frames.forEach(function (f) { if (f.el.contentWindow === e.source) from = f; });
    if (!from) return;   // only our own stage's frames are heard
    if (m.type === "ready" && Array.isArray(m.hashes)) from.hashes = m.hashes.filter(function (x) { return typeof x === "string"; }).slice(0, 6000);
    if (m.type === "key" && typeof m.key === "string") key(m.key, !!m.down);
    if (window.chartroomThreads && window.chartroomThreads.message) window.chartroomThreads.message(S, T, from, m);
  });

  // ---------------------------------------------------------- live

  function refresh() {
    return T.state().then(function (st) {
      var changed = !S.room || st.sig !== S.room.sig;
      S.room = st;
      $("repo").textContent = st.repo || "";
      var mode = $("mode");
      mode.hidden = !st.mode;
      mode.textContent = st.mode === "hidden" ? "hidden from git" : st.mode === "home" ? "outside git" : st.mode === "published" ? "published" : "shared in git";
      $("conn").hidden = true;
      if (!changed) return;
      renderRegister();
      if (!S.id) {
        var want = readHash();
        var first = st.charts[0];
        if (want.id && st.charts.some(function (c) { return c.id === want.id; })) return select(want.id, want.n, want.key);
        if (first) return select(first.id);
        renderChart();
        return;
      }
      if (!st.charts.some(function (c) { return c.id === S.id; })) return select("");
      // The chart on the stage moved: reload it, and follow a new version
      // when the stage was showing the latest one.
      var was = S.seenLatest[S.id] || 0;
      var onLatest = S.n === was;
      return T.chart(S.id).then(function (d) {
        S.detail = d;
        var lv = latest(d.chart);
        S.seenLatest[S.id] = lv ? lv.n : 0;
        if (lv && lv.n > was) {
          if (onLatest) { S.n = lv.n; var p = paneIn(lv, S.key, 0); S.key = p ? p.key : ""; toast("v" + lv.n + " arrived"); }
          else toast("v" + lv.n + " arrived: press ] to reach it");
        }
        renderChart(); writeHash();
      });
    }).catch(function () {
      var c = $("conn");
      c.hidden = false;
      c.textContent = "server not answering: chartroom open restarts it";
    });
  }

  window.chartroomStudio = { S: S, T: T, h: h, toast: toast, refresh: refresh, renderChart: renderChart, version: version, paneIn: paneIn };
  window.addEventListener("hashchange", function () { var w = readHash(); if (w.id) select(w.id, w.n, w.key); });
  refresh();
  if (T.live) {
    var tick = function () { setTimeout(function () { refresh().then(tick, tick); }, document.hidden ? 10000 : 2000); };
    tick();
  }
})();
