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

/** Where a source opens: a URL, an absolute file at a line, or nowhere (a query's text, a ticket key). */
export type Target = { url: string } | { path: string; line?: number } | null;

export function sourceTarget(s: Source): Target {
  const r = s.ref.trim();
  if (/^https?:\/\//.test(r)) return { url: r };
  const m = /^(\/[^:]+)(?::(\d+))?(?::\d+)?$/.exec(r);
  if (m) return m[2] ? { path: m[1], line: Number(m[2]) } : { path: m[1] };
  return null;
}
