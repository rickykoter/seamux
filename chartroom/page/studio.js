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
            c.waiting ? h("span", { cls: "count", title: c.waiting + " thread(s) wait on you", text: String(c.waiting) })
              : c.open ? h("span", { cls: "count quiet-count", title: c.open + " open thread(s)", text: String(c.open) }) : null,
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
    // Pin mode follows the page in view.
    S.frames.forEach(function (f) { if (f.el.contentWindow) f.el.contentWindow.postMessage({ chartroom: 1, type: "mode", pin: !!S.pinMode && f.el.classList.contains("shown") }, "*"); });
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
    if (!same) { S.draft = null; S.focus = ""; S.forceThreads = true; }
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
    if (window.chartroomThreads && window.chartroomThreads.key(k, down)) return true;
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
    }).catch(function (e) {
      var c = $("conn");
      c.hidden = false;
      c.textContent = /HTTP 403/.test(String(e && e.message)) ? "this page is out of date: reload it"
        : "server not answering: chartroom open restarts it";
    });
  }

  // ---------------------------------------------------------- threads, pins, picks

  S.pinMode = false;   // the next click in the chart drops a pin
  S.draft = null;      // { version, pane, pin } being written
  S.focus = "";        // a thread id to show
  S.placed = {};       // frame key -> { found: [n], gone: [n] }

  var num = function (t) { return Number(String(t.id).slice(1)); };
  // lib/ops.mjs's waitsOnPerson; the page cannot import it, so the rule is
  // repeated here and the probe holds the two to the same answers.
  var waits = function (t) { return !!(t && !t.resolved && t.messages && t.messages.length && t.messages[t.messages.length - 1].by === "agent"); };
  var who = function (by) { return by === "human" ? "you" : "Claude"; };
  var threadsNow = function () { return (S.detail && S.detail.threads) || []; };

  function shownFrame() { var f = null; S.frames.forEach(function (x) { if (x.el.classList.contains("shown")) f = x; }); return f; }

  // Every frame gets the pins made on its pane at its version or before.
  function placePins(f) {
    if (!f || !f.el.contentWindow) return;
    var pins = threadsNow().filter(function (t) { return t.pin && t.pane === f.key && t.version <= f.n; }).map(function (t) {
      return { n: num(t), path: t.pin.path, dx: t.pin.dx, dy: t.pin.dy, text: t.pin.text, waits: waits(t), resolved: !!t.resolved, focus: t.id === S.focus };
    });
    f.el.contentWindow.postMessage({ chartroom: 1, type: "place", pins: pins }, "*");
  }
  function placeAll() { S.frames.forEach(placePins); }

  function setPinMode(on) {
    S.pinMode = !!on;
    S.frames.forEach(function (f) { if (f.el.contentWindow) f.el.contentWindow.postMessage({ chartroom: 1, type: "mode", pin: S.pinMode && f === shownFrame() }, "*"); });
    var b = $("pin-btn");
    if (b) { b.classList.toggle("on", S.pinMode); b.setAttribute("aria-pressed", S.pinMode ? "true" : "false"); }
    $("stage").classList.toggle("pinning", S.pinMode);
    if (S.pinMode) toast("Click the chart to pin a comment (Esc to stop)");
  }

  function send(body) {
    return T.op(Object.assign({ chart: S.id }, body)).then(function (r) { return refresh().then(function () { return r; }); })
      .catch(function (e) { toast("Not saved: " + e.message); throw e; });
  }

  function renderPickSlot() {
    var slot = $("pick-slot");
    slot.textContent = "";
    var c = S.detail && S.detail.chart;
    var v = c && version(c, S.n);
    var p = v && paneIn(v, S.key, 0);
    if (!p) return;
    slot.appendChild(h("button", { id: "pin-btn", cls: "act" + (S.pinMode ? " on" : ""), "aria-pressed": S.pinMode ? "true" : "false",
      title: "Pin a comment on the chart (c)", on: { click: function () { setPinMode(!S.pinMode); } } }, [pinIcon(), h("span", { text: "Comment" })]));
    if (p.role !== "option") return;
    var chosen = c.chosen && c.chosen.version === v.n && c.chosen.pane === p.key;
    slot.appendChild(chosen
      ? h("span", { cls: "chip st-chosen", text: "Chosen: " + p.label })
      : h("button", { cls: "act pick", title: "Choose this option", on: { click: function () {
          send({ op: "pick", version: v.n, pane: p.key }).then(function () { toast("Picked " + p.label); }, function () {});
        } } }, [h("span", { text: "Pick " + p.label })]));
  }

  function pinIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("width", "14"); s.setAttribute("height", "14"); s.setAttribute("aria-hidden", "true");
    var c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "8"); c.setAttribute("cy", "6.5"); c.setAttribute("r", "4.5"); c.setAttribute("fill", "none"); c.setAttribute("stroke", "currentColor"); c.setAttribute("stroke-width", "1.6");
    var l = document.createElementNS(ns, "path");
    l.setAttribute("d", "M8 11 V15"); l.setAttribute("stroke", "currentColor"); l.setAttribute("stroke-width", "1.6");
    s.appendChild(c); s.appendChild(l);
    return s;
  }

  function composer(draft) {
    var label = (draft.pin ? "Pin on " + (draft.pin.text ? "“" + draft.pin.text.slice(0, 40) + "”" : "the chart") : "Comment on this view") +
      " · v" + draft.version + " " + draft.pane.toUpperCase();
    var ta = h("textarea", { rows: "3", placeholder: "What should change? (Cmd+Enter saves)", "aria-label": "Comment" });
    var save = function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      send({ op: "comment", version: draft.version, pane: draft.pane, pin: draft.pin, text: text })
        .then(function (r) { S.draft = null; S.focus = r.item; S.scrollTo = r.item; S.forceThreads = true; renderRail(); }, function () {});
    };
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.preventDefault(); S.draft = null; renderRail(); }
    });
    // Focus once, when the person has just dropped the pin; a redraw must
    // never pull focus (in the seamux app it would take it from the terminal).
    if (!draft.focused) { draft.focused = true; setTimeout(function () { ta.focus(); }, 0); }
    return h("div", { cls: "thread draft" }, [h("div", { cls: "thread-k", text: label }), ta,
      h("div", { cls: "thread-acts" }, [
        h("button", { cls: "act", text: "Cancel", on: { click: function () { S.draft = null; renderRail(); } } }),
        h("button", { cls: "act primary", text: "Save", on: { click: save } })])]);
  }

  function threadCard(t, here) {
    var c = S.detail.chart;
    var v = version(c, t.version);
    var p = v && paneIn(v, t.pane, 0);
    var f = shownFrame();
    var placed = f && S.placed[S.id + "/" + f.n + "/" + f.key];
    var gone = here && t.pin && placed && placed.gone.indexOf(num(t)) >= 0;
    var state = t.resolved ? "resolved" : waits(t) ? "waits on you" : "open";
    var ta = h("textarea", { rows: "2", placeholder: "Reply (Cmd+Enter)", "aria-label": "Reply to " + t.id });
    var reply = function () {
      var text = ta.value.trim();
      if (text) send({ op: "reply", item: t.id, text: text }).then(function () { S.focus = t.id; }, function () {});
    };
    ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reply(); } });
    var card = h("div", { cls: "thread" + (t.resolved ? " resolved" : "") + (waits(t) ? " waits" : "") + (t.id === S.focus ? " focus" : ""), id: "thread-" + t.id,
      on: { click: function (e) { if (e.target.closest("button,textarea")) return; S.focus = t.id; placeAll(); markFocus(); } } }, [
      h("div", { cls: "thread-k" }, [
        h("span", { cls: "pin-no" + (waits(t) ? " waits" : "") + (t.resolved ? " resolved" : ""), text: String(num(t)) }),
        h("span", { text: "v" + t.version + " " + (p ? p.label : t.pane) + (t.pin ? (t.pin.text ? " · “" + t.pin.text.slice(0, 32) + "”" : " · pinned") : " · whole view") }),
        h("span", { cls: "gap" }),
        h("span", { cls: "state", text: state }),
      ]),
      gone ? h("div", { cls: "gone small", text: "Not on v" + f.n + ": the element it was pinned on is gone or changed." }) : null,
    ].concat(t.messages.map(function (m) {
      return h("div", { cls: "msg" + (m.by === "agent" ? " agent" : "") }, [
        h("span", { cls: "msg-by", text: who(m.by) + (m.kind === "status" ? " marked it " + m.to : "") }),
        m.text ? h("div", { cls: "msg-text", text: m.text }) : null]);
    })).concat([
      t.resolved ? null : ta,
      h("div", { cls: "thread-acts" }, [
        t.resolved ? null : h("button", { cls: "act", text: "Reply", on: { click: reply } }),
        h("button", { cls: "act", text: t.resolved ? "Reopen" : "Resolve", on: { click: function () {
          send({ op: t.resolved ? "reopen" : "resolve", item: t.id, text: ta.value.trim() }).then(function () {}, function () {});
        } } })]),
    ]));
    return card;
  }

  function markFocus() {
    document.querySelectorAll("#threads .thread").forEach(function (el) { el.classList.toggle("focus", el.id === "thread-" + S.focus); });
    var el = S.focus && document.getElementById("thread-" + S.focus);
    if (el && S.scrollTo === S.focus) { S.scrollTo = ""; el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }

  window.chartroomThreads = {
    // opts.noPlace: a redraw for a "placed" answer must not ask the frames to
    // place again, or the two would answer each other forever.
    render: function (S_, T_, opts) {
      renderPickSlot();
      var box = $("threads");
      // Keep what is being typed: a poll that redraws must not eat a reply.
      var typingIn = document.activeElement && box.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
      if (typingIn && !S.forceThreads) return;
      S.forceThreads = false;
      box.textContent = "";
      var c = S.detail && S.detail.chart;
      if (!c) return;
      var v = version(c, S.n);
      var p = v && paneIn(v, S.key, 0);
      if (p) box.appendChild(h("button", { cls: "act wide", text: "Comment on this whole view", on: { click: function () {
        S.draft = { version: v.n, pane: p.key, pin: null }; S.forceThreads = true; renderRail();
      } } }));
      if (S.draft) box.appendChild(composer(S.draft));
      var all = threadsNow().slice().sort(function (a, b) { return (waits(b) - waits(a)) || (a.resolved - b.resolved) || (num(a) - num(b)); });
      var here = all.filter(function (t) { return p && t.pane === p.key && t.version <= S.n; });
      var elsewhere = all.filter(function (t) { return here.indexOf(t) < 0; });
      if (!all.length && !S.draft) box.appendChild(h("p", { cls: "quiet small", text: "No comments yet. Press c, or Comment, then click the chart to pin one." }));
      here.forEach(function (t) { box.appendChild(threadCard(t, true)); });
      if (elsewhere.length) {
        box.appendChild(h("h3", { cls: "sub", text: "Elsewhere in this chart" }));
        elsewhere.forEach(function (t) { box.appendChild(threadCard(t, false)); });
      }
      markFocus();
      if (!(opts && opts.noPlace)) placeAll();
    },
    message: function (S_, T_, from, m) {
      var key = S.id + "/" + from.n + "/" + from.key;
      if (m.type === "ready") placePins(from);
      if (m.type === "placed") {
        var gone = (m.gone || []).filter(Number.isFinite).sort(function (a, b) { return a - b; });
        var was = S.placed[key] ? S.placed[key].gone.join(",") : null;
        S.placed[key] = { found: (m.found || []).filter(Number.isFinite), gone: gone };
        // Redraw only when which pins are gone changed, and never place again from here.
        if (from === shownFrame() && was !== gone.join(",")) { S.forceThreads = true; window.chartroomThreads.render(S, T, { noPlace: true }); }
      }
      if (m.type === "pin" && S.pinMode && from === shownFrame() && m.pin && typeof m.pin.path === "string") {
        S.draft = { version: from.n, pane: from.key, pin: { path: String(m.pin.path).slice(0, 600), dx: Number(m.pin.dx) || 0, dy: Number(m.pin.dy) || 0, text: String(m.pin.text || "").slice(0, 120) } };
        setPinMode(false);
        S.forceThreads = true; renderRail();
      }
      if (m.type === "focus" && Number.isFinite(m.n)) { S.focus = "t" + m.n; S.scrollTo = S.focus; placeAll(); markFocus(); }
    },
    key: function (k, down) {
      if (!down) return false;
      if (k === "c") { setPinMode(!S.pinMode); return true; }
      if (k === "Escape" && (S.pinMode || S.draft)) { setPinMode(false); S.draft = null; S.forceThreads = true; renderRail(); return true; }
      return false;
    },
  };

  window.chartroomStudio = { S: S, T: T, h: h, toast: toast, refresh: refresh, renderChart: renderChart, version: version, paneIn: paneIn };
  window.addEventListener("hashchange", function () { var w = readHash(); if (w.id) select(w.id, w.n, w.key); });
  refresh();
  if (T.live) {
    var tick = function () { setTimeout(function () { refresh().then(tick, tick); }, document.hidden ? 10000 : 2000); };
    tick();
  }
})();
