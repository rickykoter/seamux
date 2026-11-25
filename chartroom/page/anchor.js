// chartroom's anchor: runs inside a chart's sandboxed iframe and talks to the
// studio only through postMessage (the anchor contract). It never sees the
// studio's token or routes.
//
//   to the studio:   { chartroom: 1, type: "ready", hashes }   every element's subtree hash
//                    { chartroom: 1, type: "key", key, down }  a studio key pressed in here
//                    { chartroom: 1, type: "pin", pin }        a click in pin mode: {path, dx, dy, text}
//                    { chartroom: 1, type: "placed", found, gone }  which pins this page could place
//                    { chartroom: 1, type: "focus", n }        a pin was clicked
//   from the studio: { chartroom: 1, type: "outline", against } outline what is not in `against`
//                    { chartroom: 1, type: "mode", pin }       pin mode on or off
//                    { chartroom: 1, type: "place", pins }     draw these pins
(function () {
  if (window.__chartroomAnchor) return;
  window.__chartroomAnchor = true;
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  var post = function (msg) { msg.chartroom = 1; try { parentWin.postMessage(msg, "*"); } catch (e) { /* gone */ } };

  // FNV-1a, 32 bits, as hex.
  var fnv = function (s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  };
  var ATTRS = ["id", "class", "src", "href", "d", "points", "fill", "stroke", "x", "y", "cx", "cy", "r", "width", "height", "style", "transform", "viewBox"];
  var MAX = 6000;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1 };

  // Each element's subtree hash: its tag, chosen attributes, own text and its
  // children's hashes. A change anywhere below an element changes its hash.
  var hashes = new Map(), count = 0;
  var hashOf = function (el) {
    if (count++ > MAX) return "";
    var parts = [el.tagName];
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute && el.getAttribute(ATTRS[i]);
      if (v) parts.push(ATTRS[i] + "=" + v.slice(0, 400));
    }
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { var t = n.nodeValue.replace(/\s+/g, " ").trim(); if (t) parts.push("#" + t.slice(0, 400)); }
      else if (n.nodeType === 1 && !SKIP[n.tagName] && !n.hasAttribute("data-chartroom")) parts.push(hashOf(n));
    }
    var h = fnv(parts.join("|"));
    hashes.set(el, h);
    return h;
  };
  var compute = function () {
    hashes = new Map(); count = 0;
    if (document.body) hashOf(document.body);
    return hashes;
  };

  var ready = function () {
    var hs = compute(), list = [];
    hs.forEach(function (h) { list.push(h); });
    post({ type: "ready", hashes: list.slice(0, MAX) });
  };

  // What to outline against the other version's hashes: the topmost element
  // whose whole subtree is new, and any changed element whose children are
  // all unchanged (its own text or attributes moved, or a child went).
  var toOutline = function (against) {
    var other = new Set(against || []);
    var changed = function (el) { var h = hashes.get(el); return h !== undefined && !other.has(h); };
    var out = [];
    var walk = function (el, insideNew) {
      if (!hashes.has(el)) return;
      var kids = [];
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (hashes.has(c)) kids.push(c);
      var ch = changed(el);
      var allNew = ch && kids.every(changed);
      var noneChanged = kids.every(function (k) { return !changed(k); });
      if (!insideNew && el !== document.body && ch && (allNew || noneChanged)) { out.push(el); insideNew = true; }
      if (out.length > 80) return;
      for (var i = 0; i < kids.length; i++) walk(kids[i], insideNew);
    };
    if (document.body) walk(document.body, false);
    return out;
  };

  var layer = null, fade = null;
  // hold: keep the outlines until told otherwise (while Space is held);
  // otherwise they fade after a moment.
  var outline = function (against, hold) {
    compute();
    var els = toOutline(against);
    if (layer) layer.remove();
    clearTimeout(fade);
    layer = document.createElement("div");
    layer.setAttribute("data-chartroom", "outline");
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;transition:opacity .5s ease;opacity:1";
    var sx = window.scrollX, sy = window.scrollY;
    els.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      var b = document.createElement("div");
      b.style.cssText = "position:absolute;box-sizing:border-box;border:2px solid #7fbbb3;border-radius:3px;" +
        "box-shadow:0 0 0 3px rgba(127,187,179,.28);left:" + (r.left + sx - 3) + "px;top:" + (r.top + sy - 3) + "px;" +
        "width:" + (r.width + 6) + "px;height:" + (r.height + 6) + "px";
      layer.appendChild(b);
    });
    document.documentElement.appendChild(layer);
    if (!hold) fade = setTimeout(function () { if (layer) layer.style.opacity = "0"; }, 1400);
  };

  // ---------------------------------------------------------- pins

  // An element's path from body: an id when it is unique in the page, else
  // tag:nth-of-type steps. The pin also keeps the element's text prefix, so a
  // path that lands on a different element on a later version counts as gone.
  var cssId = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&"); };
  var pathOf = function (el) {
    var steps = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll("#" + cssId(el.id)).length === 1) { steps.unshift("#" + el.id); break; }
      var tag = el.tagName.toLowerCase(), k = 1;
      for (var s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) k++;
      steps.unshift(tag + ":nth-of-type(" + k + ")");
      el = el.parentElement;
    }
    if (!steps.length || steps[0].charAt(0) !== "#") steps.unshift("body");
    return steps.join(" > ");
  };
  var textOf = function (el) { return String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60); };

  var pinMode = false;
  var setMode = function (on) {
    pinMode = !!on;
    document.documentElement.style.cursor = pinMode ? "crosshair" : "";
  };
  // In pin mode a click drops a pin instead of doing what the page would do.
  ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "submit"].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!pinMode) return;
      var t = e.target;
      if (t && t.closest && t.closest("[data-chartroom]")) return;
      e.preventDefault(); e.stopPropagation();
      if (type !== "click" || !t || t.nodeType !== 1) return;
      var r = t.getBoundingClientRect();
      post({ type: "pin", pin: { path: pathOf(t), dx: Math.round(e.clientX - r.left), dy: Math.round(e.clientY - r.top), text: textOf(t) } });
    }, true);
  });

  // Place the studio's pins: [{ n, path, dx, dy, text, waits }]. Reports
  // which were found on this page and which are gone.
  var pinLayer = null, lastPins = [];
  var place = function (pins) {
    lastPins = pins;
    if (pinLayer) pinLayer.remove();
    pinLayer = document.createElement("div");
    pinLayer.setAttribute("data-chartroom", "pins");
    pinLayer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646";
    var found = [], gone = [], sx = window.scrollX, sy = window.scrollY, stack = {};
    pins.forEach(function (p) {
      var el = null;
      try { el = document.querySelector(p.path); } catch (e) { el = null; }
      var t = el ? textOf(el) : "";
      // The text prefix must still match: a path that now names another
      // element is a gone pin, not a pin on the wrong thing.
      if (!el || (p.text && t.slice(0, Math.min(20, p.text.length)) !== p.text.slice(0, Math.min(20, p.text.length)))) { if (!p.draft) gone.push(p.n); return; }
      var r = el.getBoundingClientRect();
      var x = r.left + sx + Math.min(Math.max(p.dx, 0), Math.max(r.width, 1)), y = r.top + sy + Math.min(Math.max(p.dy, 0), Math.max(r.height, 1));
      // The pin sits on the element's top-right corner, so the words it is
      // about stay readable; a dot marks the exact spot. Kept on the page.
      // Just outside the element's right edge, level with its top, so the pin
      // covers none of it; more pins on one element fan out to the right.
      var S = 22, vw = document.documentElement.clientWidth;
      var k = (stack[p.path] = (stack[p.path] || 0) + 1) - 1;
      var left = r.right + sx + 3 + k * (S + 3), top = r.top + sy - 4;
      if (left > sx + vw - S - 2) left = Math.max(sx + 2, r.right + sx - S - 3 - k * (S + 3));
      if (top < sy + 2) top = sy + 2;
      var b = document.createElement("button");
      b.setAttribute("data-chartroom", "pin");
      b.textContent = String(p.n);
      b.title = p.draft ? "your new comment" : "thread " + p.n + (p.waits ? " (waits on you)" : p.resolved ? " (resolved)" : "");
      b.setAttribute("aria-label", b.title);
      // Amber means "waits on you" and nothing else; focus is the teal ring.
      var fill = p.draft ? "#ffffff" : p.waits ? "#dfa000" : p.resolved ? "#ffffff" : "#7fbbb3";
      var ink = p.draft ? "#2f6f6a" : p.resolved ? "#5c6a72" : "#1e2326";
      var edge = p.draft ? "2px dashed #2f6f6a" : p.resolved ? "2px solid #859289" : "2px solid #ffffff";
      b.style.cssText = "position:absolute;left:" + left + "px;top:" + top + "px;width:" + S + "px;height:" + S + "px;border-radius:50% 50% 50% 50%;" +
        "box-sizing:border-box;border:" + edge + ";background:" + fill + ";color:" + ink + ";font:700 11px/18px system-ui,sans-serif;text-align:center;padding:0;" +
        "cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)" + (p.focus ? ";outline:3px solid #2f6f6a;outline-offset:2px" : "");
      // A small mark on the exact spot the pin points at.
      // A small ring on the exact spot: hollow, so the letter under it shows.
      var dot = document.createElement("span");
      dot.setAttribute("data-chartroom", "pin-dot");
      dot.style.cssText = "position:absolute;left:" + (x - 4) + "px;top:" + (y - 4) + "px;width:8px;height:8px;border-radius:50%;pointer-events:none;box-sizing:border-box;" +
        "border:2px solid " + (p.waits ? "#dfa000" : p.resolved ? "#859289" : "#2f6f6a");
      pinLayer.appendChild(dot);
      b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); if (!p.draft) post({ type: "focus", n: p.n }); });
      pinLayer.appendChild(b);
      if (!p.draft) found.push(p.n);
    });
    document.documentElement.appendChild(pinLayer);
    post({ type: "placed", found: found, gone: gone });
  };
  var replaceTimer = null;
  window.addEventListener("resize", function () { clearTimeout(replaceTimer); replaceTimer = setTimeout(function () { if (lastPins.length) place(lastPins); }, 120); });

  window.addEventListener("message", function (e) {
    if (e.source !== parentWin) return;
    var m = e.data;
    if (!m || m.chartroom !== 1) return;
    if (m.type === "outline") outline(Array.isArray(m.against) ? m.against : [], !!m.hold);
    if (m.type === "unoutline" && layer) { layer.remove(); layer = null; }
    if (m.type === "mode") setMode(m.pin);
    if (m.type === "place" && Array.isArray(m.pins)) place(m.pins.filter(function (p) { return p && typeof p.path === "string"; }).slice(0, 300));
  });

  // The studio's keys still work while the chart has focus.
  var KEYS = { " ": 1, "[": 1, "]": 1, "j": 1, "k": 1, "c": 1, "?": 1, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1, "8": 1, "9": 1, "Escape": 1 };
  var typing = function (t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };
  ["keydown", "keyup"].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!KEYS[e.key] || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === " ") e.preventDefault();
      if (type === "keydown" && e.repeat) return;
      post({ type: "key", key: e.key, down: type === "keydown" });
    }, true);
  });

  // Once at load, and again a little later for a chart that draws itself
  // with script after load.
  var start = function () { ready(); setTimeout(ready, 1500); };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
