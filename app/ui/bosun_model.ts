// The Bosun tab's model (bosun.ts draws it): the answer rail's day groups
// and cards, its filter, re-checks and newer answers, the reading pane's
// text, the whistle's mood, and what ⌘B does. A pure module, so
// bosun_probe.ts runs it in Node.

/** One source behind an answer, as `seamux bosun log add` keeps it. */
export type Source = { kind: string; ref: string; label: string };
/** One answer log entry (crew_core::bosun::log). `at` is ms since the epoch. */
export type Entry = { id: string; at: number; question: string; answer: string; sources: Source[]; asker: string; report?: ReportRun };
/** A section's result in a report run: needs the person, fine, or not checked. */
export type SectionStatus = "needs" | "ok" | "unchecked";
/** One section of a report run, as `seamux bosun report done` logs it (crew_core::bosun::reports). */
export type ReportSection = { title: string; status: SectionStatus; line: string; why?: string };
/** A report run's `report` field: which report, its doc (or why there is none), its sections. */
export type ReportRun = { id: string; run: string; title: string; doc?: string; docWhy?: string; sections: ReportSection[] };
/** bosun_log's answer: one day's entries, and the days that have a log, newest first. */
export type LogPage = { day: string; today: string; days: string[]; entries: Entry[] };
/** bosun_status's answer (bosun_app.rs). */
export type Status = {
  backend: string; tmux: boolean; known: boolean; live: boolean;
  ws?: string; pane?: string; state?: string; session?: string; day?: string; root?: string; why?: string;
};

