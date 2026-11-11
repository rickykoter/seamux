// The run page's drawing (crew/board/run.html, served by crew-board's
// run_page.rs). The page is drawn from (run, t): the run as its adapter last
// reported it (seamux.run/1, docs/RUNS.md) and a moment t, which is now
// while it runs and the scrubber's time once it has ended. Everything that
// can be worked out without a page (each agent's state at t, the slots,
// whether a label fits its bar) is in `model`, which the board probe runs
// in node; the rest draws it.
//
// Updates go by keyed elements: a bar, a result and a card are found by the
// agent's id and changed in place, so a new report moves bars rather than
// redrawing them, and an open section stays open.
(function (root) {
  "use strict";

  // ---- the model: no DOM -------------------------------------------------
  // An agent's state at t: queued before it started, running (or waiting
  // on you) until it ended, then whatever it ended as.
  function stateAt(a, t) {
    if (!(a.start > 0) || t < a.start) return "queued";
    if (a.end > 0 && t >= a.end) return a.state === "running" ? "done" : a.state;
    if (a.state !== "running" && !(a.end > 0)) return a.state;
    return a.needsYou ? "need" : "running";
  }
  // The span the swimlane draws: the run's start to its end, or to now.
  function span(run, now) {
    var as = (run.agents || []).filter(function (a) { return a.start > 0; });
    var t0 = run.start > 0 ? run.start : Math.min.apply(null, as.map(function (a) { return a.start; }).concat([now]));
    var t1 = run.status === "running" ? now : run.end > 0 ? run.end
      : Math.max.apply(null, as.map(function (a) { return a.end || a.start; }).concat([t0 + 1000]));
    return [t0, Math.max(t1, t0 + 1000)];
  }
  // Slots: each started agent in the first slot free at its start. A slot
  // once given is kept (`keep`, by agent id), so a bar never jumps lanes as
  // the run goes on; a running agent holds its slot until it ends.
  function pack(agents, keep, now) {
    var ends = [];
    var out = {};
    var started = agents.filter(function (a) { return a.start > 0; })
      .sort(function (a, b) { return a.start - b.start || (a.id < b.id ? -1 : 1); });
    var endOf = function (a) { return a.end > 0 ? a.end : a.state === "running" ? Infinity : a.start; };
    started.forEach(function (a) {
      var k = keep && keep[a.id] != null ? keep[a.id] : -1;
      if (k < 0 || (ends[k] != null && ends[k] > a.start)) {
        k = 0;
        while (ends[k] != null && ends[k] > a.start) k++;
      }
      out[a.id] = k;
      ends[k] = Math.max(ends[k] || 0, endOf(a));
    });
    void now;
    return out;
  }
  // How many agents ran at once, as steps over the span: [[t, n], ...].
  function concurrency(agents, t0, t1) {
    var ev = [];
    agents.forEach(function (a) {
      if (!(a.start > 0)) return;
      ev.push([Math.max(a.start, t0), 1]);
      // One still running at t1 has not ended yet: it counts to the end.
      if (a.end > 0 && a.end < t1) ev.push([a.end, -1]);
    });
    ev.sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
    var n = 0, pts = [[t0, 0]];
    ev.forEach(function (e) { n += e[1]; pts.push([e[0], n]); });
    pts.push([t1, n]);
    return pts;
  }
  // Whether a label (and its badge) fits inside a bar this wide, in px,
  // at about 6.6px a character of 11.5px system type, plus the padding.
  function textPx(label, badge) { return 10 + label.length * 6.6 + (badge ? 8 + badge.length * 7 : 0); }
  function fits(label, badge, px) { return px >= textPx(label, badge); }
  // Where each bar's label goes, one slot's bars at a time ([{id, left,
  // width} in px, by start]): "in" when it fits the bar, "out" (to its
  // right) when it fits before the next bar in the slot, else "cut" (in the
  // bar, cut short): a label never covers another bar's.
  function place(items) {
    var out = {};
    items.forEach(function (it, i) {
      var next = items[i + 1];
      var room = next ? next.left - (it.left + it.width) - 8 : Infinity;
      out[it.id] = fits(it.label, it.badge, it.width) ? "in" : textPx(it.label, it.badge) <= room ? "out" : "cut";
    });
    return out;
  }
  function took(ms) {
    var s = Math.floor(Math.max(0, ms) / 1000), m = Math.floor(s / 60);
    return s < 60 ? s + "s" : m < 60 ? m + "m " + (s % 60 < 10 ? "0" : "") + (s % 60) + "s"
      : Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function tokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n); }
  // Each phase's counts at t, in the run's order (then any an agent names).
  function phaseCounts(run, t) {
    var names = (run.phases || []).slice();
    (run.agents || []).forEach(function (a) { if (a.phase && names.indexOf(a.phase) < 0) names.push(a.phase); });
    return names.map(function (p) {
      var c = { name: p, n: 0, done: 0, running: 0, need: 0, failed: 0, queued: 0 };
      (run.agents || []).forEach(function (a) {
        if (a.phase !== p) return;
        var s = stateAt(a, t);
        c.n++;
        if (s === "done") c.done++;
        else if (s === "running") c.running++;
        else if (s === "need") c.need++;
        else if (s === "failed" || s === "cancelled") c.failed++;
        else c.queued++;
      });
      return c;
    });
  }
  var model = { stateAt: stateAt, span: span, pack: pack, concurrency: concurrency, fits: fits, place: place, took: took, phaseCounts: phaseCounts };
  root.__runPage = model;
  if (typeof document === "undefined" || !document.getElementById || !document.getElementById("lanes")) return;

  // ---- the page ------------------------------------------------------------
  var boot = {};
  try { boot = JSON.parse(document.getElementById("boot").textContent); } catch (e) { boot = {}; }
  var $ = function (id) { return document.getElementById(id); };

  // Opened from the session page: a way back to it.
  var back = "";
  try { back = new URLSearchParams(location.search).get("back") || ""; } catch (e) { back = ""; }
  if (!/^\/runs\/[A-Za-z0-9_.-]+$/.test(back)) back = "";
  if (back && $("back")) {
    $("back").href = back;
    $("back").hidden = false;
    $("back").textContent = "← All agents";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var CLS = { queued: "", running: "run", need: "need", done: "ok", failed: "bad", cancelled: "cancelled" };
  // One mark per state, used by the pipeline's cards: a sprite can stand in
  // for it later without touching anything else.
  function mark(state) {
    var col = { running: "var(--run)", need: "var(--need)", done: "var(--ok)", failed: "var(--bad)" }[state] || "var(--idle)";
    var fill = state === "done" || state === "failed" ? col : "none";
    return '<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" fill="' + fill +
      '" stroke="' + col + '" stroke-width="1.6"' + (state === "queued" ? ' stroke-dasharray="2 1.6"' : "") + "/></svg>";
  }

  var run = null, slots = {}, replayT = null, lanes = $("lanes");
  var bars = {}, labs = {};
  function now() { return Date.now(); }
  function tOf() { return replayT != null ? replayT : now(); }
  function openAgent(a) {
    if (!a || !a.transcript) return;
    location.href = "/agent/" + encodeURIComponent(boot.session || "") + "/" + encodeURIComponent(a.id) +
      "?back=" + encodeURIComponent(location.pathname + (back ? "?back=" + encodeURIComponent(back) : ""));
  }

  function drawHeader(t) {
    var A = run.agents || [];
    document.title = (run.name || "Run") + " · run";
    $("name").textContent = run.name || run.id;
    var st = replayT != null && replayT < span(run, now())[1] ? "running" : run.status;
    $("status").className = "pill " + esc(st);
    $("status").textContent = replayT != null && st === "running" ? "replay" : st;
    var c = { done: 0, running: 0, need: 0, failed: 0, queued: 0 };
    A.forEach(function (a) { var s = stateAt(a, t); c[s === "cancelled" ? "failed" : s] = (c[s === "cancelled" ? "failed" : s] || 0) + 1; });
    var sp = span(run, now());
    var bits = ["<span><b>" + took(Math.min(t, sp[1]) - sp[0]) + "</b> " + (run.status === "running" && replayT == null ? "so far" : "") + "</span>",
      "<span><b>" + c.done + "</b>/" + A.length + " done</span>"];
    if (c.running) bits.push("<span><b>" + c.running + "</b> running</span>");
    if (c.queued) bits.push("<span>" + c.queued + " queued</span>");
    if (c.failed) bits.push('<span style="color:var(--bad-t)"><b>' + c.failed + "</b> failed</span>");
    var tok = run.totals && run.totals.tokens;
    if (tok > 0) bits.push("<span>" + tokens(tok) + " tokens</span>");
    if (run.source) bits.push("<span>via " + esc(run.source) + "</span>");
    $("meta").innerHTML = bits.join("");
    $("phases").innerHTML = phaseCounts(run, t).map(function (p) {
      var w = function (k) { return p.n ? (100 * p[k] / p.n).toFixed(2) + "%" : "0"; };
      return '<div class="ph"><div class="pt"><b>' + esc(p.name) + "</b><span>" + (p.done + p.failed) + "/" + p.n + '</span></div><div class="seg">' +
        '<i class="ok" style="width:' + w("done") + '"></i><i class="bad" style="width:' + w("failed") + '"></i>' +
        '<i class="need" style="width:' + w("need") + '"></i><i class="run" style="width:' + w("running") + '"></i></div></div>';
    }).join("");
    var need = A.filter(function (a) { return stateAt(a, t) === "need"; });
    $("need").hidden = !need.length;
    $("need").textContent = need.length ? (need.length === 1 ? need[0].label + " needs you" : need.length + " agents need you: " +
      need.map(function (a) { return a.label; }).join(", ")) : "";
    $("notice").hidden = !run.notice;
    $("notice").textContent = run.notice || "";
  }

  function drawLanes(t) {
    var A = run.agents || [];
    var sp = span(run, now()), t0 = sp[0], t1 = sp[1], W = lanes.clientWidth || 800;
    var x = function (ms) { return ((ms - t0) / (t1 - t0)) * 100; };
    slots = pack(A, slots, now());
    var nSlots = 0;
    Object.keys(slots).forEach(function (k) { nSlots = Math.max(nSlots, slots[k] + 1); });
    $("empty").hidden = nSlots > 0;
    if (!nSlots) $("empty").textContent = A.length ? "Nothing has started yet." : "This run has no agents.";
    var have = lanes.querySelectorAll(".slot");
    for (var i = have.length; i < nSlots; i++) {
      var s = document.createElement("div");
      s.className = "slot";
      lanes.appendChild(s);
    }
    for (var j = have.length - 1; j >= nSlots; j--) have[j].remove();
    var rows = lanes.querySelectorAll(".slot");
    var seen = {}, bySlot = {};
    A.forEach(function (a) {
      if (!(a.id in slots)) return;
      var st = stateAt(a, t);
      if (st === "queued") { if (bars[a.id]) bars[a.id].style.display = "none"; if (labs[a.id]) labs[a.id].style.display = "none"; return; }
      seen[a.id] = 1;
      var end = st === "running" || st === "need" ? t : Math.min(a.end || a.start, t);
      var left = x(a.start), width = Math.max(0, x(end) - x(a.start));
      var b = bars[a.id];
      if (!b) {
        b = document.createElement("div");
        b.setAttribute("data-id", a.id);
        b.tabIndex = 0;
        b.innerHTML = '<span class="bl"></span><span class="bb"></span>';
        bars[a.id] = b;
        var l = document.createElement("div");
        l.className = "lab";
        labs[a.id] = l;
      }
      var row = rows[slots[a.id]];
      if (b.parentNode !== row) { row.appendChild(b); row.appendChild(labs[a.id]); }
      b.style.display = labs[a.id].style.display = "";
      b.className = "bar " + (CLS[st] || "") + (a.transcript ? "" : " notr");
      b.style.left = left + "%";
      b.style.width = width + "%";
      var badge = st === "done" || st === "failed" ? (a.result && a.result.badge) || "" : "";
      (bySlot[slots[a.id]] = bySlot[slots[a.id]] || []).push({ id: a.id, label: a.label || a.id, badge: badge,
        left: (left / 100) * W, width: (width / 100) * W, at: left + width });
      b.setAttribute("aria-label", (a.label || a.id) + ", " + st + (badge ? ", " + badge : ""));
    });
    Object.keys(bySlot).forEach(function (k) {
      var items = bySlot[k].sort(function (p, q) { return p.left - q.left; });
      var where = place(items);
      items.forEach(function (it) {
        var b = bars[it.id], lab = labs[it.id], w = where[it.id];
        b.firstChild.textContent = w === "out" ? "" : it.label;
        b.lastChild.textContent = w === "in" ? it.badge : "";
        lab.hidden = w !== "out";
        lab.innerHTML = w === "out" ? esc(it.label) + (it.badge ? "<b>" + esc(it.badge) + "</b>" : "") : "";
        lab.style.left = "calc(" + it.at + "% + 4px)";
      });
    });
    Object.keys(bars).forEach(function (id) {
      if (!seen[id] && !A.some(function (a) { return a.id === id && a.id in slots; })) { bars[id].remove(); labs[id].remove(); delete bars[id]; delete labs[id]; }
    });
    // The now line, while the run goes or the scrubber is back in time.
    var nowEl = $("now");
    nowEl.hidden = !(run.status === "running" || replayT != null);
    nowEl.style.left = x(Math.min(t, t1)) + "%";
    drawAxis(t0, t1);
    drawCap(A, t0, Math.min(t, t1), t1, nSlots);
  }

  function drawAxis(t0, t1) {
    var span_ = t1 - t0, steps = [1e3, 2e3, 5e3, 10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3];
    var step = steps.filter(function (s) { return span_ / s <= 6; })[0] || 7200e3;
    var out = ['<span class="first" style="left:0">0</span>'];
    for (var s = step; s < span_ - step * 0.4; s += step) out.push('<span style="left:' + (100 * s / span_).toFixed(2) + '%">' + took(s).replace(" 00s", "") + "</span>");
    $("axis").innerHTML = out.join("");
  }

  function drawCap(A, t0, t, t1, nSlots) {
    var pts = concurrency(A.filter(function (a) { return a.start > 0 && a.start <= t; }).map(function (a) {
      return { start: a.start, end: a.end > 0 && a.end <= t ? a.end : 0 };
    }), t0, t);
    var peak = Math.max(run.cap || 0, nSlots, 1);
    var X = function (ms) { return ((ms - t0) / (t1 - t0)) * 1000; }, Y = function (n) { return 30 - (n / peak) * 26; };
    var d = "M0 30", last = 0;
    pts.forEach(function (p) { d += " L" + X(p[0]).toFixed(1) + " " + Y(last).toFixed(1) + " L" + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1); last = p[1]; });
    d += " L" + X(t).toFixed(1) + " 30 Z";
    var cap = run.cap > 0 ? '<line class="lim" x1="0" x2="1000" y1="' + Y(run.cap) + '" y2="' + Y(run.cap) + '"/>' : "";
    $("cap").setAttribute("viewBox", "0 0 1000 30");
    $("cap").innerHTML = '<path class="area" d="' + d + '"/>' + cap;
    var nowN = pts.length ? pts[pts.length - 1][1] : 0;
    $("capl").textContent = nowN + " at once" + (run.cap > 0 ? " · cap " + run.cap : "");
  }

  // Results and the pipeline, keyed by agent id; drawn whether folded or not.
  function drawBelow(t) {
    var A = run.agents || [];
    var fin = A.filter(function (a) { var s = stateAt(a, t); return s === "done" || s === "failed"; })
      .sort(function (a, b) { return (a.end || 0) - (b.end || 0); });
    var ul = $("res"), held = {};
    for (var c = ul.firstChild; c; c = c.nextSibling) held[c.getAttribute("data-id")] = c;
    fin.forEach(function (a) {
      var li = held[a.id] || document.createElement("li");
      var r = a.result || {};
      li.setAttribute("data-id", a.id);
      li.className = stateAt(a, t) === "failed" ? "bad" : "";
      li.innerHTML = '<span class="rb">' + esc(r.badge || (stateAt(a, t) === "failed" ? "failed" : "–")) + '</span><span class="rl">' +
        esc(a.label) + '</span><span class="rd">' + esc(String(r.detail || "").split("\n")[0]) + "</span>";
      ul.appendChild(li);
      delete held[a.id];
    });
    Object.keys(held).forEach(function (k) { held[k].remove(); });
    $("resd").querySelector("summary").textContent = "Results · " + fin.length;
    var cols = phaseCounts(run, t);
    if (!cols.length) cols = [{ name: "Agents", n: A.length }];
    $("pipe").innerHTML = cols.map(function (p) {
      var mine = A.filter(function (a) { return cols.length === 1 && !a.phase ? true : a.phase === p.name; });
      return '<div class="col"><h4>' + esc(p.name) + "<span>" + mine.length + "</span></h4>" + mine.map(function (a) {
        var s = stateAt(a, t), b = s === "done" && a.result && a.result.badge;
        return '<div class="card" data-id="' + esc(a.id) + '">' + mark(s) + '<span class="cl">' + esc(a.label) + "</span>" +
          (b ? '<span class="cb">' + esc(b) + "</span>" : "") + "</div>";
      }).join("") + "</div>";
    }).join("");
  }

  function drawReplay() {
    var ended = run.status !== "running";
    $("replay").hidden = !ended;
    if (!ended) replayT = null;
  }

  function draw() {
    if (!run) return;
    drawReplay();
    var t = tOf();
    drawHeader(t);
    drawLanes(t);
    drawBelow(t);
    if (replayT != null) {
      var sp = span(run, now());
      $("at").textContent = took(replayT - sp[0]);
    } else $("at").textContent = "";
  }

  // ---- hover, clicks, the scrubber -------------------------------------
  var tip = $("tip");
  function agentOf(el) {
    var n = el && el.closest && el.closest("[data-id]");
    var id = n && n.getAttribute("data-id");
    return id && run ? (run.agents || []).filter(function (a) { return a.id === id; })[0] : null;
  }
  lanes.addEventListener("mousemove", function (e) {
    var a = agentOf(e.target);
    if (!a || !e.target.closest(".bar")) { tip.hidden = true; return; }
    var t = tOf(), s = stateAt(a, t), end = s === "running" || s === "need" ? t : a.end || a.start;
    var det = a.result && a.result.detail ? String(a.result.detail).split("\n").slice(0, 12).join("\n") : "";
    tip.innerHTML = '<div class="th">' + esc(a.label) + '</div><div class="tm">' + esc([s, a.model, a.phase, took(end - a.start),
      a.tokens > 0 ? tokens(a.tokens) + " tokens" : ""].filter(Boolean).join(" · ")) + "</div>" +
      (det ? '<div class="td">' + esc(det) + "</div>" : "");
    tip.hidden = false;
    var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8), y = e.clientY + 16;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 10;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  });
  lanes.addEventListener("mouseleave", function () { tip.hidden = true; });
  function clickOpen(e) { var a = agentOf(e.target); if (a) openAgent(a); }
  lanes.addEventListener("click", clickOpen);
  lanes.addEventListener("keydown", function (e) { if (e.key === "Enter") clickOpen(e); });
  $("res").addEventListener("click", clickOpen);
  $("pipe").addEventListener("click", clickOpen);
  $("scrub").addEventListener("input", function (e) {
    if (!run) return;
    var sp = span(run, now()), v = Number(e.target.value) / 1000;
    replayT = v >= 1 ? null : sp[0] + v * (sp[1] - sp[0]);
    draw();
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(function () { draw(); }).observe(lanes);

  // ---- data: the first read, then the run's own event feed ------------------
  function gone(why) {
    $("empty").hidden = false;
    $("empty").textContent = why;
  }
  function take(v) {
    if (v && v.gone) return gone("No adapter reports this run any more.");
    if (v && v.error) return gone("The run could not be read: " + v.error);
    run = v;
    draw();
  }
  var base = "/run/" + encodeURIComponent(boot.session || "") + "/" + encodeURIComponent(boot.id || "");
  var tok = "?t=" + encodeURIComponent(boot.t || "");
  fetch(base + "/data" + tok, { cache: "no-store" }).then(function (r) {
    return r.json().then(function (v) { return r.ok ? take(v) : gone(v.error || "This run could not be found."); });
  }).catch(function () { gone("The intent server is not answering."); });
  if (typeof EventSource === "function") {
    var es = new EventSource(base + "/events" + tok);
    es.addEventListener("run", function (e) { try { take(JSON.parse(e.data)); } catch (x) { /* a torn event: the next one carries it */ } });
  }
  // A running run's bars grow with the clock between reports.
  setInterval(function () { if (run && run.status === "running" && replayT == null) draw(); }, 1000);
})(this);
