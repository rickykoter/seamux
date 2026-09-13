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
//   plan / review        openURL(file:// plan page)        -> a=plan
//   go N                 crew:plan-go                      -> a=go&x=N
//   sandbox chip         crew:sandbox-up / -down           -> a=sandbox-up|-down
//   feed allow / deny    crew:feed-allow / crew:feed-deny  -> a=feed-allow|-deny
//   the sync clock       crew:sync-now                     -> a=sync
//
// Two ways an element declares itself a target, in precedence order:
//   data-a="verb" [data-x="arg"]   explicit -- branch, PR, every signal chip
//   a .chip whose LABEL is in MAP  the tier action row, which has no attributes
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
  var V = "3";
  var host = document.getElementById("rows");
  if (!host) return "no #rows";

  // ---- affordance ------------------------------------------------------
  // Injected here rather than into board.html so that the page stays inert and
  // its probe contract is untouched.
  if (!document.getElementById("intent-css")) {
    var st = document.createElement("style");
    st.id = "intent-css";
    st.textContent =
      ".row{cursor:pointer}" +
      ".row:hover{background:#2f3639}" +
      ".row:active{background:#374145}" +
      ".chip{cursor:pointer}" +
      ".chip:hover{filter:brightness(1.35);text-decoration:underline}" +
      ".chip.hit{opacity:.45}" +
      ".chip.ok{box-shadow:inset 0 0 0 1px #a7c080}" +
      ".chip.bad{box-shadow:inset 0 0 0 1px #e67e80}" +
      "#stamp{cursor:pointer}#stamp:hover{text-decoration:underline}" +
      // A row that cannot be acted on must not pretend otherwise.
      ".row.inert,.row.inert:hover{cursor:default;background:none}";
    document.head.appendChild(st);
  }

  // ---- the chip vocabulary --------------------------------------------
  // Keys are the labels the collector emits. A label with no entry here is left
  // unclickable rather than guessed at, so a new chip is inert, never wrong.
  var MAP = {
    "jump": "jump", "diff": "diff", "pr": "pr", "checks": "checks",
    "plan": "plan", "review": "plan", "take the check": "take the check",
    "reclaim": "reclaim", "close plan": "close plan", "code": "code"
  };

  function target(el) {
    // An explicit data-a wins over everything. It is how the branch name, the PR
    // number and the signals strip declare what they do, which means a new target
    // is one attribute in render.js rather than a new entry in the label table
    // below -- and it cannot drift, because there is no label to match.
    var decl = el.closest && el.closest("[data-a]");
    if (decl) {
      return { a: decl.getAttribute("data-a"),
               x: decl.getAttribute("data-x") || "", el: decl };
    }
    var chip = el.closest && el.closest(".chip");
    if (chip) {
      var label = (chip.textContent || "").trim();
      var m = /^go\s+(\d+)$/.exec(label);
      if (m) return { a: "go", x: m[1], el: chip };
      if (MAP[label]) return { a: MAP[label], x: "", el: chip };
      return null;                       // an unknown chip stays inert
    }
    var row = el.closest && el.closest(".row");
    if (row && !row.classList.contains("inert")) return { a: "row", x: "", el: row };
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
    function done(cls) {
      el.classList.remove("hit");
      if (!cls) return;
      el.classList.add(cls);
      // Long enough to see, short enough that the next push is not fighting it.
      setTimeout(function () { el.classList.remove(cls); }, 1200);
    }
    fetch(url).then(function (r) { return r.json(); })
      .then(function (j) { done(j && j.ok ? "ok" : "bad"); })
      // A failed fetch means the server is not up. Say so on the element the
      // human just pressed; a silent no-op is the regression we are fixing.
      .catch(function () { done("bad"); });
  }

  // Refreshed on every push; the listener below is installed only once.
  host.setAttribute("data-intent-cfg", JSON.stringify({ port: cfg.port, token: cfg.token }));

  if (host.getAttribute("data-intent") !== V) {
    host.addEventListener("click", function (ev) {
      // A listener from a superseded version stands down instead of acting, so
      // an upgraded page fires exactly one command per click.
      if (host.getAttribute("data-intent") !== V) return;
      var t = target(ev.target);
      if (!t) return;
      var row = ev.target.closest(".row");
      var rid = row && row.getAttribute("data-id");
      if (!rid) return;
      // A chip is a specific verb; without this the row's own "select" would
      // fire too and steal focus away from whatever the chip just opened.
      ev.preventDefault();
      ev.stopPropagation();
      fire(t, rid);
    });
    host.setAttribute("data-intent", V);
  }

  var stamp = document.getElementById("stamp");
  if (stamp && stamp.getAttribute("data-intent") !== V) {
    stamp.title = "Force a full reconcile";
    stamp.addEventListener("click", function () {
      fire({ a: "sync", x: "", el: stamp }, "-");
    });
    stamp.setAttribute("data-intent", V);
  }
  return "wired";
}