/** A day of cards in the rail: Today, Yesterday, then the date. */
export type Day = { day: string; label: string; cards: Card[] };
/** What a rail card shows. */
export type Card = { id: string; time: string; from: string; question: string; first: string; chips: Chip[]; entry: Entry; report: ReportRun | null };
/** One chip per source kind, with how many of that kind; `name` is its full name, for a tooltip. */
export type Chip = { kind: string; label: string; name: string; n: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The day before `day` (YYYY-MM-DD), by the calendar. */
export function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

/** "Today", "Yesterday", else "Sun 22 Nov" (with the year when it is not `today`'s). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === dayBefore(today)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const year = day.slice(0, 4) === today.slice(0, 4) ? "" : ` ${y}`;
  return `${wd} ${d} ${MONTHS[m - 1]}${year}`;
}

/** The answer's first line that says something, cut to `max` characters,
 *  without its markdown marks (heading, quote, bullet, code ticks, bold). */
export function firstLine(answer: string, max = 120): string {
  const line =
    answer
      .split("\n")
      .map((l) => l.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^[#>*\-\s]+/, "").replace(/`/g, "").trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

/** Short names for the source kinds the Bosun's skills write; others keep their own. */
const KIND_LABEL: Record<string, string> = {
  file: "file", github: "gh", gh: "gh", pr: "gh", jira: "jira", ticket: "jira",
  snowflake: "sql", query: "sql", sql: "sql", datadog: "dd", dashboard: "dash", splunk: "splunk",
  workspace: "ws", url: "link", link: "link", command: "cmd", cmd: "cmd", doc: "doc",
};

/** The full name behind each short label, for its tooltip. */
const LABEL_NAME: Record<string, string> = {
  file: "File", gh: "GitHub", jira: "Jira", sql: "SQL query", dd: "Datadog", dash: "Dashboard",
  splunk: "Splunk search", ws: "Workspace", link: "Link", cmd: "Command", doc: "Claude Doc",
};

/** A source kind's short label ("gh") and full name ("GitHub"): the chip and the source list say the same. */
export function kindLabel(kind: string): { label: string; name: string } {
  const k = (kind || "link").toLowerCase();
  const label = KIND_LABEL[k] ?? k;
  return { label, name: LABEL_NAME[label] ?? label };
}

/** One chip per source kind, in the order they first appear. */
export function chips(sources: Source[]): Chip[] {
  const out: Chip[] = [];
  for (const s of sources) {
    const kind = (s.kind || "link").toLowerCase();
    const { label, name } = kindLabel(kind);
    const have = out.find((c) => c.label === label);
    if (have) have.n++;
    else out.push({ kind, label, name, n: 1 });
  }
  return out;
}

/** A chip's tooltip: "GitHub, 2 sources". */
export function chipTitle(c: Chip): string {
  return `${c.name}, ${c.n} source${c.n === 1 ? "" : "s"}`;
}

/** "10:42" in local time. */
export function clock(at: number, tz?: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
}

/** Who asked, for the card's top line, all in one shape: a workspace's
 *  name, "sitrep loop", or "the app". */
export function fromLabel(asker: string): string {
  const a = asker.trim();
  if (!a) return "";
  if (a === "app") return "the app";
  if (a === "person") return "you";
  if (a.startsWith("loop:")) return `${a.slice(5)} loop`;
  if (a.startsWith("report:")) return `${a.slice(7)} report`;
  if (a.startsWith("ask:")) return a.slice(4);
  return a;
}

export function card(e: Entry, tz?: string): Card {
  return {
    id: e.id, time: clock(e.at, tz), from: fromLabel(e.asker), question: e.question.trim(),
    first: firstLine(e.answer), chips: chips(e.sources ?? []), entry: e, report: reportOf(e),
  };
}

const STATUSES: SectionStatus[] = ["needs", "ok", "unchecked"];

/** An entry's report run, when it is one and its field reads: sections with
 *  a title, a known status and a line. A doc link that is not https is dropped. */
export function reportOf(e: Entry): ReportRun | null {
  const r = e.report;
  if (!r || typeof r !== "object" || !Array.isArray(r.sections) || typeof r.id !== "string" || !r.id) return null;
  const sections = r.sections
    .filter((s) => s && typeof s.title === "string" && typeof s.line === "string" && STATUSES.includes(s.status))
    .map((s) => ({ title: s.title, status: s.status, line: s.line, ...(s.why ? { why: String(s.why) } : {}) }));
  if (!sections.length) return null;
  const doc = typeof r.doc === "string" && r.doc.startsWith("https://") ? r.doc : undefined;
  return {
    id: r.id, run: String(r.run ?? e.id), title: String(r.title ?? "").trim() || e.question.trim(), sections,
    ...(doc ? { doc } : {}), ...(!doc && r.docWhy ? { docWhy: String(r.docWhy) } : {}),
  };
}

/** What a report run's answer says beyond its section lines (the lines
 *  `report done` writes when the Bosun sends none): "" when nothing. */
export function reportExtra(e: Entry, r: ReportRun): string {
  const said = new Set(r.sections.flatMap((s) => [`${s.title}: ${s.line}`, `- ${s.title}: ${s.line}`].map((x) => x.trim().toLowerCase())));
  return e.answer
    .split("\n")
    .filter((l) => l.trim() && !said.has(l.trim().toLowerCase()))
    .join("\n")
    .trim();
}

/** A section's dot, for its tooltip and the screen reader. */
export function statusLabel(s: SectionStatus): string {
  return s === "needs" ? "Needs you" : s === "ok" ? "Fine" : "Not checked";
}

/** How many of a run's sections need the person. */
export function needsCount(r: ReportRun): number {
  return r.sections.filter((s) => s.status === "needs").length;
}

/** The rail: one group per page, newest day first, newest entry first in each. */
export function rail(pages: LogPage[], tz?: string): Day[] {
  const seen = new Set<string>();
  const out: Day[] = [];
  for (const p of [...pages].sort((a, b) => (a.day < b.day ? 1 : -1))) {
    if (seen.has(p.day)) continue;
    seen.add(p.day);
    const cards = [...p.entries].sort((a, b) => b.at - a.at).map((e) => card(e, tz));
    if (cards.length || p.day === p.today) out.push({ day: p.day, label: dayLabel(p.day, p.today), cards });
  }
  return out;
}

/** The days the rail asks for: today, and the newest `n - 1` other days that have a log. */
export function daysToLoad(today: string, days: string[], n = 4): string[] {
  const rest = days.filter((d) => d !== today && d < today).slice(0, Math.max(0, n - 1));
  return [today, ...rest];
}

/** How many logged days are older than the ones `daysToLoad` asks for: what "Show older" would add. */
export function olderDays(today: string, days: string[], n = 4): number {
  return Math.max(0, days.filter((d) => d !== today && d < today).length - Math.max(0, n - 1));
}

// ---- the filter ----

/** A question as compared with another: case, spacing and a closing "?" do not count. */
export function sameQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s?.!]+$/, "");
}

/** The filter's words, each to be found at the start of a word (so "dd" does not find "added"). */
function wordsOf(query: string): RegExp[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu"));
}

/** Whether an answer matches the filter: every word of it, at the start of
 *  a word in the question, the answer, who asked, or a source's label, ref or kind. */
export function matches(e: Entry, query: string): boolean {
  const words = wordsOf(query);
  if (!words.length) return true;
  const report = reportOf(e);
  const lines = report ? report.sections.flatMap((s) => [s.title, s.line, statusLabel(s.status)]) : [];
  const hay = [e.question, e.answer, e.asker, fromLabel(e.asker), ...lines, ...(e.sources ?? []).flatMap((s) => [s.label, s.ref, s.kind, kindLabel(s.kind).name])].join("\n");
  return words.every((w) => w.test(hay));
}

/** Why a card matched, when the card does not show it: the first source or
 *  answer line holding a word that its question and first line lack. "" when
 *  what shows is reason enough. */
export function matchedWhere(e: Entry, query: string): string {
  const words = wordsOf(query);
  // What a card shows of its answer: about two lines of the rail, not the whole first line.
  // A report card shows its sections' lines instead of its answer's first line.
  const report = reportOf(e);
  const shown = report ? `${e.question}\n${report.sections.map((s) => `${s.title} ${s.line}`).join("\n")}` : `${e.question}\n${firstLine(e.answer, 80)}\n${fromLabel(e.asker)}`;
  const hidden = words.filter((w) => !w.test(shown));
  if (!hidden.length) return "";
  for (const s of e.sources ?? []) {
    const t = `${s.label} ${s.ref}`;
    if (hidden.some((w) => w.test(t) || w.test(s.kind) || w.test(kindLabel(s.kind).name))) {
      const what = s.label && s.label !== s.ref ? s.label : s.ref;
      return `source: ${kindLabel(s.kind).label} ${what.length > 60 ? what.slice(0, 59) + "…" : what}`;
    }
  }
  const line = e.answer.split("\n").find((l) => hidden.some((w) => w.test(l)));
  if (line) return `answer: ${firstLine(line, 70)}`;
  return "";
}

/** Text cut into runs that match a filter word (at a word start) and runs
 *  that don't, for the rail to mark what it found. */
export function hits(text: string, query: string): { s: string; hit: boolean }[] {
  // Longest first: the alternation takes the first word that fits, so "ret" must not win over "retry".
  const words = query
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length || !text) return [{ s: text, hit: false }];
  const re = new RegExp(`(?<=^|[^\\p{L}\\p{N}])(?:${words.join("|")})`, "giu");
  const out: { s: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index! > last) out.push({ s: text.slice(last, m.index), hit: false });
    out.push({ s: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ s: text.slice(last), hit: false });
  return out;
}

