//! What the Bosun keeps across a compaction.
//!
//! ```text
//! seamux bosun precompact   the PreCompact hook: its stdout is the summary's instructions
//! seamux bosun recall       SessionStart, matcher compact: the same index, as fresh context
//! ```
//!
//! Both read one index: the answers logged since the conversation's day
//! began (each one's id, question and sources), the prompts still waiting
//! in the queue, and each loop's last run and what it found. Claude Code
//! cuts a hook's output at 10,000 characters, so the index gives way first,
//! oldest answers before newer ones, and the instructions never get cut.

use std::path::Path;

use serde_json::Value;

use super::{log, loops, queue};

/// The most a hook prints: under Claude Code's 10,000-character cap, with room to spare.
pub const LIMIT: usize = 9_500;

/// What the summary is told to keep, ahead of the index.
pub const KEEP: &str = "\
Instructions for this summary. You are the Bosun: one long-running, read-only session that answers \
questions across the code root and logs each answer. Keep these, in this order:
1. Open threads: questions asked and not yet answered, follow-ups you said you would do, and anything a person asked you to watch.
2. The sources behind every answer: for each answer id below, the sources exactly as you cited them (file:line, command, query, ticket, dashboard or link). Shorten the wording before you drop a source.
3. Loop results: what each loop's last run found, and what changed since the run before it.
4. The person's standing preferences and corrections.
Drop tool output already folded into an answer, and the full text of logged answers: `seamux bosun log list` keeps them.
";

fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// One answer, as the index shows it.
fn answer_lines(e: &Value) -> String {
    let asker = s(e, "asker");
    let mut out = format!("- {}{}: {}\n", s(e, "id"), if asker.is_empty() { String::new() } else { format!(" ({asker})") }, one_line(s(e, "question"), 200));
    let sources: Vec<String> = e
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|x| {
            let (kind, r, label) = (s(x, "kind"), one_line(s(x, "ref"), 200), s(x, "label"));
            let k = if kind.is_empty() { String::new() } else { format!("{kind} ") };
            if label.is_empty() { format!("{k}{r}") } else { format!("{k}{r} ({})", one_line(label, 60)) }
        })
        .collect();
    out.push_str(&format!("  sources: {}\n", if sources.is_empty() { "none cited".to_string() } else { sources.join("; ") }));
    out
}

/// The parts of the index, each a list of lines-blocks so the oldest can go first.
pub struct Index {
    /// Answers, oldest first.
    pub answers: Vec<String>,
    /// Queued prompts, oldest first.
    pub queued: Vec<String>,
    /// One block per loop.
    pub loops: Vec<String>,
}

/// The answers logged since `since` (the conversation's day, YYYY-MM-DD;
/// "" means `today` only), oldest first.
fn answers_since(dir: &Path, since: &str, today: &str) -> Vec<Value> {
    let from = if since.is_empty() || since > today { today } else { since };
    let mut days: Vec<String> = log::days(dir).into_iter().filter(|d| d.as_str() >= from && d.as_str() <= today).collect();
    days.sort();
    days.iter().flat_map(|d| log::list(dir, d).unwrap_or_default()).collect()
}

fn when(secs: i64, today: &str) -> String {
    let l = loops::local(secs);
    let hm = format!("{:02}:{:02}", l.minute / 60, l.minute % 60);
    if l.day == today { hm } else { format!("{} {hm}", l.day) }
}

/// The day the Bosun's conversation began: the later of state.json's day
/// and the day the supervisor last typed /clear, as the supervisor reads it.
pub fn conversation_day(dir: &Path) -> String {
    super::supervise::later_day(&super::launch::State::load(dir).day, &super::supervise::read_reset_day(dir))
}

/// The index of `dir` as of `today`, for a conversation that began on `since`.
pub fn index(dir: &Path, since: &str, today: &str) -> Index {
    let answers = answers_since(dir, since, today);
    let waiting = queue::waiting(dir);
    let queued = waiting
        .iter()
        .map(|i| format!("- {} ({}): {}\n", i.id, i.source, one_line(i.text.lines().find(|l| !l.trim().is_empty() && !l.starts_with('[')).unwrap_or(&i.text), 160)))
        .collect();
    let mut state = loops::state(dir);
    state.sort_by(|a, b| a.0.cmp(&b.0));
    let loops = state
        .into_iter()
        .filter(|(_, l)| !l.queued.is_empty())
        .map(|(id, l)| {
            let src = format!("loop:{id}");
            // This run's answer: logged under its item id, or as the loop's
            // asker after the run was queued. An older run's answer is not it.
            let since_run = (l.last.max(0) as u64) * 1000;
            let found = answers
                .iter()
                .rev()
                .find(|e| s(e, "id") == l.queued || (s(e, "asker") == src && e.get("at").and_then(Value::as_u64).unwrap_or(0) >= since_run));
            let what = match found {
                Some(e) => format!("answered as {}: {}", s(e, "id"), one_line(s(e, "answer"), 300)),
                None if waiting.iter().any(|i| i.id == l.queued) => "still waiting in the queue".to_string(),
                None => "no answer logged yet".to_string(),
            };
            format!("- {id}, last run {}: {what}\n", when(l.last, today))
        })
        .collect();
    Index { answers: answers.iter().map(answer_lines).collect(), queued, loops }
}

