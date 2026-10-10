// lookout's page. Everything it draws arrives in #lookout-data: the review
// (source, files, findings) and, per file, rows already highlighted and
// word-marked by the CLI — [type, oldNo, newNo, html]. The html is
// highlight.js output over the repository's own text, escaped by it; nothing
// else is ever inserted as markup.
(() => {
  "use strict";
  const D = JSON.parse(document.getElementById("lookout-data").textContent);
  let R = D.review;               // replaced whole when a fresher copy arrives
  const ROWS = D.rows || {};
  const $ = id => document.getElementById(id);

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  let layout = store.get("lookout.layout", "split") === "unified" ? "unified" : "split";
  const opened = new Set();          // collapsed files the reader chose to show
  const closedDirs = new Set(JSON.parse(store.get("lookout.closed." + R.id, "[]")));
  const narrow = () => window.matchMedia("(max-width: 760px)").matches;

  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;      // highlighted rows only
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  };

  // ---------------------------------------------------------------- tree

  // Files into a directory tree; a folder with one child folder and no files
  // is folded into it, the way VS Code shows compact folders.
  function buildTree(files) {
    const root = { name: "", dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let n = root;
      for (const p of parts.slice(0, -1)) {
        if (!n.dirs.has(p)) n.dirs.set(p, { name: p, dirs: new Map(), files: [] });
        n = n.dirs.get(p);
      }
      n.files.push(f);
    }
    const compact = n => {
      for (const [k, d] of [...n.dirs]) {
        let c = d;
        while (c.files.length === 0 && c.dirs.size === 1) {
          const [only] = c.dirs.values();
          c = { ...only, name: c.name + "/" + only.name };
        }
        n.dirs.delete(k);
        n.dirs.set(c.name, c);
        compact(c);
      }
    };
    compact(root);
    return root;
  }

  // The order j/k walks: the side list's visual order.
  let ORDER = [];
  function drawPathTree() {
    const tree = buildTree(R.files || []);
    ORDER = [];
    const walk = (n, prefix) => {
      const ul = el("ul");
      for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = prefix + d.name;
        const closed = closedDirs.has(key);
        const li = el("li", null,
          el("div", { class: "row dir", title: key, onclick: () => {
            closed ? closedDirs.delete(key) : closedDirs.add(key);
            store.set("lookout.closed." + R.id, JSON.stringify([...closedDirs]));
            drawSide();
          } }, el("span", { class: "chev" }, closed ? "▸" : "▾"), el("span", { class: "name" }, d.name)));
        if (!closed) li.append(walk(d, key + "/"));
        else collectHidden(d);
        ul.append(li);
      }
      for (const f of n.files.sort((a, b) => a.path.localeCompare(b.path))) {
        ORDER.push(f.path);
        const name = f.path.slice(f.path.lastIndexOf("/") + 1);
        ul.append(el("li", null, el("div", {
          class: "row file" + (f.path === current ? " sel" : "") + (f.collapsed ? " collapsed-file" : ""),
          title: f.path + (f.oldPath ? " (from " + f.oldPath + ")" : ""),
          "data-path": f.path, onclick: () => select(f.path),
        }, el("span", { class: "chev" }), el("span", { class: "name" }, name),
           badge(f.path), el("span", { class: "counts" }, countsText(f)),
           el("span", { class: "st st-" + f.status }, f.status))));
      }
      return ul;
    };
    // Files inside a closed folder still take their turn in j/k.
    const collectHidden = n => {
      for (const d of n.dirs.values()) collectHidden(d);
      for (const f of n.files) ORDER.push(f.path);
    };
    $("tree").replaceChildren(walk(tree, ""));
  }

  // Risk view: high, medium and low bands; inside each, the groups whose
  // riskiest file sits in that band, riskiest first. A group of two or more
  // draws a rail beside its files and says why they belong together.
  const BANDS = [["high", 0.6], ["medium", 0.35], ["low", 0]];
  const bandOf = r => BANDS.find(([, min]) => (r || 0) >= min)[0];
  const byPath = () => new Map((R.files || []).map(f => [f.path, f]));

  function fileRow(f, { dir = false } = {}) {
    const cut = f.path.lastIndexOf("/");
    return el("div", {
      class: "row file" + (f.path === current ? " sel" : "") + (f.collapsed ? " collapsed-file" : ""),
      title: f.path + (f.oldPath ? " (from " + f.oldPath + ")" : "") +
        (f.reasons && f.reasons.length ? "\nrisk " + Math.round((f.risk || 0) * 100) + "%: " + f.reasons.join(", ") : ""),
      "data-path": f.path, onclick: () => select(f.path),
    }, el("span", { class: "dot band-" + (f.band || "low") }),
       el("span", { class: "name" }, f.path.slice(cut + 1),
         dir && cut >= 0 ? el("span", { class: "in" }, " " + f.path.slice(0, cut)) : null),
       badge(f.path), el("span", { class: "counts" }, countsText(f)),
       el("span", { class: "st st-" + f.status }, f.status));
  }

  function drawRisk() {
    ORDER = [];
    const box = el("div", { class: "risk-list" });
    for (const [band] of BANDS) {
      const groups = (R.groups || []).filter(g => bandOf(g.risk) === band);
      if (!groups.length) continue;
      const n = groups.reduce((x, g) => x + g.files.length, 0);
      box.append(el("div", { class: "band-head band-" + band }, el("span", null, band), el("span", null, String(n))));
      for (const g of groups) {
        const files = g.files.map(p => byPath().get(p)).filter(Boolean);
        for (const f of files) ORDER.push(f.path);
        if (files.length < 2) { box.append(fileRow(files[0], { dir: true })); continue; }
        const why = (g.edges || []).map(e => e.why);
        box.append(el("div", { class: "group", "data-group": g.id },
          files.map(f => fileRow(f, { dir: true })),
          why.length ? el("div", { class: "why", title: why.join("\n") },
            why.slice(0, 2).join(" · ") + (why.length > 2 ? ` · +${why.length - 2} more` : "")) : null));
      }
    }
    $("tree").replaceChildren(box);
  }

  const hasRisk = () => (R.files || []).some(f => typeof f.risk === "number") && (R.groups || []).length > 0;
  let view = hasRisk() && store.get("lookout.view", "risk") === "risk" ? "risk" : "path";
  function drawSide() {
    if (!hasRisk()) view = "path";
    for (const b of document.querySelectorAll("#view button"))
      b.setAttribute("aria-pressed", String(b.dataset.view === view));
    $("view").hidden = !hasRisk();
    $("side-title").textContent = view === "risk" ? "By risk" : "Changes";
    $("side-count").textContent = String((R.files || []).length);
    view === "risk" ? drawRisk() : drawPathTree();
    drawGhosts();
    $("tree").prepend(el("div", { class: "row ov-row" + (overview ? " sel" : ""), onclick: () => openOverview() },
      el("span", { class: "chev" }, "◇"), el("span", { class: "name" }, "Overview"),
      notesOf().length ? el("span", { class: "counts" }, `${notesOf().length} note(s)`) : null));
  }

  // Files that left the diff (a fix reverted them) but still carry findings
  // or comments. The gate still counts what is open on them, so they stay
  // listed where the human can read and close them.
  const ghosts = () => {
    const here = new Set((R.files || []).map(f => f.path));
    return [...new Set(items().map(x => x.file).filter(p => !here.has(p)))].sort();
  };
  function drawGhosts() {
    const g = ghosts();
    if (!g.length) return;
    $("tree").append(el("div", { class: "band-head ghost-head" }, el("span", null, "no longer in the diff"), el("span", null, String(g.length))),
      ...g.map(p => {
        ORDER.push(p);
        return el("div", { class: "row file ghost" + (p === current ? " sel" : ""), "data-path": p, title: p, onclick: () => select(p) },
          el("span", { class: "chev" }), el("span", { class: "name" }, p.slice(p.lastIndexOf("/") + 1),
            el("span", { class: "in" }, " " + p.slice(0, Math.max(0, p.lastIndexOf("/"))))), badge(p));
      }));
  }
  for (const b of document.querySelectorAll("#view button"))
    b.addEventListener("click", () => { view = b.dataset.view; store.set("lookout.view", view); drawSide(); if (!overview) select(current); });

  const countsText = f => f.binary ? "bin" : `+${f.adds} −${f.dels}`;

  // ---------------------------------------------------------------- findings

  const SEV = ["blocker", "major", "minor", "nit"];
  const isOpen = x => !["resolved", "dismissed"].includes(x.status || "open");
  const items = () => [...(R.findings || []), ...(R.threads || [])];
  const openFindings = p => (R.findings || []).filter(x => x.file === p && isOpen(x));

  // A file's open findings as one badge, colored by the worst of them.
  function badge(p) {
    const o = openFindings(p);
    const t = (R.threads || []).filter(x => x.file === p && isOpen(x)).length;
    if (!o.length && !t) return null;
    const worst = SEV.find(s => o.some(x => x.severity === s));
    return el("span", { class: "fbadge" + (worst ? " sev-" + worst : " sev-comment"),
      title: `${o.length} open finding(s)` + (t ? `, ${t} open comment(s)` : "") }, String(o.length + t));
  }

  const when = iso => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  function message(m) {
    if (m.kind === "status")
      return el("div", { class: "msg change" }, `${m.by} marked it ${m.to}`, m.text ? " — " + m.text : "",
        el("span", { class: "at" }, " · " + when(m.at)));
    return el("div", { class: "msg by-" + m.by }, el("div", { class: "who" }, m.by, el("span", { class: "at" }, " · " + when(m.at))),
      el("div", { class: "text" }, m.text));
  }

  // One finding or comment thread, drawn under its line.
  const expandedClosed = new Set();
  function card(x) {
    const finding = x.id.startsWith("f");
    const closed = !isOpen(x);
    const body = !closed || expandedClosed.has(x.id);
    const head = el("div", { class: "card-head", onclick: closed ? () => { expandedClosed.has(x.id) ? expandedClosed.delete(x.id) : expandedClosed.add(x.id); drawFile(); } : null },
      finding ? el("span", { class: "sev sev-" + x.severity }, x.severity) : el("span", { class: "sev sev-comment" }, "comment"),
      el("span", { class: "fid" }, x.id),
      finding ? el("span", { class: "cat" }, x.category + " · " + (x.verdict === "CONFIRMED" ? "confirmed" : "plausible")) : null,
      el("span", { class: "title" }, finding ? x.short_summary || x.summary : ((x.messages || [])[0] || {}).text || ""),
      el("span", { class: "status st-" + (x.status || "open") }, x.status || "open"));
    return el("div", { class: "card" + (closed ? " closed" : "") + (finding ? "" : " comment"), "data-item": x.id },
      head,
      body && finding ? el("div", { class: "card-body" },
        el("div", { class: "summary" }, x.summary),
        el("div", { class: "failure" }, el("b", null, "Fails when: "), x.failure_scenario)) : null,
      body ? el("div", { class: "msgs" }, (finding ? x.thread || [] : (x.messages || []).slice(1)).map(message)) : null,
      body ? actions(x) : null);
  }
  // Increment 4's comment channel fills this in when the page is served.
  let actions = () => null;

  // Items anchored per file: "new:12" / "old:7" → items; and the ones whose
  // line the drawn diff does not show.
  function anchorsFor(p, drawn) {
    const at = new Map();
    const shown = new Set();
    for (const h of drawn.hunks || []) for (const [, o, n] of h.rows) {
      if (o != null) shown.add("old:" + o);
      if (n != null) shown.add("new:" + n);
    }
    const outside = [];
    for (const x of items().filter(x => x.file === p)) {
      const k = (x.side || "new") + ":" + x.line;
      if (!shown.has(k)) { outside.push(x); continue; }
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(x);
    }
    const sort = a => a.sort((x, y) => (isOpen(y) - isOpen(x)) || SEV.indexOf(x.severity) - SEV.indexOf(y.severity));
    for (const v of at.values()) sort(v);
    return { at, outside: sort(outside) };
  }
  const threadRow = (list, span) => el("tr", { class: "thread-row" }, el("td", { colspan: span },
    el("div", { class: "threads" }, list.map(card))));

  // ---------------------------------------------------------------- notes

  // What the reviewer says each group MEANS (lib/notes.mjs): why it is risky,
  // the direction it moves the design, what to check by hand, the
  // fundamentals it touches. The Overview lists every group with its notes;
  // a file shows its group's note as a strip above the diff.
  //
  // The quiz: with it on (policy.quiz), a note that carries a question shows
  // the question first, its options shuffled, and the note only once the
  // question is answered, so the reader meets the code before the agent's
  // account of it. Answers are recorded by crew's server; opened as a file the
  // page cannot record one, so it shows the notes and says so.
  const notesOf = () => R.notes || [];
  const TOUCH = { "invariant": "invariant", "security-boundary": "security boundary",
                  "data-model": "data model", "cross-system-assumption": "cross-system assumption" };
  const quizOn = () => !!(R.policy && R.policy.quiz);
  // Served means asked: from http(s) even before serve() runs, so the first
  // draw never shows a note its question should hide.
  const served = () => !!live || /^https?:$/.test(location.protocol);
  const asking = n => quizOn() && served() && n.quiz && !n.quiz.answered;
  const groupOf = p => (R.groups || []).find(g => g.files.includes(p));
  // The notes about a file: its group's, and a partial note that covers it
  // from another group.
  const notesFor = p => {
    const g = groupOf(p);
    return notesOf().filter(n => (g && n.group === g.id) || n.files.includes(p));
  };
  // A stable shuffle per note, so options do not move between redraws.
  function order(n) {
    let h = 2166136261;
    for (const c of n.id + n.quiz.prompt) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const ix = n.quiz.options.map((_, i) => i);
    for (let i = ix.length - 1; i > 0; i--) {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      const j = h % (i + 1);
      [ix[i], ix[j]] = [ix[j], ix[i]];
    }
    return ix;
  }
  // Recording an answer is crew's server's (the `answer` op), set by serve();
  // opened as a file the options cannot be picked.
  let answer = null;

  function marks(n) {
    const others = n.partial ? [...new Set(n.files.map(p => groupOf(p)).filter(g => g && g.id !== n.group).map(g => g.id))] : [];
    return [
      n.stale ? el("span", { class: "nmark stale", title: "One of its files changed after the note was written; the reviewer has not looked again." }, "stale") : null,
      n.partial ? el("span", { class: "nmark partial", title: "Its files are split across groups." }, "partial" + (others.length ? ": also " + others.join(", ") : "")) : null,
    ];
  }

  function watchLink(w) {
    return el("li", null, el("a", { href: "#", class: "wloc", onclick: e => { e.preventDefault(); goToLine(w.file, w.side || "new", w.line); } },
      `${w.file.slice(w.file.lastIndexOf("/") + 1)}:${w.line}`), w.outside ? el("span", { class: "outside-tag", title: "a line the diff does not show" }, " outside") : null,
      " ", w.text);
  }

  function noteBody(n) {
    const drift = (n.drift || []).map(id => (R.findings || []).find(f => f.id === id)).filter(Boolean);
    return el("div", { class: "note-body" },
      el("div", { class: "nfield" }, el("div", { class: "nlabel" }, "Why it is risky"), el("div", null, n.why_risky)),
      el("div", { class: "nfield" }, el("div", { class: "nlabel" }, "Direction"), el("div", null, n.direction)),
      (n.watch || []).length ? el("div", { class: "nfield" }, el("div", { class: "nlabel" }, "Watch for"),
        el("ul", { class: "watch" }, n.watch.map(watchLink))) : null,
      drift.length ? el("div", { class: "nfield drift" }, el("div", { class: "nlabel" }, "Drift from the plan"),
        el("ul", { class: "watch" }, drift.map(f => el("li", null,
          el("a", { href: "#", class: "wloc", onclick: e => { e.preventDefault(); goTo(f.id); } }, f.id),
          ` ${f.severity}${isOpen(f) ? "" : " (" + f.status + ")"} `, f.short_summary || f.summary)))) : null,
      (n.touches || []).length ? el("div", { class: "touches" }, n.touches.map(t => el("span", { class: "touch" }, TOUCH[t] || t))) : null);
  }

  // A question in place of its note, or (answered) the result above the note.
  function quizBlock(n) {
    const q = n.quiz;
    if (q.answered) {
      const a = q.answered;
      return el("div", { class: "quiz done " + (a.correct ? "right" : "wrong") },
        el("div", { class: "qprompt" }, q.prompt),
        el("div", null, "You answered: ", el("b", null, q.options[a.pick] ?? "?"),
          a.correct ? " — right." : " — not what the code does."),
        a.correct ? null : el("div", null, "Expected: ", el("b", null, q.options[q.answer])),
        el("div", { class: "qwhy" }, q.why));
    }
    const status = el("span", { class: "send-status" });
    const ix = order(n);
    return el("div", { class: "quiz ask" },
      el("div", { class: "qlead" }, "Before the note: answer from the code."),
      el("div", { class: "qprompt" }, q.prompt),
      el("div", { class: "qopts" }, ix.map((i, k) => el("button", {
        type: "button", class: "qopt", disabled: !answer,
        title: answer ? null : "this server cannot record answers yet",
        onclick: () => answer && answer(n, i, status),
      }, el("span", { class: "qkey" }, String.fromCharCode(97 + k)), " ", q.options[i]))),
      status);
  }

  function noteCard(n) {
    return el("div", { class: "note", "data-note": n.id },
      el("div", { class: "note-head" }, el("span", { class: "nid" }, n.id),
        el("span", { class: "nfiles" }, n.files.map(p => p.slice(p.lastIndexOf("/") + 1)).join(", ")), ...marks(n)),
      asking(n) ? quizBlock(n) : [n.quiz && n.quiz.answered ? quizBlock(n) : null, noteBody(n)]);
  }

  // The strip above a file's diff: one line per note about it, expanding to
  // the note; a question still waiting sends the reader to the Overview.
  const stripOpen = new Set();
  function strip(p) {
    const ns = notesFor(p);
    if (!ns.length) return "";
    return el("div", { class: "strips" }, ns.map(stripOf));
  }
  // One strip; toggling it swaps only this element, so the diff below (and
  // a comment being typed in it) is left alone.
  function stripOf(n) {
    if (asking(n))
      return el("div", { class: "strip ask", onclick: () => openOverview(n.id) },
        el("span", { class: "chev" }, "?"), el("span", { class: "sline" }, `${n.group || n.id}: a question waits before this note — answer it in the Overview`));
    const openNow = stripOpen.has(n.id);
    const node = el("div", { class: "strip" + (openNow ? " open" : "") },
      el("div", { class: "strip-head", onclick: () => { openNow ? stripOpen.delete(n.id) : stripOpen.add(n.id); node.replaceWith(stripOf(n)); } },
        el("span", { class: "chev" }, openNow ? "▾" : "▸"),
        el("span", { class: "sgroup" }, n.group || n.id),
        el("span", { class: "sline" }, n.direction), ...marks(n)),
      openNow ? noteBody(n) : null);
    return node;
  }

  // The architecture pass: every group, riskiest first, with its notes.
  let overview = false;
  function drawOverview() {
    const groups = R.groups || [];
    const ns = notesOf();
    const waiting = ns.filter(asking).length;
    const head = [el("span", { class: "path" }, "Overview"),
      el("span", { class: "from" }, `${groups.length} group(s) · ${ns.length} note(s)` +
        (quizOn() ? ` · quiz on${waiting ? `, ${waiting} to answer` : ""}` : ""))];
    $("file-head").replaceChildren(...head);
    const box = el("div", { class: "ov" });
    if (quizOn() && !served())
      box.append(el("div", { class: "ov-line" }, "This review has the quiz on, which needs crew's intent server to record answers. Opened as a file, the notes are shown in full."));
    if (!R.reviewedAt) box.append(el("div", { class: "ov-line" }, "No reviewer has reported yet: groups are lookout's, and there are no notes."));
    else if (!ns.length) box.append(el("div", { class: "ov-line" }, "The reviewer wrote no notes for this review."));
    for (const g of groups) {
      const files = g.files.map(p => byPath().get(p)).filter(Boolean);
      const mine = ns.filter(n => n.group === g.id);
      const band = g.band || bandOf(g.risk);
      if (!mine.length && band === "low") continue;
      const why = [...new Set((g.edges || []).map(e => e.why))];
      box.append(el("section", { class: "ov-group band-" + band, "data-group": g.id },
        el("div", { class: "ov-head" }, el("span", { class: "dot band-" + band }), el("span", { class: "gid" }, g.id),
          el("span", { class: "gband" }, band),
          el("span", { class: "gfiles" }, files.map(f => el("a", { href: "#", class: "gfile", title: f.path,
            onclick: e => { e.preventDefault(); select(f.path); } }, f.path.slice(f.path.lastIndexOf("/") + 1), badge(f.path))))),
        why.length ? el("div", { class: "ov-why" }, why.join(" · ")) : null,
        mine.length ? mine.map(noteCard) : el("div", { class: "ov-none" }, "No note for this group.")));
    }
    const low = groups.filter(g => (g.band || bandOf(g.risk)) === "low" && !ns.some(n => n.group === g.id));
    if (low.length)
      box.append(el("div", { class: "ov-line" }, `${low.length} low-risk group(s) without notes: `,
        ...low.flatMap(g => g.files).map((p, i) => [i ? ", " : "", el("a", { href: "#", class: "gfile",
          onclick: e => { e.preventDefault(); select(p); } }, p.slice(p.lastIndexOf("/") + 1))])));
    const lost = ns.filter(n => !n.group);
    if (lost.length)
      box.append(el("section", { class: "ov-group" }, el("div", { class: "ov-head" }, "Notes on files no longer in the diff"), lost.map(noteCard)));
    $("diff").replaceChildren(box);
  }

  function openOverview(noteId) {
    overview = true;
    current = null;
    try { history.replaceState(null, "", "#overview"); } catch { /* file:// in some hosts */ }
    for (const r of document.querySelectorAll("#tree .row")) r.classList.remove("sel");
    drawOverviewChrome();
    drawOverview();
    $("main").scrollTop = 0;
    const c = noteId && document.querySelector(`[data-note="${CSS.escape(noteId)}"]`);
    if (c) { c.scrollIntoView({ block: "center" }); c.classList.add("flash"); }
  }
  function drawOverviewChrome() {
    $("ov-btn").setAttribute("aria-pressed", String(overview));
    const row = document.querySelector("#tree .ov-row");
    if (row) row.classList.toggle("sel", overview);
  }
  function toggleOverview() {
    if (overview) select(lastFile && (R.files || []).some(f => f.path === lastFile) ? lastFile : ORDER[0] || null);
    else openOverview();
  }
  $("ov-btn").addEventListener("click", toggleOverview);
  const drawMain = () => overview ? drawOverview() : drawFile();

  // A watch item's line: its file, uncollapsed, scrolled to the row.
  function goToLine(p, side, line) {
    if (!(R.files || []).some(f => f.path === p)) return;
    select(p);
    if ((R.files.find(f => f.path === p) || {}).collapsed && !opened.has(p)) { opened.add(p); drawFile(); }
    const tr = document.querySelector(`#diff tr.line[data-${side === "old" ? "old" : "new"}="${line}"]`);
    if (!tr) return;
    tr.scrollIntoView({ block: "center" });
    for (const o of document.querySelectorAll("tr.line.flash")) o.classList.remove("flash");
    tr.classList.add("flash");
  }

  // ---------------------------------------------------------------- diff

  let current = null, lastFile = null;
  function select(p) {
    current = p;
    if (p) lastFile = p;
    overview = false;
    drawOverviewChrome();
    if (!p) { drawFile(); return; }
    try { history.replaceState(null, "", "#file=" + encodeURIComponent(p)); } catch { /* file:// in some hosts */ }
    for (const r of document.querySelectorAll("#tree .row.file"))
      r.classList.toggle("sel", r.dataset.path === p);
    const s = document.querySelector(`#tree .row.file[data-path="${CSS.escape(p)}"]`);
    if (s) s.scrollIntoView({ block: "nearest" });
    drawFile();
    $("main").scrollTop = 0;
  }

  function fileHead(f) {
    const cut = f.path.lastIndexOf("/");
    return [
      el("span", { class: "st st-" + f.status }, f.status),
      el("span", { class: "path" }, cut >= 0 ? el("span", { class: "dir" }, f.path.slice(0, cut + 1)) : null,
        f.path.slice(cut + 1)),
      f.oldPath ? el("span", { class: "from" }, "from " + f.oldPath) : null,
      el("span", { class: "counts" }, el("span", { class: "plus" }, "+" + f.adds), " ",
        el("span", { class: "minus" }, "−" + f.dels)),
      typeof f.risk === "number" ? el("span", { class: "risk band-" + (f.band || "low"),
        title: (f.reasons || []).join(", ") }, `${f.band} risk`,
        f.reasons && f.reasons.length ? el("span", { class: "reasons" }, " · " + f.reasons.join(", ")) : null) : null,
      f.lang ? el("span", { class: "lang" }, f.lang) : null,
    ];
  }

  function notice(f, drawn) {
    const why = f.binary || drawn.note === "binary" ? "Binary file — there is no text diff to show."
      : drawn.note === "too-large" ? `${drawn.total} changed rows — too large to draw here. Use git diff for this file.`
      : f.generated ? "Generated file — collapsed."
      : f.large ? `Large change (${f.adds + f.dels} lines) — collapsed.`
      : "Collapsed.";
    const canShow = !f.binary && !drawn.note;
    return el("div", { class: "notice" }, el("div", null, why),
      canShow ? el("button", { type: "button", onclick: () => { opened.add(f.path); drawFile(); } }, "Show diff") : null);
  }

  const lnCell = (n, cls, side) => el("td", { class: "ln" + (cls ? " " + cls : ""),
    "data-side": n == null ? null : side, "data-line": n == null ? null : n }, n == null ? "" : String(n));
  const codeCell = (html, cls, sign) => el("td", { class: "code" + (cls ? " " + cls : ""), "data-sign": sign, html });
  const KIND = { "+": "add", "-": "del", " ": "" };

  // The items to draw after a row: each anchor key once per table.
  function takeAt(anch, used, keys) {
    const out = [];
    for (const k of keys) if (k && anch.at.has(k) && !used.has(k)) { used.add(k); out.push(...anch.at.get(k)); }
    return out;
  }

  function unified(drawn, anch) {
    const t = el("table", { class: "diff unified" },
      el("colgroup", null, el("col", { style: "width:52px" }), el("col", { style: "width:52px" }), el("col")));
    const used = new Set();
    for (const h of drawn.hunks) {
      t.append(el("tr", { class: "hunk" }, el("td", { colspan: 3 }, h.header)));
      for (const [ty, o, n, html] of h.rows) {
        const k = KIND[ty];
        t.append(el("tr", { class: "line " + (k || "ctx"), "data-old": o ?? null, "data-new": n ?? null },
          lnCell(o, k, "old"), lnCell(n, k, "new"), codeCell(html, k, ty === " " ? " " : ty)));
        const here = takeAt(anch, used, [n != null ? "new:" + n : null, o != null ? "old:" + o : null]);
        if (here.length) t.append(threadRow(here, 3));
      }
    }
    return t;
  }

  function split(drawn, anch) {
    const t = el("table", { class: "diff split" },
      el("colgroup", null, el("col", { style: "width:52px" }), el("col"), el("col", { style: "width:52px" }), el("col")));
    const used = new Set();
    const pair = (l, r) => {
      const row = pairRow(l, r);
      const here = takeAt(anch, used, [r ? "new:" + r[2] : null, l ? "old:" + l[1] : null]);
      return here.length ? [row, threadRow(here, 4)] : [row];
    };
    const pairRow = (l, r) => el("tr", { class: "line", "data-old": l ? l[1] : null, "data-new": r ? r[2] : null },
      l ? lnCell(l[1], KIND[l[0]], "old") : el("td", { class: "ln empty" }),
      l ? codeCell(l[3], KIND[l[0]], l[0] === " " ? " " : l[0]) : el("td", { class: "code empty" }),
      r ? lnCell(r[2], KIND[r[0]], "new") : el("td", { class: "ln empty" }),
      r ? codeCell(r[3], KIND[r[0]], r[0] === " " ? " " : r[0]) : el("td", { class: "code empty" }));
    for (const h of drawn.hunks) {
      t.append(el("tr", { class: "hunk" }, el("td", { colspan: 4 }, h.header)));
      const rows = h.rows;
      for (let i = 0; i < rows.length;) {
        if (rows[i][0] === " ") { t.append(...pair(rows[i], rows[i])); i++; continue; }
        const dels = [], adds = [];
        while (i < rows.length && rows[i][0] === "-") dels.push(rows[i++]);
        while (i < rows.length && rows[i][0] === "+") adds.push(rows[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) t.append(...pair(dels[k], adds[k]));
      }
    }
    return t;
  }

  function drawFile() {
    const f = (R.files || []).find(x => x.path === current);
    if (!f && current && ghosts().includes(current)) {
      $("file-head").replaceChildren(el("span", { class: "path" }, current), el("span", { class: "from" }, "no longer in the diff"));
      $("diff").replaceChildren(el("div", { class: "outside" },
        el("div", { class: "outside-head" }, "This file has left the diff; what was said on it is kept until closed"),
        el("div", { class: "threads" }, items().filter(x => x.file === current).map(card))));
      return;
    }
    if (!f) {
      $("file-head").replaceChildren();
      $("diff").replaceChildren(el("div", { class: "empty-review" },
        (R.files || []).length ? "Pick a file." : "No changes to review."));
      return;
    }
    $("file-head").replaceChildren(...fileHead(f).filter(Boolean));
    const drawn = ROWS[f.path] || { note: "missing" };
    if (drawn.note || (f.collapsed && !opened.has(f.path))) {
      $("diff").replaceChildren(strip(f.path), notice(f, drawn));
      return;
    }
    // An added or deleted file has one side; split would draw half a page of nothing.
    const oneSided = drawn.hunks.every(h => h.rows.every(r => r[0] === "+")) ||
                     drawn.hunks.every(h => h.rows.every(r => r[0] === "-"));
    const useSplit = layout === "split" && !narrow() && !oneSided;
    const anch = anchorsFor(f.path, drawn);
    $("diff").replaceChildren(
      strip(f.path),
      anch.outside.length ? el("div", { class: "outside" }, el("div", { class: "outside-head" }, "On lines this diff does not show"),
        el("div", { class: "threads" }, anch.outside.map(card))) : "",
      useSplit ? split(drawn, anch) : unified(drawn, anch));
  }

  // n / p: through open findings (all of them once none is open), in the
  // side list's order, then by line.
  function stepFinding(d) {
    let list = (R.findings || []).filter(isOpen);
    if (!list.length) list = R.findings || [];
    if (!list.length) return;
    const pos = x => [ORDER.indexOf(x.file), x.line];
    list = [...list].sort((a, b) => pos(a)[0] - pos(b)[0] || a.line - b.line);
    let i = list.findIndex(x => x.id === curFinding);
    i = i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length;
    goTo(list[i].id);
  }
  let curFinding = null;
  function goTo(id) {
    const x = items().find(y => y.id === id);
    if (!x) return;
    curFinding = id;
    if (x.file !== current) select(x.file);
    const f = (R.files || []).find(y => y.path === x.file);
    if (f && f.collapsed && !opened.has(f.path)) { opened.add(f.path); drawFile(); }
    if (!isOpen(x)) { expandedClosed.add(id); drawFile(); }
    const c = document.querySelector(`[data-item="${CSS.escape(id)}"]`);
    if (c) {
      c.scrollIntoView({ block: "center" });
      for (const o of document.querySelectorAll(".card.flash")) o.classList.remove("flash");
      c.classList.add("flash");
    }
  }

  // ---------------------------------------------------------------- chrome

  function drawLayout() {
    for (const b of document.querySelectorAll("#layout button"))
      b.setAttribute("aria-pressed", String(b.dataset.layout === layout));
  }
  function setLayout(l) { layout = l; store.set("lookout.layout", l); drawLayout(); drawMain(); }
  for (const b of document.querySelectorAll("#layout button"))
    b.addEventListener("click", () => setLayout(b.dataset.layout));

  function step(d) {
    if (!ORDER.length) return;
    // From the Overview, j/k move on from the file the reader left.
    const i = ORDER.indexOf(current ?? lastFile);
    select(ORDER[Math.max(0, Math.min(ORDER.length - 1, (i < 0 ? 0 : i + d)))]);
  }
  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "j") { step(1); e.preventDefault(); }
    else if (e.key === "k") { step(-1); e.preventDefault(); }
    else if (e.key === "v") { setLayout(layout === "split" ? "unified" : "split"); e.preventDefault(); }
    else if (e.key === "n") { stepFinding(1); e.preventDefault(); }
    else if (e.key === "p") { stepFinding(-1); e.preventDefault(); }
    else if (e.key === "o") { toggleOverview(); e.preventDefault(); }
  });
  let wasNarrow = narrow();
  window.addEventListener("resize", () => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); drawMain(); } });

  // The gate as the page sees it, the same rule `lookout gate` applies.
  function gateText() {
    if (!R.reviewedAt) return { cls: "none", text: "not reviewed yet" };
    const open = (R.findings || []).filter(isOpen);
    const blocking = open.filter(x => x.severity === "blocker" || x.severity === "major");
    const counts = SEV.map(s => [s, open.filter(x => x.severity === s).length]).filter(([, n]) => n)
      .map(([s, n]) => `${n} ${s}`).join(", ");
    if (blocking.length) return { cls: "blocked", text: `blocked · ${counts} open` };
    return { cls: "pass", text: open.length ? `pass · ${counts} open` : "pass · no open findings" };
  }

  function drawHeader() {
    $("title").textContent = R.title || R.id;
    const s = R.stats || {};
    const where = R.source && (R.source.kind === "patch" ? "patch " + R.source.label : R.source.label);
    $("label").textContent = [where !== R.title ? where : null,
      `${s.files || 0} files`, `+${s.adds || 0} −${s.dels || 0}`].filter(Boolean).join(" · ");
    const g = gateText();
    $("mode").textContent = live ? "live" : "read-only";
    $("mode").className = "mode " + (live ? "live" : "file");
    $("mode").title = live ? "Comments and closes go to the agent at its next prompt."
      : "Opened as a file: comments need crew's intent server (lookout open shows the served page when it is up).";
    $("gate").className = "gate " + g.cls;
    $("gate").textContent = g.text;
    $("gate").title = (R.policy && R.policy.agentMayClose) ? "The agent may also close findings on this review."
                                                           : "Only you close findings; the agent replies and marks them addressed.";
    document.title = "lookout · " + R.id;
    const notes = [];
    if (R.highlight && !/^highlight\.js/.test(R.highlight) && R.highlight !== "off")
      notes.push("Drawn without syntax highlighting: " + R.highlight);
    if (R.scoring && !R.scoring.ok)
      notes.push("Risk from signals only — " + (R.scoring.why || "no Jev scores") + ".");
    $("banner").textContent = notes.join("  ");
    $("banner").hidden = !notes.length;
  }

  // Swap in a fresher review (the served page polls for one) and redraw what
  // depends on it, keeping the reader's place.
  function applyReview(next) {
    const y = $("main").scrollTop;
    R = next;
    drawHeader();
    drawSide();
    drawMain();
    $("main").scrollTop = y;
  }
  // ---------------------------------------------------------------- served

  // Served by crew's intent server, the page takes comments and closes and
  // polls for the agent's replies. From a file it stays read-only: there is
  // nothing to send them to.
  let live = null;
  function serve({ token, id }) {
    live = { token, id, pending: null };
    document.body.classList.add("served");
    drawHeader();
    const post = body => fetch("/review/" + encodeURIComponent(id), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, t: token }),
    }).then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || "refused"); return j; }));

    // A composer with words in it is never redrawn away; a fresher review
    // waits until it is sent or cancelled.
    const busy = () => [...document.querySelectorAll("textarea")].some(t => t.value.trim());
    const take = next => {
      if (next.patchHash !== R.patchHash) { location.reload(); return; }
      if (busy()) { live.pending = next; return; }
      live.pending = null;
      applyReview(next);
    };
    // Every 2.5s while visible; a background tab checks every 15s, so it is
    // current by the time someone looks, and catches up at once when shown.
    let ticks = 0;
    const poll = (e) => {
      if (document.hidden && !e && ++ticks % 6) return;
      fetch(`/review/${encodeURIComponent(id)}.json?t=${encodeURIComponent(token)}`, { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j && j.updatedAt !== R.updatedAt) take(j); else if (live.pending && !busy()) take(live.pending); })
        .catch(() => { /* the server restarted; the next poll will tell */ });
    };
    setInterval(() => poll(), 2500);
    document.addEventListener("visibilitychange", e => { if (!document.hidden) poll(e); });

    const send = (body, status) => {
      status.textContent = "sending…";
      return post(body).then(j => { live.pending = null; applyReview(j.review); })
        .catch(e => { status.textContent = e.message; status.classList.add("bad"); throw e; });
    };

    // A quiz answer: graded and recorded by the server, once; the redraw
    // that follows shows the note with the result above it.
    answer = (n, pick, status) => {
      for (const b of document.querySelectorAll(`[data-note="${CSS.escape(n.id)}"] .qopt`)) b.disabled = true;
      send({ op: "answer", item: n.id, pick }, status).then(() => {}, () => {
        for (const b of document.querySelectorAll(`[data-note="${CSS.escape(n.id)}"] .qopt`)) b.disabled = false;
      });
    };

    // Reply, and close or reopen, under every card.
    actions = x => {
      const finding = x.id.startsWith("f");
      const open = isOpen(x);
      const ta = el("textarea", { rows: 2, placeholder: open ? "Reply, or a note for a close…" : "Reply…" });
      const status = el("span", { class: "send-status" });
      const go = (op, needText) => () => {
        if (needText && !ta.value.trim()) { ta.focus(); return; }
        send({ op, item: x.id, text: ta.value }, status).then(() => {}, () => {});
      };
      ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go("comment", true)(); });
      return el("div", { class: "actions" }, ta, el("div", { class: "buttons" },
        el("button", { type: "button", class: "primary", onclick: go("comment", true) }, "Reply"),
        open ? el("button", { type: "button", onclick: go("resolve") }, "Resolve") : null,
        open && finding ? el("button", { type: "button", onclick: go("dismiss") }, "Dismiss") : null,
        !open ? el("button", { type: "button", onclick: go("reopen") }, "Reopen") : null,
        status));
    };

    // A click on a line number opens a comment under that line.
    $("diff").addEventListener("click", e => {
      const cell = e.target.closest && e.target.closest("td.ln[data-line]");
      if (!cell) return;
      const tr = cell.closest("tr");
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("composer")) { next.remove(); return; }
      const side = cell.dataset.side, line = Number(cell.dataset.line);
      const span = tr.children.length;
      const ta = el("textarea", { rows: 3, placeholder: `Comment on ${side === "old" ? "old " : ""}line ${line}…` });
      const status = el("span", { class: "send-status" });
      const row = el("tr", { class: "composer" }, el("td", { colspan: span },
        el("div", { class: "card comment" }, el("div", { class: "actions" }, ta, el("div", { class: "buttons" },
          el("button", { type: "button", class: "primary", onclick: submit }, "Comment"),
          el("button", { type: "button", onclick: () => { row.remove(); if (live.pending) take(live.pending); } }, "Cancel"),
          status)))));
      function submit() {
        if (!ta.value.trim()) { ta.focus(); return; }
        send({ op: "comment", file: current, line, side, text: ta.value }, status).then(() => {}, () => {});
      }
      ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) submit(); });
      tr.after(row);
      ta.focus();
    });
    drawSide();
    drawMain();
  }

  window.lookout = { get review() { return R; }, applyReview, serve, el, current: () => current,
                     overview: () => overview, openOverview, goToLine };

  drawHeader();
  drawLayout();
  drawSide();
  // Architecture first: a review with notes opens on its Overview, unless the
  // link names a file.
  const want = decodeURIComponent((location.hash.match(/file=([^&]+)/) || [])[1] || "");
  if ((R.files || []).some(f => f.path === want)) select(want);
  else if (location.hash === "#overview" || notesOf().length) openOverview();
  else select(ORDER[0] || null);
})();