/** How long ago, for the reading pane: "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now: number): string {
  const m = Math.floor((now - at) / 60e3);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The rail narrowed to the answers that match, with how many show of how many. */
export function filterRail(days: Day[], query: string): { days: Day[]; shown: number; total: number } {
  const total = days.reduce((n, d) => n + d.cards.length, 0);
  if (!query.trim()) return { days, shown: total, total };
  const out = days.map((d) => ({ ...d, cards: d.cards.filter((c) => matches(c.entry, query)) })).filter((d) => d.cards.length);
  return { days: out, shown: out.reduce((n, d) => n + d.cards.length, 0), total };
}

// ---- newer answers and re-checks ----

/** For each answer that a later one asked again, the newest such answer's id. */
export function newerAnswers(entries: Entry[]): Map<string, string> {
  const newest = new Map<string, Entry>();
  for (const e of entries) {
    const k = sameQuestion(e.question);
    const had = newest.get(k);
    if (!had || e.at > had.at) newest.set(k, e);
  }
  const out = new Map<string, string>();
  for (const e of entries) {
    const n = newest.get(sameQuestion(e.question))!;
    if (n.id !== e.id && n.at > e.at) out.set(e.id, n.id);
  }
  return out;
}

/** The answer a re-check came back as. A queued ask is logged under its
 *  queue id (bosun/references/answers.md), so the id `bosun_send` gave back
 *  finds it; failing that, the newest entry asking the same question that
 *  was logged at or after `since`. Null until it lands. */
