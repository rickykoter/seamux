// The board's click targets. PUSHED with every update, like the renderer, and for
// the same reason: nothing may depend on a script being resident in the page.
//
// Restores the affordances the Swift sidebar had. Its taxonomy, which this mirrors:
//
//   whole row            cmux("workspace.select")          -> a=row
//   chipJump             cmux("workspace.select")          -> a=jump
//   PR number            openURL(pr.url)                   -> a=pr
//   CI chip              openURL(pr.url + "/checks")       -> a=checks
//   branch text          cmux("notification.create" crew:code)  -> a=code
//   reclaim chip         crew:reclaim (asks before deleting)    -> a=reclaim
//                        (framed by an app that says it can: its own wizard)
//   plan / review        openURL(file:// plan page)        -> a=plan
//   go N                 crew:plan-go                      -> a=go&x=N
//   parent goes · inc N  the same go, on a delegated child    -> a=go&x=N
//   sandbox chip         crew:sandbox-up / -down           -> a=sandbox-up|-down
//   feed allow / deny    crew:feed-allow / crew:feed-deny  -> a=feed-allow|-deny
//   the sync clock       crew:sync-now                     -> a=sync
//
// One verb never leaves the page: a=fold, on every card's header. It folds or
// unfolds the card in place and sends nothing. Where a click lands decides
// what it does:
//
//   the rail (left edge)    jump, folded or not          -> a=jump
//   the header              fold / unfold                -> a=fold
//   a folded card, anywhere unfold
//   an unfolded card's body select the workspace         -> a=row
//
// What was folded by hand lives on #rows as data-fold, id -> [open, tier],
// which render.js reads on the next push so the choice holds.
//
// Two ways an element declares itself a target:
//   data-a="verb" [data-x="arg"]   explicit -- branch, PR, every signal chip
//   a .chip whose LABEL is in MAP  the tier action row, which has no attributes
// The NEAREST one to the click wins. A child's filled button sits inside its
// header, which is itself a target (toggle); the button must fire its own verb.
//
// Two structural constraints, both learned the hard way:
//
//   Delegation is not a style choice. __boardRender replaces #rows.innerHTML on
//   every push, so a listener bound to a row or a chip is destroyed by the next
//   update. #rows itself survives, so ONE listener there survives with it.
//
//   The install must be idempotent across pushes without using `window` -- the
//   pushed script may run in an isolated world that does not share it. The guard
//   is an attribute on the DOM, the one thing both worlds see. Without it every
//   push would add another listener and one click would fire N commands.
function __boardIntent(cfg) {
  // Bump when the handler's behaviour changes. A plain boolean guard was an
  // upgrade trap: it stopped a push from re-attaching, so a page that was wired
  // once kept running the OLD handler forever and a fix could not reach it
  // without reloading the surface. Versioning the guard lets a push install a
  // newer handler, and the check inside the listener retires the older one --
  // which is why removeEventListener is not needed (and not possible: the old
  // function is not reachable from here).
  var V = "13";
  var host = document.getElementById("rows");
  if (!host) return "no #rows";

  // ---- affordance ------------------------------------------------------
  // Injected here rather than into board.html so that the page stays inert and
  // its probe contract is untouched. Versioned like the listener: a page wired
  // by an older handler keeps its <style> element, and its rules are replaced.
  var st = document.getElementById("intent-css");
  if (!st) {
    st = document.createElement("style");
    st.id = "intent-css";
    document.head.appendChild(st);
  }
  if (st.getAttribute("data-v") !== V) {
    st.setAttribute("data-v", V);
    st.textContent =
      ".row{cursor:pointer}" +
      ".row:not(.inert):hover{background:#2f3639}" +
      ".row:not(.inert):active{background:#374145}" +
      ".chip{cursor:pointer}" +
      ".chip:hover{filter:brightness(1.35);text-decoration:underline}" +
      ".chip.hit,.wk.hit{opacity:.45}" +
      ".wk.ok{box-shadow:inset 0 0 0 1px #a7c080}" +
      ".wk.bad{box-shadow:inset 0 0 0 1px #e67e80}" +
      ".chip.ok{box-shadow:inset 0 0 0 1px #a7c080}" +
      ".chip.bad{box-shadow:inset 0 0 0 1px #e67e80}" +
      // A delegated child's go: its parent is expected to give it, so it is
      // muted, never filled or breathing -- but still a button a person can
      // press. render.js titles an unknown label with the label itself.
      '.row .chip.chip[title^="parent goes"]{background:transparent;border-color:#4f585e;' +
      'color:#9da9a0;font-weight:500;animation:none}' +
      "#stamp{cursor:pointer}#stamp:hover{text-decoration:underline}" +
      // A child sits on its family's darker well; hover lifts it from there.
      ".kids>.row.kid:not(.inert):hover{background:#323b40}" +
      ".kidhd.hit{opacity:.6}" +
      // A fold header is a target even on an inert card: a family's shell.
      "[data-a=fold]{cursor:pointer}" +
      ".jmp.hit{opacity:.6}" +
      ".jmp.ok{box-shadow:inset 0 0 0 2px #a7c080}.jmp.bad{box-shadow:inset 0 0 0 2px #e67e80}" +
      // A row that cannot be acted on must not pretend otherwise: no pointer
      // and no hover. It keeps its card ground -- a family's shell card is
      // inert and is still a card.
      ".row.inert{cursor:default}" +
      // Framed by the seamux app: the workspace the app shows beside the board.
      ".row.appsel{outline:2px solid #dbbc7f;outline-offset:-2px;background:#2f3639}" +
      // Why a click failed, for a few seconds: the red flash alone said nothing.
      "#intent-toast{position:fixed;left:12px;right:12px;bottom:12px;z-index:50;padding:8px 12px;" +
      "border-radius:6px;background:#3a2a2c;border:1px solid #e67e80;color:#f2d4d4;font:12px/1.4 system-ui,sans-serif;" +
      "pointer-events:none}#intent-toast[hidden]{display:none}";
  }

  // ---- the chip vocabulary --------------------------------------------
  // Keys are the labels the collector emits. A label with no entry here is left
  // unclickable rather than guessed at, so a new chip is inert, never wrong.
  var MAP = {
    "jump": "jump", "diff": "diff", "pr": "pr", "checks": "checks",
    "plan": "plan", "review": "plan", "take the check": "take the check",
    "reclaim": "reclaim", "close plan": "close plan", "code": "code",
    "archive": "archive", "wake": "wake"
  };

  // The verbs the app answers itself when it frames the board, and what it shows.
  var SHOWN = { "row": "any", "jump": "any", "plan": "plan", "wake": "wake" };

  function target(el) {
    // The nearest target to the click wins, explicit or chip: a family child's
    // filled button sits inside its header, which is itself a target (toggle),
    // and the button must fire its own verb. On the element it lands on, an
    // explicit data-a beats the label -- that is how the branch, the PR number
    // and every signal declare what they do, so a new target is one attribute
    // in render.js rather than a new entry in the table above, and it cannot
    // drift, because there is no label to match.
    var hit = el.closest && el.closest("[data-a], .chip");
    if (hit && hit.getAttribute("data-a")) {
      return { a: hit.getAttribute("data-a"),
               x: hit.getAttribute("data-x") || "", el: hit };
    }
    // A rail with nowhere to jump is colour, not a target: it neither jumps
    // nor stands in for the card around it.
    if (el.closest && el.closest(".jmp")) return null;
    var chip = hit;
    if (chip) {
      var label = (chip.textContent || "").trim();
      var m = /^(?:go|parent goes \u00b7 inc)\s+(\d+)$/.exec(label);
      if (m) return { a: "go", x: m[1], el: chip };
      if (MAP[label]) return { a: MAP[label], x: "", el: chip };
      return null;                       // an unknown chip stays inert
    }
    var row = el.closest && el.closest(".row");
    if (!row) return null;
    // Folded, the whole card opens; unfolded, its body is the card itself and
    // selects the workspace -- the header above it is what folds it again.
    if (row.classList.contains("fd") && !row.classList.contains("open")) return { a: "fold", x: "", el: row };
    if (!row.classList.contains("inert")) return { a: "row", x: "", el: row };
    return null;
  }

  // Read at CLICK time, never captured in a closure. The listener is installed
  // once and outlives every push, but the server's port and token do NOT: the
  // port is claimed fresh whenever the server restarts. A handler that closed
  // over cfg kept talking to a dead port, and because the install guard stops a
  // later push from re-attaching, nothing would ever have corrected it -- clicks
  // just silently stopped. The DOM is the one place both the pushed script and
  // the resident listener can see.
  function live() {
    try { return JSON.parse(host.getAttribute("data-intent-cfg") || "{}"); }
    catch (e) { return {}; }
  }

  function fire(t, rid) {
    var c = live();
    if (!c.port) return;
    var url = "http://127.0.0.1:" + c.port + "/do?t=" + encodeURIComponent(c.token) +
      "&a=" + encodeURIComponent(t.a) + "&r=" + encodeURIComponent(rid) +
      "&x=" + encodeURIComponent(t.x || "");
    var el = t.el;
    el.classList.add("hit");
    function done(cls, why) {
      el.classList.remove("hit");
      if (!cls) return;
      el.classList.add(cls);
      // Long enough to see, short enough that the next push is not fighting it.
      setTimeout(function () { el.classList.remove(cls); }, 1200);
      if (why) say(el, why);
    }
    fetch(url).then(function (r) {
      // A refusal is JSON too ({error}); anything else is said by its status.
      return Promise.resolve().then(function () { return r.json(); }).then(function (j) { return j || {}; },
        function () { return { ok: false, detail: "the server answered " + r.status }; });
    }, function () { return null; })
      .then(function (j) {
        // No answer at all: the server is not up. Say so on the element the
        // human just pressed; a silent no-op is the regression we are fixing.
        if (!j) return done("bad", "server not reachable");
        if (j.ok) return done("ok");
        done("bad", String(j.detail || j.error || "that did not work"));
      });
  }

  // Why a click failed: on the element (its title) and in a toast, for a few
  // seconds. The toast is outside #rows, so a push does not wipe it.
  var toastTimer = 0;
  function say(el, why) {
    var prev = el.getAttribute ? el.getAttribute("title") : null;
    el.title = why;
    setTimeout(function () { if (el.title === why) el.title = prev || ""; }, 4000);
    if (!document.body || !document.createElement) return;
    var box = document.getElementById("intent-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "intent-toast";
      box.setAttribute("role", "status");
      document.body.appendChild(box);
    }
    box.textContent = why;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 4000);
  }

  // Fold or unfold a card in place. The class flips now, so the card changes
  // under the pointer instead of on the next push; data-fold is what the next
  // push reads, with the tier the card had, so render.js can drop the choice
  // when the card moves tier. Sends nothing: the rail is the jump.
  function fold(row, rid) {
    var f = {};
    try { f = JSON.parse(host.getAttribute("data-fold") || "{}"); } catch (e) { f = {}; }
    if (!f || typeof f !== "object" || Array.isArray(f)) f = {};
    var open = !row.classList.contains("open");
    if (open) row.classList.add("open");
    else row.classList.remove("open");
    f[rid] = [open ? 1 : 0, row.getAttribute("data-k") || ""];
    host.setAttribute("data-fold", JSON.stringify(f));
  }

  // The ⋯ menu that is open, if any: shut, and forgotten for the next push.
  function shutMenu() {
    host.setAttribute("data-tk-open", "");
    var open = host.querySelectorAll ? host.querySelectorAll(".row.tkopen") : [];
    for (var j = 0; j < open.length; j++) { open[j].classList.remove("tkopen"); open[j].classList.remove("tkup"); }
  }

  // ---- framed by the seamux app ----------------------------------------
  // In a frame, the app asks for the workspace it shows to be marked, and a
  // row click goes to it (above). Top-level, as cmux's Dock, none of this runs.
  function framed() {
    try {
      return typeof window !== "undefined" && !!window.parent && window.parent !== window &&
        typeof window.parent.postMessage === "function";
    } catch (e) { return false; }
  }
  // The origins allowed to frame the board (the server's frame-ancestors list).
  // Messages go to the app's origin only, never "*": they name workspaces.
  function allowed(o) {
    var p = live().parents;
    return typeof o === "string" && Object.prototype.toString.call(p) === "[object Array]" && p.indexOf(o) >= 0;
  }
  // The parent's origin: what its first message came from, else what the
  // browser says framed this page. Null when neither is an allowed one.
  function appOrigin() {
    var o = host.getAttribute("data-app-origin");
    if (o && allowed(o)) return o;
    try {
      var a = window.location && window.location.ancestorOrigins;
      if (a && a.length && allowed(a[0])) return a[0];
    } catch (e) { /* no location */ }
    return null;
  }
  // To the app, at its origin. Before that is known (no ancestorOrigins, and
  // no "selected" yet), the message waits on #rows (a push does not drop it)
  // and goes when the app's first message names its origin: framed, a click
  // meant for the app never falls through to cmux instead.
  function tell(msg) {
    var o = appOrigin();
    if (o) return window.parent.postMessage(msg, o);
    var q = [];
    try { q = JSON.parse(host.getAttribute("data-app-pending") || "[]"); } catch (e) { q = []; }
    if (Object.prototype.toString.call(q) !== "[object Array]") q = [];
    q.push(msg);
    host.setAttribute("data-app-pending", JSON.stringify(q.slice(-10)));
  }
  function flush() {
    var o = appOrigin(), q = [];
    if (!o) return;
    try { q = JSON.parse(host.getAttribute("data-app-pending") || "[]"); } catch (e) { q = []; }
    host.removeAttribute ? host.removeAttribute("data-app-pending") : host.setAttribute("data-app-pending", "[]");
    if (Object.prototype.toString.call(q) !== "[object Array]") return;
    for (var i = 0; i < q.length; i++) window.parent.postMessage(q[i], o);
  }
  function mark(ws) {
    host.setAttribute("data-app-sel", ws || "");
    if (!host.querySelectorAll) return;
    var rows = host.querySelectorAll(".row");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-id") === ws) rows[i].classList.add("appsel");
      else rows[i].classList.remove("appsel");
    }
  }
  // Refreshed on every push; the listener below is installed only once.
  host.setAttribute("data-intent-cfg", JSON.stringify({ port: cfg.port, token: cfg.token,
    parents: Object.prototype.toString.call(cfg.parents) === "[object Array]" ? cfg.parents : [] }));

  // Every push redraws the rows: mark the app's workspace again.
  if (framed()) mark(host.getAttribute("data-app-sel") || "");
  if (framed() && host.getAttribute("data-app-msg") !== V) {
    window.addEventListener("message", function (ev) {
      if (host.getAttribute("data-app-msg") !== V) return;
      var d = ev.data;
      if (ev.source === window.parent && allowed(ev.origin) && d && d.crew === "selected") {
        host.setAttribute("data-app-origin", ev.origin);
        flush();
        mark(String(d.ws || ""));
        // What the app does itself instead of cmux (its reclaim wizard). An
        // app that never says keeps every chip going to cmux.
        if (Object.prototype.toString.call(d.can) === "[object Array]") host.setAttribute("data-app-can", d.can.join(" "));
      }
    });
    host.setAttribute("data-app-msg", V);
    // Listening now: ask the app which workspace it shows. Where the browser
    // does not say who framed it, the ask goes to each allowed origin (it
    // carries nothing; the others drop it).
    var ao = appOrigin(), ps = ao ? [ao] : (live().parents || []);
    for (var pi = 0; pi < ps.length; pi++) {
      try { window.parent.postMessage({ crew: "ready" }, ps[pi]); } catch (e) { /* a bad origin */ }
    }
  }

  if (host.getAttribute("data-intent") !== V) {
    host.addEventListener("click", function (ev) {
      // A listener from a superseded version stands down instead of acting, so
      // an upgraded page fires exactly one command per click.
      if (host.getAttribute("data-intent") !== V) return;
      // A click anywhere but the ⋯ menu shuts an open one.
      if (!(ev.target.closest && ev.target.closest(".tk, .tkm"))) shutMenu();
      // The tucked section's header: remember it open or shut for the next push.
      var sum = ev.target.closest && ev.target.closest("details.tucked > summary");
      if (sum) {
        setTimeout(function () { host.setAttribute("data-tuck-open", sum.parentNode.open ? "1" : "0"); }, 0);
        return;
      }
      var t = target(ev.target);
      if (!t) return;
      var row = ev.target.closest(".row");
      var rid = row && row.getAttribute("data-id");
      if (!rid) return;
      // A chip is a specific verb; without this the row's own "select" would
      // fire too and steal focus away from whatever the chip just opened.
      ev.preventDefault();
      ev.stopPropagation();
      if (t.a === "fold") return fold(row, rid);
      // The ⋯ menu (framed by the app only): open it, or hand the choice to
      // the app, which keeps tucked.json and says what it did, with Undo.
      if (t.a === "tk") {
        var openNow = !row.classList.contains("tkopen");
        shutMenu();
        if (openNow) {
          // Near the bottom (the news bar sits there), it opens upward.
          var r = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
          var up = !!r && typeof window.innerHeight === "number" && r.bottom > window.innerHeight - 140;
          row.classList.add("tkopen");
          if (up) row.classList.add("tkup");
          // A push redraws the rows: render.js opens it again from these.
          host.setAttribute("data-tk-open", rid);
          host.setAttribute("data-tk-up", up ? "1" : "0");
        }
        return;
      }
      if (t.a === "tuck") {
        shutMenu();
        if (framed()) {
          var nm = row.querySelector(".nm");
          tell({ crew: "tuck", ws: rid, level: t.x, name: nm ? nm.textContent : rid });
        }
        return;
      }
      // Framed by the seamux app, the clicks that go to a workspace or its
      // plan (a card's body, its rail, Plan, the Wake) show it in the app:
      // its terminal and pages beside the board. cmux is not asked to jump.
      // Every other chip still does what it does in cmux's Dock.
      // Reclaim, framed by an app with a wizard of its own: the app shows what
      // would go and asks there. Anywhere else, crew:reclaim opens a terminal.
      if (framed() && t.a === "reclaim" && (" " + (host.getAttribute("data-app-can") || "") + " ").indexOf(" reclaim ") >= 0) {
        var rn = row.querySelector ? row.querySelector(".nm") : null;
        tell({ crew: "reclaim", ws: rid, name: rn ? rn.textContent : rid });
        return;
      }
      if (framed() && SHOWN[t.a]) {
        tell({ crew: "select", ws: rid, show: SHOWN[t.a] });
        mark(rid);
        return;
      }
      fire(t, rid);
    });
    host.setAttribute("data-intent", V);
  }

  // The stamp's click has never changed, and its listener carries no version
  // check (v3's did not, and it cannot be retired from here). So it is
  // installed once per page, whatever version got there first: re-installing
  // it on an upgrade sent every sync click twice.
  var stamp = document.getElementById("stamp");
  if (stamp && !stamp.getAttribute("data-intent")) {
    stamp.title = "Force a full reconcile";
    stamp.addEventListener("click", function () {
      fire({ a: "sync", x: "", el: stamp }, "-");
    });
    stamp.setAttribute("data-intent", V);
  }
  return "wired";
}
