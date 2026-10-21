
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
  es.onerror = function(){ document.documentElement.setAttribute("data-feed", "lost"); };
})();
</script>
