// chartroom's ops: what a person (or Claude) can do to a chart's threads and
// its pick. One function, applyOp, used by the local server, by the CLI, and
// inlined into a published page (ADR: the same ops on both routes), so it
// imports nothing and uses no Node API. It works on { chart, threads } in
// memory and returns [http code, reply]; the caller reads and writes files.
//
// threads.json:
//   { v, seq, threads: [{ id: "t3", version, pane, pin, at, by, resolved,
//                         messages: [{ id: "m1", by, text, at, kind? }] }],
//     picks: [{ version, pane, label, at, by }] }
// a pin: { path, dx, dy, text } (lib/../page/anchor.js makes it), or null
// for a comment on the whole pane.
//
// Ops (the body): comment {version, pane, pin?, text} · reply {item, text} ·
// resolve {item, text?} · reopen {item, text?} · pick {version, pane, text?}

export const OPS = ["comment", "reply", "resolve", "reopen", "pick"];
export const BYS = ["human", "agent"];
export const MAX_TEXT = 4000;
export const MAX_PATH = 600;

function fail(code, error) { return [code, { error: error }]; }
function str(x) { return typeof x === "string" ? x : ""; }
function cleanText(x) { return str(x).replace(/\r\n?/g, "\n").trim(); }

export function emptyThreads() { return { v: 1, seq: 0, threads: [], picks: [] }; }

export function normalize(threads) {
  var t = threads && typeof threads === "object" ? threads : {};
  if (!Array.isArray(t.threads)) t.threads = [];
  if (!Array.isArray(t.picks)) t.picks = [];
  if (typeof t.seq !== "number") t.seq = t.threads.reduce(function (n, x) { var k = Number(String(x.id).slice(1)); return k > n ? k : n; }, 0);
  if (!t.v) t.v = 1;
  return t;
}

function findVersion(chart, n) {
  return (chart.versions || []).filter(function (v) { return v.n === n; })[0] || null;
}
function findPane(v, key) { return v ? v.panes.filter(function (p) { return p.key === key; })[0] || null : null; }

function cleanPin(pin) {
  if (pin === null || pin === undefined) return [null, null];
  if (typeof pin !== "object" || Array.isArray(pin)) return [null, "pin must be an object"];
  var path = str(pin.path);
  if (!path || path.length > MAX_PATH) return [null, "pin.path must be 1 to " + MAX_PATH + " characters"];
  var dx = Number(pin.dx), dy = Number(pin.dy);
  if (!isFinite(dx) || !isFinite(dy) || Math.abs(dx) > 100000 || Math.abs(dy) > 100000) return [null, "pin.dx and pin.dy must be numbers"];
  return [{ path: path, dx: Math.round(dx), dy: Math.round(dy), text: str(pin.text).replace(/\s+/g, " ").trim().slice(0, 120) }, null];
}

function threadOf(threads, item) {
  return threads.threads.filter(function (t) { return t.id === item; })[0] || null;
}

function nextMsgId(t) { return "m" + (t.messages.length + 1); }

// state: { chart, threads }, changed in place. by: "human" or "agent".
export function applyOp(state, body, at, by) {
  if (!body || typeof body !== "object") return fail(400, "an op is an object");
  var op = str(body.op);
  if (OPS.indexOf(op) < 0) return fail(400, "unknown op " + JSON.stringify(body.op));
  if (BYS.indexOf(by) < 0) return fail(400, "by must be human or agent");
  var chart = state.chart, threads = normalize(state.threads);
  state.threads = threads;
  at = str(at) || new Date().toISOString();
  var text = cleanText(body.text);
  if (text.length > MAX_TEXT) return fail(413, "text is over " + MAX_TEXT + " characters");

  if (op === "comment" || op === "pick") {
    var n = Number(body.version);
    var v = findVersion(chart, n);
    if (!v) return fail(404, "no version " + JSON.stringify(body.version));
    var pane = findPane(v, str(body.pane));
    if (!pane) return fail(404, "v" + n + " has no pane " + JSON.stringify(body.pane));
    if (op === "comment") {
      if (!text) return fail(400, "a comment needs text");
      var pr = cleanPin(body.pin);
      if (pr[1]) return fail(400, pr[1]);
      threads.seq += 1;
      var t = { id: "t" + threads.seq, version: n, pane: pane.key, pin: pr[0], at: at, by: by, resolved: false,
        messages: [{ id: "m1", by: by, text: text, at: at }] };
      threads.threads.push(t);
      return [200, { item: t.id, thread: t }];
    }
    if (pane.role !== "option") return fail(400, pane.label + " is a view; only an option can be picked");
    if (chart.status === "superseded") return fail(409, "this chart is superseded; set it back to exploring before picking");
    // A pick with no words keeps a decision someone wrote; it only replaces
    // an empty one or the line an earlier pick wrote.
    var auto = function (d) { return !d || /^Option .* \(v\d+\)$/.test(d); };
    threads.picks.push({ version: n, pane: pane.key, label: pane.label, at: at, by: by });
    chart.chosen = { version: n, pane: pane.key, at: at, by: by };
    chart.status = "chosen";
    if (text) chart.decision = text;
    else if (auto(chart.decision)) chart.decision = "Option " + pane.label + " (v" + n + ")";
    return [200, { item: "pick", chosen: chart.chosen }];
  }

  var th = threadOf(threads, str(body.item));
  if (!th) return fail(404, "no thread " + JSON.stringify(body.item));
  if (op === "reply") {
    if (!text) return fail(400, "a reply needs text");
    th.messages.push({ id: nextMsgId(th), by: by, text: text, at: at });
    return [200, { item: th.id }];
  }
  var to = op === "resolve";
  if (th.resolved === to) return fail(409, th.id + " is already " + (to ? "resolved" : "open"));
  th.resolved = to;
  th.messages.push({ id: nextMsgId(th), by: by, text: text, at: at, kind: "status", to: to ? "resolved" : "open" });
  return [200, { item: th.id }];
}

// A thread waits on the person when it is open and Claude spoke last.
export function waitsOnPerson(t) {
  if (!t || t.resolved || !t.messages || !t.messages.length) return false;
  return t.messages[t.messages.length - 1].by === "agent";
}
