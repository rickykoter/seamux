
<script>
(function(){
  var T = "__TOKEN__", SLUG = "__SLUG__";

  // The generator renders every control disabled because on disk it cannot act.
  // Being served is exactly what changes that, so enabling them is the first
  // thing this does -- and the tooltip has to stop saying "when open in the Dock".
  var acts = document.querySelectorAll(".dp-act[data-a][data-n]");
  for (var i = 0; i < acts.length; i++) {
    var b = acts[i];
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
        el.title = "the crew intent server did not answer";
      });
  }

  function fire(b) {
    var a = b.getAttribute("data-a"), n = b.getAttribute("data-n"), why = "";
    if (a === "block") {
      why = window.prompt("Why is increment " + n + " blocked?") || "";
      if (!why) return;                      // cancelled: park nothing
    }
    // One at a time. A double-click on `go` used to be two authorizations.
    if (b.classList.contains("dp-busy")) return;
    b.classList.add("dp-busy");
    var q = "/inc?t=" + encodeURIComponent(T) + "&slug=" + encodeURIComponent(SLUG) +
            "&n=" + encodeURIComponent(n) + "&a=" + encodeURIComponent(a) +
            "&why=" + encodeURIComponent(why);
    fetch(q).then(function(r){ return r.json(); }).then(function(j){
      b.classList.remove("dp-busy");
      b.classList.add(j && j.ok ? "dp-ok" : "dp-bad");
      if (!j || !j.ok) { b.title = (j && j.detail) || "refused"; return; }
      // The transition rewrote this file. Reload rather than patch the DOM: the
      // page is a pure function of tracker state and guessing at the new state
      // here is how the two drift.
      setTimeout(function(){ location.reload(); }, 350);
    }).catch(function(){
      b.classList.remove("dp-busy");
      b.classList.add("dp-bad");
      b.title = "the crew intent server did not answer";
    });
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
  var seen = null;
  window.__dpChanged = function(cb){
    fetch("/plan-stamp?slug=" + encodeURIComponent(SLUG))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (!j || !j.mtime) return cb(false);
        if (seen === null) { seen = j.mtime; return cb(false); }
        var moved = j.mtime !== seen;
        seen = j.mtime;
        cb(moved);
      }).catch(function(){ cb(false); });
  };

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
