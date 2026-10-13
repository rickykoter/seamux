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
// One verb never leaves the page: a=toggle, on a family child's header. It opens
// the child's full card in place and, on opening only, sends the ordinary row
// action for the child, so cmux selects that workspace. Closing is local and
// goes nowhere. The open set lives on #rows as data-open, which render.js reads
// on the next push so an opened child stays open.
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
  var V = "4";
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
      ".chip.hit{opacity:.45}" +
      ".chip.ok{box-shadow:inset 0 0 0 1px #a7c080}" +
      ".chip.bad{box-shadow:inset 0 0 0 1px #e67e80}" +
      "#stamp{cursor:pointer}#stamp:hover{text-decoration:underline}" +
      // A child sits on its family's darker well; hover lifts it from there.
      ".kids>.row.kid:not(.inert):hover{background:#323b40}" +
      ".kidhd.hit{opacity:.6}" +
      // A row that cannot be acted on must not pretend otherwise: no pointer
      // and no hover. It keeps its card ground -- a family's shell card is
      // inert and is still a card.
      ".row.inert{cursor:default}";
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
    var chip = hit;
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

  // Open or close a family child in place. The class flips now, so the card
  // opens under the pointer instead of on the next push; data-open is what the
  // next push reads. Opening also selects the child's workspace -- the ordinary
  // row action, which the server already knows -- when it has one: render.js
  // marks the toggle data-x="select" only for a child with a workspace ref, so
  // a plan with no workspace opens without asking the server for one. Closing
  // sends nothing.
  function toggle(t, row, rid) {
    var open = [];
    try { open = JSON.parse(host.getAttribute("data-open") || "[]"); } catch (e) { open = []; }
    if (!Array.isArray(open)) open = [];
    var i = open.indexOf(rid);
    if (i >= 0) {
      open.splice(i, 1);
      row.classList.remove("open");
    } else {
      open.push(rid);
      row.classList.add("open");
      if (t.x === "select") fire({ a: "row", x: "", el: t.el }, rid);
    }
    host.setAttribute("data-open", JSON.stringify(open));
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
      if (t.a === "toggle") return toggle(t, row, rid);
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
