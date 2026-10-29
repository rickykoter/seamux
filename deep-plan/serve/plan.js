
<script>
(function(){
  var T = "__TOKEN__", SLUG = "__SLUG__";
  // PAGE: the /plan/ segment this page was served at (a slug, or
  // <slug>.review.html); STAMP: that file's stamp when it was read.
  var PAGE = "__PAGE__", STAMP = "__STAMP__";

  // Which transitions each status allows (deep_plan.mjs applyTransition). A
  // button the status makes pointless is not shown: an older render drew all
  // five on every increment.
  var VALID = { pending: ["go", "block"], blocked: ["go", "reset"],
    authorized: ["start", "done", "block", "reset"], working: ["done", "block", "reset"], done: ["reset"] };
  function allowed(b) {
    var inc = b.closest && b.closest(".inc[data-status]");
    var ok = inc && VALID[inc.getAttribute("data-status")];
    return !ok || ok.indexOf(b.getAttribute("data-a")) >= 0;
  }

  // The generator renders every control disabled because on disk it cannot act.
  // Being served is exactly what changes that, so enabling them is the first
  // thing this does -- and the tooltip has to stop saying "when open in the Dock".
  var acts = document.querySelectorAll(".dp-act[data-a][data-n]");
  for (var i = 0; i < acts.length; i++) {
    var b = acts[i];
    if (!allowed(b)) { b.hidden = true; continue; }
    b.disabled = false;
    b.title = (b.title || "").replace(/ — available when.*$/, "");
  }

  // Turns on the affordance the stylesheet keeps behind .dp-live: a path is only
  // underlined once there is something that can open it.
  document.body.classList.add("dp-live");

  function openPath(el) {
    if (el.classList.contains("dp-busy")) return;
    el.classList.add("dp-busy");
    fetch("/open?t=" + encodeURIComponent(T) + "&slug=" + encodeURIComponent(SLUG) +
          "&path=" + encodeURIComponent(el.getAttribute("data-file")))
      .then(function(r){ return r.json(); })
      .then(function(j){
        el.classList.remove("dp-busy");
        if (j && j.ok) return;
        el.classList.add("dp-bad");
        el.title = (j && j.detail) || "could not open it";
        setTimeout(function(){ el.classList.remove("dp-bad"); }, 2500);
      })
      .catch(function(){
        el.classList.remove("dp-busy");
        el.classList.add("dp-bad");
        el.title = "the deep-plan server did not answer";
      });
  }

  // What a transition said, in words beside its buttons: a refusal's reason
  // is the point of showing it, and a hover title is where nobody looks.
  function msgFor(b) {
    var p = b.parentNode, m = p.querySelector(".dp-act-msg");
    if (!m) { m = el("span", "dp-act-msg"); m.setAttribute("role", "status"); m.setAttribute("aria-live", "polite"); p.appendChild(m); }
    return m;
  }
  function say(b, text, bad) { var m = msgFor(b); m.textContent = text; m.classList.toggle("dp-bad", !!bad); }
  function siblings(b) { return b.parentNode.querySelectorAll(".dp-act[data-a][data-n]"); }

  // An inline question in place of window.prompt/confirm, which an embedded
  // WebView without dialog delegates answers with null. `input`: ask for
  // text (and refuse an empty one); `yes(text)` runs on the confirm.
  function inlineAsk(after, opts, yes) {
    var host = after.parentNode, old = host.querySelector(".dp-why");
    if (old) { var f = old.querySelector("input,button"); if (f) f.focus(); return; }
    var row = el("span", "dp-why");
    if (opts.text) row.appendChild(el("span", "", opts.text));
    var inp = null;
    if (opts.input) { inp = el("input"); inp.placeholder = opts.input; inp.setAttribute("aria-label", opts.input); row.appendChild(inp); }
    var ok = el("button", "dp-act", opts.ok), no = el("button", "dp-act", "cancel");
    ok.type = no.type = "button";
    function done() { row.remove(); after.focus(); }
    function go() {
      var v = inp ? inp.value.trim() : "";
      if (inp && !v) { inp.focus(); return; }
      row.remove(); yes(v);
    }
    ok.addEventListener("click", go);
    no.addEventListener("click", done);
    row.addEventListener("keydown", function(e){
      if (e.key === "Escape") { e.preventDefault(); done(); }
      else if (e.key === "Enter" && inp && e.target === inp) { e.preventDefault(); go(); }
    });
    row.appendChild(ok); row.appendChild(no);
    after.after(row);
    (inp || ok).focus();
  }

  function fire(b, why) {
    var a = b.getAttribute("data-a"), n = b.getAttribute("data-n");
    if (a === "block" && why === undefined) {
      return inlineAsk(b, { input: "why is increment " + n + " blocked?", ok: "block it" }, function(v){ fire(b, v); });
    }
    // One at a time, across the increment's buttons. A double-click on `go`
    // used to be two authorizations.
    if (b.classList.contains("dp-busy")) return;
    var all = siblings(b);
    for (var i = 0; i < all.length; i++) { all[i].disabled = true; all[i].classList.remove("dp-bad", "dp-ok"); }
    b.classList.add("dp-busy");
    b.setAttribute("aria-busy", "true");
    var t0 = Date.now();
    say(b, a + " " + n + "\u2026");
    // The engine can take up to 90s; the count says it is still going.
    var tick = setInterval(function(){ say(b, a + " " + n + "\u2026 " + Math.round((Date.now() - t0) / 1000) + "s"); }, 1000);
    function settle(ok, text) {
      clearInterval(tick);
      b.classList.remove("dp-busy");
      b.removeAttribute("aria-busy");
      b.classList.add(ok ? "dp-ok" : "dp-bad");
      say(b, text, !ok);
      if (ok) return;
      for (var i = 0; i < all.length; i++) if (!all[i].hidden) all[i].disabled = false;
    }
    var q = "/inc?t=" + encodeURIComponent(T) + "&slug=" + encodeURIComponent(SLUG) +
            "&n=" + encodeURIComponent(n) + "&a=" + encodeURIComponent(a) +
            "&why=" + encodeURIComponent(why || "");
    fetch(q).then(function(r){ return r.json(); }).then(function(j){
      if (!j || !j.ok) return settle(false, (j && j.detail) || "refused");
      settle(true, "\u2713 " + (j.detail || a) + " \u2014 reloading");
      // The transition rewrote this file. Reload rather than patch the DOM: the
      // page is a pure function of tracker state and guessing at the new state
      // here is how the two drift.
      setTimeout(function(){ location.reload(); }, 350);
    }).catch(function(){ settle(false, "the deep-plan server did not answer"); });
  }

  document.addEventListener("click", function(ev){
    if (!ev.target.closest) return;
    var f = ev.target.closest(".dp-path[data-file]");
    if (f) { ev.preventDefault(); return openPath(f); }
    var b = ev.target.closest(".dp-act[data-a][data-n]");
    if (!b || b.disabled) return;
    ev.preventDefault();
    fire(b);
  });

  // Answer "has the tracker written anything?" for the page's own auto-refresh,
  // rather than running a second reload loop beside it. Two timers reloading the
  // same document is how you get a page that reloads twice and loses your scroll
  // position on the second one.
  //
  // This is also what makes auto-refresh defensible as a DEFAULT: with a probe,
  // "live" costs a 20-byte JSON every few seconds and the page only reloads when
  // the file actually moved. Without one it would be a blind reload under the
  // reader, which is what kept it opt-in before.
  //
  // The baseline is the stamp of the file as it was served (injected), not
  // whatever the first probe sees: a write between serving the page and that
  // probe is a change too. And the answer is "has the file moved since this
  // page was served?", so a skipped reload asks again and still hears yes.
  var seen = /^__/.test(STAMP) ? null : STAMP;
  if (/^__/.test(PAGE)) PAGE = SLUG;
  window.__dpChanged = function(cb){
    fetch("/plan-stamp?slug=" + encodeURIComponent(PAGE))
      .then(function(r){ return r.json(); })
      .then(function(j){
        var now = j && (j.stamp || (j.mtime ? String(j.mtime) : ""));
        if (!now) return cb(false);
        if (seen === null) { seen = now; return cb(false); }
        cb(now !== seen);
      }).catch(function(){ cb(false); });
  };
  // Reload now if the file moved, unless the reader turned auto-refresh off
  // or is mid-comment.
  function reloadIfMoved() {
    var auto = document.getElementById("dp-auto");
    if ((auto && !auto.checked) || (window.dpBusy && window.dpBusy())) return;
    window.__dpChanged(function(moved){ if (moved) location.reload(); });
  }

  // ---------------------------------------------- browser and claiming checks
  // Rows the engine marked (.dp-check: a browser run, or a claim that asks)
  // get their controls here: run, open tab, a filmstrip that fills while the
  // run goes on, the replay and trace after it, which of its scripts changed
  // in this increment, and a picker when its claim is asking. Everything acts
  // through the token-checked /check/* routes; nothing here records a verdict.
  var CSS = ".dp-bc{margin:6px 0 10px 18px;font-size:12px}" +
    ".dp-bc .dp-bc-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:3px 0}" +
    ".dp-bc button{font:inherit;padding:2px 8px;border-radius:5px;border:1px solid var(--line,#8884);background:transparent;color:inherit;cursor:pointer}" +
    ".dp-bc button.dp-busy{opacity:.5}.dp-bc button.dp-bad{border-color:var(--bad,#c33)}" +
    ".dp-film{display:flex;gap:4px;overflow-x:auto;padding:4px 0;max-width:100%}" +
    ".dp-film img{height:54px;border-radius:3px;border:1px solid var(--line,#8884);cursor:zoom-in;flex:none}" +
    ".dp-film img.dp-now{outline:2px solid var(--accent,#4a8)}" +
    ".dp-film img.dp-failed{outline:2px solid var(--bad,#c33)}" +
    ".dp-bc .dp-step{opacity:.85}.dp-bc .dp-err{color:var(--bad,#c33)}" +
    ".dp-bc input{font:inherit;padding:2px 6px;border-radius:5px;border:1px solid var(--line,#8884);background:transparent;color:inherit}" +
    ".dp-act.dp-busy{opacity:.65;cursor:progress}.dp-act.dp-bad{border-color:var(--bad,#c33);color:var(--bad,#c33)}" +
    ".dp-act.dp-ok{border-color:var(--good,#4a8);color:var(--good,#4a8)}" +
    ".dp-bc button.dp-ok{border-color:var(--good,#4a8)}" +
    ".dp-act-msg{font-size:12px;margin-left:4px;color:var(--dim,#888)}.dp-act-msg.dp-bad{color:var(--bad,#c33)}" +
    ".dp-why{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 6px 4px 0;font-size:12px}" +
    ".dp-why input{font:inherit;min-width:16em;padding:3px 6px;border-radius:5px;border:1px solid var(--line,#8884);background:transparent;color:inherit}" +
    ".dp-why button.dp-act{padding:2px 10px}" +
    "#dp-lightbox{position:fixed;inset:0;background:#000c;display:flex;align-items:center;justify-content:center;z-index:99;cursor:zoom-out}" +
    "#dp-lightbox img{max-width:94vw;max-height:90vh;border-radius:6px}" +
    "#dp-lightbox span{position:absolute;bottom:14px;color:#fff;font-size:13px}";
  var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);

  function q(path, li, extra) {
    return path + "?t=" + encodeURIComponent(T) + "&slug=" + encodeURIComponent(SLUG) +
      "&n=" + encodeURIComponent(li.getAttribute("data-n")) + "&id=" + encodeURIComponent(li.getAttribute("data-id")) + (extra || "");
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function evUrl(ev, file) { return "/plan-evidence/" + encodeURIComponent(SLUG) + "/" + encodeURIComponent(ev.dir) + "/" + encodeURIComponent(file); }

  function lightbox(src, caption) {
    var box = el("div"); box.id = "dp-lightbox";
    var img = el("img"); img.src = src; box.appendChild(img);
    if (caption) box.appendChild(el("span", "", caption));
    box.addEventListener("click", function(){ box.remove(); });
    document.addEventListener("keydown", function esc(e){ if (e.key === "Escape") { box.remove(); document.removeEventListener("keydown", esc); } });
    document.body.appendChild(box);
  }

  function act(btn, path, li, extra, after) {
    if (btn.classList.contains("dp-busy")) return;
    btn.classList.add("dp-busy");
    fetch(q(path, li, extra)).then(function(r){ return r.json(); }).then(function(j){
      btn.classList.remove("dp-busy");
      if (!j || !j.ok) { btn.classList.add("dp-bad"); btn.title = (j && j.detail) || "refused"; return; }
      btn.classList.remove("dp-bad"); btn.title = j.detail || "";
      if (after) after(j);
    }).catch(function(){ btn.classList.remove("dp-busy"); btn.classList.add("dp-bad"); btn.title = "the deep-plan server did not answer"; });
  }

  // Which frame a step label belongs to, for the lightbox caption.
  function labelOf(ev, k) {
    var s = (ev.steps || []).filter(function(x){ return x.from <= k && (x.to === null || k < x.to || (x.to === x.from && k === x.from)); });
    return s.length ? s[s.length - 1].label : "";
  }

  function draw(li, box, ev) {
    box.innerHTML = "";
    var row = el("div", "dp-bc-row");
    var running = ev.status === "running";
    if (!running) {
      var run = el("button", "", ev.frames || ev.status === "fail" ? "run again" : "run");
      run.addEventListener("click", function(){ act(run, "/check/run", li, "", function(){ setTimeout(function(){ poll(li, box); }, 600); }); });
      row.appendChild(run);
    }
    if (li.hasAttribute("data-browser") && ev.tab) {
      var tab = el("button", "", "open tab");
      tab.title = "bring the run's tab to the front of its cmux workspace";
      tab.addEventListener("click", function(){ act(tab, "/check/tab", li); });
      row.appendChild(tab);
    }
    if (ev.frames) {
      var said = running ? "● " + (ev.label ? "step: " + ev.label : "starting") + " · " + ev.frames + " frame" + (ev.frames === 1 ? "" : "s")
        : (ev.result === "fail" ? "✗ failed in “" + (ev.label || "?") + "”" : "✓ " + ev.frames + " frames");
      row.appendChild(el("span", "dp-step", said));
    }
    if (!running && ev.animation) {
      var rp = el("button", "", "replay");
      rp.addEventListener("click", function(){ lightbox(evUrl(ev, ev.animation), "the whole run"); });
      row.appendChild(rp);
    }
    if (!running && ev.trace) {
      var tr = el("a", "", "trace"); tr.href = evUrl(ev, ev.trace); tr.target = "_blank";
      row.appendChild(tr);
    }
    // PR proof from a passed run: built locally first, then, on a person's
    // ok, uploaded into the PR's description (gh pr edit --attach).
    if (!running && ev.status === "pass" && ev.frames && li.hasAttribute("data-browser")) {
      var pf = el("button", "", "proof");
      pf.title = "build the replay, key frames and proof.md for the PR";
      pf.addEventListener("click", function(){ act(pf, "/check/proof", li, "", function(){
        pf.textContent = "proof built";
        var a = el("a", "", "proof.md"); a.href = "/plan/" + encodeURIComponent(SLUG) + ".proof/proof.md"; a.target = "_blank";
        pf.after(a);
      }); });
      row.appendChild(pf);
      var up = el("button", "", "attach to PR");
      up.title = "upload the proof into this branch's PR description";
      up.addEventListener("click", function(){
        inlineAsk(up, { text: "upload this check's replay and key frames to the PR's description on GitHub?", ok: "upload" }, function(){
          act(up, "/check/proof", li, "&attach=1", function(j){ up.textContent = "on the PR"; up.title = j.detail || ""; });
        });
      });
      row.appendChild(up);
    }
    box.appendChild(row);
    if (ev.error) box.appendChild(el("div", "dp-err", ev.error.split("\n")[0]));
    var frames = ev.framesList || [];
    if (frames.length) {
      var film = el("div", "dp-film");
      frames.slice(-24).forEach(function(f, k, all){
        var idx = frames.length - all.length + k;
        var img = el("img"); img.loading = "lazy"; img.src = evUrl(ev, f); img.alt = f;
        var cap = labelOf(ev, idx); if (cap) img.title = cap;
        if (k === all.length - 1) img.className = running ? "dp-now" : (ev.result === "fail" ? "dp-failed" : "");
        img.addEventListener("click", function(){ lightbox(img.src, cap); });
        film.appendChild(img);
      });
      box.appendChild(film);
      film.scrollLeft = film.scrollWidth;
    }
    if (ev.changed && ev.changed.length) {
      var ch = el("div", "dp-bc-row");
      ch.appendChild(el("span", "dp-step", "changed in this increment:"));
      ev.changed.forEach(function(f){ var p = el("span", "dp-path", f); p.setAttribute("data-file", f); ch.appendChild(p); });
      box.appendChild(ch);
    }
    // What a run left held (a SIGKILL, a crash, a failed release): named, with
    // the command that gives it back. A new run is refused until then.
    if (!running && ev.claims && ev.claims.length) {
      var held = el("div", "dp-bc-row dp-err");
      held.textContent = "holds " + ev.claims.map(function(c){ return c.lock ? "lock " + c.lock : (c.name ? c.name + "=" + c.value : c.release); }).join(", ") +
        " · give it back: deep-plan check release " + SLUG + " " + li.getAttribute("data-n") + " " + li.getAttribute("data-id");
      box.appendChild(held);
    }
    if (ev.ask && (running || ev.status === "needs-value")) {
      var ask = el("div", "dp-bc-row");
      ask.appendChild(el("span", "", ev.ask.question + (ev.ask.name ? " (" + ev.ask.name + ")" : "")));
      var send = function(v, btn){ act(btn, "/check/answer", li, "&name=" + encodeURIComponent(ev.ask.name || "") + "&value=" + encodeURIComponent(v),
        function(){ btn.textContent = "sent"; setTimeout(function(){ poll(li, box); }, 600); }); };
      (ev.ask.choices || []).forEach(function(c){ var b = el("button", "", c); b.addEventListener("click", function(){ send(c, b); }); ask.appendChild(b); });
      var inp = el("input"); inp.placeholder = (ev.ask.choices || []).length ? "or type one" : "value";
      var go = el("button", "", "send");
      go.addEventListener("click", function(){ if (inp.value.trim()) send(inp.value.trim(), go); });
      inp.addEventListener("keydown", function(e){ if (e.key === "Enter" && inp.value.trim()) send(inp.value.trim(), go); });
      ask.appendChild(inp); ask.appendChild(go);
      box.appendChild(ask);
    }
  }

  // The row's own words ("● running · ...") were drawn with the page. When
  // the run's status moves on, say so in the row, and reload the page if the
  // engine has rewritten it since (its verdict and the increment's aggregate
  // live in the file, not here).
  function restatus(li, status) {
    var was = li.getAttribute("data-status");
    if (!status || status === was) return;
    li.setAttribute("data-status", status);
    var mark = li.firstElementChild;
    if (mark && mark.classList && mark.classList.contains("dp-mark")) mark.style.visibility = "hidden";
    for (var c = li.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 && c.data.indexOf(was + " \u00b7") >= 0) { c.data = c.data.replace(was + " \u00b7", status + " \u00b7"); break; }
    }
    reloadIfMoved();
  }

  function poll(li, box) {
    fetch(q("/check/evidence", li)).then(function(r){ return r.json(); }).then(function(ev){
      if (!ev || ev.ok === false) return;
      restatus(li, ev.status);
      // Redrawn only when something changed, and never under a person using
      // the picker; a filmstrip scrolled back stays where they left it.
      var key = JSON.stringify(ev);
      var using = box.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
      if (key !== box.__dpSeen && !using) {
        var film = box.querySelector(".dp-film");
        var back = film && film.scrollLeft + film.clientWidth < film.scrollWidth - 4 ? film.scrollLeft : null;
        draw(li, box, ev);
        box.__dpSeen = key;
        var again = box.querySelector(".dp-film");
        if (again && back !== null) again.scrollLeft = back;
      }
      if (ev.status === "running") setTimeout(function(){ poll(li, box); }, 1000);
    }).catch(function(){ /* the page's own refresh tries again */ });
  }

  var rows = document.querySelectorAll("li.dp-check[data-id][data-n]");
  for (var r = 0; r < rows.length; r++) {
    var box = el("div", "dp-bc");
    rows[r].appendChild(box);
    poll(rows[r], box);
  }

  // The page armed its timer before this script ran, so it captured no probe.
  // Re-arm it now that one exists -- a change event is the only handle the page
  // exposes, and toggling twice lands back on whatever the reader chose.
  var box = document.getElementById("dp-auto");
  if (box) {
    var want = box.checked;
    box.checked = !want;
    box.dispatchEvent(new Event("change"));
    box.checked = want;
    box.dispatchEvent(new Event("change"));
  }
})();
</script>