export function landed(question: string, since: number, entries: Entry[], qid = ""): string | null {
  if (qid && entries.some((e) => e.id === qid)) return qid;
  const k = sameQuestion(question);
  let best: Entry | null = null;
  for (const e of entries) if (e.at >= since && sameQuestion(e.question) === k && (!best || e.at > best.at)) best = e;
  return best?.id ?? null;
}

/** What a waiting re-check says, by what the Bosun is doing; a report's run
 *  says its sources are checked first. */
export function pendingNote(live: boolean, state: string | undefined, report = false): string {
  if (report) {
    if (!live) return "Queued. It runs once the Bosun is running.";
    if (state === "needs_input") return "Queued. It runs after you answer the Bosun's prompt.";
    return "Queued. Its sources are checked first, then the new run lands at the top.";
  }
  if (!live) return "Queued. The Bosun answers once it is running.";
  if (state === "needs_input") return "Queued. It waits until you answer the Bosun's prompt.";
  if (state === "working") return "Queued. The Bosun answers after its current turn.";
  return "Queued. The new answer lands at the top.";
}

/** The whistle: resting, piping while the Bosun works, waiting on you, or one trill for a new answer. */
export type Mood = "rest" | "pipe" | "wait" | "trill";

export function mood(state: string | undefined, fresh: boolean): Mood {
  if (fresh) return "trill";
  if (state === "needs_input") return "wait";
  return state === "working" ? "pipe" : "rest";
}

/** The ids in `now` that `before` did not have; nothing on the first look (`before` null). */
export function freshIds(before: Set<string> | null, now: string[]): string[] {
  if (!before) return [];
  return now.filter((id) => !before.has(id));
}

/** What ⌘B does: on the Bosun tab it only focuses the terminal; elsewhere it drops the Bosun down or puts it away. */
export type DropAct = "focus" | "open" | "close";

export function dropAct(tab: string, open: boolean): DropAct {
  if (tab === "bosun") return "focus";
  return open ? "close" : "open";
}

/** The re-check prompt: the same question, queued again. */
export function recheck(e: Entry): string {
  return e.question.trim();
}

/** How a card asks again: a report run queues its report (bosun_report_run,
 *  which goes through the supervisor's source check); an answer queues its question. */
export function askAgain(e: Entry): { cmd: "bosun_report_run"; args: { id: string } } | { cmd: "bosun_send"; args: { text: string } } {
  const r = reportOf(e);
  return r ? { cmd: "bosun_report_run", args: { id: r.id } } : { cmd: "bosun_send", args: { text: recheck(e) } };
}

// ---- the answer's text ----