/// The index under `head`, oldest answers (then oldest queued prompts)
/// dropped until it fits in `limit` characters with `head`. Empty when
/// there is nothing to show.
pub fn render(head: &str, ix: &Index, limit: usize) -> String {
    let mut answers: Vec<&String> = ix.answers.iter().collect();
    let mut queued: Vec<&String> = ix.queued.iter().collect();
    let loops: Vec<&String> = ix.loops.iter().collect();
    let (mut dropped_a, mut dropped_q) = (0, 0);
    // A first cut, counted once: drop the oldest answers until the rest
    // would fit, with room for the headings and the left-out line. The loop
    // below then settles the exact text.
    let len = |v: &[&String]| v.iter().map(|x| x.chars().count()).sum::<usize>();
    let room = limit.saturating_sub(head.chars().count() + len(&queued) + len(&loops) + 400);
    let mut total = len(&answers);
    while total > room && !answers.is_empty() {
        total -= answers.remove(0).chars().count();
        dropped_a += 1;
    }
    loop {
        let mut out = String::from(head);
        if !answers.is_empty() || dropped_a > 0 {
            out.push_str("\nAnswers in this conversation (id, asker, question, sources):\n");
            if dropped_a > 0 {
                out.push_str(&format!("({dropped_a} older answers left out; `seamux bosun log list` has them)\n"));
            }
            answers.iter().for_each(|a| out.push_str(a));
        }
        if !queued.is_empty() || dropped_q > 0 {
            out.push_str("\nStill waiting in the queue (typed in as you go idle):\n");
            if dropped_q > 0 {
                out.push_str(&format!("({dropped_q} older prompts left out)\n"));
            }
            queued.iter().for_each(|q| out.push_str(q));
        }
        if !loops.is_empty() {
            out.push_str("\nLoops (bosun.json), last run and what it found:\n");
            loops.iter().for_each(|l| out.push_str(l));
        }
        if out.chars().count() <= limit {
            return if out == head { String::new() } else { out };
        }
        if !answers.is_empty() {
            answers.remove(0);
            dropped_a += 1;
        } else if !queued.is_empty() {
            queued.remove(0);
            dropped_q += 1;
        } else {
            // Only the head and the loops are left: cut the loops' end.
            let cut: String = out.chars().take(limit.saturating_sub(1)).collect();
            return format!("{cut}…");
        }
    }
}

/// The PreCompact hook's stdout for `payload` (its JSON on stdin).
pub fn precompact(payload: &str, dir: &Path, since: &str, today: &str) -> String {
    let v: Value = serde_json::from_str(payload).unwrap_or_default();
    let mut head = String::from(KEEP);
    // A person's own /compact text, repeated here so it holds whether this
    // output is added to it or takes its place.
    let asked = s(&v, "custom_instructions").trim();
    if !asked.is_empty() {
        head.push_str(&format!("\nThe person also asked, when compacting: {}\n", one_line(asked, 1500)));
    }
    let out = render(&head, &index(dir, since, today), LIMIT);
    if out.is_empty() { head } else { out }
}

