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
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
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
      '" width="26" height="26" viewBox="0 0 32 32">' +
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
      was.at[id] = at(els[i]);
      was.idx[id] = i;
    }
    return was;
  }

  // Where a row sits on the PAGE. offsetTop alone is relative to the nearest
  // positioned ancestor, and a family's card is one: a child's offsetTop is its
  // place inside the card, so a whole family could climb the board while its
  // children measured as having not moved -- or move inside the card and be
  // mistaken for a board-level slide. Summing up the offsetParent chain puts
  // every row, nested or not, on one axis.
  function at(el) {
    var y = 0;
    for (var e = el; e; e = e.offsetParent) y += e.offsetTop || 0;
    return y;
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

    // Where everything is now, so a child can subtract its card's slide: the
    // card's own animation already carries the child with it, and adding the
    // same distance again on the child would move it twice.
    var now = {};
    for (var n = 0; n < els.length; n++) now[els[n].getAttribute("data-id")] = at(els[n]);

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
      var dy = was.at[id] - now[id];
      var inCard = el.getAttribute("data-in");
      if (inCard && inCard in was.at && inCard in now) dy -= was.at[inCard] - now[inCard];
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

  // What the cat says. The first line of each mood is catSays(), verbatim; the
  // rest are the board's own. {top} is the row the line is about -- the first
  // waiting row, the first broken-or-working one, or the row a reaction is
  // for -- and a line that names one is skipped when there is none. The line
  // is picked from the push's stamp, so it holds still for a whole push and
  // moves on with the next one instead of flickering.
  var SAYS = {
    swat: ["hey. hey. HEY.", "{top} is waiting on you", "paws on the gate: {top}",
           "a human is required", "psst. {top}."],
    pace: ["supervising", "keeping an eye on {top}", "patrolling the worktrees",
           "{top}, still at it", "on the prowl"],
    nap: ["off duty", "nothing needs you", "all quiet. nap time.", "zzz",
          "dreaming of green checks"],
    hop: ["{top} is done!", "{top} landed. nice."],
    stretch: ["all clear. big stretch.", "nothing left for you. stretching."],
    perk: ["ears up: {top}", "ooh. {top} needs you."]
  };
  function line(key, top, stamp) {
    var pool = (SAYS[key] || []).filter(function (l) { return top || l.indexOf("{top}") < 0; });
    if (!pool.length) return "";
    var h = 0, k = String(stamp || "");
    for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) % 9973;
    // A function, not a string: "$&" or "$$" in a row's name is not a pattern.
    return pool[h % pool.length].replace("{top}", function () { return top || ""; });
  }

  // The cat's reactions: this push against the last one, which data-prev
  // remembers as id -> kind. One at a time, most cheerful first. Nothing on the
  // first push of a page, when every row is "new" and nothing has changed --
  // which is data-pushed, not an empty data-prev: a board that was empty a
  // moment ago has an empty data-prev too, and its first waiting row is news.
  function reaction(rows) {
    if (host.getAttribute("data-pushed") !== "1") return null;
    var ids = Object.keys(prev);
    var hop = rows.filter(function (a) { return a.kind === "done" && prev[a.id] && prev[a.id] !== "done"; })[0];
    if (hop) return { cls: "hop", top: hop.name };
    var had = ids.filter(function (id) { return prev[id] === "attend"; }).length;
    var need = rows.filter(function (a) { return a.kind === "attend"; }).length;
    if (had && !need) return { cls: "stretch", top: "" };
    var perk = rows.filter(function (a) { return a.kind === "attend" && prev[a.id] !== "attend"; })[0];
    if (perk) return { cls: "perk", top: perk.name };
    return null;
  }

  // The tally: the tiers between the headline and the quiet divider, counted.
  // Attend is the headline's own number and quiet is the divider's, so neither
  // is repeated on the line they share. Labelled by what the tier MEANS rather
  // than by its internal name -- "broken" is the word you would use, "wilt" is
  // the word the shader used. Ordered by urgency, like the list below it.
  var TIERS = [["wilt", "broken"], ["running", "working"], ["done", "to close"]];

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

  // The signals carry the Swift sidebar's palette, which was picked for a
  // near-black ground. On a card some of it falls under 4.5:1 -- the red is
  // 3.8, the draft grey 3.2 -- so each colour is mixed toward white just far
  // enough to pass against the lightest card ground. The bright ones come back
  // unchanged. Anything that is not a plain hex comes back empty, and the
  // signal inherits the footer's grey: the value lands in a style attribute.
  var CARD = [59, 65, 54];                       // --bg-attend, the lightest card
  function lum(c) {
    var v = c.map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function lift(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return "";
    var n = parseInt(m[1], 16), c = [n >> 16, (n >> 8) & 255, n & 255];
    var ground = lum(CARD);
    for (var k = 0; k <= 20; k++) {
      var t = k / 20, mix = c.map(function (x) { return Math.round(x + (255 - x) * t); });
      if ((lum(mix) + 0.05) / (ground + 0.05) >= 4.6) {
        return k ? "#" + mix.map(function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("")
                 : "#" + m[1].toLowerCase();
      }
    }
    return "#ffffff";
  }

  function chipTip(c) {
    return TIP[c] || TIP[String(c).replace(/\s+\d+$/, "")] || c;
  }

  // The button row. The first chip is the verb that resolves the row -- the
  // collector orders them that way -- and it is filled only on the tiers that
  // ask something of you. Actionable signals follow as ghost buttons in their
  // own colour; the collector has already dropped any that repeat a chip.
  var FILLED = { attend: true, wilt: true, done: true };
  function buttons(a) {
    var out = (a.chips || []).map(function (c, i) {
      return '<span class="chip' + (i === 0 && FILLED[a.kind] ? " pri" : "") +
        '" title="' + esc(chipTip(c)) + '">' + esc(c) + "</span>";
    });
    (a.signals || []).forEach(function (e) {
      if (!e.a) return;
      var col = lift(e.c);
      out.push('<span class="chip sig"' + (col ? ' style="color:' + col + '"' : "") +
        ' data-a="' + esc(e.a) + '"' +
        (e.x !== undefined && e.x !== null && e.x !== "" ? ' data-x="' + esc(e.x) + '"' : "") +
        ' title="' + esc(e.h) + '">' + esc(e.t) + "</span>");
    });
    return out.length ? '<div class="chips">' + out.join("") + "</div>" : "";
  }

  // Today's spend, when known and non-zero. Dimmer under a dollar: the point
  // is spotting the row that is quietly burning, not pricing every row.
  // A model ccusage could not price counts as $0, so its tokens make the
  // figure a floor: it gets a "+" and a title naming the model, and shows
  // even at $0 -- a row burning only an unpriced model is not a quiet row.
  function cost(a) {
    var unpriced = Array.isArray(a.cost_unpriced) ? a.cost_unpriced : [];
    var c = typeof a.cost === "number" ? a.cost : 0;
    if (!(c > 0 || unpriced.length)) return "";
    var amt = c >= 100 ? Math.round(c) : c.toFixed(2);
    var tip = "Claude spend in this worktree today (ccusage, ~5min cache)";
    if (unpriced.length) {
      tip += ". At least this much: ccusage has no price for " +
        unpriced.join(", ") + ", so its tokens count as $0";
    }
    return '<span class="cost' + (c < 1 && !unpriced.length ? " small" : "") +
      '" title="' + esc(tip) + '">$' + amt + (unpriced.length ? "+" : "") + "</span>";
  }

  var DIRTY = '<span class="dirty" title="Uncommitted changes in this worktree">●</span>';

  // The footer: what you recognise a row by, in one mono line. Branch, PR and
  // issue are targets; status signals, progress and spend are read, not
  // clicked, so they do not react.
  function foot(a) {
    var out = "";
    if (a.branch) {
      out += '<span class="branch" data-a="code" title="Open this worktree in VS Code — ' +
        esc(a.branch) + '">' + esc(headClip(a.branch, 30)) + "</span>";
    }
    if (a.dirty) out += DIRTY;
    if (a.pr) {
      out += '<span class="pr' + (a.pr_state === "open" ? " open" : "") +
        '" data-a="pr" title="Open the pull request in your default browser">' +
        esc(a.pr) + "</span>";
    }
    // The linked issue (closing reference or branch pattern) — present only
    // when the GitHub Issues integration is enabled; the collector gates it.
    if (a.issue) {
      out += '<span class="issue" data-a="issue" title="Open the linked issue in your default browser">' +
        esc(a.issue) + "</span>";
    }
    (a.signals || []).forEach(function (e) {
      if (e.a) return;
      var col = lift(e.c);
      out += '<span class="sig"' + (col ? ' style="color:' + col + '"' : "") +
        ' title="' + esc(e.h) + '">' + esc(e.t) + "</span>";
    });
    if (a.meta) out += '<span class="meta">' + esc(a.meta) + "</span>";
    out += cost(a);
    return out ? '<div class="foot">' + out + "</div>" : "";
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
  // The open set: the children whose full card is showing. intent.js flips an
  // id in and out when a sub-row is clicked, and it lives on #rows for the same
  // reason data-prev does -- #rows survives a push and nothing else does. Ids no
  // longer on the board are dropped here, so it cannot grow without bound.
  var openSet = [];
  try { openSet = JSON.parse(host.getAttribute("data-open") || "[]"); } catch (e) { openSet = []; }
  if (!Array.isArray(openSet)) openSet = [];
  var onBoard = {};
  rows.forEach(function (r) { onBoard[r.id] = true; });
  openSet = openSet.filter(function (id) { return onBoard[id] === true; });

  // The opening tag every row shares, card or sub-row.
  // data-id is the delegation handle intent.js needs: #rows survives a push but
  // its children do not, so a click is resolved from the row's id at click time.
  // A row with neither a workspace ref nor a plan has nothing to act on, and is
  // marked inert so it does not offer a pointer it cannot honour.
  // title= on the row, not on .nm: a quiet row's name is often a full shell
  // prompt, and the CSS clamps it to one line, so the hover is the only way to
  // read the whole thing.
  // --own is the worktree's identity colour, the same hex Peacock paints the
  // VS Code window with. Worn as a dot beside the name so the rail can keep
  // saying which tier the row is in. Only a plain hex gets through: it lands
  // in a style attribute.
  // The workspace you are standing in is marked (.here), not moved: promoting
  // it to the top would fight the ranking, which is the one thing this board
  // is for.
  // data-in names the card a sub-row sits in, so the reorder animation can
  // take the card's own slide out of the child's (see slide()).
  // A row that turned done on THIS push: the ripple, the confetti and the
  // family-complete moment all key off it, and data-prev is what makes it once.
  function turned(a) { return !!prev[a.id] && prev[a.id] !== "done" && a.kind === "done"; }

  // Pixel confetti for a card that just turned done. Every bit's spot, drift,
  // delay and colour come from the row id through a small LCG, so the same card
  // throws the same handful and the probe can count it.
  var CONFETTI = ["#a7c080", "#dfa000", "#7fbbb3", "#e69875", "#d699b6", "#F5F5F7"];
  function confetti(id, n) {
    var h = 7;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 2147483647;
    function rnd() { h = (h * 48271) % 2147483647; return h / 2147483647; }
    var out = '<span class="confetti" aria-hidden="true">';
    for (var k = 0; k < n; k++) {
      out += '<i style="--x:' + Math.round(8 + rnd() * 84) + "%;--dx:" + Math.round(rnd() * 48 - 24) +
        "px;--up:" + -Math.round(10 + rnd() * 14) + "px;--dy:" + Math.round(18 + rnd() * 26) +
        "px;--t:" + Math.round(rnd() * 160) + "ms;background:" + CONFETTI[k % CONFETTI.length] + '"></i>';
    }
    return out + "</span>";
  }

  // Family pips: a kitten head per child, filled in the child's tier colour,
  // with the child's name and badge as its tooltip. Two cut-out cells are its
  // eyes. Five at most, most urgent first, then "+N": the name beside them is
  // the only thing in the head that shrinks, and a big family clipped it.
  var PIP = "M0 0h1v1h1v1h3v-1h1v-1h1v5h-1v1h-5v-1h-1zM2 3v1h1v-1zM4 3v1h1v-1z";
  function pips(kids) {
    var shown = kids.slice().sort(function (x, y) {
      return (RANK[x.kind] === undefined ? 9 : RANK[x.kind]) - (RANK[y.kind] === undefined ? 9 : RANK[y.kind]);
    }).slice(0, 5);
    var more = kids.length - shown.length;
    return '<span class="pips">' + shown.map(function (k) {
      return '<svg class="pip ' + (COL[k.kind] ? k.kind : "quiet") + '" viewBox="0 0 7 6" aria-hidden="true">' +
        "<title>" + esc(k.name + (k.badge ? " · " + k.badge : "")) + '</title><path fill-rule="evenodd" d="' +
        PIP + '"/></svg>';
    }).join("") + (more > 0 ? '<span class="pipmore">+' + more + "</span>" : "") + "</span>";
  }

  function opening(a, cls, inCard) {
    var ripple = turned(a) ? " ripple" : "";
    next[a.id] = a.kind;
    var inert = !a.ref && !a.slug ? " inert" : "";
    var hex = /^#[0-9a-f]{3,8}$/i.test(a.color || "") ? a.color : "";
    return '<div class="row ' + a.kind + ripple + inert + (a.selected ? " here" : "") + cls +
      (hex ? " owned" : "") + '" data-id="' + esc(a.id) + '" title="' + esc(a.name) + '"' +
      (inCard ? ' data-in="' + esc(inCard) + '"' : "") +
      (hex ? ' style="--own:' + hex + '"' : "") + ">" + (ripple ? confetti(a.id, inCard ? 8 : 12) : "");
  }
  function dotOf(a) { return /^#[0-9a-f]{3,8}$/i.test(a.color || "") ? '<span class="own"></span>' : ""; }
  // No empty badge: a bare outline pill was the quiet row's second line.
  function badgeOf(a) { return a.badge ? '<span class="badge">' + esc(a.badge) + "</span>" : ""; }
  function nameOf(a) { return '<span class="nm">' + esc(a.name) + "</span>"; }
  // Everything under a card's head: what was said, the reply window, the
  // buttons, the footer.
  function body(a) {
    return (a.said ? '<p class="said">' + said(a.said) + "</p>" : "") + feed(a) + buttons(a) + foot(a);
  }

  // A quiet row is one line and the whole of it is the target, which jumps.
  // Its other chips (diff, pr) stay, as ghosts at the end of the line: a row
  // badged "pr open" with no way to open the PR was the first cut of this.
  // When it has them, they say what the badge would, so the badge steps aside
  // for the name. Spend still shows, because a row that is quietly burning
  // money is the one quiet row worth noticing.
  function quietRow(a) {
    var acts = (a.chips || []).filter(function (c) { return c !== "jump"; });
    var qb = acts.length ? '<span class="chips">' + acts.map(function (c) {
      return '<span class="chip" title="' + esc(chipTip(c)) + '">' + esc(c) + "</span>";
    }).join("") + "</span>" : "";
    return opening(a, a.family ? " fam" : "") + '<div class="top">' + dotOf(a) + nameOf(a) +
      (a.dirty ? DIRTY : "") + cost(a) + (qb || badgeOf(a)) + "</div></div>";
  }

  function card(a, kids, roll, g) {
    if (a.kind === "quiet" && !kids) return quietRow(a);
    var whole = g && famDone(g);
    return opening(a, (a.family ? " fam" : "") + (whole ? " famdone" : "")) +
      (whole && !turned(a) ? confetti("fam:" + a.id, 22) : "") +
      '<div class="top">' + dial(a.frac, a.kind) + dotOf(a) + nameOf(a) +
      (g ? pips(g.kids) : "") + (roll || badgeOf(a)) + "</div>" + body(a) + kids + "</div>";
  }

  // The family-complete moment: every child is done now, and at least one of
  // them got there on this push.
  function famDone(g) {
    return g.kids.length > 0 && g.kids.every(function (k) { return k.kind === "done"; }) &&
      g.kids.some(turned);
  }

  // A child, inside its family's card. One line until opened: the caret, its
  // dial, its dot, its name and badge. A child that needs you or is broken also
  // shows what it said and its first chip, filled, so the family card answers
  // "what do I press" without opening anything. The header and that line are
  // data-a="toggle": intent.js opens the child's full card in place (the body
  // is always rendered, CSS shows it) and selects its workspace; a second click
  // closes it and goes nowhere. The inline chip is its own target, nearer than
  // the toggle, so it fires its verb for the child.
  function kid(a, inCard) {
    var isOpen = openSet.indexOf(a.id) >= 0;
    // Opening selects the child's workspace -- if it has one to select.
    var sel = a.ref ? ' data-x="select"' : "";
    var loud = a.kind === "attend" || a.kind === "wilt";
    var first = (a.chips || [])[0];
    var inline = loud && first ? '<span class="chip pri" title="' + esc(chipTip(first)) + '">' +
      esc(first) + "</span>" : "";
    return opening(a, " fam kid" + (isOpen ? " open" : ""), inCard) +
      '<div class="top kidhd' + (inline ? " loud" : "") + '" data-a="toggle"' + sel + '><span class="caret"></span>' + dial(a.frac, a.kind) +
      dotOf(a) + nameOf(a) + badgeOf(a) + inline + "</div>" +
      (loud && a.said ? '<p class="said nest" data-a="toggle"' + sel + ">" + said(a.said) + "</p>" : "") +
      '<div class="kbody">' + body(a) + "</div></div>";
  }

  // What the family's card says about its children: the most urgent tier among
  // them, counted. It replaces the parent's own badge, because "working" on a
  // card holding a shut gate is the wrong half of the story -- but only when
  // the children ARE more urgent: a parent waiting on you keeps saying so over
  // a broken child, whose own row says it is broken.
  var RANK = { attend: 0, wilt: 1, running: 2, done: 3, quiet: 4 };
  function rollup(kids, own) {
    var n = { attend: 0, wilt: 0, done: 0 };
    kids.forEach(function (k) { if (k.kind in n) n[k.kind]++; });
    var top = n.attend ? "attend" : n.wilt ? "wilt" : n.done === kids.length ? "done" : "";
    if (!top || (own in RANK && RANK[own] <= RANK[top])) return "";
    if (n.attend) return '<span class="badge roll attend">' + n.attend +
      (n.attend === 1 ? " needs you" : " need you") + "</span>";
    if (n.wilt) return '<span class="badge roll wilt">' + n.wilt + " broken</span>";
    return '<span class="badge roll done">all ' + n.done + " done</span>";
  }

  // families.py emits each family as one contiguous run, parent first. Fold the
  // run into one group; a run with no parent row gets a shell card named by the
  // family's label, which carries no actions of its own (inert).
  var groups = [];
  rows.forEach(function (r) {
    var last = groups[groups.length - 1];
    if (r.family && r.famkid && last && last.family === r.family) last.kids.push(r);
    else if (r.family && r.famkid) groups.push({ family: r.family, label: r.famlabel || r.family, lead: null, kids: [r] });
    else groups.push({ family: r.family || "", lead: r, kids: [] });
  });
  function shell(g) {
    var t = g.kids[0].famtier || g.kids[0].kind;
    if (!COL[t]) t = "quiet";
    var id = "fam:" + g.family;
    var whole = famDone(g);
    return '<div class="row ' + t + ' fam shell inert' + (whole ? " famdone" : "") + '" data-id="' +
      esc(id) + '" title="' + esc(g.label) + '">' + (whole ? confetti(id, 22) : "") +
      '<div class="top"><span class="nm">' + esc(g.label) + "</span>" + pips(g.kids) +
      (rollup(g.kids) || '<span class="badge">' + g.kids.length + " plans</span>") + "</div>" +
      '<div class="kids">' + g.kids.map(function (k) { return kid(k, id); }).join("") + "</div></div>";
  }

  // A label before the first quiet row, so the divider between "needs you" and
  // "does not" stays legible now that both are on the page. Emitted inline with
  // the rows rather than as separate markup, because #rows is replaced whole.
  var seenQuiet = false;
  // A quiet member of a family that sorts above the divider sits with its
  // family, not under it (families.py), so it neither opens the quiet section
  // nor counts toward it.
  var belowDivider = function (r) { return r.kind === "quiet" && (!r.famtier || r.famtier === "quiet"); };
  host.innerHTML = rows.length ? groups.map(function (g) {
    var lead = g.lead || g.kids[0], sect = "";
    if (belowDivider(lead) && !seenQuiet) {
      seenQuiet = true;
      sect = '<div class="sect">quiet · ' + rows.filter(belowDivider).length + "</div>";
    }
    if (!g.lead) return sect + shell(g);
    var kids = g.kids.length ? '<div class="kids">' + g.kids.map(function (k) {
      return kid(k, g.lead.id);
    }).join("") + "</div>" : "";
    return sect + card(g.lead, kids, g.kids.length ? rollup(g.kids, g.lead.kind) : "", g.kids.length ? g : null);
  }).join("") :
    '<div class="empty">Nothing is waiting on you.<br>' + esc(d.quiet || "") + "</div>";
  host.setAttribute("data-open", JSON.stringify(openSet));
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
  var rx = reaction(rows);
  host.setAttribute("data-pushed", "1");
  if (cat) {
    // Off, a style flush, then on: the same reaction two pushes running would
    // otherwise leave the class unchanged, and CSS replays an animation only
    // when its name comes back.
    if (rx) {
      cat.setAttribute("class", m);
      if (cat.getBoundingClientRect) cat.getBoundingClientRect();
    }
    cat.setAttribute("class", m + (rx ? " " + rx.cls : ""));
  }
  // The sky follows the local hour at push time. Pushes come at least every
  // 120s, so it is never more than two minutes behind the clock.
  var shelf = $("shelf");
  if (shelf) {
    var hr = new Date().getHours();
    var sky = hr >= 5 && hr < 8 ? "dawn" : hr >= 8 && hr < 18 ? "day" : hr >= 18 && hr < 21 ? "dusk" : "night";
    if (!shelf.getAttribute("data-sky")) shelf.setAttribute("data-sky-first", "1");
    else if (shelf.removeAttribute) shelf.removeAttribute("data-sky-first");
    shelf.setAttribute("data-sky", sky);
  }
  var says = $("says");
  var lead = rows.filter(function (a) {
    return m === "swat" ? a.kind === "attend" : a.kind === "wilt" || a.kind === "running";
  })[0];
  if (says) says.textContent = rx ? line(rx.cls, rx.top, d.stamp) : line(m, lead ? lead.name : "", d.stamp);
  var tl = $("tally");
  if (tl) tl.innerHTML = tally(rows);

  var n = rows.filter(function (a) { return a.kind === "attend"; }).length;
  // "all clear" claimed more than this number knows: it counts the attend tier
  // only, so it was printing ALL CLEAR directly above a tally reading "5 broken".
  // The headline answers exactly one question -- is anything blocked on a human --
  // and the tally beside it answers the rest.
  var need = $("need");
  need.textContent = n ? n + (n === 1 ? " needs you" : " need you") : "nothing needs you";
  need.className = n ? "on" : "";
  $("quiet").textContent = tail;
  // The news footer. Only its contents are written: the <details> itself is
  // never replaced, so whether you left it open survives every push without
  // any state of ours. Below #rows and filled after slide(), it cannot move a
  // row the FLIP has already measured. The text is news.py's and goes through
  // the same escape-then-two-affordances path as `said`.
  var nw = $("news");
  if (nw) {
    var news = d.news || {};
    var items = news.items || [];
    nw.hidden = !items.length;
    var ttl = $("news-ttl");
    if (ttl) ttl.textContent = "news" + (news.hours ? " · " + news.hours + "h" : "");
    var lede = $("news-lede");
    if (lede) lede.innerHTML = said(news.lede || "");
    var body = $("news-body");
    if (body) body.innerHTML = items.map(function (it) {
      var tier = COL[it.tier] ? it.tier : "quiet";
      return '<p class="ni ' + tier + '">' + said(it.text) + "</p>";
    }).join("");
  }
  $("src").textContent = d.src || "";
  var st = $("stamp");
  st.textContent = d.stamp || "";
  st.className = d.stale ? "stale" : "";
  return rows.length;
}