/** A run of text inside a line: plain, `code`, **bold**, or a bare URL. */
export type Span = { t: "text" | "code" | "b" | "url"; s: string };
/** A block of an answer: a heading, a paragraph, a list, or fenced code. */
export type Block =
  | { t: "h"; level: number; spans: Span[] }
  | { t: "p"; spans: Span[] }
  | { t: "ul" | "ol"; items: Span[][] }
  | { t: "pre"; s: string };

/** The inline marks the Bosun writes: code ticks, bold, and bare links. */
export function mdInline(line: string): Span[] {
  const out: Span[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*|(https?:\/\/[^\s<>()\]]*[^\s<>()\].,;:!?'"])/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > last) out.push({ t: "text", s: line.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", s: m[1] });
    else if (m[2] !== undefined) out.push({ t: "b", s: m[2] });
    else out.push({ t: "url", s: m[3] });
    last = m.index! + m[0].length;
  }
  if (last < line.length) out.push({ t: "text", s: line.slice(last) });
  return out;
}

/** An answer's markdown as blocks, for the reading pane to draw as plain
 *  elements (never as HTML): headings, paragraphs, lists, fenced code. */
export function mdBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", spans: mdInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push({ t: "pre", s: code.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    const ul = /^\s*[-*+]\s+(.*)$/.exec(l);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(l);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1].length, spans: mdInline(h[2].trim()) });
    } else if (ul || ol) {
      flush();
      const t = ul ? "ul" : "ol";
      const prev = out[out.length - 1];
      const item = mdInline((ul ?? ol)![1]);
      if (prev && prev.t === t) prev.items.push(item);
      else out.push({ t, items: [item] });
    } else if (!l.trim()) flush();
    else para.push(l.replace(/^\s*>\s?/, ""));
  }
  flush();
  return out;
}

