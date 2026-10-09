// lookout's page. Everything it draws arrives in #lookout-data: the review
// (source, files, findings) and, per file, rows already highlighted and
// word-marked by the CLI — [type, oldNo, newNo, html]. The html is
// highlight.js output over the repository's own text, escaped by it; nothing
// else is ever inserted as markup.
(() => {
  "use strict";
  const D = JSON.parse(document.getElementById("lookout-data").textContent);
  const R = D.review;
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
           el("span", { class: "counts" }, countsText(f)),
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
  const byPath = new Map((R.files || []).map(f => [f.path, f]));

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
       el("span", { class: "counts" }, countsText(f)),
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
        const files = g.files.map(p => byPath.get(p)).filter(Boolean);
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

  const hasRisk = (R.files || []).some(f => typeof f.risk === "number") && (R.groups || []).length > 0;
  let view = hasRisk && store.get("lookout.view", "risk") === "risk" ? "risk" : "path";
  function drawSide() {
    for (const b of document.querySelectorAll("#view button"))
      b.setAttribute("aria-pressed", String(b.dataset.view === view));
    $("view").hidden = !hasRisk;
    $("side-title").textContent = view === "risk" ? "By risk" : "Changes";
    $("side-count").textContent = String((R.files || []).length);
    view === "risk" ? drawRisk() : drawPathTree();
  }
  for (const b of document.querySelectorAll("#view button"))
    b.addEventListener("click", () => { view = b.dataset.view; store.set("lookout.view", view); drawSide(); select(current); });

  const countsText = f => f.binary ? "bin" : `+${f.adds} −${f.dels}`;

  // ---------------------------------------------------------------- diff

  let current = null;
  function select(p) {
    current = p;
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

  const lnCell = (n, cls) => el("td", { class: "ln" + (cls ? " " + cls : "") }, n == null ? "" : String(n));
  const codeCell = (html, cls, sign) => el("td", { class: "code" + (cls ? " " + cls : ""), "data-sign": sign, html });
  const KIND = { "+": "add", "-": "del", " ": "" };

  function unified(drawn) {
    const t = el("table", { class: "diff unified" },
      el("colgroup", null, el("col", { style: "width:52px" }), el("col", { style: "width:52px" }), el("col")));
    for (const h of drawn.hunks) {
      t.append(el("tr", { class: "hunk" }, el("td", { colspan: 3 }, h.header)));
      for (const [ty, o, n, html] of h.rows) {
        const k = KIND[ty];
        t.append(el("tr", { class: "line " + (k || "ctx") }, lnCell(o, k), lnCell(n, k), codeCell(html, k, ty === " " ? " " : ty)));
      }
    }
    return t;
  }

  function split(drawn) {
    const t = el("table", { class: "diff split" },
      el("colgroup", null, el("col", { style: "width:52px" }), el("col"), el("col", { style: "width:52px" }), el("col")));
    const pair = (l, r) => el("tr", { class: "line" },
      l ? lnCell(l[1], KIND[l[0]]) : el("td", { class: "ln empty" }),
      l ? codeCell(l[3], KIND[l[0]], l[0] === " " ? " " : l[0]) : el("td", { class: "code empty" }),
      r ? lnCell(r[2], KIND[r[0]]) : el("td", { class: "ln empty" }),
      r ? codeCell(r[3], KIND[r[0]], r[0] === " " ? " " : r[0]) : el("td", { class: "code empty" }));
    for (const h of drawn.hunks) {
      t.append(el("tr", { class: "hunk" }, el("td", { colspan: 4 }, h.header)));
      const rows = h.rows;
      for (let i = 0; i < rows.length;) {
        if (rows[i][0] === " ") { t.append(pair(rows[i], rows[i])); i++; continue; }
        const dels = [], adds = [];
        while (i < rows.length && rows[i][0] === "-") dels.push(rows[i++]);
        while (i < rows.length && rows[i][0] === "+") adds.push(rows[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) t.append(pair(dels[k], adds[k]));
      }
    }
    return t;
  }

  function drawFile() {
    const f = (R.files || []).find(x => x.path === current);
    if (!f) {
      $("file-head").replaceChildren();
      $("diff").replaceChildren(el("div", { class: "empty-review" },
        (R.files || []).length ? "Pick a file." : "No changes to review."));
      return;
    }
    $("file-head").replaceChildren(...fileHead(f).filter(Boolean));
    const drawn = ROWS[f.path] || { note: "missing" };
    if (drawn.note || (f.collapsed && !opened.has(f.path))) {
      $("diff").replaceChildren(notice(f, drawn));
      return;
    }
    // An added or deleted file has one side; split would draw half a page of nothing.
    const oneSided = drawn.hunks.every(h => h.rows.every(r => r[0] === "+")) ||
                     drawn.hunks.every(h => h.rows.every(r => r[0] === "-"));
    const useSplit = layout === "split" && !narrow() && !oneSided;
    $("diff").replaceChildren(useSplit ? split(drawn) : unified(drawn));
  }

  // ---------------------------------------------------------------- chrome

  function drawLayout() {
    for (const b of document.querySelectorAll("#layout button"))
      b.setAttribute("aria-pressed", String(b.dataset.layout === layout));
  }
  function setLayout(l) { layout = l; store.set("lookout.layout", l); drawLayout(); drawFile(); }
  for (const b of document.querySelectorAll("#layout button"))
    b.addEventListener("click", () => setLayout(b.dataset.layout));

  function step(d) {
    if (!ORDER.length) return;
    const i = ORDER.indexOf(current);
    select(ORDER[Math.max(0, Math.min(ORDER.length - 1, (i < 0 ? 0 : i + d)))]);
  }
  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "j") { step(1); e.preventDefault(); }
    else if (e.key === "k") { step(-1); e.preventDefault(); }
    else if (e.key === "v") { setLayout(layout === "split" ? "unified" : "split"); e.preventDefault(); }
  });
  let wasNarrow = narrow();
  window.addEventListener("resize", () => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); drawFile(); } });

  $("title").textContent = R.title || R.id;
  const s = R.stats || {};
  const where = R.source && (R.source.kind === "patch" ? "patch " + R.source.label : R.source.label);
  $("label").textContent = [where !== R.title ? where : null,
    `${s.files || 0} files`, `+${s.adds || 0} −${s.dels || 0}`].filter(Boolean).join(" · ");
  document.title = "lookout · " + R.id;
  const notes = [];
  if (R.highlight && !/^highlight\.js/.test(R.highlight) && R.highlight !== "off")
    notes.push("Drawn without syntax highlighting: " + R.highlight);
  if (R.scoring && !R.scoring.ok)
    notes.push("Risk from signals only — " + (R.scoring.why || "no Jev scores") + ".");
  if (notes.length) { $("banner").textContent = notes.join("  "); $("banner").hidden = false; }

  drawLayout();
  drawSide();
  const want = decodeURIComponent((location.hash.match(/file=([^&]+)/) || [])[1] || "");
  select((R.files || []).some(f => f.path === want) ? want : ORDER[0] || null);
})();
