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
  // A file's status letter, spelled out in its tooltip.
  const ST_NAMES = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed" };
  // In the side list it is one of a row's extras (class "x", review.css): out
  // of sight at rest, shown on the selected or hovered row.
  const stLetter = (f, cls = "") => el("span", { class: "st st-" + f.status + (cls ? " " + cls : ""), title: ST_NAMES[f.status] || f.status }, f.status);
  // Split needs room: with the diff column under SPLIT_MIN px the page draws
  // unified, whatever the saved choice (which it keeps), and draws split
  // again once the column is wide enough. The column, not the window: the
  // file list and the app's own side take width too.
  // 900, not 700: at 700-800px split wrapped nearly every line.
  const SPLIT_MIN = 900;
  const cramped = () => narrow() || ($("main").offsetWidth > 0 && $("main").offsetWidth < SPLIT_MIN);
  // Framed by the seamux app (?embed=app), whose own header names the review:
  // the page drops its title row and keeps one row of tools.
  const embedded = (() => { try { return new URLSearchParams(location.search).get("embed") === "app"; } catch { return false; } })();
  if (embedded) document.documentElement.dataset.embed = "app";
  // Set once the app says it shows the page's tools on its own header row (postState).
  let hosted = false;
  let hostOrigin = "*";
  let helloTimer = 0;
  // "1 file", "2 files"; `many` for the odd plural.
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  // Drafts: every reply box and line composer keeps its words here, per
  // review, so a redraw (a fresher review, the layout toggle, the 760px
  // breakpoint, a reload) puts them back instead of dropping them.
  const DRAFTS = "lookout.drafts." + R.id;
  const drafts = (() => { try { return JSON.parse(store.get(DRAFTS, "{}")) || {}; } catch { return {}; } })();
  // A reply draft is its text (its item keeps its id across diffs). A line
  // composer's draft is { t, h, x }: its text, the patchHash it was written
  // against, and the text of its line then, so a new diff never places it
  // under different code.
  const draftText = k => { const d = drafts[k]; return d == null ? "" : typeof d === "string" ? d : d.t || ""; };
  // Read-modify-write of one key: another tab on this review keeps its own
  // drafts in the same entry, and writing this tab's whole copy would drop them.
  const readDrafts = () => { try { return JSON.parse(store.get(DRAFTS, "{}")) || {}; } catch { return {}; } };
  // Keys typed in on this page since it loaded: a draft merely restored from
  // storage is shown, but does not hold fresher reviews back (busy()).
  const edited = new Set();
  const saveDraft = (k, v, meta) => {
    const all = readDrafts();
    if (String(v || "").trim()) { drafts[k] = all[k] = meta ? { t: v, ...meta } : v; edited.add(k); }
    else { delete drafts[k]; delete all[k]; edited.delete(k); }
    store.set(DRAFTS, JSON.stringify(all));
  };
  // Another tab's writes: taken into this tab's copy (not redrawn under the
  // reader), so the next redraw here places them.
  // Only keys the other tab removed (in its old value, not its new one) leave
  // this tab's copy: a draft this tab could not save is not in storage
  // either, and must not be dropped for it.
  window.addEventListener("storage", e => {
    if (e.key !== DRAFTS) return;
    const parse = v => { try { return JSON.parse(v || "{}") || {}; } catch { return {}; } };
    const before = parse(e.oldValue), now = parse(e.newValue);
    for (const k of Object.keys(before)) if (!(k in now)) delete drafts[k];
    Object.assign(drafts, now);
  });
  // Set by serve(): reopens composers and refills drafts after a redraw.
  let afterDraw = () => {};

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
          title: rowTitle(f), "data-path": f.path, onclick: () => select(f.path),
        }, el("span", { class: "chev" }), el("span", { class: "name" }, name),
           badge(f.path), el("span", { class: "counts x" }, countsText(f)),
           stLetter(f, "x"))));
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

  // A file row is quiet: its risk dot, its name and its findings badge. The
  // folder, the +/- counts and the status letter are extras (class "x"):
  // review.css shows them on the selected or hovered row and keeps them in
  // the DOM otherwise. The tooltip says all of it, and why the file sits in
  // its group (`why`), which is not a row of its own.
  function rowTitle(f, why = []) {
    const risk = typeof f.risk === "number" ? riskLine(f) : "";
    return [f.path + (f.oldPath ? " (from " + f.oldPath + ")" : ""),
      countsText(f) + " · " + (ST_NAMES[f.status] || f.status),
      risk, why.length ? "Grouped: " + why.join("; ") : ""].filter(Boolean).join("\n");
  }
  function fileRow(f, { dir = false, why = [] } = {}) {
    const cut = f.path.lastIndexOf("/");
    return el("div", {
      class: "row file" + (f.path === current ? " sel" : "") + (f.collapsed ? " collapsed-file" : ""),
      title: rowTitle(f, why), "data-path": f.path, onclick: () => select(f.path),
    }, el("span", { class: "dot band-" + (f.band || "low") }),
       el("span", { class: "name" }, f.path.slice(cut + 1),
         dir && cut >= 0 ? el("span", { class: "in x" }, " " + f.path.slice(0, cut)) : null),
       badge(f.path), el("span", { class: "counts x" }, countsText(f)),
       stLetter(f, "x"));
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
        // Why they belong together is the group's tooltip and each row's, and
        // the Overview's line under the group: never a line between rows.
        const why = [...new Set((g.edges || []).map(e => e.why))];
        box.append(el("div", { class: "group", "data-group": g.id, title: why.length ? why.join("\n") : null },
          files.map(f => fileRow(f, { dir: true, why }))));
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
      notesOf().length ? el("span", { class: "counts" }, plural(notesOf().length, "note")) : null));
    postState();
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
        return el("div", { class: "row file ghost" + (p === current ? " sel" : ""), "data-path": p, title: p + "\nno longer in the diff", onclick: () => select(p) },
          el("span", { class: "chev" }), el("span", { class: "name" }, p.slice(p.lastIndexOf("/") + 1),
            el("span", { class: "in x" }, " " + p.slice(0, Math.max(0, p.lastIndexOf("/"))))), badge(p));
      }));
  }
  for (const b of document.querySelectorAll("#view button"))
    b.addEventListener("click", () => { view = b.dataset.view; store.set("lookout.view", view); drawSide(); if (!overview && !mapOn) select(current); });

  const countsText = f => f.binary ? "bin" : `+${f.adds} −${f.dels}`;

  // ---------------------------------------------------------------- findings

  const SEV = ["blocker", "major", "minor", "nit"];
  const isOpen = x => !["resolved", "dismissed"].includes(x.status || "open");
  const items = () => [...(R.findings || []), ...(R.threads || []), ...ghItems()];

  // ---------------------------------------------------------------- the PR

  // The review's pull request, as `lookout gh sync` saw it (lib/github.mjs
  // writes R.github), or null when the review is not linked to one.
  const GH = () => (R.github && R.github.pr ? R.github : null);
  // Only github.com links are drawn as links: the record is data.
  const ghUrl = u => /^https:\/\/github\.com\//.test(String(u || "")) ? u : null;
  // A posted item's GitHub thread: the one whose first comment it posted.
  function threadOf(x) {
    const g = GH(), id = x.github && x.github.commentId;
    return g && id ? (g.threads || []).find(t => (t.comments[0] || {}).id === id) || null : null;
  }
  // GitHub's own threads as cards ("g<first comment id>"), drawn where the
  // review's own items are. One that began as a posted item's comment is
  // that item's card, not a second one. GitHub's line is on the PR's head:
  // it is used only while the review is at that head, and otherwise the
  // card goes to "On lines this diff does not show".
  function ghItems() {
    const g = GH();
    if (!g) return [];
    const mine = new Set([...(R.findings || []), ...(R.threads || [])].map(x => x.github && x.github.commentId).filter(Boolean));
    const here = (R.files || []).map(f => f.path);
    return (g.threads || []).filter(t => t.comments.length && !mine.has(t.comments[0].id) && here.includes(t.path)).map(t => ({
      id: "g" + t.comments[0].id, gh: t, file: t.path, side: t.side,
      line: g.behind === 0 ? t.line || t.originalLine : null,
      status: t.resolved ? "resolved" : "open",
      messages: t.comments.map(c => ({ by: c.author, at: c.at, text: c.body, url: c.url })),
    }));
  }
  // GitHub threads on files this review does not hold, counted on the strip.
  const ghElsewhere = () => {
    const g = GH(), here = new Set((R.files || []).map(f => f.path));
    return g ? (g.threads || []).filter(t => !here.has(t.path)).length : 0;
  };
  // A finding or comment of the review's own not yet on GitHub.
  const unposted = x => !x.gh && !(x.github && x.github.postedAt);
  // The chips a card's head carries about the PR: GitHub's word on its own
  // threads, posted or pending on the review's items, and stale.
  function prChips(x) {
    const g = GH();
    if (!g) return [];
    const out = [];
    if (x.gh) {
      if (x.gh.outdated) out.push(el("span", { class: "chip outdated", title: "GitHub says the code under this thread changed" }, "outdated"));
      return out;
    }
    const why = (g.stale || {})[x.id];
    if (why) out.push(el("span", { class: "chip stale", title: why[0].toUpperCase() + why.slice(1) + "." }, "stale"));
    const link = x.github && ghUrl(x.github.url || x.github.reviewUrl);
    if (!unposted(x)) out.push(link ? el("a", { class: "chip posted", href: link, target: "_blank", rel: "noopener", title: "Open it on GitHub" }, "posted ↗")
                                    : el("span", { class: "chip posted" }, "posted"));
    else if (isOpen(x)) out.push(el("span", { class: "chip pending", title: "Only in lookout: post it from the Lookout tab, or `lookout gh post`" }, "pending"));
    return out;
  }
  // What GitHub said under an item the review posted, after its own comment.
  function ghReplies(x) {
    const t = threadOf(x);
    const more = t ? t.comments.slice(1) : [];
    if (!more.length && !(t && (t.outdated || t.resolved))) return null;
    return el("div", { class: "gh-replies" },
      el("div", { class: "gh-head" }, ghMark(), "On GitHub",
        t.resolved ? el("span", { class: "chip" }, "resolved there") : null, t.outdated ? el("span", { class: "chip outdated" }, "outdated") : null),
      more.map(c => ghMessage(c)));
  }
  const ghMessage = c => el("div", { class: "msg by-gh" }, el("div", { class: "who" }, c.author,
      el("span", { class: "at" }, " · " + when(c.at)), ghUrl(c.url) ? el("a", { class: "at", href: ghUrl(c.url), target: "_blank", rel: "noopener" }, " ↗") : null),
    el("div", { class: "text" }, c.body));
  // GitHub's mark, drawn (no emoji, no font).
  function ghMark() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("class", "ghmark"); svg.setAttribute("aria-hidden", "true");
    const pth = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pth.setAttribute("d", "M8 1a7 7 0 0 0-2.2 13.6c.4.1.5-.2.5-.4v-1.3c-2 .4-2.4-.9-2.4-.9-.3-.8-.8-1.1-.8-1.1-.7-.5 0-.5 0-.5.7.1 1.1.8 1.1.8.6 1.1 1.7.8 2.1.6.1-.5.3-.8.5-1-1.6-.2-3.2-.8-3.2-3.5 0-.8.3-1.4.7-1.9 0-.2-.3-.9.1-1.9 0 0 .6-.2 1.9.7a6.6 6.6 0 0 1 3.5 0c1.3-.9 1.9-.7 1.9-.7.4 1 .1 1.7.1 1.9.4.5.7 1.1.7 1.9 0 2.7-1.6 3.3-3.2 3.5.3.2.5.7.5 1.3v2c0 .2.1.5.5.4A7 7 0 0 0 8 1Z");
    svg.append(pth);
    return svg;
  }

  // The strip under the header: the PR, how far its head is past the
  // review, what is stale or pending, and the checks (a list on a click).
  let checksOpen = false;
  function drawPR() {
    const g = GH(), box = $("pr");
    if (!g) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const st = g.draft ? "draft" : String(g.state || "").toLowerCase() || "open";
    const by = (...b) => (g.checks || []).filter(c => b.includes(c.bucket));
    const fails = by("fail", "cancel"), pend = by("pending"), pass = by("pass", "skipping");
    const own = [...(R.findings || []), ...(R.threads || [])];
    const stale = own.filter(x => (g.stale || {})[x.id] && isOpen(x)).length;
    const pending = GH() ? own.filter(x => unposted(x) && isOpen(x)).length : 0;
    const elsewhere = ghElsewhere();
    const link = ghUrl(g.url);
    const drift = g.behind > 0
      ? el("span", { class: "pr-drift", title: `The PR's head (${String(g.head).slice(0, 8)}) is ${plural(g.behind, "commit")} past the one reviewed (${String(g.reviewed).slice(0, 8)}).` +
          (hosted ? "" : " Re-open the review to diff the new head: lookout open, then a reviewer.") }, `${plural(g.behind, "commit")} past the review`)
      : g.behind === 0 ? el("span", { class: "pr-quiet" }, "at the reviewed head") : null;
    const rereview = g.behind > 0 && hosted
      ? el("button", { type: "button", class: "pr-btn", onclick: () => window.parent.postMessage({ lookout: "rereview", id: R.id }, hostOrigin) }, "Re-review") : null;
    const count = (cls, glyph, n, word) => n ? el("span", { class: "ck " + cls, title: plural(n, word) }, glyph + " " + n) : null;
    const checks = (g.checks || []).length
      ? el("button", { type: "button", class: "pr-checks-btn" + (fails.length ? " bad" : ""), "aria-expanded": String(checksOpen), "aria-controls": "pr-checks",
          title: "The PR's checks on its head", onclick: () => { checksOpen = !checksOpen; drawPR(); } },
          count("pass", "✓", pass.length, "passed check"), count("fail", "✗", fails.length, "failed check"), count("pend", "●", pend.length, "running check"), " ▾")
      : el("span", { class: "pr-quiet" }, "no checks");
    box.replaceChildren(...[
      el("div", { class: "pr-row" },
        ghMark(),
        link ? el("a", { class: "pr-link", href: link, target: "_blank", rel: "noopener", title: g.title || "" }, `PR #${g.pr}`) : el("span", { class: "pr-link" }, `PR #${g.pr}`),
        el("span", { class: "pr-state st-" + st }, st),
        drift, rereview,
        stale ? el("span", { class: "chip stale", title: "Open findings or comments whose code changed on the PR's head" }, `${stale} stale`) : null,
        pending ? el("span", { class: "chip pending", title: "Open findings or comments not yet posted to GitHub" }, `${pending} pending`) : null,
        elsewhere ? el("span", { class: "pr-quiet", title: "GitHub threads on files this review does not show" }, `${plural(elsewhere, "thread")} on other files`) : null,
        el("span", { class: "pr-gap" }),
        checks,
        g.error ? el("span", { class: "pr-err", title: g.error }, "sync trouble") : null,
        g.changedAt ? el("span", { class: "pr-quiet", title: "When GitHub last told lookout something new" }, "as of " + when(g.changedAt)) : null),
      checksOpen ? el("div", { class: "pr-checks", id: "pr-checks" },
        [...fails, ...pend, ...pass].map(c => {
          const k = fails.includes(c) ? "fail" : pend.includes(c) ? "pend" : "pass";
          const name = (c.workflow ? c.workflow + " / " : "") + c.name;
          const at = k === "pend" ? (c.startedAt ? "running since " + when(c.startedAt) : "queued") : c.completedAt ? "ran " + when(c.completedAt) : "";
          return el("div", { class: "pr-check " + k },
            el("span", { class: "ck " + k }, k === "fail" ? "✗" : k === "pend" ? "●" : "✓"),
            ghUrl(c.link) ? el("a", { href: ghUrl(c.link), target: "_blank", rel: "noopener" }, name) : el("span", null, name),
            el("span", { class: "pr-quiet" }, at));
        })) : null].filter(Boolean));
  }
  const openFindings = p => (R.findings || []).filter(x => x.file === p && isOpen(x));

  // A file's open findings as one badge, colored by the worst of them.
  function badge(p) {
    const o = openFindings(p);
    const t = (R.threads || []).filter(x => x.file === p && isOpen(x)).length;
    if (!o.length && !t) return null;
    const worst = SEV.find(s => o.some(x => x.severity === s));
    return el("span", { class: "fbadge" + (worst ? " sev-" + worst : " sev-comment"),
      title: plural(o.length, "open finding") + (t ? ", " + plural(t, "open comment") : "") }, String(o.length + t));
  }

  const when = iso => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  function message(m, pill, folded) {
    // A status change its author made with a reply, at the same moment: its
    // words ride on that reply's line, not as a second message.
    if (folded && m === folded.m) return null;
    if (folded && m === folded.after) return el("div", { class: "msg by-" + m.by }, el("div", { class: "who" }, m.by,
      el("span", { class: "at" }, " · " + when(m.at)), el("span", { class: "at note", title: `${folded.m.by} marked it ${folded.to}` }, " · " + folded.text)),
      el("div", { class: "text" }, m.text));
    // The status change the pill already shows: only its words, as its
    // author's message; with no words, nothing.
    if (m === pill) return m.text ? el("div", { class: "msg by-" + m.by }, el("div", { class: "who" }, m.by, el("span", { class: "at" }, " · " + when(m.at))),
      el("div", { class: "text" }, m.text)) : null;
    if (m.kind === "status")
      return el("div", { class: "msg change" }, `${m.by} marked it ${m.to}`, m.text ? " — " + m.text : "",
        el("span", { class: "at" }, " · " + when(m.at)));
    return el("div", { class: "msg by-" + m.by }, el("div", { class: "who" }, m.by, el("span", { class: "at" }, " · " + when(m.at))),
      el("div", { class: "text" }, m.text));
  }

  const stillBlocks = x => x.id.startsWith("f") && x.status === "addressed" && (x.severity === "blocker" || x.severity === "major");

  // Two words kept apart: the CURRENT card (curFinding, class "cur") is the
  // one the reader is on, by a click, Enter or n/p; PICKED cards (the set
  // `picked`, class "picked", a check mark at their left) are the findings
  // the app's Act menu will edit, fix or post. Only the app knows the
  // picked set; it posts it (op "picks") once it hosts the page.
  let picked = new Set();
  const checkIcon = () => {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 12 12");
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M2.5 6.3 5 8.6 9.5 3.6");
    s.append(p);
    return el("span", { class: "pickmark", title: "Picked: the app's Act menu acts on it" }, s);
  };

  // Blockers and majors keep their card open; a minor, a nit or a comment
  // folds to one row (its chip and short title) unless it is the current
  // card or has a reply draft in it. A click, Enter, or n/p landing on it
  // makes it current, which opens it.
  const holdsOpen = x => x.severity === "blocker" || x.severity === "major";
  const foldedCard = x => isOpen(x) && !holdsOpen(x) && x.id !== curFinding && !draftText("r:" + x.id).trim();

  // One finding or comment thread, drawn under its line.
  const expandedClosed = new Set();
  // A finding's category and verdict in plain words, for its tooltip and the
  // current card's head; its id only in the tooltip.
  const verdictWords = x => x.verdict === "CONFIRMED" ? "confirmed" : "plausible, not confirmed";
  const metaWords = x => x.id.startsWith("f") ? `${x.category} · ${verdictWords(x)}` : "";
  // A closed card (resolved or dismissed) is its own look: one row, its
  // severity chip dimmed, a muted status chip, no Resolve. A click or Enter
  // opens it to its thread and Reopen; its head folds it again.
  const foldedClosed = x => !isOpen(x) && !expandedClosed.has(x.id);
  function card(x) {
    const finding = x.id.startsWith("f");
    const closed = !isOpen(x);
    const body = !closed || expandedClosed.has(x.id);
    const sev = finding ? el("span", { class: "sev sev-" + x.severity }, x.severity)
      : x.gh ? el("span", { class: "sev sev-github", title: "A thread on GitHub" }, ghMark(), "GitHub")
      : el("span", { class: "sev sev-comment" }, "comment");
    const chips = prChips(x);
    const mark = picked.has(x.id) ? checkIcon() : null;
    const closedChip = closed ? el("span", { class: "status st-" + x.status }, x.status) : null;
    if (foldedClosed(x)) {
      const title = finding ? x.short_summary || x.summary : ((x.messages || [])[0] || {}).text || "";
      const open = () => { expandedClosed.add(x.id); openCard(x.id); };
      return el("div", { class: "card folded closed" + (finding ? "" : " comment") + (mark ? " picked" : ""), "data-item": x.id,
        tabindex: "0", role: "button", "aria-expanded": "false",
        title: `${x.id} (${x.status}): open it to read its thread` + (finding ? "\n" + metaWords(x) : ""),
        onclick: e => { if (!e.target.closest("button, a, textarea, input") && !String(getSelection() || "")) open(); },
        onkeydown: e => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); expandedClosed.add(x.id); openCard(x.id, true); } } },
        el("div", { class: "card-head" }, mark, sev, el("span", { class: "title" }, title), closedChip, chips));
    }
    if (foldedCard(x)) {
      const title = finding ? x.short_summary || x.summary : ((x.messages || [])[0] || {}).text || "";
      return el("div", { class: "card folded" + (finding ? "" : " comment") + (mark ? " picked" : ""), "data-item": x.id,
        tabindex: "0", role: "button", "aria-expanded": "false", title: x.id + ": open this " + (finding ? "finding" : "comment"),
        onclick: e => pickCard(x.id, e),
        onkeydown: e => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); openCard(x.id, true); } } },
        el("div", { class: "card-head" }, mark, sev, el("span", { class: "title" }, title), chips));
    }
    // An opened closed card's head folds it back, in place.
    const head = el("div", { class: "card-head", title: closed ? "Fold it to one row" : null,
      onclick: closed ? e => { if (e.target.closest("button, a")) return; e.stopPropagation(); expandedClosed.delete(x.id); redrawCards([x.id]); } : null },
      mark, sev,
      // Title first; folded, a finding shows its short summary, open, the full one, once.
      // Hovered, the title's tooltip names the id, category and verdict.
      el("span", { class: "title", title: x.id + (finding ? " · " + metaWords(x) : "") }, finding ? (body ? x.summary : x.short_summary || x.summary) : ((x.messages || [])[0] || {}).text || ""),
      // The category and verdict, in plain words, sit out of the row
      // (review.css .card-head .meta), so the title has the full width until
      // the card is focused or current. The id stays in the tooltip.
      finding ? el("span", { class: "meta" }, el("span", { class: "cat" }, metaWords(x))) : null,
      // Open is the usual state: only the others get a pill. An addressed
      // blocker or major still blocks the gate, and its pill says so.
      (x.status || "open") !== "open" ? (stillBlocks(x)
        ? el("span", { class: "status st-addressed blocks", title: "Still blocks the gate until you resolve it" }, "addressed · still blocks")
        : el("span", { class: "status st-" + x.status }, x.gh ? "resolved on GitHub" : x.status)) : null,
      chips);
    const thread = finding ? x.thread || [] : (x.messages || []).slice(1);
    // The latest status change, when it is the one the pill shows.
    const last = [...thread].reverse().find(m => m.kind === "status");
    const pill = last && last.to === (x.status || "open") && x.status !== "open" ? last : null;
    // The pill's change folds into the reply just before it when one author
    // wrote both within two minutes.
    const prev = pill && pill.text ? thread[thread.indexOf(pill) - 1] : null;
    const folded = prev && prev.kind !== "status" && prev.by === pill.by &&
      Math.abs(Date.parse(pill.at) - Date.parse(prev.at)) <= 120000 ? { m: pill, after: prev, to: pill.to, text: pill.text } : null;
    return el("div", { class: "card" + (closed ? " closed" : "") + (finding ? "" : " comment") + (x.id === curFinding ? " cur" : "") + (mark ? " picked" : ""), "data-item": x.id,
      onclick: e => pickCard(x.id, e) },
      head,
      body && finding ? el("div", { class: "card-body" },
        el("div", { class: "failure" }, el("span", { class: "label" }, "Fails when: "), el("span", { class: "scenario" }, x.failure_scenario))) : null,
      body ? el("div", { class: "msgs" }, thread.map(m => message(m, pill, folded))) : null,
      body && !x.gh ? ghReplies(x) : null,
      // GitHub's threads are answered on GitHub.
      body ? (x.gh ? ghOpen(x) : actions(x)) : null);
  }
  const ghOpen = x => {
    const u = ghUrl((x.messages[x.messages.length - 1] || {}).url) || ghUrl((x.messages[0] || {}).url);
    return u ? el("div", { class: "actions" }, el("a", { class: "gh-open", href: u, target: "_blank", rel: "noopener" }, "Reply on GitHub ↗")) : null;
  };
  // A click on a card makes it the current one, as n/p do, which opens a
  // folded card and shows its Reply / Resolve / Dismiss row. Not a click on
  // a control, and not the end of a text selection.
  function pickCard(id, e) {
    if (e.target.closest("button, a, textarea, input") || String(getSelection() || "")) return;
    openCard(id);
  }
  // `focus`: opened from the keyboard, the opened card takes the focus the
  // folded row had (the row itself is gone).
  function openCard(id, focus = false) {
    const prev = curFinding;
    curFinding = id;
    redrawCards([prev, id]);
    for (const o of document.querySelectorAll(".card.cur")) if (o.dataset.item !== id) o.classList.remove("cur");
    const c = document.querySelector(`[data-item="${CSS.escape(id)}"]`);
    if (!c) return;
    c.classList.add("cur");
    if (focus) { c.tabIndex = -1; c.focus({ preventScroll: true }); }
  }
  // The app's Act set changed: only the cards that joined or left it redraw.
  function setPicked(ids) {
    const next = new Set(ids.filter(id => typeof id === "string"));
    const changed = [...picked, ...next].filter(id => picked.has(id) !== next.has(id));
    picked = next;
    redrawCards(changed);
  }
  // Draws these cards again in place (a fold, a pick): the diff around them,
  // and a box being typed in elsewhere, are left alone.
  function redrawCards(ids) {
    for (const id of new Set(ids.filter(Boolean))) {
      const x = items().find(y => y.id === id);
      if (!x) continue;
      for (const c of document.querySelectorAll(`#diff [data-item="${CSS.escape(id)}"]`)) c.replaceWith(card(x));
    }
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

  // A watch item: its file:line (mono, the one place the Overview uses it)
  // goes to the line; a line the diff does not show says so.
  function watchLink(w) {
    return el("li", null, el("a", { href: "#", class: "wloc", onclick: e => { e.preventDefault(); goToLine(w.file, w.side || "new", w.line); } },
      `${w.file.slice(w.file.lastIndexOf("/") + 1)}:${w.line}`), w.outside ? el("span", { class: "outside-tag", title: "a line the diff does not show" }, " outside") : null,
      " — ", w.text);
  }

  // A note, compacted: why it is risky and its direction as two short
  // paragraphs, the watch list, any drift, its touches as chips. No caps
  // labels: the order says which is which. `lead` skips the direction when
  // the group's row already shows all of it.
  function noteBody(n, { lead = false } = {}) {
    const drift = (n.drift || []).map(id => (R.findings || []).find(f => f.id === id)).filter(Boolean);
    return el("div", { class: "note-body" },
      n.why_risky ? el("p", { class: "nwhy" }, n.why_risky) : null,
      lead ? null : el("p", { class: "ndir" }, n.direction),
      (n.watch || []).length ? el("ul", { class: "watch" }, n.watch.map(watchLink)) : null,
      drift.length ? el("div", { class: "ndrift" }, el("span", { class: "ndrift-lead" }, "Drift from the plan:"),
        el("ul", { class: "watch" }, drift.map(f => el("li", null,
          el("a", { href: "#", class: "wloc", onclick: e => { e.preventDefault(); goTo(f.id); } }, f.id),
          ` ${f.severity}${isOpen(f) ? "" : " (" + f.status + ")"} — `, f.short_summary || f.summary)))) : null,
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

  // Small file links on one line; a click opens the file's diff.
  const fileLinks = paths => el("div", { class: "nfiles" }, paths.map(p => el("a", { href: "#", class: "gfile", title: p,
    onclick: e => { e.preventDefault(); select(p); } }, p.slice(p.lastIndexOf("/") + 1), badge(p))));

  // One note inside an opened group. `lead`: the row shows its whole direction.
  // A note whose files differ from the group's leads with its own.
  // `gone`: its files left the diff, so they are named but not links.
  function noteCard(n, { lead = false, files = null, gone = false } = {}) {
    const own = gone || (files && [...n.files].sort().join("\n") !== [...files].sort().join("\n"));
    const names = gone ? el("div", { class: "nfiles" }, n.files.map(p => el("span", { class: "gfile gone", title: p }, p.slice(p.lastIndexOf("/") + 1))))
      : fileLinks(n.files);
    return el("div", { class: "note", "data-note": n.id },
      own ? el("div", { class: "note-head" }, names, ...marks(n)) : null,
      asking(n) ? quizBlock(n) : [n.quiz && n.quiz.answered ? quizBlock(n) : null, noteBody(n, { lead })]);
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
      openNow ? noteBody(n, { lead: true }) : null);
    return node;
  }

  // The architecture pass: one folded row per group, riskiest first. A row
  // is its band, a headline (its first note's direction, first sentence)
  // and counts; a click, Enter or Space opens just that group. Which are
  // open is kept per review for the tab (sessionStorage), so a redraw or a
  // reload leaves them as they were.
  let overview = false;
  const OV_OPEN = "lookout.ovopen." + R.id;
  const ovOpen = new Set((() => { try { return JSON.parse(sessionStorage.getItem(OV_OPEN) || "[]"); } catch { return []; } })());
  const saveOvOpen = () => { try { sessionStorage.setItem(OV_OPEN, JSON.stringify([...ovOpen])); } catch { /* private window */ } };
  // The first sentence: up to a stop followed by a capital (so "e.g. x" holds).
  const firstSentence = s => { const t = String(s || "").trim(); const m = t.match(/^[\s\S]*?[.!?](?=\s+[A-Z("'`]|$)/); return m ? m[0] : t; };
  const LOST = "lost";
  // A group's section (or the notes whose files left the diff, key LOST).
  function ovSection(key) {
    const lost = key === LOST;
    const g = lost ? null : (R.groups || []).find(x => x.id === key);
    const mine = notesOf().filter(n => lost ? !n.group : n.group === key);
    if (!lost && !g) return null;
    const band = lost ? null : g.band || bandOf(g.risk);
    const files = lost ? [...new Set(mine.flatMap(n => n.files))] : g.files;
    const isOpenNow = ovOpen.has(key);
    const first = mine[0];
    const ask = mine.some(asking);
    const headline = lost ? "Notes on files no longer in the diff"
      : !first ? "No note for this group"
      : asking(first) ? "The note shows once its question is answered" : firstSentence(first.direction);
    const findings = files.reduce((k, p) => k + openFindings(p).length, 0);
    const watch = mine.reduce((k, n) => k + (asking(n) ? 0 : (n.watch || []).length), 0);
    const counts = [lost ? plural(mine.length, "note") : plural(files.length, "file"),
      findings ? plural(findings, "finding") : null, watch ? `${watch} to watch` : null].filter(Boolean).join(" · ");
    const why = lost ? [] : [...new Set((g.edges || []).map(e => e.why))];
    const title = [lost ? null : `${g.id}, ${band} risk`, why.length ? "Grouped: " + why.join("; ") : null,
      first && !asking(first) ? first.direction : null].filter(Boolean).join("\n");
    // Marks once each: one "stale" for the group, a "partial" per note.
    const seen = new Set();
    const rowMarks = mine.flatMap(marks).filter(m => m && !seen.has(m.textContent) && seen.add(m.textContent));
    const toggle = () => {
      isOpenNow ? ovOpen.delete(key) : ovOpen.add(key);
      saveOvOpen();
      const next = ovSection(key);
      // A fresher review may have dropped this group: its row goes.
      if (!next) { sec.remove(); return; }
      sec.replaceWith(next);
      next.querySelector(".ov-sum").focus({ preventScroll: true });
    };
    const sum = el("div", { class: "ov-sum", role: "button", tabindex: "0", "aria-expanded": String(isOpenNow), "data-key": key, title,
      onclick: e => { if (!e.target.closest("a")) toggle(); },
      onkeydown: e => {
        if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        else if (e.key === "Escape" && isOpenNow && $("keys").hidden) { e.preventDefault(); toggle(); }
        else if (/^(ArrowDown|ArrowUp|Home|End)$/.test(e.key)) {
          const all = [...document.querySelectorAll("#diff .ov-sum")];
          const i = all.indexOf(e.currentTarget);
          const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
          e.preventDefault();
          all[to].focus();
        }
      } },
      el("span", { class: "dot" + (lost ? " lost" : " band-" + band) }),
      el("span", { class: "gband" }, lost ? "" : band),
      el("span", { class: "ov-hl" + (lost ? "" : !first || asking(first) ? " none" : "") }, headline),
      el("span", { class: "ov-meta" },
        ask ? el("span", { class: "ov-q", title: "A question waits before this group's note: open the group to answer it." }, "? answer first") : null,
        ...rowMarks,
        el("span", { class: "ov-counts" }, counts)),
      el("span", { class: "chev", "aria-hidden": "true" }, isOpenNow ? "▾" : "▸"));
    const body = isOpenNow ? el("div", { class: "ov-body",
      onkeydown: e => {
        if (e.key !== "Escape" || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || !$("keys").hidden) return;
        e.preventDefault(); toggle();
      } },
      mine.length ? mine.map((n, i) => noteCard(n, { lead: i === 0 && !asking(n) && n.direction.trim() === headline, files: lost ? null : files, gone: lost })) : null,
      lost ? null : fileLinks(files)) : null;
    const sec = el("section", { class: "ov-group" + (band ? " band-" + band : "") + (isOpenNow ? " open" : ""), "data-group": key }, sum, body);
    return sec;
  }
  function drawOverview() {
    const groups = R.groups || [];
    const ns = notesOf();
    const waiting = ns.filter(asking).length;
    const watching = ns.reduce((k, n) => k + (asking(n) ? 0 : (n.watch || []).length), 0);
    const head = [el("span", { class: "path" }, "Overview"),
      el("span", { class: "from" }, `${plural(groups.length, "group")} · ${plural(ns.length, "note")}` +
        (watching ? ` · ${watching} to watch` : "") +
        (quizOn() ? ` · quiz on${waiting ? `, ${waiting} to answer` : ""}` : ""))];
    $("file-head").replaceChildren(...head);
    // A redraw (a fresher review) keeps the row that had focus focused.
    const a = document.activeElement;
    const focusKey = a && a.classList && a.classList.contains("ov-sum") ? a.dataset.key : null;
    const box = el("div", { class: "ov" });
    if (quizOn() && !served())
      box.append(el("div", { class: "ov-line" }, "This review has the quiz on, which needs crew's intent server to record answers. Opened as a file, the notes are shown in full."));
    if (!R.reviewedAt) box.append(el("div", { class: "ov-line" }, "No reviewer has reported yet: groups are lookout's, and there are no notes."));
    else if (!ns.length) box.append(el("div", { class: "ov-line" }, "The reviewer wrote no notes for this review."));
    const list = el("div", { class: "ov-list" });
    for (const g of groups) {
      const band = g.band || bandOf(g.risk);
      if (band === "low" && !ns.some(n => n.group === g.id)) continue;
      list.append(ovSection(g.id));
    }
    if (ns.some(n => !n.group)) list.append(ovSection(LOST));
    if (list.childNodes.length) box.append(list);
    const low = groups.filter(g => (g.band || bandOf(g.risk)) === "low" && !ns.some(n => n.group === g.id));
    if (low.length)
      box.append(el("div", { class: "ov-line" }, `${plural(low.length, "low-risk group")} without notes: `,
        ...low.flatMap(g => g.files).map((p, i) => [i ? ", " : "", el("a", { href: "#", class: "gfile",
          onclick: e => { e.preventDefault(); select(p); } }, p.slice(p.lastIndexOf("/") + 1))])));
    $("diff").replaceChildren(box);
    if (focusKey) { const r = box.querySelector(`.ov-sum[data-key="${CSS.escape(focusKey)}"]`); if (r) r.focus({ preventScroll: true }); }
  }

  // The Map view: the plan's End state map (lookout open --plan-map) against
  // what this diff touched, drawn by page/plan-map.js (shared/plan-map.js).
  // The comparison is the CLI's (lib/planmap.mjs), made when the page was
  // drawn, so it matches the diff this page shows.
  let mapOn = false;
  const PV = D.planView || null;
  const STATUS_NOTE = {
    ok: "The plan named this file and the diff touched it.",
    miss: "The plan named this file for this work, and the diff never touched it.",
  };
  // A card's file as the diff names it: extras carry it, planned cards are
  // relative to the plan root.
  // A planned file the diff renamed is filed (findings included) under its
  // new path: follow the rename.
  const renamedTo = p => { const f = (R.files || []).find(x => x.oldPath === p); return f ? f.path : p; };
  const diffPathOf = c => c.diffPath || renamedTo(((R.planMap && R.planMap.prefix) || "") + c.path);
  // The reader's place on the map, kept across redraws of a fresher review.
  const mapKeep = {};
  const findingsOn = c => (R.findings || []).filter(f => f.file === diffPathOf(c));
  function drawMap() {
    const head = [el("span", { class: "path" }, "Map")];
    const live = (R.findings || []).filter(isOpen);
    const onFiles = new Set(live.map(f => f.file)).size;
    if (PV) head.push(el("span", { class: "from" },
      `${PV.counts.ok} as planned · ${PV.counts.miss} planned, not touched · ${PV.counts.extra} touched, not planned` +
      (live.length ? ` · ${plural(live.length, "open finding")} on ${plural(onFiles, "file")}` : "")));
    $("file-head").replaceChildren(...head);
    const box = el("div", { class: "ov map-view" });
    $("diff").replaceChildren(box);
    if (!R.planMap || !PV) {
      box.append(el("div", { class: "ov-line" }, "No plan map was passed to this review. deep-plan passes its plan's map " +
        "when it opens a review (lookout open --plan-map ~/.claude/plans/<slug>.map.json); a re-open from deep-plan adds it."));
      return;
    }
    if (!window.PlanMap) { box.append(el("div", { class: "ov-line" }, "The map's renderer (page/plan-map.js) is missing from this install.")); return; }
    // A card names a file by its planned path; a rename's diff is under its
    // new path, so both lead to it.
    const diffOf = new Map();
    for (const f of R.files || []) { diffOf.set(f.path, f.path); if (f.oldPath) diffOf.set(f.oldPath, f.path); }
    const mountAt = el("div");
    box.append(mountAt);
    // #main scrolls, not the window: the map's sticky panel sizes itself to it.
    const fitView = () => mountAt.style.setProperty("--pm-view", $("main").clientHeight + "px");
    fitView();
    if (!drawMap.fit) { drawMap.fit = true; window.addEventListener("resize", () => { const m = document.querySelector("#main .pm"); if (m) m.parentNode.style.setProperty("--pm-view", $("main").clientHeight + "px"); }); }
    window.PlanMap.mount(mountAt, { ...R.planMap, cards: PV.cards }, {
      extra: PV.extra,
      status: c => c.status || "",
      planLabel: PV.inc === "all" ? "the plan vs the diff" : `increment ${PV.inc} vs the diff`,
      groups: cards => [
        ["as planned", cards.filter(c => c.status === "ok")],
        ["planned, not touched", cards.filter(c => c.status === "miss")],
        ["touched, not planned", cards.filter(c => c.status === "extra")],
      ],
      statusNote: (c, st) => st === "extra"
        ? (c.plannedIn && c.plannedIn.length ? `The plan names this file for increment ${c.plannedIn.join(", ")}, not this one.`
          : "The diff changed this file, but no part of the plan names it. That may be plan drift.")
        : c.undone ? "The plan removes this file, and the diff edited it instead of deleting it."
        : STATUS_NOTE[st] || "",
      // Card paths are relative to the plan root; the diff's to the repo top.
      onOpen: p => { const k = diffOf.has(p) ? p : (R.planMap.prefix || "") + p; if (diffOf.has(k)) select(diffOf.get(k)); },
      canOpen: c => diffOf.has(diffPathOf(c)),
      keep: mapKeep,
      openLabel: "Open its diff",
      // The review's findings on each card's file, live: a close on the page
      // redraws the map with it.
      findings: c => findingsOn(c).map(f => ({ id: f.id, severity: f.severity, status: f.status || "open",
        summary: f.short_summary || f.summary, line: f.line })),
      onFinding: (c, f) => {
        const x = (R.findings || []).find(y => y.id === f.id);
        if (x) goToLine(x.file, x.side === "old" ? "old" : "new", x.line);
      },
      trayNote: "The plan's map was frozen when the plan rendered; this view holds it against the current diff.",
    });
  }
  function openMap() {
    mapOn = true;
    overview = false;
    current = null;
    try { history.replaceState(null, "", "#map"); } catch { /* file:// in some hosts */ }
    for (const r of document.querySelectorAll("#tree .row")) r.classList.remove("sel");
    drawOverviewChrome();
    drawMap();
    $("main").scrollTop = 0;
  }
  function toggleMap() {
    if (mapOn) select(lastFile && (R.files || []).some(f => f.path === lastFile) ? lastFile : ORDER[0] || null);
    else openMap();
  }
  $("map-btn").addEventListener("click", toggleMap);

  function openOverview(noteId) {
    mapOn = false;
    overview = true;
    current = null;
    try { history.replaceState(null, "", "#overview"); } catch { /* file:// in some hosts */ }
    for (const r of document.querySelectorAll("#tree .row")) r.classList.remove("sel");
    drawOverviewChrome();
    // A note asked for (a strip, a link): its group opens, and comes into view.
    const n = noteId && notesOf().find(x => x.id === noteId);
    const key = n ? n.group || LOST : null;
    if (key && !ovOpen.has(key)) { ovOpen.add(key); saveOvOpen(); }
    drawOverview();
    $("main").scrollTop = 0;
    const sec = key && document.querySelector(`#diff .ov-group[data-group="${CSS.escape(key)}"]`);
    if (sec) {
      sec.scrollIntoView({ block: "start" });
      sec.querySelector(".ov-sum").focus({ preventScroll: true });
      const c = sec.querySelector(`[data-note="${CSS.escape(noteId)}"]`);
      if (c) c.classList.add("flash");
    }
  }
  function drawOverviewChrome() {
    $("ov-btn").setAttribute("aria-pressed", String(overview));
    $("map-btn").setAttribute("aria-pressed", String(mapOn));
    const row = document.querySelector("#tree .ov-row");
    if (row) row.classList.toggle("sel", overview);
    postState();
  }
  function toggleOverview() {
    if (overview) select(lastFile && (R.files || []).some(f => f.path === lastFile) ? lastFile : ORDER[0] || null);
    else openOverview();
  }
  $("ov-btn").addEventListener("click", toggleOverview);
  const drawMain = () => mapOn ? drawMap() : overview ? drawOverview() : drawFile();

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
    mapOn = false;
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

  // The file's header line: status, path, counts and risk. Not the language,
  // and not a risk reason that only repeats an open finding ("open blocker
  // finding"): the gate pill and the cards already say that. Nor "Jev 100%",
  // which means nothing at a glance: the risk reads "high risk" in plain
  // words, and its tooltip (riskLine) gives the score and Jev's part in it.
  const headReasons = f => (f.reasons || []).filter(r => !/^open \w+ finding$/.test(r) && !/^Jev \d+%$/.test(r));
  const riskLine = f => `${f.band || bandOf(f.risk)} risk, ${Math.round((f.risk || 0) * 100)} of 100` +
    (headReasons(f).length ? ": " + headReasons(f).join(", ") : "") +
    (typeof f.jev === "number" ? `. Jev (TypeSafe's model) read the change as ${Math.round(f.jev * 100)}% risky.`
      : R.scoring && !R.scoring.ok ? ". Ranked on signals alone (path and size)." : ".");
  function fileHead(f) {
    const cut = f.path.lastIndexOf("/");
    const reasons = headReasons(f);
    return [
      stLetter(f),
      el("span", { class: "path" }, cut >= 0 ? el("span", { class: "dir" }, f.path.slice(0, cut + 1)) : null,
        f.path.slice(cut + 1)),
      f.oldPath ? el("span", { class: "from" }, "from " + f.oldPath) : null,
      el("span", { class: "counts" }, el("span", { class: "plus" }, "+" + f.adds), " ",
        el("span", { class: "minus" }, "−" + f.dels)),
      typeof f.risk === "number" ? el("span", { class: "risk band-" + (f.band || "low"),
        title: riskLine(f) }, `${f.band} risk`,
        reasons.length ? el("span", { class: "reasons" }, " · " + reasons.join(", ")) : null) : null,
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

  // The findings gutter: a line that carries open findings or comments gets
  // a dot per severity in its line-number cell, worst first, so a folded
  // card's line still shows from the code. Hovered, the dots name their
  // findings; a click or Enter goes to the worst one.
  let gutter = new Map();     // "new:12" → open items on that line, worst first
  const sevOf = x => x.id.startsWith("f") ? x.severity : "comment";
  const GUTTER_ORDER = [...SEV, "comment"];
  function gutterMark(list) {
    const sevs = GUTTER_ORDER.filter(s => list.some(x => sevOf(x) === s));
    const names = list.map(x => `${sevOf(x)}: ${x.id.startsWith("f") ? x.short_summary || x.summary : ((x.messages || [])[0] || {}).text || ""}`);
    return el("button", { type: "button", class: "gmark", title: names.join("\n"),
      "aria-label": `${plural(list.length, "finding")} on this line: ${names.join("; ")}`,
      onclick: e => { e.stopPropagation(); goTo(list[0].id); } },
      sevs.map(s => el("span", { class: "gdot sev-" + s })));
  }
  const lnCell = (n, cls, side) => {
    const here = n == null ? null : gutter.get(side + ":" + n);
    return el("td", { class: "ln" + (cls ? " " + cls : "") + (here ? " marked" : ""),
      "data-side": n == null ? null : side, "data-line": n == null ? null : n }, n == null ? "" : String(n), here ? gutterMark(here) : null);
  };
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

  // Every redraw of the diff goes through here, so drafts survive it and the
  // box being typed in keeps its focus and caret.
  function drawFile() {
    const a = document.activeElement;
    const keep = a && a.tagName === "TEXTAREA" && a.dataset.draft
      ? { key: a.dataset.draft, from: a.selectionStart, to: a.selectionEnd } : null;
    drawFileNow();
    afterDraw(keep);
  }
  function drawFileNow() {
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
    const useSplit = layout === "split" && !cramped() && !oneSided;
    const anch = anchorsFor(f.path, drawn);
    const worstFirst = (a, b) => GUTTER_ORDER.indexOf(sevOf(a)) - GUTTER_ORDER.indexOf(sevOf(b));
    gutter = new Map([...anch.at].map(([k, list]) => [k, list.filter(isOpen).sort(worstFirst)]).filter(([, list]) => list.length));
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
  // The gate pill: to the first open blocker or major, in the side list's
  // order; with none, on like n.
  function firstBlocking() {
    const pos = x => [ORDER.indexOf(x.file), x.line];
    const list = (R.findings || []).filter(x => isOpen(x) && (x.severity === "blocker" || x.severity === "major"))
      .sort((a, b) => pos(a)[0] - pos(b)[0] || a.line - b.line);
    if (list.length) goTo(list[0].id);
    else stepFinding(1);
  }
  $("gate").addEventListener("click", firstBlocking);
  let curFinding = null;
  function goTo(id) {
    const x = items().find(y => y.id === id);
    if (!x) return;
    const prev = curFinding;
    curFinding = id;
    if (x.file !== current) select(x.file);
    const f = (R.files || []).find(y => y.path === x.file);
    if (f && f.collapsed && !opened.has(f.path)) { opened.add(f.path); drawFile(); }
    if (!isOpen(x)) { expandedClosed.add(id); drawFile(); }
    // The card left folds again (a minor or nit), the one landed on opens.
    redrawCards([prev, id]);
    const c = document.querySelector(`[data-item="${CSS.escape(id)}"]`);
    if (c) {
      c.scrollIntoView({ block: "center" });
      for (const o of document.querySelectorAll(".card.flash, .card.cur")) o.classList.remove("flash", "cur");
      c.classList.add("flash", "cur");
    }
  }

  // ---------------------------------------------------------------- chrome

  function drawLayout() {
    for (const b of document.querySelectorAll("#layout button"))
      b.setAttribute("aria-pressed", String(b.dataset.layout === layout));
    // Too narrow for split: the toggle would change nothing on screen, so it hides.
    $("layout").classList.toggle("auto", cramped());
    postState();
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
    // Esc closes the key list from anywhere, a reply box included.
    if (e.key === "Escape" && !$("keys").hidden) { toggleKeys(false); e.preventDefault(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "j") { step(1); e.preventDefault(); }
    else if (e.key === "k") { step(-1); e.preventDefault(); }
    else if (e.key === "v") { setLayout(layout === "split" ? "unified" : "split"); e.preventDefault(); }
    else if (e.key === "n") { stepFinding(1); e.preventDefault(); }
    else if (e.key === "p") { stepFinding(-1); e.preventDefault(); }
    else if (e.key === "o") { toggleOverview(); e.preventDefault(); }
    else if (e.key === "m") { toggleMap(); e.preventDefault(); }
    else if (e.key === "?") { toggleKeys(); e.preventDefault(); }
  });
  // The key list sits behind a ? button; ?, Esc or a click elsewhere closes it.
  function toggleKeys(show = $("keys").hidden) {
    $("keys").hidden = !show;
    $("keys-btn").setAttribute("aria-expanded", String(show));
    postState();
  }
  $("keys-btn").addEventListener("click", e => { e.stopPropagation(); toggleKeys(); });
  document.addEventListener("click", e => {
    if (!$("keys").hidden && !$("keys").contains(e.target)) toggleKeys(false);
  });
  // The diff column's width, not the window's, picks split or unified.
  let wasCramped = cramped();
  new ResizeObserver(() => { if (cramped() !== wasCramped) { wasCramped = cramped(); drawLayout(); drawMain(); } }).observe($("main"));

  // The gate as the page sees it, the same rule `lookout gate` applies.
  function gateText() {
    if (!R.reviewedAt) return { cls: "none", text: "not reviewed yet" };
    const open = (R.findings || []).filter(isOpen);
    const blocking = open.filter(x => x.severity === "blocker" || x.severity === "major");
    const counts = SEV.map(s => [s, open.filter(x => x.severity === s).length]).filter(([, n]) => n)
      .map(([s, n]) => `${n} ${s}`).join(", ");
    // The pill says how many; its tooltip says which.
    const detail = open.length ? `${counts} open.` : "";
    if (blocking.length) return { cls: "blocked", text: `blocked · ${open.length} open`, detail };
    return { cls: "pass", text: open.length ? `pass · ${open.length} open` : "pass · no open findings", detail };
  }

  function drawHeader() {
    $("title").textContent = R.title || R.id;
    const s = R.stats || {};
    const where = R.source && (R.source.kind === "patch" ? "patch " + R.source.label : R.source.label);
    $("label").textContent = [where !== R.title ? where : null,
      plural(s.files || 0, "file"), `+${s.adds || 0} −${s.dels || 0}`].filter(Boolean).join(" · ");
    const g = gateText();
    const down = live && live.down;
    $("mode").textContent = down ? "disconnected — run `lookout open` to reconnect"
      : live ? (live.http ? `live · last poll ${live.http}` : "live") : "read-only";
    $("mode").className = "mode " + (down ? "down" : live ? "live" : "file");
    $("mode").title = down ? "The review server stopped answering. Your drafts are kept in this browser; `lookout open` starts a server and opens a fresh page."
      : live ? "Comments and closes go to the agent at its next prompt."
      : "Opened as a file: comments need crew's intent server (lookout open shows the served page when it is up).";
    const gt = gateTitle(g);
    $("gate").className = "gate " + g.cls;
    // A pill that goes somewhere says so with an arrow.
    $("gate").replaceChildren(g.text, gt.go ? el("span", { class: "go", "aria-hidden": "true" }, "↓") : "");
    $("gate").disabled = !gt.go;
    $("gate").title = gt.title;
    // No plan map, no Map button (m still says why).
    $("map-btn").hidden = !R.planMap;
    $("keys-map").hidden = !R.planMap;
    document.title = "lookout · " + R.id;
    const notes = [];
    if (R.highlight && !/^highlight\.js/.test(R.highlight) && R.highlight !== "off")
      notes.push("Drawn without syntax highlighting: " + R.highlight);
    // Scoring without Jev is a fact about the ranking, not an alarm: a quiet
    // line under the list it ranks, opened (click, tap or Enter) for the reason.
    const signalsOnly = !!(R.scoring && !R.scoring.ok);
    $("side-why").textContent = signalsOnly ? (R.scoring.why || "no Jev scores") + "." : "";
    $("side-note").hidden = !signalsOnly;
    const stale = live && live.stale;
    $("banner").replaceChildren(
      stale ? el("span", { class: "stale" }, "The diff changed while you were typing. ",
        el("button", { type: "button", onclick: () => location.reload() }, "Reload when ready"),
        " (drafts are kept)") : "",
      stale && notes.length ? "  " : "", notes.join("  "));
    $("banner").hidden = !notes.length && !stale;
    drawPR();
    postState();
  }
  function gateTitle(g) {
    const go = !!(R.findings || []).length;
    return { go, title: (g.detail ? g.detail + " " : "") + (g.cls === "blocked" ? "Go to the first blocking finding (n goes on). " : go ? "Go to the first finding (n goes on). " : "") +
      ((R.policy && R.policy.agentMayClose) ? "The agent may also close findings on this review."
                                            : "Only you close findings; the agent replies and marks them addressed.") };
  }

  // Framed by the app, the page's tools move up onto the app's header row, so
  // one row of chrome sits above the file. Only on the app's say-so: the page
  // says hello, the app answers "host", and from then on the page hides its
  // row, posts what the row would show, and takes the app's clicks back as
  // commands. An app that never answers leaves the page's own row in place.
  // What goes up is what the row shows (the gate's counts, live or not).
  function prSummary() {
    const g = GH();
    if (!g) return null;
    const n = (...b) => (g.checks || []).filter(c => b.includes(c.bucket)).length;
    const own = [...(R.findings || []), ...(R.threads || [])].filter(isOpen);
    return { pr: g.pr, repo: g.repo, url: ghUrl(g.url), state: g.state, draft: !!g.draft, behind: g.behind,
             pass: n("pass", "skipping"), fail: n("fail", "cancel"), pending: n("pending"),
             stale: own.filter(x => (g.stale || {})[x.id]).length, unposted: own.filter(unposted).length };
  }
  function postState() {
    if (!hosted) return;
    const g = gateText(), gt = gateTitle(g);
    // The open findings by severity, as the pill counts them: the app's
    // findings button counts the same set, and reloads its list when they move.
    const open = {};
    for (const x of (R.findings || []).filter(isOpen)) open[x.severity] = (open[x.severity] || 0) + 1;
    window.parent.postMessage({ lookout: "state", id: R.id,
      gate: { cls: g.cls, text: g.text, title: gt.title, go: gt.go }, open,
      mode: { cls: $("mode").className.replace("mode ", ""), text: $("mode").textContent, title: $("mode").title },
      layout, auto: cramped(), overview, map: mapOn, hasMap: !!R.planMap, keys: !$("keys").hidden,
      // The list's own Overview row: while it shows, the app needs no Overview button.
      ovRow: !!document.querySelector("#tree .ov-row")?.getClientRects().length,
      // The PR as the strip shows it, for the app's header and list.
      github: prSummary() }, hostOrigin);
  }
  if (embedded && window.parent !== window) {
    window.addEventListener("message", e => {
      if (e.source !== window.parent || !e.data || typeof e.data !== "object") return;
      // The first parent that answers is the host; after that, only its
      // origin is heard, and state goes only to it.
      if (hostOrigin !== "*" && e.origin !== hostOrigin) return;
      const d = e.data;
      if (d.lookout === "host") {
        // An opaque origin ("null", as a custom scheme may report) can't be a
        // postMessage target: keep "*" then, still answering only the parent.
        hostOrigin = e.origin && e.origin !== "null" ? e.origin : "*";
        clearInterval(helloTimer);
        hosted = true;
        document.documentElement.dataset.host = "app";
        postState();
      } else if (hosted && d.lookout === "do") {
        if (d.op === "gate") firstBlocking();
        else if (d.op === "overview") toggleOverview();
        else if (d.op === "map" && R.planMap) toggleMap();
        else if (d.op === "layout" && (d.layout === "split" || d.layout === "unified")) setLayout(d.layout);
        else if (d.op === "keys") toggleKeys();
        else if (d.op === "picks" && Array.isArray(d.ids)) setPicked(d.ids);
        else if (d.op === "focus" && typeof d.item === "string") focusItem(d.item);
      }
    });
    // Hello carries nothing but the id, so it may go anywhere. It repeats for
    // a few seconds: the app may not be listening yet when the page loads
    // (its frame origin arrives with the intent server's answer).
    const hello = () => window.parent.postMessage({ lookout: "hello", id: R.id }, "*");
    hello();
    let tries = 0;
    helloTimer = setInterval(() => { if (hosted || ++tries > 10) clearInterval(helloTimer); else hello(); }, 500);
  }

  // The app's banner click lands here (op "focus"): "checks" opens the
  // strip's check list; f#/t#/g# goes to that card; "c<id>" is a GitHub
  // comment, found on its own card or on the posted item it replies to.
  function focusItem(item) {
    if (item === "checks") { checksOpen = true; drawPR(); $("pr").scrollIntoView({ block: "nearest" }); return; }
    let id = item;
    const m = /^c(\d+)$/.exec(item);
    if (m) {
      const cid = Number(m[1]);
      const t = ((GH() || {}).threads || []).find(t => t.comments.some(c => c.id === cid));
      const own = t && [...(R.findings || []), ...(R.threads || [])].find(x => x.github && x.github.commentId === (t.comments[0] || {}).id);
      id = own ? own.id : t ? "g" + t.comments[0].id : "";
    }
    if (id && items().some(x => x.id === id)) goTo(id);
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
  // `post` and `poll: false` replace the server for a page that keeps its
  // edits elsewhere (an exported Artifact writes them to its db, lib/artifact.mjs).
  function serve({ token, id, post: postVia = null, poll: polls = true }) {
    live = { token, id, pending: null };
    document.body.classList.add("served");
    drawHeader();
    const post = postVia || (body => fetch("/review/" + encodeURIComponent(id), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, t: token }),
    }).catch(e => { e.unreachable = true; throw e; })     // only fetch itself: no server
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || "refused"); return j; })));

    // A composer with words in it is never redrawn away; a fresher review
    // waits until it is sent or cancelled.
    // Only words someone is working on count: a box in focus, or one typed
    // in since this page loaded. A restored draft (an unplaced one included)
    // stays on screen but would otherwise hold every fresher review back.
    const busy = () => [...document.querySelectorAll("textarea")].some(t => t.value.trim() &&
      (t === document.activeElement || edited.has(t.dataset.draft)));
    const take = next => {
      if (next.patchHash !== R.patchHash) {
        // A new diff means a new page; not under someone typing. The banner
        // offers the reload, and the next idle poll takes it.
        if (!busy()) { location.reload(); return; }
        live.pending = next;
        if (!live.stale) { live.stale = true; drawHeader(); }
        return;
      }
      // The page's own diff again: whatever new one was waiting is gone.
      if (live.stale) { live.stale = false; drawHeader(); }
      if (busy()) { live.pending = next; return; }
      live.pending = null;
      applyReview(next);
    };
    // Every 2.5s while visible; a background tab checks every 15s, so it is
    // current by the time someone looks, and catches up at once when shown.
    // A hidden tab's poll says so (bg=1): it does not keep the server from
    // idling out. After DOWN_AFTER failed polls in a row the header says the
    // server is gone, and goes back to live when one answers.
    const DOWN_AFTER = 3;
    let ticks = 0, fails = 0;
    const UNREACHED = {};
    const setDown = d => { if (!!live.down !== d) { live.down = d; drawHeader(); } };
    const setHttp = h => { if ((live.http || "") !== h) { live.http = h; drawHeader(); } };
    const poll = (e) => {
      if (document.hidden && !e && ++ticks % 6) return;
      fetch(`/review/${encodeURIComponent(id)}.json?t=${encodeURIComponent(token)}${document.hidden ? "&bg=1" : ""}`, { cache: "no-store" })
        // Only a fetch that reached nothing counts toward disconnected; an
        // HTTP error is a server that answered, said in a short note.
        .then(r => {
          fails = 0; setDown(false);
          setHttp(r.ok ? "" : "HTTP " + r.status);
          return r.ok ? r.json() : null;
        }, () => { if (++fails >= DOWN_AFTER) setDown(true); return UNREACHED; })
        .then(j => {
          // Nothing answered: no take(), which could reload onto a dead server.
          if (j === UNREACHED) return;
          // A GitHub sync writes github.changedAt without moving updatedAt
          // (it is not activity on the review): either is news.
          const ghAt = r => (r && r.github && r.github.changedAt) || "";
          if (j && (j.updatedAt !== R.updatedAt || ghAt(j) !== ghAt(R))) take(j); else if (live.pending && !busy()) take(live.pending);
        })
        .catch(() => { /* a bad body: the next poll asks again */ });
    };
    if (polls) {
      setInterval(() => poll(), 2500);
      document.addEventListener("visibilitychange", e => { if (!document.hidden) poll(e); });
    }

    // A sent draft is cleared before the redraw, so the redraw does not put
    // it back; every other draft is restored by afterDraw.
    const openComposers = new Set();
    // Reply boxes opened on this page, and ones Esc folded with a draft in them.
    const replying = new Set(), folded = new Set();
    const send = (body, status, key) => {
      status.textContent = "sending…";
      status.classList.remove("bad");
      // The success handler runs outside the failure one: an error drawing
      // the reply is not a failed send, and never reads as a dead server.
      return post(body).then(j => {
        if (key) {
          saveDraft(key, ""); openComposers.delete(key); replying.delete(key); folded.delete(key);
          const sent = document.querySelector(`textarea[data-draft="${CSS.escape(key)}"]`);
          if (sent) sent.value = "";
        }
        // A reply that lands on a new diff is a new page: take() reloads, or
        // offers the reload when another draft is open.
        if (j.review && j.review.patchHash !== R.patchHash) { take(j.review); return; }
        live.pending = null; applyReview(j.review);
      }, e => {
        // Marked by post() when fetch itself rejected (nothing answered),
        // whatever the browser's wording; a refusal is a plain Error.
        status.textContent = e.unreachable ? "not sent: the review server is not answering — run `lookout open`" : e.message;
        status.classList.add("bad"); throw e;
      });
    };

    // A quiz answer: graded and recorded by the server, once; the redraw
    // that follows shows the note with the result above it.
    answer = (n, pick, status) => {
      for (const b of document.querySelectorAll(`[data-note="${CSS.escape(n.id)}"] .qopt`)) b.disabled = true;
      send({ op: "answer", item: n.id, pick }, status).then(() => {}, () => {
        for (const b of document.querySelectorAll(`[data-note="${CSS.escape(n.id)}"] .qopt`)) b.disabled = false;
      });
    };

    // Reply, and close or reopen, under every card. Folded, a card shows small
    // Reply / Resolve / Dismiss links; the reply box opens on Reply, and closes
    // on Esc or when it loses focus empty. A box with a draft in it starts open,
    // unless Esc folded it on this page.
    actions = x => {
      const finding = x.id.startsWith("f");
      const open = isOpen(x);
      const key = "r:" + x.id;
      const status = el("span", { class: "send-status" });
      let ta = null;
      const go = (op, needText) => () => {
        if (needText && !(ta && ta.value.trim())) { unfold(); return; }
        // Folded, a close sends no note and leaves a kept draft alone.
        send({ op, item: x.id, text: ta ? ta.value : "" }, status, ta ? key : null).then(() => {}, () => {});
      };
      const box = el("div", { class: "actions" });
      const unfold = () => { replying.add(key); folded.delete(key); draw(); ta.focus(); };
      const fold = () => { replying.delete(key); if (draftText(key).trim()) folded.add(key); draw(); };
      const closers = [
        open ? el("button", { type: "button", onclick: go("resolve") }, "Resolve") : null,
        open && finding ? el("button", { type: "button", onclick: go("dismiss") }, "Dismiss") : null,
        !open ? el("button", { type: "button", onclick: go("reopen") }, "Reopen") : null,
      ];
      function draw() {
        const show = replying.has(key) || (!!draftText(key).trim() && !folded.has(key));
        box.classList.toggle("folded", !show);
        // Folded, the links show on focus or the current finding; one with a draft always does.
        box.classList.toggle("draft", !show && !!draftText(key).trim());
        if (!show) {
          ta = null;
          box.replaceChildren(el("div", { class: "buttons links" },
            el("button", { type: "button", onclick: unfold }, draftText(key).trim() ? "Reply (draft)" : "Reply"),
            ...closers, status));
          return;
        }
        ta = el("textarea", { rows: 2, placeholder: open ? "Reply, or a note for a close…" : "Reply…", "data-draft": key });
        ta.value = draftText(key);
        ta.addEventListener("input", () => saveDraft(key, ta.value));
        ta.addEventListener("keydown", e => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go("comment", true)();
          else if (e.key === "Escape" && $("keys").hidden) { e.preventDefault(); fold(); }
        });
        // A click on this card's own buttons is not leaving the box.
        // A redraw replaces the box; only a box still on the page folds.
        const mine = ta;
        mine.addEventListener("blur", e => {
          if (e.relatedTarget && box.contains(e.relatedTarget)) return;
          setTimeout(() => { if (mine.isConnected && document.activeElement !== mine && !mine.value.trim()) fold(); });
        });
        box.replaceChildren(ta, el("div", { class: "buttons" },
          el("button", { type: "button", class: "primary", onclick: go("comment", true) }, "Reply"),
          ...closers, status));
      }
      draw();
      return box;
    };

    // A click on a line number opens a comment under that line.
    const composerKey = (file, side, line) => "c:" + JSON.stringify([file, side, line]);
    // The plain text of a line as this page's diff draws it, or null.
    const lineText = (file, side, line) => {
      for (const h of ((ROWS[file] || {}).hunks || []))
        for (const r of h.rows) if ((side === "old" ? r[1] : r[2]) === line) {
          const d = document.createElement("div"); d.innerHTML = r[3]; return d.textContent;
        }
      return null;
    };
    // A line with its neighbours above and below: what a draft remembers
    // of where it was written.
    const lineCtx = (file, side, line) => [line - 1, line, line + 1].map(n => lineText(file, side, n));
    // A saved composer goes back under its line only when it was written
    // against this diff, or on a new diff when the line and both neighbours
    // still read the same and the line has words in it ("}" or a blank line
    // matches anywhere). An empty composer opened on this page always does.
    const placeable = (k, file, side, line) => {
      const d = drafts[k];
      if (d == null) return true;
      if (typeof d !== "object") return false;
      if (d.h === R.patchHash) return true;
      return Array.isArray(d.x) && /\w/.test(d.x[1] || "") &&
        JSON.stringify(lineCtx(file, side, line)) === JSON.stringify(d.x);
    };
    // A saved draft that does not belong under this line (placeable says no)
    // moves to a key of its own, so it stays in the unplaced list and the
    // new composer starts empty instead of inheriting it.
    function setAside(key, file, side, line) {
      const d = drafts[key];
      const alt = "c:" + JSON.stringify([file, side, line, (d && d.h) || "earlier"]);
      const all = readDrafts();
      all[alt] = drafts[alt] = d; delete all[key]; delete drafts[key];
      if (edited.delete(key)) edited.add(alt);
      store.set(DRAFTS, JSON.stringify(all));
    }
    function openComposer(tr, side, line) {
      const file = current, key = composerKey(file, side, line);
      if (drafts[key] != null && !placeable(key, file, side, line)) {
        setAside(key, file, side, line);
        // Redraw so the unplaced list shows it under its new key, then open
        // on the same line of the redrawn diff.
        drawFile();
        const cell = document.querySelector(`#diff td.ln[data-side="${side === "old" ? "old" : "new"}"][data-line="${Number(line)}"]`);
        if (!cell) return null;
        tr = cell.closest("tr");
      }
      openComposers.add(key);
      const span = tr.children.length;
      const ta = el("textarea", { rows: 3, placeholder: `Comment on ${side === "old" ? "old " : ""}line ${line}…`, "data-draft": key });
      ta.value = draftText(key);
      ta.addEventListener("input", () => saveDraft(key, ta.value, { h: R.patchHash, x: lineCtx(file, side, line) }));
      const status = el("span", { class: "send-status" });
      const row = el("tr", { class: "composer", "data-draft": key }, el("td", { colspan: span },
        el("div", { class: "card comment" }, el("div", { class: "actions" }, ta, el("div", { class: "buttons" },
          el("button", { type: "button", class: "primary", onclick: submit }, "Comment"),
          el("button", { type: "button", onclick: () => {
            openComposers.delete(key); saveDraft(key, ""); row.remove();
            if (live.pending && !busy()) take(live.pending);
          } }, "Cancel"),
          status)))));
      function submit() {
        if (!ta.value.trim()) { ta.focus(); return; }
        send({ op: "comment", file, line, side, text: ta.value }, status, key).then(() => {}, () => {});
      }
      ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) submit(); });
      tr.after(row);
      return ta;
    }
    $("diff").addEventListener("click", e => {
      const cell = e.target.closest && e.target.closest("td.ln[data-line]");
      if (!cell) return;
      const tr = cell.closest("tr");
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("composer")) {
        // A second click closes an empty composer; one with words keeps them.
        const t = next.querySelector("textarea");
        if (t && t.value.trim()) { t.focus(); return; }
        openComposers.delete(next.dataset.draft); next.remove(); return;
      }
      const ta = openComposer(tr, cell.dataset.side, Number(cell.dataset.line));
      if (ta) ta.focus();
    });
    // After any redraw of the diff: reopen this file's composers (open ones,
    // and drafts left from before a reload), refill reply boxes, and give the
    // box being typed in its focus and caret back.
    afterDraw = keep => {
      const unplaced = [];
      for (const k of new Set([...openComposers, ...Object.keys(drafts)])) {
        if (!k.startsWith("c:")) continue;
        let file, side, line;
        try { [file, side, line] = JSON.parse(k.slice(2)); } catch { continue; }
        if (file !== current) continue;
        if (!placeable(k, file, side, Number(line))) { unplaced.push([k, side, Number(line)]); continue; }
        const cell = document.querySelector(`#diff td.ln[data-side="${side === "old" ? "old" : "new"}"][data-line="${Number(line)}"]`);
        const tr = cell && cell.closest("tr");
        if (!tr || document.querySelector(`#diff tr.composer[data-draft="${CSS.escape(k)}"]`)) continue;
        openComposer(tr, side, Number(line));
      }
      // Drafts whose line changed under them: kept and shown, never placed.
      if (unplaced.length) $("diff").prepend(el("div", { class: "outside unplaced" },
        el("div", { class: "outside-head" }, "Drafts written against an earlier diff — their lines changed, so they are not placed"),
        unplaced.map(([k, side, line]) => {
          const d = drafts[k] || {};
          const ta = el("textarea", { rows: 2, "data-draft": k });
          ta.value = draftText(k);
          ta.addEventListener("input", () => saveDraft(k, ta.value, { h: d.h, x: d.x }));
          const box = el("div", { class: "card comment" }, el("div", { class: "card-head" },
            el("span", { class: "title" }, `${side === "old" ? "old " : ""}line ${line}` + ((Array.isArray(d.x) ? d.x[1] : d.x) != null ? ` — was “${String(Array.isArray(d.x) ? d.x[1] : d.x).trim().slice(0, 80)}”` : ""))),
            el("div", { class: "actions" }, ta, el("div", { class: "buttons" },
              el("button", { type: "button", onclick: () => { saveDraft(k, ""); openComposers.delete(k); box.remove(); } }, "Discard"))));
          return box;
        })));
      if (!keep) return;
      const t = document.querySelector(`#diff textarea[data-draft="${CSS.escape(keep.key)}"]`);
      if (!t) return;
      t.focus();
      try { t.setSelectionRange(keep.from, keep.to); } catch { /* not a text box */ }
    };
    drawSide();
    drawMain();
    // A caller with its own transport pushes fresher reviews through take,
    // which never redraws away a composer that has words in it.
    return { take };
  }

  window.lookout = { get review() { return R; }, applyReview, serve, el, current: () => current,
                     overview: () => overview, openOverview, goToLine, mapView: () => mapOn, openMap };

  drawHeader();
  drawLayout();
  drawSide();
  // Architecture first: a review with notes opens on its Overview, unless the
  // link names a file.
  const want = decodeURIComponent((location.hash.match(/file=([^&]+)/) || [])[1] || "");
  if ((R.files || []).some(f => f.path === want)) select(want);
  else if (location.hash === "#map") openMap();
  else if (location.hash === "#overview" || notesOf().length) openOverview();
  else select(ORDER[0] || null);
})();