/// The SessionStart (compact) hook's stdout: the index again, as context.
pub fn recall(dir: &Path, since: &str, today: &str) -> String {
    render("The conversation was just compacted. What the Bosun has done and still owes, from its log and queue:\n", &index(dir, since, today), LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bosun-compact-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("log")).unwrap();
        d
    }

    fn line(id: &str, q: &str, asker: &str, refs: &[&str]) -> String {
        let sources: Vec<Value> = refs.iter().map(|r| json!({"kind": "file", "ref": r, "label": ""})).collect();
        json!({"id": id, "at": 1, "question": q, "answer": format!("answer to {q}"), "sources": sources, "asker": asker}).to_string() + "\n"
    }

    #[test]
    fn the_index_names_answers_sources_queue_and_loops() {
        let d = tmp("ix");
        fs::write(d.join("log/2026-11-23.jsonl"), line("a1", "is X on?", "ws shop", &["app/x.rs:12"]) + &line("l1", "sitrep", "loop:checkin", &[])).unwrap();
        fs::write(d.join("loops-state.json"), json!({"checkin": {"last": 1_795_000_000, "slot": "", "queued": "l1"}, "prs": {"last": 1_795_000_000, "slot": "", "queued": "q9"}}).to_string()).unwrap();
        queue::enqueue_as(&d, "q9", "[Loop prs]\nlist my PRs\n\nAnswer it…", "loop:prs").unwrap();
        let out = precompact(r#"{"trigger":"auto","custom_instructions":null}"#, &d, "2026-11-23", "2026-11-23");
        assert!(out.starts_with(KEEP));
        assert!(out.contains("- a1 (ws shop): is X on?\n  sources: file app/x.rs:12\n"), "{out}");
        assert!(out.contains("- l1 (loop:checkin): sitrep\n  sources: none cited"));
        assert!(out.contains("- q9 (loop:prs): list my PRs"));
        assert!(out.contains("- checkin, last run") && out.contains("answered as l1: answer to sitrep"));
        assert!(out.contains("- prs, last run") && out.contains("still waiting in the queue"));
        assert!(!out.contains("asked, when compacting"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_older_runs_answer_is_not_the_newest_runs() {
        let d = tmp("stale");
        // The 09:30 run (item r1) was answered; the 14:00 run (item r2) was typed but not yet logged.
        let morning = json!({"id": "r1", "at": 1_000_000, "question": "my PRs", "answer": "two PRs", "sources": [], "asker": "loop:my-prs"}).to_string();
        fs::write(d.join("log/2026-11-23.jsonl"), morning + "\n").unwrap();
        fs::write(d.join("loops-state.json"), json!({"my-prs": {"last": 2_000, "slot": "2026-11-23 14:00", "queued": "r2"}}).to_string()).unwrap();
        let ix = index(&d, "2026-11-23", "2026-11-23").loops.join("");
        assert!(ix.contains("no answer logged yet") && !ix.contains("answered as r1"), "{ix}");
        // Logged as the loop's asker after the run, under another id: that is this run's answer.
        let later = json!({"id": "x9", "at": 2_000_500, "question": "my PRs", "answer": "three PRs", "sources": [], "asker": "loop:my-prs"}).to_string();
        fs::write(d.join("log/2026-11-23.jsonl"), fs::read_to_string(d.join("log/2026-11-23.jsonl")).unwrap() + &later + "\n").unwrap();
        assert!(index(&d, "2026-11-23", "2026-11-23").loops.join("").contains("answered as x9: three PRs"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_conversations_day_is_the_later_of_state_and_the_reset() {
        let d = tmp("day");
        super::super::launch::State { session: "s".into(), day: "2026-11-22".into() }.save(&d).unwrap();
        assert_eq!(conversation_day(&d), "2026-11-22");
        // The supervisor typed /clear this morning; prime has not rewritten state.json yet.
        fs::write(d.join("reset-day"), "2026-11-23").unwrap();
        assert_eq!(conversation_day(&d), "2026-11-23");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_persons_compact_text_is_kept() {
        let d = tmp("ask");
        let out = precompact(r#"{"trigger":"manual","custom_instructions":"keep the Snowflake numbers"}"#, &d, "", "2026-11-23");
        assert!(out.starts_with(KEEP) && out.contains("The person also asked, when compacting: keep the Snowflake numbers"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn answers_since_the_conversations_day_and_not_before() {
        let d = tmp("days");
        fs::write(d.join("log/2026-11-21.jsonl"), line("old", "old q", "", &[])).unwrap();
        fs::write(d.join("log/2026-11-22.jsonl"), line("y1", "late q", "", &[])).unwrap();
        fs::write(d.join("log/2026-11-23.jsonl"), line("t1", "today q", "", &[])).unwrap();
        let ids = |since: &str| index(&d, since, "2026-11-23").answers.join("");
        let after_midnight = ids("2026-11-22");
        assert!(after_midnight.contains("y1") && after_midnight.contains("t1") && !after_midnight.contains("old"));
        assert!(!ids("").contains("y1"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn oldest_answers_give_way_to_fit_and_the_keep_list_stays() {
        let d = tmp("trim");
        let mut text = String::new();
        for i in 0..200 {
            text.push_str(&line(&format!("e{i:03}"), &format!("question number {i} {}", "x".repeat(60)), "", &["some/long/path/to/a/file.rs:120"]));
        }
        fs::write(d.join("log/2026-11-23.jsonl"), text).unwrap();
        let out = precompact("{}", &d, "2026-11-23", "2026-11-23");
        assert!(out.chars().count() <= LIMIT);
        assert!(out.starts_with(KEEP));
        assert!(out.contains("- e199:") && !out.contains("- e000:"), "the newest stay");
        assert!(out.contains("older answers left out"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn recall_is_empty_with_nothing_to_say() {
        let d = tmp("empty");
        assert_eq!(recall(&d, "", "2026-11-23"), "");
        assert_eq!(precompact("", &d, "", "2026-11-23"), KEEP);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn long_text_is_cut_on_a_character() {
        assert_eq!(one_line("a  b\n c", 10), "a b c");
        assert_eq!(one_line("ééééé", 3), "éé…");
    }
}
