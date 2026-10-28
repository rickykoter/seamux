
<script>
// Served by deep-plan serve (lib/serve.mjs) and, through its proxy, by
// crew-board. Ported from crew-board src/inject/; the token and the id are
// filled in per request.
(function(){
  var T = "__TOKEN__", ID = "__ID__";
  var picks = document.querySelectorAll(".dp-ask-pick[data-n]");
  for (var i = 0; i < picks.length; i++) {
    picks[i].disabled = false;
    picks[i].title = (picks[i].title || "").replace(/ \u2014 available when.*$/, "");
  }
  var status = document.getElementById("dp-ask-status");
  function say(t, bad) { if (status) { status.textContent = t; status.style.color = bad ? "var(--warn)" : "var(--good)"; } }
  document.addEventListener("click", function(ev){
    if (!ev.target.closest) return;
    var b = ev.target.closest(".dp-ask-pick[data-n]");
    if (!b || b.disabled) return;
    ev.preventDefault();
    for (var i = 0; i < picks.length; i++) picks[i].disabled = true;
    say("sending " + b.getAttribute("data-n") + "\u2026");
    fetch("/answer?t=" + encodeURIComponent(T) + "&id=" + encodeURIComponent(ID) +
          "&n=" + encodeURIComponent(b.getAttribute("data-n")))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (j && j.ok && j.delivered) { say("\u2713 " + j.detail + " \u2014 the terminal has your answer"); return; }
        if (j && j.ok) { say("recorded, not typed: " + j.detail, true); return; }
        say((j && j.detail) || "refused", true);
        for (var i = 0; i < picks.length; i++) picks[i].disabled = false;
      })
      .catch(function(){ say("the deep-plan server did not answer", true);
        for (var i = 0; i < picks.length; i++) picks[i].disabled = false; });
  });
})();
</script>