/** ~ for the home folder in a path. */
export function tilde(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** Where a source goes, for its row: a web page (by host), a file (by
 *  folder), or nowhere (a ticket key, a query), with a short name to show. */
export function sourceRow(s: Source, root = ""): { to: "web" | "file" | "none"; name: string; where: string } {
  const t = sourceTarget(s, root);
  if (t && "url" in t) {
    let host = "";
    try {
      host = new URL(t.url).host.replace(/^www\./, "");
    } catch {
      /* not a URL after all: no host */
    }
    // A GitHub link names its repo too: "PR 812" alone doesn't say where.
    let where = host;
    if (host === "github.com") {
      const repo = new URL(t.url).pathname.split("/").filter(Boolean).slice(0, 2).join("/");
      if (repo) where = `${host}/${repo}`;
    }
    return { to: "web", name: s.label || t.url, where };
  }
  if (t) {
    const base = t.path.split("/").pop() || t.path;
    const file = t.line ? `${base}:${t.line}` : base;
    const dir = tilde(t.path.slice(0, t.path.length - base.length).replace(/\/$/, ""));
    // A label ("retry cap") stands for a file: the file still shows beside it.
    return { to: "file", name: s.label || file, where: s.label && s.label !== file ? `${file} · ${dir}` : dir };
  }
  return { to: "none", name: s.label || s.ref, where: "" };
}

// ---- Ask the Bosun (bosun_ask.ts) ----

/** What an Ask from a Radar row or a Lookout review carries: the chip the
 *  box shows, the facts written into the question, and a question to start from. */
export type AskContext = { from: "Radar" | "Lookout"; chip: string; facts: string[]; suggest: string };

/** "4 files: a.ts, b.ts, c.ts and 1 more", by base name. */
export function fileList(paths: string[], max = 3): string {
  const names = paths.map((p) => p.split("/").pop() || p);
  const shown = names.slice(0, max).join(", ");
  const more = names.length > max ? ` and ${names.length - max} more` : "";
  return `${names.length} file${names.length === 1 ? "" : "s"}: ${shown}${more}`;
}

/** A Radar workspace: its name, branch, worktree, and what it edits and plans. */
export function workspaceAsk(w: { title: string; branch: string; root: string; editing: string[]; planned: { plan: string; inc: number }[] }): AskContext {
  const facts = [`workspace ${w.title}`];
  if (w.branch) facts.push(`branch ${w.branch}`);
  if (w.root) facts.push(`worktree ${tilde(w.root)}`);
  if (w.editing.length) facts.push(`editing ${fileList(w.editing)}`);
  const plans = [...new Set(w.planned.map((p) => `${p.plan} increment ${p.inc}`))];
  if (plans.length) facts.push(`planned in ${plans.join(", ")}`);
  return {
    from: "Radar",
    chip: w.branch ? `${w.title} · ${w.branch}` : w.title,
    facts,
    suggest: `Where does ${w.title} stand against main, and is anyone else touching its files?`,
  };
}

/** A Lookout review (a review job, a terminal review, or a PR no review covers). */
export function reviewAsk(r: {
  title: string; repo?: string; branch?: string; root?: string; pr?: number | null; url?: string | null; state?: string; open?: Record<string, number>;
}): AskContext {
  const facts = [`Lookout review ${r.title}`];
  if (r.repo) facts.push(`repo ${r.repo}`);
  if (r.branch) facts.push(`branch ${r.branch}`);
  if (r.root) facts.push(`worktree ${tilde(r.root)}`);
  if (r.pr) facts.push(`PR #${r.pr}${r.url ? ` (${r.url})` : ""}${r.state ? `, ${r.state}` : ""}`);
  else if (r.url) facts.push(r.url);
  const open = Object.entries(r.open ?? {}).filter(([, n]) => n > 0);
  if (r.open) facts.push(open.length ? `open findings: ${open.map(([s, n]) => `${n} ${s}`).join(", ")}` : "no open findings");
  return {
    from: "Lookout",
    // A title that already names its PR ("shop · PR #41") is not told it twice.
    chip: r.pr && !r.title.includes(`#${r.pr}`) ? `${r.title} · PR #${r.pr}` : !r.pr && r.branch ? `${r.title} · ${r.branch}` : r.title,
    facts,
    suggest: r.pr ? `What's the state of PR #${r.pr}: its checks, its reviews, and what is left before it merges?` : "What's the state of this change, and what is left before it can merge?",
  };
}

/** The queued text: the question, then its context as one short line. A
 *  PR title or branch from outside may hold newlines; each fact is kept to
 *  one line so nothing in it reads as a line of its own. */
export function askText(ctx: AskContext, question: string): string {
  const q = question.trim();
  const facts = ctx.facts.map((f) => f.replace(/\s+/g, " ").trim()).filter(Boolean);
  return `${q}\n\nContext (asked from the app's ${ctx.from}): ${facts.join("; ")}.`;
}

/** Where a source opens: a URL, a file at a line, or nowhere (a query's text, a ticket key). */
export type Target = { url: string } | { path: string; line?: number } | null;

/** A file source the Bosun wrote from the code root (`shop/app/retry.rb:42`,
 *  bosun/references/answers.md) opens under `root`; an absolute one as is. */
export function sourceTarget(s: Source, root = ""): Target {
  const r = s.ref.trim();
  if (/^https?:\/\//.test(r)) return { url: r };
  const m = /^(\/[^:]+)(?::(\d+))?(?::\d+)?$/.exec(r);
  if (m) return m[2] ? { path: m[1], line: Number(m[2]) } : { path: m[1] };
  // Relative: no spaces (a query has them), a folder in it (a key or a name has none), no scheme.
  const rel = /^([\w.@-][^\s:]*\/[^\s:]+)(?::(\d+))?(?::\d+)?$/.exec(r);
  // A ".." step would leave the code root: such a ref opens nowhere.
  if (rel && root && (s.kind || "file").toLowerCase() === "file" && !rel[1].split("/").includes("..")) {
    const path = `${root.replace(/\/$/, "")}/${rel[1].replace(/^\.\//, "")}`;
    return rel[2] ? { path, line: Number(rel[2]) } : { path };
  }
  return null;
}
