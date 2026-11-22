// The Bosun tab's model (bosun.ts draws it): the answer rail's day groups
// and cards, the whistle's mood, and what ⌘B does. A pure module, so
// bosun_probe.ts runs it in Node.

/** One source behind an answer, as `seamux bosun log add` keeps it. */
export type Source = { kind: string; ref: string; label: string };
/** One answer log entry (crew_core::bosun::log). `at` is ms since the epoch. */
export type Entry = { id: string; at: number; question: string; answer: string; sources: Source[]; asker: string };
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
export type Card = { id: string; time: string; from: string; question: string; first: string; chips: Chip[]; entry: Entry };
/** One chip per source kind, with how many of that kind. */
export type Chip = { kind: string; label: string; n: number };

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

/** The answer's first line that says something, cut to `max` characters. */
export function firstLine(answer: string, max = 120): string {
  const line = answer.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

/** Short names for the source kinds the Bosun's skills write; others keep their own. */
const KIND_LABEL: Record<string, string> = {
  file: "file", github: "gh", gh: "gh", pr: "gh", jira: "jira", ticket: "jira",
  snowflake: "sql", query: "sql", sql: "sql", datadog: "dd", dashboard: "dash", splunk: "splunk",
  workspace: "ws", url: "link", link: "link",
};

/** One chip per source kind, in the order they first appear. */
export function chips(sources: Source[]): Chip[] {
  const out: Chip[] = [];
  for (const s of sources) {
    const kind = (s.kind || "link").toLowerCase();
    const label = KIND_LABEL[kind] ?? kind;
    const have = out.find((c) => c.label === label);
    if (have) have.n++;
    else out.push({ kind, label, n: 1 });
  }
  return out;
}

/** "10:42" in local time. */
export function clock(at: number, tz?: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
}

/** Who asked, for the card's top line: a workspace's name, a loop, or the app. */
export function fromLabel(asker: string): string {
  const a = asker.trim();
  if (!a) return "";
  if (a === "app") return "from the app";
  if (a.startsWith("loop:")) return `loop ${a.slice(5)}`;
  if (a.startsWith("ask:")) return `from ${a.slice(4)}`;
  return `from ${a}`;
}

export function card(e: Entry, tz?: string): Card {
  return {
    id: e.id, time: clock(e.at, tz), from: fromLabel(e.asker), question: e.question.trim(),
    first: firstLine(e.answer), chips: chips(e.sources ?? []), entry: e,
  };
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

/** The whistle: resting, piping while the Bosun works, or one trill for a new answer. */
export type Mood = "rest" | "pipe" | "trill";

export function mood(state: string | undefined, fresh: boolean): Mood {
  if (fresh) return "trill";
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

/** ~ for the home folder in a path. */
export function tilde(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
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

/** The queued text: the question, then its context as one short line. */
export function askText(ctx: AskContext, question: string): string {
  const q = question.trim();
  return `${q}\n\nContext (asked from the app's ${ctx.from}): ${ctx.facts.join("; ")}.`;
}

/** Where a source opens: a URL, an absolute file at a line, or nowhere (a query's text, a ticket key). */
export type Target = { url: string } | { path: string; line?: number } | null;

export function sourceTarget(s: Source): Target {
  const r = s.ref.trim();
  if (/^https?:\/\//.test(r)) return { url: r };
  const m = /^(\/[^:]+)(?::(\d+))?(?::\d+)?$/.exec(r);
  if (m) return m[2] ? { path: m[1], line: Number(m[2]) } : { path: m[1] };
  return null;
}
