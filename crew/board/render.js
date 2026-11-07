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
    "diff": "Review this branch's diff in lookout, beside its terminal",
    "pr": "Open the pull request in your default browser",
    "checks": "Open the checks in your default browser",
    "plan": "Open the plan page",
    "review": "Open the plan page",
    "take the check": "Open the plan and take the alignment check",
    "reclaim": "Dry-run the reclaim in a terminal, and ask before deleting anything",
    "archive": "Close this workspace and remember it; crew-resume brings it back",
    "close plan": "Retire this plan's gate",
    "go": "Authorize this increment",
    "wake": "Open the Wake: what this workspace's sessions left behind"
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

  // A turn a usage limit stopped (the Rust board's `limited`, with `armed`
  // when the app will type continue at the reset). Its header wears a pill
  // naming the limit; its said line says when it can go again; an armed row
  // carries a chip, its click the disarm. Times are this machine's clock,
  // and every time on the board is in one format, clockOf's: "1:31 AM"
  // today, "Sat 1:31 AM" within the week, "Nov 14 1:31 AM" further off.
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function clockOf(ms) {
    var d = new Date(ms), now = new Date(), h = d.getHours(), m = d.getMinutes();
    var hm = ((h % 12) || 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
    if (d.toDateString() === now.toDateString()) return hm;
    if (ms > now.getTime() && ms - now.getTime() < 6 * 864e5) return DAYS[d.getDay()] + " " + hm;
    return MONTHS[d.getMonth()] + " " + d.getDate() + " " + hm;
  }
  // When an armed row resumes: its next try on usage billing, else the reset.
  function dueOf(l) { return l.usage && l.next_try ? l.next_try : l.resets_at; }
  function stopText(a) {
    var l = a.limited;
    // The app tried and stopped (the resume watcher's gave_up): it waits for you.
    if (a.armed && l.gave_up) return "stopped: " + l.label + " \u00b7 didn\u2019t resume: " + l.gave_up;
    if (l.error === "billing_error") return "stopped: spend limit reached" + (l.resets_at ? " \u00b7 resets " + clockOf(l.resets_at) : "");
    if (l.usage && !l.window) {
      if (!a.armed) return "stopped: rate limited";
      return "stopped: rate limited" + (l.next_try ? " \u00b7 next try " + clockOf(l.next_try) : " \u00b7 retries in a few minutes");
    }
    return "stopped: " + l.label + (l.resets_at ? " \u00b7 resets " + clockOf(l.resets_at) : " \u00b7 reset time unknown");
  }
  var AMBER = COL.attend;
  // The pill takes the badge's place: the limit is why the row needs you.
  // It names the limit and when it lifts, in plain words.
  function limPill(a) {
    if (!a.limited) return "";
    // Which limit is in its tooltip and the said line; here, when it lifts.
    var l = a.limited, word = l.error === "billing_error" ? "spend limit" : l.label;
    return '<span class="badge lim" style="color:' + AMBER + ";border-color:" + AMBER + '" title="' +
      esc(stopText(a)) + '">' + esc(l.resets_at ? "limit \u00b7 back " + clockOf(l.resets_at) : word) + "</span>";
  }
  // A card that needs you says so on its badge, the headline's words; why it
  // does opens its said line ("Question: ..."). One rule, not a guess at the
  // wording: the label shows unless the line already starts with it. Every
  // other tier keeps its reason on the badge.
  var REASON = { "asked you": "Question", "gate shut": "Gate shut", "review": "Review", "needs a value": "Needs a value" };
  function reasonOf(a) {
    if (a.kind !== "attend" || !a.badge || a.limited) return "";
    var r = REASON[a.badge] || a.badge.charAt(0).toUpperCase() + a.badge.slice(1);
    var plain = String(a.said || "").replace(/\{\{|\}\}/g, "").trim();
    return plain.toLowerCase().indexOf(r.toLowerCase()) === 0 ? "" : r;
  }
  // What a card says under its head: the stop, while a limit holds it.
  function saidOf(a) {
    if (a.limited) return '<span class="lim" style="color:' + AMBER + '">' + esc(stopText(a)) + "</span>";
    var why = reasonOf(a);
    if (!why) return said(a.said);
    return '<span class="rsn">' + esc(why) + (a.said ? ":</span> " + said(a.said) : "</span>");
  }
  var CLOCK = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" style="vertical-align:-1px;margin-right:3px">' +
    '<circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M6 3.4V6l1.8 1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  function armedChip(a) {
    if (!a.limited || !a.armed) return "";
    var l = a.limited, due = dueOf(l), text, tip;
    if (l.error === "billing_error" && !l.resets_at) {
      text = "armed \u00b7 a spend limit is not retried"; tip = "Typing continue would only fail again";
    } else if (l.gave_up) {
      text = "armed \u00b7 gave up"; tip = "It did not resume (" + l.gave_up + "): it waits for you";
    } else if (due) {
      text = "resumes " + clockOf(due); tip = "The app types continue here then, once it has checked the screen";
    } else {
      text = "resumes at reset"; tip = "No reset time is known: it waits for you";
    }
    return '<span class="chip sig armed" data-a="resume" data-x="off" style="color:' + COL.running + '" title="' +
      esc(tip + ". Click to stop resuming this worktree.") + '">' + CLOCK + esc(text) + " \u00d7</span>";
  }

  // How far, in words, for the dial's tooltip: "1 of 4 increments" from the
  // row's meta ("1/4 increments"), else a percentage. The ring is too small
  // for a number inside it to be read, so the arc is the reading and this is
  // the exact figure.
  function farOf(frac, meta) {
    var m = /^(\d+)\/(\d+)\b/.exec(String(meta || ""));
    if (m) return m[1] + " of " + m[2] + " increments";
    return Math.round(frac * 100) + "% done";
  }
  function dial(frac, kind, meta) {
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
    return head.replace("<circle", "<title>" + esc(farOf(frac, meta)) + "</title><circle") +
      '<circle class="arc" cx="16" cy="16" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="3"' +
      ' stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '"' +
      ' stroke-dashoffset="' + (c * (1 - frac)).toFixed(2) + '" transform="rotate(-90 16 16)"/></svg>';
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
  // and the row badges already say which of the two a row is -- the cat is there
  // to answer "is anyone waiting on me", and it only has one voice for "no".
  function mood(rows) {
    if (outOfTreats(rows)) return "nap";
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
           "a human is required"],
    pace: ["supervising", "keeping an eye on {top}", "patrolling the worktrees",
           "{top}, still at it", "on the prowl"],
    nap: ["off duty", "nothing needs you", "all quiet. nap time.", "zzz",
          "dreaming of green checks"],
    hop: ["{top} is done!", "{top} landed. nice."],
    stretch: ["all clear. big stretch.", "nothing left for you. stretching."],
    perk: ["ears up: {top}", "ooh. {top} needs you."]
  };
  // Every live session is stopped on a limit: nothing runs, and all that
  // waits on you is a limit. The cat naps till the soonest reset (true when
  // none is known); false otherwise.
  function outOfTreats(rows) {
    var lim = rows.filter(function (a) { return a.limited; });
    if (!lim.length) return false;
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i].kind;
      if (k === "running" || k === "wilt" || (k === "attend" && !rows[i].limited)) return false;
    }
    var due = lim.map(function (a) { return dueOf(a.limited); }).filter(function (t) { return t > 0; });
    return due.length ? Math.min.apply(null, due) : true;
  }
  function treatsLine(rows) {
    var t = outOfTreats(rows);
    return t === false ? "" : t === true ? "out of treats. back after the reset" : "out of treats till " + clockOf(t);
  }
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
  var TIERS = [["wilt", "broken"], ["running", "working"], ["done", "done"]];

  function tally(rows) {
    var n = {};
    for (var i = 0; i < rows.length; i++) n[rows[i].kind] = (n[rows[i].kind] || 0) + 1;
    // Done rows that all wear one badge are counted by it ("1 merged"), so
    // the tally and the card say the same word.
    var doneBadges = {};
    for (var j = 0; j < rows.length; j++) if (rows[j].kind === "done") doneBadges[rows[j].badge || ""] = 1;
    var one = Object.keys(doneBadges);
    var doneWord = one.length === 1 && one[0] ? one[0] : "done";
    var out = "";
    for (var t = 0; t < TIERS.length; t++) {
      var k = TIERS[t][0];
      if (!n[k]) continue;                 // a zero is noise; absence says it
      out += '<span class="tl ' + k + '"><b>' + n[k] + "</b> " + esc(k === "done" ? doneWord : TIERS[t][1]) + "</span>";
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
    var out = chipsOf(a).map(function (c, i) {
      return '<span class="chip' + (i === 0 && FILLED[a.kind] ? " pri" : "") +
        '" title="' + esc(chipTip(c)) + '">' + esc(c) + "</span>";
    });
    var arm = armedChip(a);
    if (arm) out.push(arm);
    (a.signals || []).forEach(function (e) {
      if (!e.a) return;
      var col = lift(e.c);
      out.push('<span class="chip sig"' + (col ? ' style="color:' + col + '"' : "") +
        ' data-a="' + esc(e.a) + '"' +
        (e.x !== undefined && e.x !== null && e.x !== "" ? ' data-x="' + esc(e.x) + '"' : "") +
        ' title="' + esc(e.h) + '">' + esc(e.t) + "</span>");
    });
    // A muted card keeps its compact look: no pane list, so the panes that
    // wear a tag keep it here as a chip, [plan] on the plan's owner pane and
    // [outside] on one past the workspace's pin. Each focuses its pane.
    if (!isMuted(a)) return out.length ? '<div class="chips">' + out.join("") + "</div>" : "";
    (a.panes || []).forEach(function (p) {
      if (!p || !p.surface || !(p.plan || p.outside)) return;
      var plan = !!p.plan;
      out.push('<span class="chip pane ' + (plan ? "plan" : "outside") + '" data-a="pane" data-x="' + esc(p.surface) + '"' +
        ' title="' + esc(plan ? "This workspace's pane that owns plan " + p.plan + ": focus it"
          : "A pane here has left the workspace's worktree: focus it") + '">' + (plan ? "plan" : "outside") + "</span>");
      if (plan && p.outside) out.push('<span class="chip pane outside" data-a="pane" data-x="' + esc(p.surface) + '"' +
        ' title="A pane here has left the workspace\'s worktree: focus it">outside</span>');
    });
    return out.length ? '<div class="chips">' + out.join("") + "</div>" : "";
  }

  // Every pane in the workspace, one thin row each under what the card said:
  // a Claude with its state and how long it has been in it, a terminal with
  // what it is running. The [plan] and [outside] tags sit on the pane they
  // belong to. A row is the pane's target: clicking it focuses that pane.
  function isMuted(a) { return a.tuck === "mute" && a.kind !== "attend"; }
  // How long ago, in the largest unit that fits: "4m", "2h", "3d".
  function ago(ms) {
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    return s < 60 ? "<1m" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d";
  }
  var PST = { needs_input: ["wait", "needs you"], working: ["work", "working"], idle: ["idle", "idle"], ended: ["end", "ended"] };
  var CHEV = '<svg class="pg" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M2.5 1.5 5.5 4 2.5 6.5"/></svg>';
  function paneList(a) {
    if (isMuted(a)) return "";
    var ps = (a.panes || []).filter(function (p) { return p && p.surface; });
    if (!ps.length) return "";
    return '<div class="pns">' + ps.map(function (p) {
      var term = p.kind === "term";
      var st = term ? ["sh", ""] : p.asked ? ["wait", "asked you"] : (PST[p.state] || ["unk", ""]);
      var who = term ? "term" : p.kind === "claude" || !p.kind ? "Claude" : String(p.kind);
      var when = !term && st[0] !== "work" && typeof p.since === "number" && p.since > 0 ? " · " + ago(p.since) : "";
      // cmux's stock title says nothing a terminal's chevron does not.
      var what = term ? (p.what === "Terminal" ? "" : String(p.what || "")) : st[1] + when;
      var tip = (term ? "Terminal" + (p.what ? " running " + p.what : "") : who + (st[1] ? ", " + st[1] + when : "")) +
        ": focus this pane";
      return '<div class="pn ' + (term ? "term " : "agent ") + st[0] + '" data-a="pane" data-x="' + esc(p.surface) +
        '" title="' + esc(tip) + '">' + (term ? CHEV : '<span class="pg"></span>') +
        '<span class="pk">' + esc(who) + "</span>" + (what ? '<span class="pw">' + esc(what) + "</span>" : "") +
        (p.plan ? '<span class="ptag plan" title="' + esc("Owns plan " + p.plan) + '">plan</span>' : "") +
        (p.outside ? '<span class="ptag outside" title="Has left the workspace\'s worktree">outside</span>' : "") +
        "</div>";
    }).join("") + "</div>";
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

  // No Wake icon on a row: jumping to the workspace and pressing ⌘E opens its
  // Wake, so an icon on every card was one more mark for little. The collector
  // still lists "wake" among the chips; it is dropped here.
  function chipsOf(a) { return (a.chips || []).filter(function (c) { return c !== "wake"; }); }

  // The footer: what you recognise a row by, in one mono line. Branch, PR and
  // issue are targets; status signals, progress and spend are read, not
  // clicked, so they do not react.
  function foot(a, bare) {
    var out = "";
    // A footer of only the plain facts (no PR, issue or signal) keeps to one line.
    var one = !a.pr && !a.issue && !(a.signals || []).some(function (e) { return !e.a; });
    if (a.branch || a.dirty) out += dotOf(a);
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
    // Spend and the Wake are one unit at the right end: when the line is full
    // they wrap together, still on the right. Apart, the icon alone dropped to
    // the far left of a line of its own, away from the spend it sits beside.
    var end = bare ? "" : cost(a);
    if (end) out += '<span class="end">' + end + "</span>";
    // The footer shows only on an open card, at rest, in the card's own
    // flow. A folded card has none (its .fold is gone); its header's tooltip
    // says the facts instead (factsOf).
    return out ? '<div class="foot' + (one ? " one" : "") + '">' + out + "</div>" : "";
  }

  // A blocked ask has a deadline. The bar is a CSS animation whose duration IS
  // the time remaining, so it drains in real time and finishes exactly when the
  // window closes -- no resident timer, and no number that would be a lie by the
  // next push. (The board pushes every 120s; the window is about that long.)
  function feed(a) {
    if (!a.feedby) return "";
    var left = a.feedby - Math.floor(Date.now() / 1000);
    if (left < 1) return "";
    return '<div class="feed" title="The reply window closes at ' + esc(clockOf(a.feedby * 1000)) + '">' +
      '<span class="feedbar" style="animation-duration:' + left + 's"></span></div>';
  }

  var host = $("rows");
  // Cross-push memory lives on the DOM, the one thing both worlds can see. Without it a
  // one-shot success ripple would either never fire or fire on every push.
  var prev = {};
  try { prev = JSON.parse(host.getAttribute("data-prev") || "{}"); } catch (e) { prev = {}; }
  var next = {};

  // Rows put away leave the list for one collapsed shelf at the end, and
  // count toward nothing above it: snoozed (the app's snooze, until its time
  // or until it needs you; crew-board drops the mark from a row that needs
  // you), settled (merged and idle, worked out by crew-board), and tucked.
  var all = d.rows || [];
  // A family member stays with its family even put away: a plan's
  // workstream is not missing from its card because its worktree was.
  var shelfOf = function (r) {
    if (r.family) return "";
    if (r.tuck === "snooze") return "snoozed";
    if (r.tuck === "tuck") return "tucked";
    return r.settled ? "settled" : "";
  };
  var rows = all.filter(function (r) { return !shelfOf(r); });
  var tkOpen = host.getAttribute("data-tk-open") || "", tkUp = host.getAttribute("data-tk-up") === "1";
  // The shelf's order: snoozed, soonest back first, then settled, then tucked.
  var SHELF_AT = { snoozed: 0, settled: 1, tucked: 2 };
  var shelved = all.filter(shelfOf).map(function (r, i) { return [r, i]; }).sort(function (x, y) {
    var a = x[0], b = y[0], d = SHELF_AT[shelfOf(a)] - SHELF_AT[shelfOf(b)];
    if (!d && shelfOf(a) === "snoozed") d = (+a.until || Infinity) - (+b.until || Infinity);
    return d || x[1] - y[1];
  }).map(function (p) { return p[0]; });
  var was = positions();
  // Every card folds in place. Unfolded by default are the cards that ask
  // something of you -- waiting and broken -- and nothing else; a child starts
  // folded, its family card already says what it is. What you fold or unfold
  // by hand is remembered as id -> [open, tier, last seen] on #rows
  // (data-fold), which survives a push for the same reason data-prev does,
  // and in localStorage, which survives the page loading again (a summon, a
  // server restart). A choice made by hand holds whatever the card's tier
  // does: a folded card that starts waiting on you stays folded, and its
  // filled first chip on the header (.fq) is what says so. An id off the
  // board keeps its choice for a week, so a workspace that drops out of one
  // push comes back as you left it, and the map cannot grow without end.
  var FOLD_KEY = "crew.board.fold", FOLD_KEEP_MS = 7 * 86400000, foldNow = Date.now();
  var foldLS = null;
  try { foldLS = window.localStorage || null; } catch (e) { foldLS = null; }
  // No data-fold yet: this page just loaded, so the browser's copy is the memory.
  var foldRaw = host.getAttribute("data-fold");
  if (foldRaw === null || foldRaw === undefined) {
    try { foldRaw = foldLS && foldLS.getItem(FOLD_KEY); } catch (e) { foldRaw = null; }
  }
  var fold = {};
  try { fold = JSON.parse(foldRaw || "{}"); } catch (e) { fold = {}; }
  if (!fold || typeof fold !== "object" || Array.isArray(fold)) fold = {};
  // An entry is [open, tier, last seen, chosen at]. Another board page on
  // this origin may have chosen since: its newer choices are taken here.
  var chosen = function (f) { return Array.isArray(f) ? +(f[3] || f[2]) || 0 : 0; };
  var stored = {};
  try { stored = (foldLS && JSON.parse(foldLS.getItem(FOLD_KEY) || "{}")) || {}; } catch (e) { stored = {}; }
  for (var sk in stored) if (Array.isArray(stored[sk]) && chosen(stored[sk]) > chosen(fold[sk])) fold[sk] = stored[sk];
  var keptFold = {};
  // ⌘. in the app opens the card it jumped to for the visit (intent.js
  // peekTo): open on every push while it lasts, and never written as a choice.
  var peek = host.getAttribute("data-peek") || "";
  function isOpen(id, kind, isKid) {
    var f = fold[id], open;
    if (Array.isArray(f)) { keptFold[id] = [f[0] ? 1 : 0, f[1] || kind, foldNow, chosen(f)]; open = !!f[0]; }
    else open = !isKid && (kind === "attend" || kind === "wilt");
    return open || (!!peek && id === peek);
  }

  // The opening tag every row shares, card or sub-row.
  // data-id is the delegation handle intent.js needs: #rows survives a push but
  // its children do not, so a click is resolved from the row's id at click time.
  // A row with neither a workspace ref nor a plan has nothing to act on, and is
  // marked inert so it does not offer a pointer it cannot honour.
  // title= on the row, not on .nm: a quiet row's name is often a full shell
  // prompt, and the CSS clamps it to one line, so the hover is the only way to
  // read the whole thing.
  // --own is the worktree's identity colour, the same hex Peacock paints the
  // VS Code window with. It says which worktree, not how the row is doing,
  // so it stays off the header, where a dot beside the name read as a second
  // state dot: it is the ring round the row you stand in (.here), and a dot
  // before the branch in the footer, the worktree's own line. Only a plain
  // hex gets through: it lands in a style attribute.
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
        "<title>" + esc(k.name + (k.badge ? " · " + badgeText(k) : "")) + '</title><path fill-rule="evenodd" d="' +
        PIP + '"/></svg>';
    }).join("") + (more > 0 ? '<span class="pipmore">+' + more + "</span>" : "") + "</span>";
  }

  // A card's header is the jump: one place, folded or not, that switches to
  // its workspace; its ground lifts on hover (CSS). No arrow: it took the
  // name's room to say what the hover already says. A card with no
  // workspace has nothing to jump to, so its header folds it instead.
  // Folding is the caret's job everywhere else: a real button, its own
  // data-a, nearer the click than the header around it.
  var CARET = '<button type="button" class="caret" data-a="fold" aria-label="Fold or unfold"></button>';
  // The opening of a card's header: what a click on it does, then the caret.
  function topOpen(a, cls, foldable) {
    // The header's tooltip replaces the row's, so it leads with the name: a
    // name cut short at Dock width is still readable on hover. A folded card
    // shows no footer, so the footer's hover-only facts (branch, progress,
    // spend) follow on a line of their own: still there, under the pointer.
    var facts = factsOf(a), tip = a.name + (a.ref ? " \u00b7 " + TIP.jump : "") + (facts ? "\n" + facts : "");
    var does = a.ref ? ' data-a="jump" title="' + esc(tip) + '"' : foldable ? ' data-a="fold"' + (facts ? ' title="' + esc(tip) + '"' : "") : "";
    return '<div class="top' + cls + (a.ref ? " jumps" : "") + '"' + does + ">" + (foldable ? CARET : "");
  }
  function topClose() { return "</div>"; }
  // The footer's hover-only facts as words, for the header's tooltip.
  function factsOf(a) {
    var c = typeof a.cost === "number" ? a.cost : 0, unpriced = Array.isArray(a.cost_unpriced) && a.cost_unpriced.length;
    return [a.branch ? a.branch + (a.dirty ? " (uncommitted changes)" : "") : a.dirty ? "uncommitted changes" : "",
      a.meta || "", c > 0 || unpriced ? "$" + (c >= 100 ? Math.round(c) : c.toFixed(2)) + (unpriced ? "+" : "") + " today" : ""]
      .filter(Boolean).join(" \u00b7 ");
  }
  // A card that has something to fold carries .fd, its open state, and its
  // tier in data-k, which is what intent.js writes into data-fold.
  // Whether this push draws any card open: "collapse all" shows when it does.
  var anyOpen = false;
  function foldCls(id, kind, foldable, isKid) {
    if (!foldable) return "";
    var open = isOpen(id, kind, isKid);
    if (open) anyOpen = true;
    return " fd" + (open ? " open" : "");
  }

  // fk is the tier the fold keys on, when it is not the row's own: a family
  // card folds by its family's tier (see card()).
  function opening(a, cls, inCard, fcls, fk) {
    var ripple = turned(a) ? " ripple" : "";
    next[a.id] = a.kind;
    var inert = !a.ref && !a.slug ? " inert" : "";
    var hex = /^#[0-9a-f]{3,8}$/i.test(a.color || "") ? a.color : "";
    // Muted: dimmed until it needs you again, and its tooltip says so.
    var muted = isMuted(a) ? " muted" : "";
    var hid = muted ? " \u00b7 hidden until it needs you" : "";
    // Its ⋯ menu was open before this push: it stays open (intent.js keeps which).
    if (tkOpen && a.id === tkOpen) muted += " tkopen" + (tkUp ? " tkup" : "");
    return '<div class="row ' + a.kind + ripple + inert + muted + (a.selected ? " here" : "") + cls +
      (hex ? " owned" : "") + (fcls || "") + '" data-id="' + esc(a.id) + '" data-k="' + esc(fk || a.kind) + '" title="' + esc(a.name + hid) + '"' +
      (hid ? ' aria-description="' + esc(hid.slice(3)) + '"' : "") +
      (inCard ? ' data-in="' + esc(inCard) + '"' : "") +
      (hex ? ' style="--own:' + hex + '"' : "") + ">" + (ripple ? confetti(a.id, inCard ? 8 : 12) : "");
  }
  function dotOf(a) { return /^#[0-9a-f]{3,8}$/i.test(a.color || "") ? '<span class="own" title="This worktree\u2019s colour"></span>' : ""; }
  // No empty badge: a bare outline pill was the quiet row's second line.
  // A row that needs you says it in the headline's words, "needs you"; its
  // reason opens its said line instead (reasonOf). A limit takes the badge's
  // place: it is the reason the row needs you, and two pills cut the name.
  function badgeText(a) { return a.kind === "attend" ? "needs you" : a.badge; }
  function badgeOf(a) {
    if (a.limited) return limPill(a);
    return a.badge ? '<span class="badge">' + esc(badgeText(a)) + "</span>" : "";
  }
  // The badge's slot: the badge, then the ⋯ after it in the line, which takes
  // its width only while the pointer or focus is on the row (board.html). The
  // name gives the room, by its ellipsis; the badge always reads in full.
  function slotOf(a, inner) {
    var tk = tuckOf(a);
    if (!tk) return inner;
    return '<span class="bs' + (inner ? "" : " nob") + '">' + inner + tk + "</span>";
  }
  function nameOf(a) { return '<span class="nm">' + esc(a.name) + "</span>"; }
  // Mute / tuck, as the app's views offer it: only framed by the app, which
  // keeps tucked.json (intent.js hands the choice to it), and only for a row
  // that is a workspace.
  var inApp = (function () { try { return !!window.parent && window.parent !== window; } catch (e) { return false; } })();
  // One verb for putting a row away: Hide, with when it comes back. The
  // snooze presets (intent.js turns each into an end time at the click) sit
  // between the other two, set apart by dividers. Whatever hides a row now, its item
  // reads Show again. The data-x values are intent.js's, unchanged.
  // Resuming is not hiding: it sits below the Hide group, on its own, and
  // only on a row a usage limit stopped (or one already armed, to undo it).
  var SNOOZES = [["1h", "Hide for 1 hour"], ["3h", "Hide for 3 hours"],
    ["tomorrow", "Hide until tomorrow 9 AM"], ["monday", "Hide until Monday 9 AM"]];
  function tuckOf(a) {
    if (!inApp || !a.cwd) return "";
    var item = function (label, x) { return '<span class="tki" data-a="tuck" data-x="' + x + '">' + label + "</span>"; };
    var sep = '<span class="tks" role="separator"></span>';
    var back = item("Show again", "none");
    var snooze = a.tuck === "snooze" ? back :
      SNOOZES.map(function (s) { return item(s[1], "snooze:" + s[0]); }).join("");
    return '<span class="tk" data-a="tk" title="Hide" aria-label="Hide or show again">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg></span>' +
      '<span class="tkm">' + (a.tuck === "mute" ? back : item("Hide until it needs you", "mute")) + sep + snooze + sep +
      (a.tuck === "tuck" ? back : item("Hide until I bring it back", "tuck")) + resumeOf(a, sep) + "</span>";
  }
  function resumeOf(a, sep) {
    if (!a.limited && !a.armed) return "";
    return sep + '<span class="tki tkr" data-a="resume" data-x="' + (a.armed ? "off" : "on") + '" title="' +
      (a.armed ? "Stop typing continue here when the limit resets"
        : "Type continue here once the limit resets") + '">' +
      (a.armed ? "Don\u2019t resume when the limit resets" : "Resume when the limit resets") + "</span>";
  }
  // Why a row is on the hidden shelf, in muted words of its own: a snoozed
  // row says when it comes back ("until 3:00 PM" today, else "until Mon
  // 9:00 AM", clockOf's format), a settled one that it is merged and idle, a
  // tucked one that it waits for you.
  // A settled row's reclaim is a link in its reason, so every shelf row has
  // the one shape: name, why. No badge: "idle" or "merged" beside "merged and
  // idle" said the row's state twice.
  function whyOf(a) {
    var s = shelfOf(a);
    if (s === "settled") return '<span class="why">merged and idle' + ((a.chips || []).indexOf("reclaim") >= 0 ?
      ' \u00b7 <span class="rcl" data-a="reclaim" title="' + esc(TIP.reclaim) + '">reclaim</span>' : "") + "</span>";
    if (s === "tucked") return '<span class="why">until you bring it back</span>';
    if (s !== "snoozed") return "";
    if (!a.until) return '<span class="why">for now</span>';
    return '<span class="why wakes" title="' + esc(new Date(+a.until).toString()) + '">until ' + esc(clockOf(+a.until)) + "</span>";
  }
  // Everything under a card's head: what was said, the reply window, the
  // buttons, the footer.
  function body(a) {
    return (a.said || a.limited || reasonOf(a) ? '<p class="said">' + saidOf(a) + "</p>" : "") + thumb(a) + feed(a) + paneList(a) + buttons(a) + foot(a);
  }
  // A failed browser check's last frame (the intent server serves it, so a
  // board read from disk shows none). Styled inline: the card has no slot
  // for it in board.html, and one image is not worth a stylesheet rule.
  function thumb(a) {
    if (!a.thumb || !/^\/plan-evidence\//.test(a.thumb)) return "";
    return '<img class="thumb" alt="the failed check\u2019s last frame" loading="lazy" src="' + esc(a.thumb) +
      '" style="display:block;height:56px;margin:6px 0 2px;border-radius:4px;border:1px solid rgba(127,127,127,.35)">';
  }

  // A quiet row is one line and the whole of it is the target, which jumps.
  // Its other chips (diff, pr) stay, as ghosts at the end of the line: a row
  // badged "pr open" with no way to open the PR was the first cut of this.
  // When it has them, they say what the badge would, so the badge steps aside
  // for the name. The Wake is an icon, not one of them, so an idle row with
  // only the Wake still says idle. Spend still shows, at the right end beside
  // the Wake, because a row that is quietly burning money is the one quiet row
  // worth noticing.
  // Unfolded, it shows its footer -- branch, PR, issue -- under the line; its
  // caret folds it, and its line jumps (a row with no workspace folds there).
  // On the hidden shelf a row is one shape, its name and why: its chips are
  // the list's business, a settled row's reclaim is in its why, and its badge
  // would say again what the why says. Its ⋯ comes last, after the why.
  function quietRow(a) {
    var shelf = !!shelfOf(a);
    var acts = shelf ? [] : chipsOf(a).filter(function (c) { return c !== "jump"; });
    var arm = armedChip(a);
    var qb = acts.length || arm ? '<span class="chips">' + acts.map(function (c) {
      return '<span class="chip" title="' + esc(chipTip(c)) + '">' + esc(c) + "</span>";
    }).join("") + arm + "</span>" : "";
    var more = foot(a, true);
    return opening(a, a.family ? " fam" : "", "", foldCls(a.id, a.kind, !!more)) +
      topOpen(a, "", !!more) + nameOf(a) +
      (a.dirty ? DIRTY : "") + (shelf ? "" : slotOf(a, acts.length || arm ? "" : badgeOf(a))) + (acts.length || arm ? qb + limPill(a) : "") +
      (shelf ? whyOf(a) + slotOf(a, "") : "") + cost(a) + topClose(a) +
      (more ? '<div class="fold">' + more + "</div>" : "") + "</div>";
  }

  // The header is the fold. Folded, a card that needs you or is broken keeps
  // its first chip, filled, on the header line, as a family child does.
  function loudChip(a) {
    var first = chipsOf(a)[0];
    return (a.kind === "attend" || a.kind === "wilt") && first ?
      '<span class="chip pri fq" title="' + esc(chipTip(first)) + '">' + esc(first) + "</span>" : "";
  }
  function card(a, kids, roll, g) {
    if (a.kind === "quiet" && !kids) return quietRow(a);
    var whole = g && famDone(g);
    var inner = body(a) + kids, fq = loudChip(a);
    // A family card folds by the family's tier, as a shell does: a working
    // parent holding a child that needs you starts open, so the child's line
    // and button show, and it reopens when a child starts waiting.
    var fk = g && COL[a.famtier] ? a.famtier : a.kind;
    return opening(a, (a.family ? " fam" : "") + (whole ? " famdone" : ""), "",
      foldCls(a.id, fk, !!inner), fk) +
      (whole && !turned(a) ? confetti("fam:" + a.id, 22) : "") +
      topOpen(a, fq ? " loud" : "", !!inner) +
      dial(a.frac, a.kind, a.meta) + nameOf(a) +
      (g ? pips(g.kids) : "") + slotOf(a, roll || badgeOf(a)) + fq + topClose(a) +
      (inner ? '<div class="fold">' + inner + "</div>" : "") + "</div>";
  }

  // The family-complete moment: every child is done now, and at least one of
  // them got there on this push.
  function famDone(g) {
    return g.kids.length > 0 && g.kids.every(function (k) { return k.kind === "done"; }) &&
      g.kids.some(turned);
  }

  // A child, inside its family's card. One line until opened: the caret, its
  // dial, its name and badge. A child that needs you or is broken also
  // shows what it said and its first chip, filled, so the family card answers
  // "what do I press" without opening anything. Its caret (and, with no
  // workspace, its header) folds: intent.js opens the child's full card in
  // place (the body is always rendered, CSS shows it). With a workspace, the
  // header jumps to it, as a card's does. The inline chip is its own target,
  // nearer than either, so it fires its verb for the child.
  function kid(a, inCard) {
    var loud = a.kind === "attend" || a.kind === "wilt";
    var first = chipsOf(a)[0];
    var inline = loud && first ? '<span class="chip pri" title="' + esc(chipTip(first)) + '">' +
      esc(first) + "</span>" : "";
    return opening(a, " fam kid", inCard, foldCls(a.id, a.kind, true, true)) +
      topOpen(a, " kidhd" + (inline ? " loud" : ""), true) + dial(a.frac, a.kind, a.meta) +
      nameOf(a) + badgeOf(a) + inline + topClose(a) +
      (loud && (a.said || a.limited || reasonOf(a)) ? '<p class="said nest" data-a="fold">' + saidOf(a) + "</p>" : "") +
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
    return '<div class="row ' + t + ' fam shell inert' + (whole ? " famdone" : "") + foldCls(id, t, true) +
      '" data-id="' + esc(id) + '" data-k="' + t + '" title="' + esc(g.label) + '">' +
      (whole ? confetti(id, 22) : "") +
      '<div class="top" data-a="fold">' + CARET + '<span class="nm">' + esc(g.label) + "</span>" + pips(g.kids) +
      (rollup(g.kids) || '<span class="badge">' + g.kids.length + " plans</span>") + "</div>" +
      '<div class="fold"><div class="kids">' + g.kids.map(function (k) { return kid(k, id); }).join("") +
      "</div></div></div>";
  }

  // A label before the first quiet row, so the divider between "needs you" and
  // "does not" stays legible now that both are on the page. Emitted inline with
  // the rows rather than as separate markup, because #rows is replaced whole.
  var seenQuiet = false;
  // A quiet member of a family that sorts above the divider sits with its
  // family, not under it (families.py), so it neither opens the quiet section
  // nor counts toward it.
  var belowDivider = function (r) { return r.kind === "quiet" && (!r.famtier || r.famtier === "quiet"); };
  // One shelf for every row put away, so a missing workspace is in one
  // place. Each row says why it is there (whyOf). It stays open or shut
  // across pushes, as a card's fold does (intent.js keeps data-hidden-open).
  var tuckSect = shelved.length ? '<details class="away"' + (host.getAttribute("data-hidden-open") === "1" ? " open" : "") +
    '><summary class="sect">hidden · ' + shelved.length + "</summary>" + shelved.map(quietRow).join("") + "</details>" : "";
  host.innerHTML = (rows.length ? groups.map(function (g) {
    var lead = g.lead || g.kids[0], sect = "";
    if (belowDivider(lead) && !seenQuiet) {
      seenQuiet = true;
      sect = '<div class="sect">idle · ' + rows.filter(belowDivider).length + "</div>";
    }
    if (!g.lead) return sect + shell(g);
    var kids = g.kids.length ? '<div class="kids">' + g.kids.map(function (k) {
      return kid(k, g.lead.id);
    }).join("") + "</div>" : "";
    return sect + card(g.lead, kids, g.kids.length ? rollup(g.kids, g.lead.kind) : "", g.kids.length ? g : null);
  }).join("") :
    '<div class="empty">Nothing is waiting on you.<br>' + esc(d.quiet || "") + "</div>") + tuckSect;
  // "collapse all" shows while any card is open (intent.js hides it again
  // once a fold or its own click leaves none open).
  var fa = $("foldall");
  if (fa) fa.hidden = !anyOpen;
  for (var fid in fold) {
    var ff = fold[fid];
    if (!(fid in keptFold) && Array.isArray(ff) && foldNow - (+ff[2] || foldNow) < FOLD_KEEP_MS) keptFold[fid] = ff;
  }
  var foldOut = JSON.stringify(keptFold);
  host.setAttribute("data-fold", foldOut);
  // Another board page on this origin (cmux's Dock and the app's both frame
  // it) writes the same key: what goes back is the newer choice per card,
  // by when each was chosen, so one page cannot undo the other's fold.
  try {
    if (foldLS) {
      var theirs = {};
      try { theirs = JSON.parse(foldLS.getItem(FOLD_KEY) || "{}") || {}; } catch (e) { theirs = {}; }
      var merged = {};
      for (var mk in keptFold) merged[mk] = keptFold[mk];
      for (var tk in theirs) {
        var t = theirs[tk];
        if (!Array.isArray(t) || foldNow - (+t[2] || foldNow) >= FOLD_KEEP_MS) continue;
        if (!(tk in merged) || chosen(t) > chosen(merged[tk])) merged[tk] = t;
      }
      foldLS.setItem(FOLD_KEY, JSON.stringify(merged));
    }
  } catch (e) { /* storage full or off: the page's copy still holds */ }
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
  // Out of treats is a nap, not news: a limit stop draws no reaction.
  var rx = outOfTreats(rows) ? null : reaction(rows);
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
  // While a row needs you the cat says nothing: the headline counts it and
  // the card says what it wants, so a third "needs you" is noise. Out of
  // treats still shows, since it is the only place that says when the
  // limit lifts for every row at once.
  var asks = rows.some(function (a) { return a.kind === "attend"; });
  var treats = treatsLine(rows);
  if (says) says.textContent = treats || (asks ? "" : rx ? line(rx.cls, rx.top, d.stamp) : line(m, lead ? lead.name : "", d.stamp));
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
    // The collapsed line skips news about a card already open above that
    // needs you: the card says it, louder. Its lede is the first item
    // left; with none left, the title counts the items instead. An item
    // with no id (a hand-made push, like the demo's) is matched by the
    // {{name}} it opens with.
    var asking = {};
    rows.forEach(function (a) {
      if (a.kind !== "attend") return;
      asking[a.id] = 1;
      if (a.family) asking["family:" + a.family] = 1;
      asking["{{" + a.name + "}}"] = 1;
    });
    var fresh = items.filter(function (it) {
      if (it.tier !== "attend") return true;
      var key = it.id || (/^\{\{[^}]*\}\}/.exec(it.text || "") || [""])[0];
      return !asking[key];
    });
    var ledeText = items.length && fresh.length === items.length ? news.lede || "" : fresh.length ? fresh[0].text : "";
    var ttl = $("news-ttl");
    if (ttl) ttl.textContent = "news" + (ledeText ? (news.hours ? " · " + news.hours + "h" : "") : " · " + items.length);
    var lede = $("news-lede");
    if (lede) lede.innerHTML = said(ledeText);
    var body = $("news-body");
    if (body) body.innerHTML = items.map(function (it) {
      var tier = COL[it.tier] ? it.tier : "quiet";
      return '<p class="ni ' + tier + '">' + said(it.text) + "</p>";
    }).join("");
  }
  $("src").textContent = d.src || "";
  var st = $("stamp");
  st.textContent = d.stamp || "";
  // The time of the last change, not of the last look: a quiet board is not
  // pushed again (nothing changed), so a bare clock read as a frozen one. The
  // label is its own element, so #stamp stays a bare HH:MM:SS (crew-board-diag
  // parses it).
  var sl = $("stamp-label");
  if (sl) sl.textContent = d.stamp ? "last change " : "";
  st.className = d.stale ? "stale" : "";
  return rows.length;
}
