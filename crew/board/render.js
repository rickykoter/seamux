// The board's renderer. PUSHED with every update via `cmux browser addscript`, together
// with the data — never relied upon to be resident in the page.
//
// Why: an inline <script> in board.html defined window.render, and a push failed with
//   "TypeError: window.render is not a function ... 'window.render' is undefined"
// even though the page had clearly rendered its static markup. Either addscript evaluates
// in an isolated world that does not share `window` with the document, or inline script
// does not run in that surface. Both are invisible from the outside and both are fatal to
// a page that must define its own entry point.
//
// The DOM, however, IS shared across worlds. So this function touches only `document`,
// carries no cross-push state in `window`, and stashes what it must remember on an
// element attribute instead. That makes a push self-contained and the page inert HTML.
function __boardRender(d) {
  var COL = { attend: "#dfa000", running: "#7fbbb3", wilt: "#e67e80", done: "#a7c080", quiet: "#5c6a72" };
  var $ = function (id) { return document.getElementById(id); };
  // Tooltips for the small targets. The row itself deliberately has none: a
  // tooltip on the whole row fires whenever the pointer rests anywhere on the
  // board, which is most of the time you are reading it.
  var TIP = {
    "jump": "Switch to this workspace",
    "diff": "Open this workspace's diff",
    "pr": "Open the pull request in your default browser",
    "checks": "Open the checks in your default browser",
    "plan": "Open the plan page",
    "review": "Open the plan page",
    "take the check": "Open the plan and take the alignment check",
    "reclaim": "Dry-run the reclaim in a terminal, and ask before deleting anything",
    "close plan": "Retire this plan's gate",
    "go": "Authorize this increment"
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }
  // `said` can carry raw terminal text captured with read-screen, so it is escaped first
  // and then given exactly two affordances back: {{subject}} and `path`.
  function said(s) {
    return esc(s).replace(/\{\{(.+?)\}\}/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  }

  function dial(frac, kind) {
    var r = 13, c = 2 * Math.PI * r, col = COL[kind] || COL.quiet;
    // .pending marks a dial with no number to show; CSS spins its .arc for a row
    // that is mid-turn, which is the honest shape for "working, cannot say how
    // far". A dial that HAS a percentage never spins -- it already answered.
    var indet = frac === null || frac === undefined;
    var head = '<svg class="dial' + (indet ? " pending" : "") +
      '" width="32" height="32" viewBox="0 0 32 32">' +
      '<circle cx="16" cy="16" r="' + r + '" fill="none" stroke="#2f3639" stroke-width="3"/>';
    // A plan with no increments has nothing to fill. Show a dot, not a lying 0%.
    if (indet) {
      // The dot is the resting state. The short arc is added ONLY for a row that
      // is genuinely mid-turn, because an arc that is not moving does not read as
      // "no progress information" -- it reads as a stalled spinner, or worse, as
      // 16% progress. A broken or waiting row gets the bare dot it had before.
      var arc = kind !== "running" ? "" :
        '<circle class="arc" cx="16" cy="16" r="' + r + '" fill="none" stroke="' + col +
        '" stroke-width="3" stroke-linecap="round" stroke-dasharray="' +
        (c * 0.16).toFixed(2) + " " + (c * 0.84).toFixed(2) + '"/>';
      return head + '<circle cx="16" cy="16" r="2.5" fill="' + col + '"/>' + arc + "</svg>";
    }
    return head +
      '<circle class="arc" cx="16" cy="16" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="3"' +
      ' stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '"' +
      ' stroke-dashoffset="' + (c * (1 - frac)).toFixed(2) + '" transform="rotate(-90 16 16)"/>' +
      '<text x="16" y="19.5" text-anchor="middle" font-size="9.5" font-weight="600"' +
      ' fill="#d3c6aa">' + Math.round(frac * 100) + "</text></svg>";
  }

  // Where each row SITS right now, captured before innerHTML destroys it. This is
  // the only moment the old geometry exists, so a reorder animation has to be set
  // up from here -- there is no "previous DOM" to diff against afterwards.
  function positions() {
    // Two different questions, and conflating them was a bug:
    //   at   where the row was in PIXELS -- what a smooth slide needs
    //   idx  where it was in the RANKING -- what "this climbed" means
    // Driving the climb accent off pixels lit up five rows every time the list
    // changed length, because everything below the change had moved down the
    // page without moving in the ranking at all.
    var was = { at: {}, idx: {} };
    // Feature-detected, not assumed. A throw anywhere in here does not degrade the
    // board -- it BLANKS it, because the push is one script and the rows are set
    // further down. Motion is the least important thing on this page and must
    // never be the reason it goes dark.
    if (!document.querySelectorAll) return was;
    var els = document.querySelectorAll("#rows .row[data-id]");
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute("data-id");
      was.at[id] = els[i].offsetTop;
      was.idx[id] = i;
    }
    return was;
  }

  // The document's own window, because the pushed script may be running in an
  // isolated world whose `window` is not the page's.
  var reduced = false;
  try {
    var view = document.defaultView || (typeof window !== "undefined" ? window : null);
    reduced = !!(view && view.matchMedia &&
                 view.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { reduced = false; }

  // FLIP, with .animate() rather than the transform/reflow/clear dance: the
  // element is asked to start where it used to be and end where it now is.
  // Nothing is left on the style attribute afterwards, which matters because the
  // next push replaces this node anyway.
  function slide(was) {
    if (reduced || !document.querySelectorAll) return;
    var els = document.querySelectorAll("#rows .row[data-id]");
    if (!els.length || !els[0].animate) return;      // no WAAPI: leave it static

    // The accent means "this OVERTOOK something", so it is measured against the
    // rows present in both pushes and nothing else. Absolute rank was the second
    // wrong answer here: inserting one row at the top demotes every row beneath
    // it by a slot, and crediting all of them with a change is the same noise as
    // measuring pixels, just one step further from the reader's mental model.
    var survivors = [];
    for (var s = 0; s < els.length; s++) {
      var sid = els[s].getAttribute("data-id");
      if (sid in was.idx) survivors.push(sid);
    }
    var wasRank = {}, nowRank = {};
    survivors.forEach(function (id, n) { nowRank[id] = n; });
    survivors.slice().sort(function (a, b) { return was.idx[a] - was.idx[b]; })
      .forEach(function (id, n) { wasRank[id] = n; });

    for (var i = 0; i < els.length; i++) {
      var el = els[i], id = el.getAttribute("data-id");
      if (!(id in was.at)) {
        // Arriving. A new row is news, so it fades in from slightly above --
        // never from below, which would read as "demoted".
        el.animate([{ opacity: 0, transform: "translateY(-7px)" },
                    { opacity: 1, transform: "none" }],
                   { duration: 240, easing: "cubic-bezier(.2,.7,.3,1)" });
        el.classList.add("enter");
        continue;
      }
      // Slide on any pixel move, so a row never teleports when something above
      // it grows or a divider appears. This is presentation only and says nothing
      // about rank.
      var dy = was.at[id] - el.offsetTop;
      if (Math.abs(dy) >= 2) {
        el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }],
                   { duration: 300, easing: "cubic-bezier(.2,.7,.3,1)" });
      }
      var moved = wasRank[id] - nowRank[id];
      if (moved !== 0) el.classList.add(moved > 0 ? "up" : "down");
    }
  }

  // catMood() from crew.swift, on this board's tiers. Three moods, not four: the
  // sidebar's cat lumps broken in with working (`bucket == 1 || bucket == 5`),
  // and the row rails already say which of the two a row is -- the cat is there
  // to answer "is anyone waiting on me", and it only has one voice for "no".
  function mood(rows) {
    var kinds = {};
    for (var i = 0; i < rows.length; i++) kinds[rows[i].kind] = true;
    if (kinds.attend) return "swat";
    if (kinds.wilt || kinds.running) return "pace";
    return "nap";
  }

  // catSays(), verbatim.
  var SAYS = { swat: "hey. hey. HEY.", pace: "supervising", nap: "off duty" };

  // The tally: the same five tiers the ranking uses, counted. Labelled by what
  // the tier MEANS rather than by its internal name -- "broken" is the word you
  // would use, "wilt" is the word the shader used. Ordered by urgency, like the
  // list below it, so the eye travels the same way in both.
  var TIERS = [["attend", "need you"], ["wilt", "broken"], ["running", "working"],
               ["done", "to close"], ["quiet", "quiet"]];

  function tally(rows) {
    var n = {};
    for (var i = 0; i < rows.length; i++) n[rows[i].kind] = (n[rows[i].kind] || 0) + 1;
    var out = "";
    for (var t = 0; t < TIERS.length; t++) {
      var k = TIERS[t][0];
      if (!n[k]) continue;                 // a zero is noise; absence says it
      out += '<span class="tl ' + k + '"><b>' + n[k] + "</b> " + TIERS[t][1] + "</span>";
    }
    return out;
  }

  // Truncate from the HEAD, the way the Swift row did with .truncationMode(.head):
  // every branch here starts `dev/` and the distinctive part is the tail, so
  // clipping the end is exactly the wrong half to keep. Done in JS rather than
  // with the CSS direction:rtl trick, which reorders punctuation in a
  // slash-and-dash-heavy string.
  function headClip(v, n) {
    v = String(v || "");
    return v.length > n ? "…" + v.slice(v.length - (n - 1)) : v;
  }

  // The facts line: branch, dirty marker, PR number. Each is its own target
  // rather than a segment of the grey meta string it used to be folded into.
  function facts(a) {
    var out = "";
    if (a.branch) {
      out += '<span class="branch" data-a="code" title="Open this worktree in VS Code — ' +
        esc(a.branch) + '">' + esc(headClip(a.branch, 34)) + "</span>";
    }
    if (a.dirty) {
      out += '<span class="dirty" title="Uncommitted changes in this worktree">●</span>';
    }
    if (a.pr) {
      out += '<span class="pr' + (a.pr_state === "open" ? " open" : "") +
        '" data-a="pr" title="Open the pull request in your default browser">' +
        esc(a.pr) + "</span>";
    }
    // Today's spend, when known and non-zero. Dim under a dollar: the point
    // is spotting the row that is quietly burning, not pricing every row.
    if (typeof a.cost === "number" && a.cost > 0) {
      var amt = a.cost >= 100 ? Math.round(a.cost) : a.cost.toFixed(2);
      out += '<span class="cost' + (a.cost < 1 ? " small" : "") +
        '" title="Claude spend in this worktree today (ccusage, ~5min cache)">$' +
        amt + "</span>";
    }
    return out ? '<div class="facts">' + out + "</div>" : "";
  }

  // The signals strip. Entries carrying an action are click targets; the rest are
  // status and say so by not reacting -- the affordance rule the Swift board set.
  function sigs(list) {
    if (!list || !list.length) return "";
    return '<div class="sigs">' + list.map(function (e) {
      return '<span class="sig' + (e.a ? " act" : "") + '" style="color:' + esc(e.c) +
        '"' + (e.a ? ' data-a="' + esc(e.a) + '"' : "") +
        (e.x !== undefined && e.x !== null ? ' data-x="' + esc(e.x) + '"' : "") +
        ' title="' + esc(e.h) + '">' + esc(e.t) + "</span>";
    }).join("") + "</div>";
  }

  // A blocked ask has a deadline. The bar is a CSS animation whose duration IS
  // the time remaining, so it drains in real time and finishes exactly when the
  // window closes -- no resident timer, and no number that would be a lie by the
  // next push. (The board pushes every 120s; the window is about that long.)
  function feed(a) {
    if (!a.feedby) return "";
    var left = a.feedby - Math.floor(Date.now() / 1000);
    if (left < 1) return "";
    var when = new Date(a.feedby * 1000).toTimeString().slice(0, 8);
    return '<div class="feed" title="The reply window closes at ' + when + '">' +
      '<span class="feedbar" style="animation-duration:' + left + 's"></span></div>';
  }

  var host = $("rows");
  // Cross-push memory lives on the DOM, the one thing both worlds can see. Without it a
  // one-shot success ripple would either never fire or fire on every push.
  var prev = {};
  try { prev = JSON.parse(host.getAttribute("data-prev") || "{}"); } catch (e) { prev = {}; }
  var next = {};

  var rows = d.rows || [];
  var was = positions();
  // A label before the first quiet row, so the divider between "needs you" and
  // "does not" stays legible now that both are on the page. Emitted inline with
  // the rows rather than as separate markup, because #rows is replaced whole.
  var seenQuiet = false;
  host.innerHTML = rows.length ? rows.map(function (a) {
    var sect = "";
    if (a.kind === "quiet" && !seenQuiet) {
      seenQuiet = true;
      sect = '<div class="sect">quiet · ' +
        rows.filter(function (r) { return r.kind === "quiet"; }).length + "</div>";
    }
    var ripple = prev[a.id] && prev[a.id] !== a.kind && a.kind === "done" ? " ripple" : "";
    next[a.id] = a.kind;
    // data-id is the delegation handle intent.js needs: #rows survives a push but
    // its children do not, so a click is resolved from the row's id at click time.
    // A row with neither a workspace ref nor a plan has nothing to act on, and is
    // marked inert so it does not offer a pointer it cannot honour.
    var inert = !a.ref && !a.slug ? " inert" : "";
    // title= on the row, not on .nm: a quiet row's name is often a full shell
    // prompt, and the CSS clamps it to one line, so the hover is the only way to
    // read the whole thing.
    // --own is the worktree's identity colour, the same hex Peacock paints the
    // VS Code window with. Worn as an inner stripe so the outer rail can keep
    // saying which tier the row is in -- the Swift row only had room for one and
    // spent it on identity.
    var own = a.color ? ' style="--own:' + esc(a.color) + '"' : "";
    // The workspace you are standing in. Marked, not moved: promoting it to the
    // top would fight the ranking, which is the one thing this board is for.
    var here = a.selected ? " here" : "";
    return sect + '<div class="row ' + a.kind + ripple + inert + here +
      (a.color ? " owned" : "") +
      '" data-id="' + esc(a.id) + '" title="' + esc(a.name) + '"' + own + ">" +
      dial(a.frac, a.kind) +
      '<div class="main"><div class="hd"><span class="nm">' + esc(a.name) + "</span>" +
      '<span class="badge">' + esc(a.badge) + "</span></div>" +
      (a.said ? '<p class="said">' + said(a.said) + "</p>" : "") +
      facts(a) + sigs(a.signals) + feed(a) +
      (a.chips && a.chips.length ? '<div class="chips">' + a.chips.map(function (c, i) {
        return '<span class="chip' + (i === 0 && a.kind === "attend" ? " lead" : "") +
          '" title="' + esc(TIP[c] || TIP[String(c).replace(/\s+\d+$/, "")] || c) + '">' +
          esc(c) + "</span>"; }).join("") + "</div>" : "") +
      (a.meta ? '<div class="meta">' + esc(a.meta) + "</div>" : "") +
      "</div></div>";
  }).join("") :
    '<div class="empty">Nothing is waiting on you.<br>' + esc(d.quiet || "") + "</div>";
  // With quiet workspaces now rendered as rows, #quiet is only reached when there
  // are no rows at all -- and in that case the .empty block above has already said
  // it. Echoing it there put the same sentence on the page twice.
  var tail = rows.length ? (d.quiet || "") : "";
  host.setAttribute("data-prev", JSON.stringify(next));
  slide(was);

  var cat = $("cat");
  // setAttribute, NOT .className: #cat is an <svg>, and on an SVG element
  // className is a read-only SVGAnimatedString. Assigning to it fails silently
  // -- the sprite kept its initial mood forever and no animation ever started,
  // with no error to show for it.
  var m = mood(rows);
  if (cat) cat.setAttribute("class", m);
  var says = $("says");
  if (says) says.textContent = SAYS[m] || "";
  var tl = $("tally");
  if (tl) tl.innerHTML = tally(rows);

  var n = rows.filter(function (a) { return a.kind === "attend"; }).length;
  // "all clear" claimed more than this number knows: it counts the attend tier
  // only, so it was printing ALL CLEAR directly above a tally reading "5 broken".
  // The headline answers exactly one question -- is anything blocked on a human --
  // and the tally beneath it answers the rest.
  $("need").textContent = n ? n + (n === 1 ? " needs you" : " need you")
                            : "nothing needs you";
  $("quiet").textContent = tail;
  $("src").textContent = d.src || "";
  var st = $("stamp");
  st.textContent = d.stamp || "";
  st.className = d.stale ? "stale" : "";
  return rows.length;
}
