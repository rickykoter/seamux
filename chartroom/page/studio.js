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
  var KIND_CHIP = { ux: "UX mock", arch: "architecture", domain: "domain" };

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

  // ---------------------------------------------------------- focus

  // A rebuild replaces the focused control; put focus back on its twin
  // (same data-fk), so the keyboard never drops to the top of the page.
  // Only when focus was actually inside what was rebuilt.
  function keepFocus(fn) {
    var a = document.activeElement;
    var fk = a && a.getAttribute && a.getAttribute("data-fk");
    fn();
    if (!fk || document.activeElement === a && document.body.contains(a)) return;
    var twin = document.querySelector('[data-fk="' + fk.replace(/"/g, "") + '"]');
    if (twin) twin.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------- register

  function renderRegister() { keepFocus(drawRegister); }
  function drawRegister() {
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
        var row = h("button", { cls: "row" + (c.id === S.id ? " sel" : ""), "data-id": c.id, "data-fk": "row:" + c.id, title: c.title,
          "aria-current": c.id === S.id ? "true" : null, on: { click: function () { select(c.id); } } }, [
          h("span", { cls: "row-title", text: c.title }),
          h("span", { cls: "row-meta" }, [
            h("span", { cls: "dot st-" + c.status, title: c.status }),
            h("span", { text: c.status }),
            v ? h("span", { text: "v" + v.n }) : h("span", { cls: "quiet", text: "no versions" }),
            c.waiting && !S.readOnly ? h("span", { cls: "count", title: c.waiting + " thread(s) wait on you", text: String(c.waiting) })
              : (c.open || c.waiting) ? h("span", { cls: "count quiet-count", title: (c.open || c.waiting) + " open thread(s)", text: String(c.open || c.waiting) }) : null,
          ]),
        ]);
        list.appendChild(row);
      });
    });
  }

  // ---------------------------------------------------------- the chart

  // The option's label, never its key: the tabs show labels, so must everything else.
  function paneLabel(c, n, key) {
    var v = version(c, n), p = v && v.panes.filter(function (x) { return x.key === key; })[0];
    return p ? p.label : key;
  }

  function renderChart() { keepFocus(drawChart); }
  function drawChart() {
    var c = S.detail && S.detail.chart;
    $("empty").hidden = !!c || !!(S.room && S.room.charts.length && S.id);
    $("chart").hidden = !c;
    if (!c) { renderRail(); return; }
    $("title").textContent = c.title;
    $("title").title = c.title;
    if ($("title").getAttribute("role") === "button") $("title").setAttribute("aria-label", "Charts: " + c.title);
    $("kind").textContent = KIND_CHIP[c.kind] || c.kind;
    var st = $("status");
    st.textContent = c.status + (c.chosen ? ": " + paneLabel(c, c.chosen.version, c.chosen.pane) : "");
    st.className = "chip st-" + c.status;
    $("purpose").textContent = c.purpose || "";
    $("purpose").hidden = !c.purpose;

    var vs = $("versions");
    vs.textContent = "";
    c.versions.forEach(function (v) {
      vs.appendChild(h("button", { cls: "ver" + (v.n === S.n ? " on" : ""), role: "tab", "aria-selected": v.n === S.n ? "true" : "false",
        "data-fk": "ver:" + v.n, "data-n": String(v.n), title: "Version " + v.n + (v.note ? ": " + v.note : "") + (prevVersion(c, v.n) ? " (hold Space to compare with the one before)" : ""),
        text: "v" + v.n, on: { click: function () { showVersion(v.n); } } }));
    });
    $("no-versions").hidden = !!c.versions.length;

    var tabs = $("tabs");
    tabs.textContent = "";
    var v = version(c, S.n);
    if (v && v.panes.length > 1) v.panes.forEach(function (p, i) {
      tabs.appendChild(h("button", { cls: "tab" + (p.key === S.key ? " on" : "") + (p.role === "option" ? " opt" : ""), role: "tab",
        "aria-selected": p.key === S.key ? "true" : "false", "data-fk": "tab:" + p.key, title: (i < 9 ? "key " + (i + 1) + ": " : "") + p.label,
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

  // ---------------------------------------------------------- narrow

  // Narrow is a width, not a device: a phone, or a narrow pane on a
  // computer with a mouse. The layout is in studio.css; this is behaviour.
  var narrowMq = window.matchMedia ? window.matchMedia("(max-width: 700px)") : { matches: false };
  var isNarrow = function () { return !!narrowMq.matches; };
  var DEFAULT_W = 1100;
  S.fit = true;
  try { S.fit = localStorage.getItem("chartroom.fit") !== "actual"; } catch (e) { /* a private window: fit */ }
  var rootHas = function (c) { return document.documentElement.classList.contains(c); };

  function setSheet(on) {
    on = !!on && isNarrow();
    document.documentElement.classList.toggle("sheet-open", on);
    $("scrim").hidden = !(on || rootHas("reg-open"));
    var b = document.querySelector("#narrow-bar .nb-threads");
    if (b) { b.classList.toggle("on", on); b.setAttribute("aria-expanded", on ? "true" : "false"); }
  }
  function setReg(on) {
    on = !!on && isNarrow();
    document.documentElement.classList.toggle("reg-open", on);
    $("scrim").hidden = !(on || rootHas("sheet-open"));
    if (on) { var r = document.querySelector("#register-list .row.sel") || document.querySelector("#register-list .row"); if (r) r.focus(); }
  }
  $("scrim").addEventListener("click", function () { setSheet(false); setReg(false); });
  $("sheet-close").addEventListener("click", function () { setSheet(false); });
  $("reg-close").addEventListener("click", function () { setReg(false); $("title").focus(); });
  $("title").addEventListener("click", function () { if (isNarrow()) setReg(!rootHas("reg-open")); });
  $("title").addEventListener("keydown", function (e) { if (isNarrow() && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); setReg(true); } });
  function onNarrow() {
    var n = isNarrow();
    if (n) { $("title").setAttribute("tabindex", "0"); $("title").setAttribute("role", "button"); $("title").setAttribute("aria-label", "Charts: " + $("title").textContent); }
    else { $("title").removeAttribute("tabindex"); $("title").removeAttribute("role"); $("title").removeAttribute("aria-label"); setSheet(false); setReg(false); }
    applyFit();
  }
  if (narrowMq.addEventListener) narrowMq.addEventListener("change", onNarrow);

  // A chart drawn wider than the pane renders at its own width, scaled to
  // fit (Fit), or at that width scrolled sideways (Actual). Pins and
  // outlines live inside the frame, so they scale with it.
  function applyFit() {
    var box = $("frames"), n = isNarrow();
    box.classList.toggle("actual", n && !S.fit);
    $("fit-fit").setAttribute("aria-pressed", S.fit ? "true" : "false");
    $("fit-actual").setAttribute("aria-pressed", S.fit ? "false" : "true");
    var bw = box.clientWidth, bh = box.clientHeight;
    S.frames.forEach(function (f) {
      var st = f.el.style, W = f.designW || DEFAULT_W;
      st.left = "";
      if (!n || !bw || (!f.designW && W <= bw)) { st.width = ""; st.height = ""; st.transform = ""; return; }
      // Designed narrower than the pane (a phone screen in a wider pane):
      // shown at its own width, centred, in either mode.
      if (W <= bw) { st.width = W + "px"; st.height = ""; st.transform = ""; st.left = Math.round((bw - W) / 2) + "px"; return; }
      if (S.fit) { var k = bw / W; st.width = W + "px"; st.height = Math.round(bh / k) + "px"; st.transform = "scale(" + k + ")"; }
      else { st.width = W + "px"; st.height = "100%"; st.transform = ""; }
    });
  }
  var setFit = function (on) { S.fit = on; try { localStorage.setItem("chartroom.fit", on ? "fit" : "actual"); } catch (e) { /* not kept */ } applyFit(); };
  $("fit-fit").addEventListener("click", function () { setFit(true); });
  $("fit-actual").addEventListener("click", function () { setFit(false); });
  if (window.ResizeObserver) new ResizeObserver(function () { applyFit(); }).observe($("frames"));

  // The bottom bar: Compare held (mouse button, finger, Space or Enter), Pin, Pick, Threads.
  function renderNarrowBar() {
    var bar = $("narrow-bar");
    // While Compare is held it keeps its element (it has the pointer
    // captured; replacing it would end the hold); the rest is rebuilt.
    var held = S.flipping && bar.querySelector('[data-fk="nb-compare"]');
    if (held) { while (held.nextSibling) bar.removeChild(held.nextSibling); while (held.previousSibling) bar.removeChild(held.previousSibling); }
    else bar.textContent = "";
    var c = S.detail && S.detail.chart;
    var v = c && version(c, S.n);
    var p = v && paneIn(v, S.key, 0);
    var prev = v && prevVersion(c, v.n);
    var cmp = h("button", { type: "button", cls: "nb hold" + (S.flipping ? " on" : ""), "data-fk": "nb-compare", disabled: !prev,
      title: prev ? "Hold to see v" + prev.n + " (or hold Space)" : "No earlier version to compare with",
      text: S.flipping && prev ? "Holding: v" + prev.n : "Compare" });
    var release = function () { S.holdBy = ""; if (S.flipping) { flip(false); renderNarrowBar(); } };
    cmp.addEventListener("pointerdown", function (e) {
      if (!prev) return;
      e.preventDefault();
      try { cmp.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
      cmp.classList.add("on"); cmp.textContent = "Holding: v" + prev.n;
      S.holdBy = "pointer"; S.holdPointer = e.pointerId;
      flip(true);
      if (!S.flipping) { S.holdBy = ""; S.holdPointer = undefined; cmp.classList.remove("on"); cmp.textContent = "Compare"; }
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (t) { cmp.addEventListener(t, release); });
    cmp.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.repeat && prev) { e.preventDefault(); cmp.classList.add("on"); flip(true); if (!S.flipping) cmp.classList.remove("on"); } });
    cmp.addEventListener("keyup", function (e) { if (e.key === "Enter") { e.preventDefault(); release(); } });
    if (held) { held.classList.add("on"); if (prev) held.textContent = "Holding: v" + prev.n; }
    else bar.appendChild(cmp);
    if (!S.readOnly && p) bar.appendChild(h("button", { type: "button", cls: "nb" + (S.pinMode ? " on" : ""), "data-fk": "nb-pin", "aria-pressed": S.pinMode ? "true" : "false", disabled: !!S.flipping,
      title: S.flipping ? "Release Space first" : "Pin a comment: the next click on the chart drops it (c)", text: "Pin",
      on: { click: function () { setSheet(false); setPinMode(!S.pinMode); renderNarrowBar(); } } }));
    if (p && p.role === "option") {
      var chosen = c.chosen && c.chosen.version === v.n && c.chosen.pane === p.key;
      if (chosen) bar.appendChild(h("button", { type: "button", cls: "nb", disabled: true, text: "Chosen" }));
      else if (!S.readOnly) bar.appendChild(h("button", { type: "button", cls: "nb prim", "data-fk": "nb-pick", disabled: !!S.flipping, title: S.flipping ? "Release Space first" : "Choose " + p.label + " (v" + v.n + ")",
        text: "Pick", on: { click: function () { send({ op: "pick", version: v.n, pane: p.key }).then(function () { toast("Picked " + p.label + "." + sentNote()); }, function () {}); } } }));
    }
    var all = threadsNow(), w = all.filter(waitsHere).length, open = all.filter(function (t) { return !t.resolved; }).length;
    var sheet = rootHas("sheet-open");
    bar.appendChild(h("button", { type: "button", cls: "nb nb-threads" + (sheet ? " on" : ""), "data-fk": "nb-threads", "aria-expanded": sheet ? "true" : "false",
      title: w ? w + " thread(s) wait on you" : open + " open thread(s)", on: { click: function () { setSheet(!rootHas("sheet-open")); } } },
      ["Threads", w ? h("span", { cls: "n", text: String(w) }) : open ? h("span", { cls: "n quiet", text: String(open) }) : null]));
  }
  setTimeout(onNarrow, 0);
  // A pointer hold ends wherever the pointer is let go: on this page (the
  // capture may be lost) or over the chart, which tells us (anchor.js).
  // Only the pointer that started the hold ends it: a second finger lifting
  // (a tap on Threads) does not. A release without an id (mouseup inside the
  // chart) counts.
  function endPointerHold(e) {
    if (S.holdBy !== "pointer") return;
    var id = e && typeof e.pointerId === "number" ? e.pointerId : undefined;
    if (id !== undefined && S.holdPointer !== undefined && id !== S.holdPointer) return;
    S.holdBy = ""; S.holdPointer = undefined;
    if (S.flipping) flip(false);
    renderNarrowBar();
  }
  ["pointerup", "pointercancel"].forEach(function (t) { window.addEventListener(t, endPointerHold, true); });

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
    // While flipped, everything says so: the previous version's pill is the
    // selected one, Pick and Comment wait, and a badge names both versions.
    var flipped = !!(S.flipping && old);
    var lv = latest(c), note = $("stage-note");
    note.textContent = "";
    if (c.status === "superseded") note.appendChild(h("span", { text: "Superseded" + (c.decision ? ": " + c.decision : ".") }));
    else if (v && lv && v.n < lv.n) note.appendChild(h("span", {}, ["You are on v" + v.n + "; the latest is v" + lv.n + ". ",
      h("button", { cls: "link", "data-fk": "to-latest", text: "Go to v" + lv.n, on: { click: function () { showVersion(lv.n); } } })]));
    note.hidden = !note.childNodes.length;
    setTimeout(applyFit, 0);
    document.querySelectorAll("#versions .ver").forEach(function (b) {
      var n = Number(b.getAttribute("data-n"));
      b.classList.toggle("on", flipped ? n === prev.n : n === v.n);
      b.classList.toggle("was", flipped && n === v.n);
    });
    $("pick-slot").classList.toggle("waiting", flipped);
    document.querySelectorAll("#pick-slot button").forEach(function (b) { b.disabled = flipped; });
    // The narrow bar builds its own buttons from S.flipping: one owner, so a
    // redraw never disagrees with the flip.
    if (isNarrow()) renderNarrowBar();
    var badge = $("flip-badge");
    badge.hidden = !flipped;
    if (flipped) badge.textContent = "Showing v" + prev.n + ", outlined where v" + v.n + " differs. Release Space for v" + v.n + ".";
    // The flip's tooltip stands in for the button's own, which comes back after.
    document.querySelectorAll("#pick-slot button").forEach(function (b) {
      if (flipped) { if (!b.hasAttribute("data-title")) b.setAttribute("data-title", b.title); b.title = "Release Space first"; }
      else if (b.hasAttribute("data-title")) { b.title = b.getAttribute("data-title"); b.removeAttribute("data-title"); }
    });
  }

  function renderRail() {
    var notes = $("notes");
    notes.textContent = "";
    var c = S.detail && S.detail.chart;
    $("threads-sec").hidden = $("notes-sec").hidden = !c;
    if (!c) { $("threads").textContent = ""; return; }
    if (c.decision) notes.appendChild(h("div", { cls: "note" }, [h("div", { cls: "note-k", text: "Decision" }), h("div", { text: c.decision })]));
    var v = version(c, S.n);
    if (v) {
      var p = paneIn(v, S.key, 0);
      var when = new Date(v.at);
      notes.appendChild(h("div", { cls: "note" }, [h("div", { cls: "note-k", text: "v" + v.n + " · " + when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
          ", " + when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
        v.note ? h("div", { text: v.note }) : null,
        p ? h("div", { cls: "quiet small", text: (p.role === "option" ? "Option: " : "View: ") + p.label }) : null]));
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
    setReg(false);
    // A half-written comment waits for its chart rather than being dropped.
    if (!same) { if (S.id && S.draft) S.drafts[S.id] = S.draft; S.draft = S.drafts[id] || null; delete S.drafts[id]; S.focus = ""; S.forceThreads = true; setPinMode(false); }
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
    var id = row.getAttribute("data-id");
    select(id).then(function () { var r = document.querySelector('[data-fk="row:' + id + '"]'); if (r) r.focus({ preventScroll: false }); });
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
    if (!down) { S.holdBy = ""; S.holdPointer = undefined; }
    if (down && S.pinMode) setPinMode(false);
    if (!down && (!v || !prevVersion(c, v.n))) { renderStage(); return; }
    renderStage();
    var shown = null, other = null;
    S.frames.forEach(function (f) { if (f.el.classList.contains("shown")) shown = f; else other = f; });
    // While Space is held the outlines stay; on release they fade on the
    // current version and leave the previous one.
    if (other && other.el.contentWindow) other.el.contentWindow.postMessage({ chartroom: 1, type: "unoutline" }, "*");
    if (shown && other && other.hashes && shown.el.contentWindow)
      shown.el.contentWindow.postMessage({ chartroom: 1, type: "outline", against: other.hashes, hold: down }, "*");
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
    if (k === "Escape" && down && !$("keys").hidden) { toggleKeys(false); return true; }
    if (k === "Escape" && down && rootHas("reg-open")) { setReg(false); return true; }
    if (k === "Escape" && down && rootHas("sheet-open") && !S.draft && !S.pinMode) { setSheet(false); return true; }
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
      // Space on a focused action (a button that does something, a link, a
      // thread card) presses it. On a chart row, version pill or option tab,
      // which are already chosen once focused, Space keeps its flip.
      if (e.key === " " && e.target && e.target.closest && e.target.closest("button.act,.link,a,summary,#keys-btn,#keys,.thread,.nb:not(.hold)")) return;
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
  $("keys-btn").addEventListener("click", function (e) { e.stopPropagation(); toggleKeys(); });
  $("keys-close").addEventListener("click", function () { toggleKeys(false); $("keys-btn").focus(); });
  document.addEventListener("click", function (e) { if (!$("keys").hidden && !$("keys").contains(e.target)) toggleKeys(false); });

  // ---------------------------------------------------------- frames talk

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.chartroom !== 1) return;
    var from = null;
    S.frames.forEach(function (f) { if (f.el.contentWindow === e.source) from = f; });
    if (!from) return;   // only our own stage's frames are heard
    if (m.type === "ready" && Array.isArray(m.hashes)) from.hashes = m.hashes.filter(function (x) { return typeof x === "string"; }).slice(0, 6000);
    if (m.type === "ready") { var w = Number(m.width); from.designW = w > 200 && w < 4000 ? w : 0; applyFit(); }
    if (m.type === "key" && typeof m.key === "string") key(m.key, !!m.down);
    if (m.type === "release") endPointerHold({ pointerId: typeof m.pointerId === "number" ? m.pointerId : undefined });
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
      mode.textContent = st.mode === "hidden" ? "hidden from git" : st.mode === "home" ? "outside git" : /^published/.test(st.mode) ? st.mode : "shared in git";
      mode.title = st.mode === "hidden" ? "Kept in this repo's .chartroom folder, which git ignores until you run chartroom share on" :
        st.mode === "home" ? "Kept under ~/.claude/chartroom, outside any repo" :
        /read-only/.test(st.mode) ? "This copy cannot save comments or picks" : /connecting/.test(st.mode) ? "Connecting to the page's storage" :
        /^published/.test(st.mode) ? "Comments here reach Claude when the chart's owner pulls them" : "Committed with the repo";
      var wasRo = S.readOnly;
      S.readOnly = /read-only|connecting/.test(st.mode || "");
      if (wasRo !== S.readOnly) { S.forceThreads = true; changed = true; }
      $("conn").hidden = !T.error;
      if (T.error) $("conn").textContent = T.error;
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
  S.draft = null;      // { version, pane, pin, text } being written
  S.drafts = {};       // chart id -> a draft left when the person switched charts
  S.replies = {};      // thread id -> reply text being written
  S.open = {};         // thread id -> its reply box is open
  S.focus = "";        // a thread id to show
  S.placed = {};       // frame key -> { found: [n], gone: [n] }

  var num = function (t) { return Number(String(t.id).slice(1)); };
  // lib/ops.mjs's waitsOnPerson; the page cannot import it, so the rule is
  // repeated here and the probe holds the two to the same answers.
  var waits = function (t) { return !!(t && !t.resolved && t.messages && t.messages.length && t.messages[t.messages.length - 1].by === "agent"); };
  // On a copy that cannot save, nothing waits on the reader.
  var waitsHere = function (t) { return waits(t) && !S.readOnly; };
  function focusCard(id) { setTimeout(function () { var el = document.getElementById("thread-" + id); if (el) el.focus({ preventScroll: false }); }, 0); }
  // On a published page anyone the page was shared with can write, so a
  // person is not assumed to be the reader.
  var who = function (by) { return by === "human" ? (S.room && /^published/.test(S.room.mode) ? "a person" : "you") : "Claude"; };
  var threadsNow = function () { return (S.detail && S.detail.threads) || []; };

  function shownFrame() { var f = null; S.frames.forEach(function (x) { if (x.el.classList.contains("shown")) f = x; }); return f; }

  // Every frame gets the pins made on its pane at its version or before,
  // and the frame being commented on also shows the new pin, dashed.
  function placePins(f) {
    if (!f || !f.el.contentWindow) return;
    var pins = threadsNow().filter(function (t) { return t.pin && t.pane === f.key && t.version <= f.n; }).map(function (t) {
      return { n: num(t), path: t.pin.path, dx: t.pin.dx, dy: t.pin.dy, text: t.pin.text, waits: waits(t), resolved: !!t.resolved, focus: t.id === S.focus };
    });
    var d = S.draft;
    if (d && d.pin && d.pane === f.key && d.version === f.n)
      pins.push({ n: "+", path: d.pin.path, dx: d.pin.dx, dy: d.pin.dy, text: d.pin.text, draft: true });
    f.el.contentWindow.postMessage({ chartroom: 1, type: "place", pins: pins }, "*");
  }
  function placeAll() { S.frames.forEach(placePins); }

  function setPinMode(on) {
    var f = shownFrame();
    if (on && (!f || S.readOnly || S.flipping)) {
      if (!f) toast("There is nothing to pin on yet: this chart has no version.");
      on = false;
    }
    S.pinMode = !!on;
    S.frames.forEach(function (x) { if (x.el.contentWindow) x.el.contentWindow.postMessage({ chartroom: 1, type: "mode", pin: S.pinMode && x === f }, "*"); });
    document.querySelectorAll("#pin-btn, [data-fk=nb-pin]").forEach(function (b) { b.classList.toggle("on", S.pinMode); b.setAttribute("aria-pressed", S.pinMode ? "true" : "false"); });
    $("stage").classList.toggle("pinning", S.pinMode);
    // The hint stays up exactly as long as pin mode does.
    $("pin-hint").hidden = !S.pinMode;
  }

  function send(body) {
    return T.op(Object.assign({ chart: S.id }, body)).then(function (r) { S.forceThreads = true; return refresh().then(function () { return r; }); })
      .catch(function (e) { toast("Not saved: " + e.message); throw e; });
  }
  var sentNote = function () { return S.room && /^published/.test(S.room.mode) ? " Claude sees it when the chart's owner pulls the page." : ""; };

  function renderPickSlot() {
    var slot = $("pick-slot");
    slot.textContent = "";
    var c = S.detail && S.detail.chart;
    var v = c && version(c, S.n);
    var p = v && paneIn(v, S.key, 0);
    if (!p) return;
    var chosen = p.role === "option" && c.chosen && c.chosen.version === v.n && c.chosen.pane === p.key;
    if (!S.readOnly) slot.appendChild(h("button", { id: "pin-btn", "data-fk": "pin-btn", cls: "act" + (S.pinMode ? " on" : ""), "aria-pressed": S.pinMode ? "true" : "false",
      title: "Pin a comment: the next click on the chart drops it (c)", on: { click: function () { setPinMode(!S.pinMode); } } }, [pinIcon(), h("span", { text: "Pin comment" })]));
    if (p.role !== "option") return;
    if (chosen) { slot.appendChild(h("span", { cls: "chip st-chosen", text: "Chosen" })); return; }
    if (S.readOnly) return;
    slot.appendChild(h("button", { cls: "act pick", "data-fk": "pick", title: "Choose " + p.label + " (v" + v.n + ") for this chart", on: { click: function () {
      send({ op: "pick", version: v.n, pane: p.key }).then(function () { toast("Picked " + p.label + "." + sentNote()); }, function () {});
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

  function dropDraft() { S.draft = null; S.forceThreads = true; renderRail(); placeAll(); }

  function composer(draft) {
    var c = S.detail.chart;
    var label = (draft.pin ? "New pin on " + (draft.pin.text ? "“" + draft.pin.text.slice(0, 40) + "”" : "the chart") : "Comment on the whole view") +
      " · v" + draft.version + " " + paneLabel(c, draft.version, draft.pane);
    var ta = h("textarea", { rows: "3", id: "draft-text", placeholder: "What should change?", "aria-label": "Comment" });
    ta.value = draft.text || "";
    ta.addEventListener("input", function () { draft.text = ta.value; draft.armed = false; });
    var save = function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      send({ op: "comment", version: draft.version, pane: draft.pane, pin: draft.pin, text: text })
        .then(function (r) { S.draft = null; S.focus = r.item; S.scrollTo = r.item; S.forceThreads = true; renderRail(); focusCard(r.item); toast("Comment saved." + sentNote()); }, function () {});
    };
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      // Esc never throws away words without a second press.
      if (e.key === "Escape") {
        e.preventDefault();
        if (ta.value.trim() && !draft.armed) { draft.armed = true; toast("Press Esc again to discard this comment"); return; }
        dropDraft();
      }
    });
    // Focus once, when the person has just dropped the pin; a redraw must
    // never pull focus (in the seamux app it would take it from the terminal).
    if (!draft.focused) { draft.focused = true; setTimeout(function () { ta.focus(); }, 0); }
    return h("div", { cls: "thread draft" }, [h("div", { cls: "thread-k", text: label }), ta,
      h("div", { cls: "thread-acts" }, [
        h("span", { cls: "hint", text: "⌘ Enter saves" }),
        h("button", { cls: "act", text: "Cancel", on: { click: dropDraft } }),
        h("button", { cls: "act primary", text: "Save", on: { click: save } })])]);
  }

  function goTo(t) {
    S.n = t.version; S.key = t.pane; S.focus = t.id; S.scrollTo = t.id; S.forceThreads = true;
    renderChart(); writeHash();
  }

  function threadCard(t, here) {
    var c = S.detail.chart;
    var f = shownFrame();
    var placed = f && S.placed[S.id + "/" + f.n + "/" + f.key];
    var gone = here && t.pin && placed && placed.gone.indexOf(num(t)) >= 0;
    var state = t.resolved ? "resolved" : waitsHere(t) ? "waits on you" : S.readOnly && waits(t) ? "Claude asked" : "open";
    var focused = t.id === S.focus;
    var open = !S.readOnly && !t.resolved && (S.open[t.id] || S.replies[t.id]);
    var where = "v" + t.version + " " + paneLabel(c, t.version, t.pane) + (t.pin ? (t.pin.text ? " · “" + t.pin.text.slice(0, 32) + "”" : " · pinned") : " · whole view");
    // A resolved thread folds to its last word unless it is the one in focus.
    var msgs = t.resolved && !focused ? t.messages.slice(-1) : t.messages;
    var body = [
      h("div", { cls: "thread-k" }, [
        h("span", { cls: "pin-no" + (waitsHere(t) ? " waits" : "") + (t.resolved ? " resolved" : "") + (gone ? " gone" : ""), text: String(num(t)) }),
        h("span", { cls: "where", text: where }),
        h("span", { cls: "gap" }),
        h("span", { cls: "state", text: state }),
      ]),
      gone ? h("div", { cls: "gone small", text: "What it was pinned on is gone or changed in v" + f.n + "." }) : null,
      !here || gone ? h("button", { cls: "link", "data-fk": "go:" + t.id, text: "Show it on v" + t.version + " " + paneLabel(c, t.version, t.pane),
        on: { click: function () { goTo(t); } } }) : null,
      t.resolved && !focused && t.messages.length > 1 ? h("div", { cls: "quiet small", text: (t.messages.length - 1) + " earlier message(s)" }) : null,
    ].concat(msgs.map(function (m) {
      return h("div", { cls: "msg" + (m.by === "agent" ? " agent" : "") }, [
        h("span", { cls: "msg-by", text: who(m.by) + (m.kind === "status" ? " marked it " + m.to : "") }),
        m.text ? h("div", { cls: "msg-text", text: m.text }) : null]);
    }));
    if (open) {
      var ta = h("textarea", { rows: "2", id: "reply-" + t.id, placeholder: "Reply", "aria-label": "Reply to thread " + num(t) });
      ta.value = S.replies[t.id] || "";
      ta.addEventListener("input", function () { S.replies[t.id] = ta.value; });
      var reply = function () {
        var text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        S.forceThreads = true;
        send({ op: "reply", item: t.id, text: text }).then(function () {
          delete S.replies[t.id]; delete S.open[t.id]; S.focus = t.id; S.forceThreads = true;
          if (document.activeElement === ta) ta.blur();
          renderRail(); focusCard(t.id); toast("Reply sent." + sentNote());
        }, function () {});
      };
      var closeBox = function () { delete S.open[t.id]; delete S.replies[t.id]; S.forceThreads = true; renderRail(); focusCard(t.id); };
      var armed = false;
      ta.addEventListener("input", function () { armed = false; });
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reply(); }
        // Esc closes an empty box at once, and one with words on a second press.
        if (e.key === "Escape") {
          e.preventDefault();
          if (ta.value.trim() && !armed) { armed = true; toast("Press Esc again to discard this reply"); return; }
          closeBox();
        }
      });
      if (S.open[t.id] === "focus") { S.open[t.id] = true; setTimeout(function () { ta.focus(); }, 0); }
      body.push(ta);
    }
    if (!S.readOnly) body.push(h("div", { cls: "thread-acts" }, [
      open ? h("span", { cls: "hint", text: "⌘ Enter sends" }) : null,
      open ? h("button", { cls: "act", text: "Cancel", on: { click: function () { delete S.open[t.id]; delete S.replies[t.id]; S.forceThreads = true; renderRail(); focusCard(t.id); } } }) : null,
      t.resolved ? null : open
        ? h("button", { cls: "act primary", "data-fk": "send:" + t.id, text: "Send", on: { click: function () { reply(); } } })
        : h("button", { cls: "act", "data-fk": "reply:" + t.id, text: "Reply", on: { click: function () { S.open[t.id] = "focus"; S.focus = t.id; S.forceThreads = true; renderRail(); } } }),
      h("button", { cls: "act", "data-fk": "res:" + t.id, text: t.resolved ? "Reopen" : "Resolve", on: { click: function () {
        S.forceThreads = true;
        send({ op: t.resolved ? "reopen" : "resolve", item: t.id, text: (S.replies[t.id] || "").trim() }).then(function () {
          delete S.replies[t.id]; delete S.open[t.id]; S.forceThreads = true; renderRail(); focusCard(t.id); toast(t.resolved ? "Reopened." : "Resolved.");
        }, function () {});
      } } })]));
    // A card is reachable by keyboard: Tab to it, Enter shows it in full.
    var pick = function () { S.focus = t.id; S.scrollTo = ""; S.forceThreads = true; renderRail(); focusCard(t.id); };
    return h("div", { cls: "thread" + (t.resolved ? " resolved" : "") + (waitsHere(t) ? " waits" : "") + (focused ? " focus" : ""), id: "thread-" + t.id,
      tabindex: "0", "data-fk": "thread:" + t.id, "aria-label": "Thread " + num(t) + ", " + state + ", " + where,
      on: { click: function (e) { if (e.target.closest("button,textarea,a")) return; pick(); },
            keydown: function (e) { if (e.target === e.currentTarget && e.key === "Enter") { e.preventDefault(); pick(); } } } }, body);
  }

  function markFocus() {
    document.querySelectorAll("#threads .thread").forEach(function (el) { el.classList.toggle("focus", el.id === "thread-" + S.focus); });
    var el = S.focus && document.getElementById("thread-" + S.focus);
    if (el && S.scrollTo === S.focus) { S.scrollTo = ""; el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }

  $("threads").addEventListener("focusout", function () {
    setTimeout(function () {
      var a = document.activeElement;
      // Only once focus has left the threads altogether: moving from a box to
      // its own Send or Cancel must not redraw that button out from under the click.
      if (S.threadsStale && !(a && $("threads").contains(a))) { S.forceThreads = true; window.chartroomThreads.render(S, T); }
    }, 0);
  });

  window.chartroomThreads = {
    // opts.noPlace: a redraw for a "placed" answer must not ask the frames to
    // place again, or the two would answer each other forever.
    render: function (S_, T_, opts) {
      renderPickSlot();
      renderNarrowBar();
      var box = $("threads");
      // Typed words live in S.draft and S.replies, so a redraw keeps them; it
      // is held back only while a box has focus, to keep the caret steady.
      var typingIn = document.activeElement && box.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
      // Held back while a box has focus; drawn the moment focus leaves it.
      if (typingIn && !S.forceThreads) { S.threadsStale = true; return; }
      S.forceThreads = false; S.threadsStale = false;
      keepFocus(function () {
        box.textContent = "";
        var c = S.detail && S.detail.chart;
        if (!c) return;
        var v = version(c, S.n);
        var p = v && paneIn(v, S.key, 0);
        var all = threadsNow().slice().sort(function (a, b) { return (waits(b) - waits(a)) || (a.resolved - b.resolved) || (num(a) - num(b)); });
        if (S.readOnly) box.appendChild(h("p", { cls: "ro small", text: /connecting/.test(S.room.mode) ? "Connecting to this page's comments…" : "This copy is view only: comments and picks can't be saved here." }));
        else if (S.room && /^published/.test(S.room.mode)) box.appendChild(h("p", { cls: "quiet small", text: "Comments here reach Claude when the chart's owner pulls them." }));
        if (S.draft) box.appendChild(composer(S.draft));
        var isHere = function (t) { return p && t.pane === p.key && t.version <= S.n; };
        // What waits on the person comes first, wherever it is in the chart.
        var waiting = all.filter(waitsHere);
        var here = all.filter(function (t) { return isHere(t) && waiting.indexOf(t) < 0; });
        var elsewhere = all.filter(function (t) { return !isHere(t) && waiting.indexOf(t) < 0; });
        if (!p) box.appendChild(h("p", { cls: "quiet small", text: "Comments open once this chart has a version." }));
        else if (!all.length && !S.draft) box.appendChild(h("p", { cls: "quiet small", text: S.readOnly ? "No comments on this chart." : "No comments yet. Press c or Pin comment, then click the chart." }));
        if (waiting.length) {
          box.appendChild(h("h3", { cls: "sub attend", text: "Waits on you (" + waiting.length + ")" }));
          waiting.forEach(function (t) { box.appendChild(threadCard(t, isHere(t))); });
          if (here.length) box.appendChild(h("h3", { cls: "sub", text: "On this view (" + here.length + ")" }));
        }
        here.forEach(function (t) { box.appendChild(threadCard(t, true)); });
        if (elsewhere.length) {
          box.appendChild(h("h3", { cls: "sub", text: "Elsewhere in this chart (" + elsewhere.length + ")" }));
          elsewhere.forEach(function (t) { box.appendChild(threadCard(t, false)); });
        }
        if (p && !S.readOnly && !S.draft) box.appendChild(h("button", { cls: "link", "data-fk": "whole", text: "Comment on the whole view instead", on: { click: function () {
          S.draft = { version: v.n, pane: p.key, pin: null, text: "" }; S.forceThreads = true; renderRail();
        } } }));
      });
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
        // Never while a box has focus: the change is drawn when focus leaves it.
        if (from === shownFrame() && was !== gone.join(",")) {
          var a = document.activeElement;
          if (a && $("threads").contains(a) && a.tagName === "TEXTAREA") S.threadsStale = true;
          else { S.forceThreads = true; window.chartroomThreads.render(S, T, { noPlace: true }); }
        }
      }
      if (m.type === "pin" && S.pinMode && from === shownFrame() && m.pin && typeof m.pin.path === "string") {
        var keep = S.draft && S.draft.text;
        S.draft = { version: from.n, pane: from.key, text: keep || "", pin: { path: String(m.pin.path).slice(0, 600), dx: Number(m.pin.dx) || 0, dy: Number(m.pin.dy) || 0, text: String(m.pin.text || "").slice(0, 120) } };
        setPinMode(false);
        S.forceThreads = true; renderRail(); placePins(from); setSheet(true); renderNarrowBar();
      }
      if (m.type === "focus" && Number.isFinite(m.n)) { S.focus = "t" + m.n; S.scrollTo = S.focus; S.forceThreads = true; renderRail(); setSheet(true); }
    },
    key: function (k, down) {
      if (!down) return false;
      if (k === "c") { if (!S.readOnly) setPinMode(!S.pinMode); return true; }
      if (k === "Escape" && S.pinMode) { setPinMode(false); return true; }
      if (k === "Escape" && S.draft && !(S.draft.text || "").trim()) { dropDraft(); return true; }
      return false;
    },
  };

  window.chartroomStudio = { S: S, T: T, h: h, toast: toast, refresh: refresh, renderChart: renderChart, version: version, paneIn: paneIn };
  window.addEventListener("hashchange", function () { var w = readHash(); if (w.id) select(w.id, w.n, w.key); });
  refresh();
  // A published page hears its rows through the transport, not a poll.
  if (T.subscribe) T.subscribe(function () { refresh(); });
  if (T.live) {
    var tick = function () { setTimeout(function () { refresh().then(tick, tick); }, document.hidden ? 10000 : 2000); };
    tick();
  }
})();
