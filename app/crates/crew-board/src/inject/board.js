
<style>html[data-feed="lost"] #stamp::after{content:" · reconnecting"}</style>
<script>
(function(){
  var T = "__TOKEN__", PORT = __PORT__;
  // EventSource reconnects by itself; the stamp says so while it is down.
  var es = new EventSource("/board/events?t=" + encodeURIComponent(T));
  es.addEventListener("state", function(ev){
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    document.documentElement.removeAttribute("data-feed");
    __boardRender(d);
    __boardIntent({ port: PORT, token: T });
  });
  // A server that restarted has a new token and refuses this one, and a
  // refused EventSource never retries: if the stream stays down while the
  // server answers, this page is stale, so it loads afresh.
  var stale = 0;
  es.onerror = function(){
    document.documentElement.setAttribute("data-feed", "lost");
    clearTimeout(stale);
    stale = setTimeout(function(){
      if (es.readyState === 1) return;
      fetch("/health", { cache: "no-store" })
        .then(function(r){ if (r.ok) location.reload(); })
        .catch(function(){});
    }, 4000);
  };
})();
</script>
