//! The app's watch on lookout reviews' pull requests (plan lookout-pr-window).
//! Every EVERY it asks lookout to sync each review linked to an open PR
//! (`lookout gh sync`, which owns every GitHub read and its own rate floor),
//! then holds what GitHub says against what it saw last: a comment by
//! someone other than you, or a check that went red on the PR's head, is a
//! banner whose click opens that review in the Lookout tab on that item.
//!
//! A review whose branch has no link yet is asked about while it is fresh
//! (LINK_WINDOW), so a session's or deep-plan's review links without anyone
//! opening its page. The first look at a review only learns what is there.
//! Banners go out on the tmux backend only (ADR 0050); syncing runs on both.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crew_core::backend::Kind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::notify_app::{self, NoteKind};

pub const EVERY: Duration = Duration::from_secs(120);
/// A linked review untouched this long is left alone (lookout's own rule too).
pub const IDLE_SECS: u64 = 14 * 24 * 3600;
/// An unlinked review is asked about for this long after its last change.
pub const LINK_WINDOW_SECS: u64 = 2 * 24 * 3600;
const SYNC_LIMIT: Duration = Duration::from_secs(90);

/// What the watch last saw on one review's PR.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Seen {
    pub pr: u64,
    pub comments: BTreeSet<u64>,
    /// The checks failing on the head, as "<name>@<head>".
    pub failing: BTreeSet<String>,
}

/// One banner's worth of news.
#[derive(Clone, Debug, PartialEq)]
pub struct News {
    pub kind: NoteKind,
    pub title: String,
    pub body: String,
    pub item: String,
}

fn clip(s: &str, n: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n { one } else { format!("{}…", one.chars().take(n - 1).collect::<String>()) }
}

/// What changed on a review's PR since `seen`, and what to remember now.
/// `seen` None (or another PR) only learns: nothing is news on a first look.
pub fn news(title: &str, seen: Option<&Seen>, g: &Value) -> (Vec<News>, Seen) {
    let pr = g.get("pr").and_then(Value::as_u64).unwrap_or(0);
    let head = g.get("head").and_then(Value::as_str).unwrap_or("");
    let viewer = g.get("viewer").and_then(Value::as_str).unwrap_or("");
    let mut now = Seen { pr, ..Default::default() };
    let mut fresh: Vec<(String, String, u64)> = Vec::new();
    for t in g.get("threads").and_then(Value::as_array).into_iter().flatten() {
        for c in t.get("comments").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = c.get("id").and_then(Value::as_u64) else { continue };
            now.comments.insert(id);
            let who = c.get("author").and_then(Value::as_str).unwrap_or("");
            // Without the viewer's login your own comments cannot be told
            // apart: they are learned, and none is announced.
            let mine = viewer.is_empty() || who.eq_ignore_ascii_case(viewer);
            if !mine && seen.is_some_and(|s| s.pr == pr && !s.comments.contains(&id)) {
                fresh.push((who.to_string(), c.get("body").and_then(Value::as_str).unwrap_or("").to_string(), id));
            }
        }
    }
    let mut red: Vec<String> = Vec::new();
    for c in g.get("checks").and_then(Value::as_array).into_iter().flatten() {
        // A cancelled run (a newer push cancelled it) needs no fixing: only "fail" is red.
        if c.get("bucket").and_then(Value::as_str) != Some("fail") {
            continue;
        }
        let name = c.get("name").and_then(Value::as_str).unwrap_or("");
        let key = format!("{name}@{head}");
        if seen.is_some_and(|s| s.pr == pr && !s.failing.contains(&key)) {
            red.push(name.to_string());
        }
        now.failing.insert(key);
    }
    let mut out = Vec::new();
    if let Some((who, body, id)) = fresh.first() {
        let (t, b) = if fresh.len() == 1 {
            (format!("{title} · {who} commented on PR #{pr}"), clip(body, 160))
        } else {
            let names: BTreeSet<&str> = fresh.iter().map(|f| f.0.as_str()).collect();
            (format!("{title} · {} new comments on PR #{pr}", fresh.len()), names.into_iter().collect::<Vec<_>>().join(", "))
        };
        out.push(News { kind: NoteKind::Comment, title: t, body: b, item: format!("c{id}") });
    }
    if !red.is_empty() {
        let t = if red.len() == 1 { format!("{title} · a check failed on PR #{pr}") } else { format!("{title} · {} checks failed on PR #{pr}", red.len()) };
        out.push(News { kind: NoteKind::CiFailed, title: t, body: clip(&red.join(", "), 160), item: "checks".into() });
    }
    (out, now)
}

/// Whether the watch syncs this review now: linked to an open PR and
/// touched within IDLE_SECS, or unlinked with a branch and fresh.
pub fn wanted(d: &Value, now: u64) -> bool {
    let updated = crate::review_app::iso_secs(d.get("updatedAt").and_then(Value::as_str).unwrap_or(""));
    let age = now.saturating_sub(updated);
    match d.get("github").filter(|g| g.get("pr").and_then(Value::as_u64).is_some()) {
        Some(g) => g.get("state").and_then(Value::as_str).unwrap_or("OPEN") == "OPEN" && age < IDLE_SECS,
        None => {
            let src = d.get("source");
            let kind = src.and_then(|s| s.get("kind")).and_then(Value::as_str).unwrap_or("");
            let branch = src.and_then(|s| s.get("branch")).and_then(Value::as_str).unwrap_or("");
            kind != "patch" && !branch.is_empty() && age < LINK_WINDOW_SECS
        }
    }
}

fn seen_file() -> PathBuf {
    crate::review_app::base_dir().join("pr-watch.json")
}
fn read_seen(p: &Path) -> BTreeMap<String, Seen> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
fn write_seen(p: &Path, all: &BTreeMap<String, Seen>) {
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

fn read(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// How many reviews sync at once: one slow gh must not hold every banner back.
const AT_ONCE: usize = 4;

/// One pass over the reviews dir: sync the wanted reviews, AT_ONCE at a
/// time, then hold each against what was seen. A review's seen state is
/// saved before its banners go out, so a quit mid-pass never repeats one.
fn tick(app: &AppHandle) {
    let dir = crew_board::review::reviews_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let ids: Vec<String> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?.to_string();
            let skip = !seamux_app::review::id_ok(&id) || id.ends_with(".rows") || id.ends_with(".seen") || id.ends_with(".incoming") || id.starts_with("wake-");
            (!skip && read(&e.path()).is_some_and(|d| wanted(&d, now))).then_some(id)
        })
        .collect();
    for batch in ids.chunks(AT_ONCE) {
        std::thread::scope(|sc| {
            for id in batch {
                sc.spawn(move || crate::review_app::exec("lookout", &["gh", "sync", id, "--json"], None, None, SYNC_LIMIT));
            }
        });
    }
    let file = seen_file();
    let mut seen = read_seen(&file);
    let banners = seamux_app::backend::kind() == Kind::Tmux;
    for id in &ids {
        let Some(d) = read(&dir.join(format!("{id}.json"))) else { continue };
        let Some(g) = d.get("github").filter(|g| g.get("pr").and_then(Value::as_u64).is_some()) else { continue };
        let title = d.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or(id);
        let (found, next) = news(title, seen.get(id), g);
        if seen.get(id) == Some(&next) {
            continue;
        }
        seen.insert(id.clone(), next);
        write_seen(&file, &seen);
        if banners {
            for n in found {
                notify_app::post_review(app, &notify_app::review_note(n.kind, n.title, n.body, id, &n.item));
            }
        }
    }
    // Forget reviews that are gone.
    let before = seen.len();
    seen.retain(|id, _| dir.join(format!("{id}.json")).exists());
    if seen.len() != before {
        write_seen(&file, &seen);
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            tick(&app);
            std::thread::sleep(EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn g(comments: &[(u64, &str)], failing: &[&str], head: &str) -> Value {
        json!({
            "pr": 7, "head": head, "viewer": "me",
            "threads": [{"comments": comments.iter().map(|(id, who)| json!({"id": id, "author": who, "body": "why?"})).collect::<Vec<_>>()}],
            "checks": failing.iter().map(|n| json!({"name": n, "bucket": "fail"})).chain([json!({"name": "ok", "bucket": "pass"})]).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn a_first_look_only_learns() {
        let (n, s) = news("r", None, &g(&[(1, "alice")], &["test"], "h1"));
        assert!(n.is_empty());
        assert!(s.comments.contains(&1) && s.failing.contains("test@h1"));
    }

    #[test]
    fn a_comment_from_someone_else_is_news_and_names_its_comment() {
        let (_, s) = news("r", None, &g(&[(1, "alice")], &[], "h1"));
        let (n, _) = news("r", Some(&s), &g(&[(1, "alice"), (2, "bob"), (3, "me")], &[], "h1"));
        assert_eq!(n.len(), 1);
        assert_eq!((n[0].kind, n[0].item.as_str()), (NoteKind::Comment, "c2"));
        assert!(n[0].title.contains("bob commented on PR #7"), "{}", n[0].title);
    }

    #[test]
    fn your_own_comments_are_not_news() {
        let (_, s) = news("r", None, &g(&[], &[], "h1"));
        let (n, _) = news("r", Some(&s), &g(&[(5, "ME")], &[], "h1"));
        assert!(n.is_empty());
    }

    #[test]
    fn several_new_comments_are_one_banner() {
        let (_, s) = news("r", None, &g(&[], &[], "h1"));
        let (n, _) = news("r", Some(&s), &g(&[(2, "bob"), (3, "carol")], &[], "h1"));
        assert_eq!(n.len(), 1);
        assert!(n[0].title.contains("2 new comments") && n[0].body == "bob, carol", "{:?}", n[0]);
    }

    #[test]
    fn a_check_going_red_is_news_once_per_head_and_again_after_a_pass() {
        let (_, s) = news("r", None, &g(&[], &[], "h1"));
        let (n, s) = news("r", Some(&s), &g(&[], &["test"], "h1"));
        assert_eq!((n.len(), n[0].kind, n[0].item.as_str()), (1, NoteKind::CiFailed, "checks"));
        let (n, s) = news("r", Some(&s), &g(&[], &["test"], "h1"));
        assert!(n.is_empty(), "still red is not news");
        let (n, s) = news("r", Some(&s), &g(&[], &["test"], "h2"));
        assert_eq!(n.len(), 1, "red on a new head is");
        let (_, s) = news("r", Some(&s), &g(&[], &[], "h2"));
        let (n, _) = news("r", Some(&s), &g(&[], &["test"], "h2"));
        assert_eq!(n.len(), 1, "red again after a rerun passed");
    }

    #[test]
    fn a_cancelled_check_is_not_red() {
        let (_, s) = news("r", None, &g(&[], &[], "h1"));
        let mut v = g(&[], &[], "h1");
        v["checks"] = json!([{"name": "test", "bucket": "cancel"}]);
        assert!(news("r", Some(&s), &v).0.is_empty());
    }

    #[test]
    fn without_the_viewer_no_comment_is_news() {
        let (_, s) = news("r", None, &g(&[], &[], "h1"));
        let mut v = g(&[(9, "me")], &["test"], "h1");
        v["viewer"] = json!("");
        let (n, next) = news("r", Some(&s), &v);
        assert_eq!(n.iter().map(|x| x.kind).collect::<Vec<_>>(), vec![NoteKind::CiFailed]);
        assert!(next.comments.contains(&9));
    }

    #[test]
    fn another_pr_starts_over() {
        let (_, mut s) = news("r", None, &g(&[(1, "a")], &[], "h1"));
        s.pr = 3;
        let (n, _) = news("r", Some(&s), &g(&[(1, "a"), (2, "b")], &["x"], "h1"));
        assert!(n.is_empty());
    }

    #[test]
    fn the_watch_syncs_open_fresh_linked_reviews_and_fresh_branches() {
        let now = crate::review_app::iso_secs("2026-11-10T00:00:00Z");
        let (fresh, days3, days15) = ("2026-11-09T23:59:00Z", "2026-11-07T00:00:00Z", "2026-10-26T00:00:00Z");
        assert!(wanted(&json!({"updatedAt": fresh, "github": {"pr": 1, "state": "OPEN"}}), now));
        assert!(wanted(&json!({"updatedAt": days3, "github": {"pr": 1, "state": "OPEN"}}), now));
        assert!(!wanted(&json!({"updatedAt": fresh, "github": {"pr": 1, "state": "MERGED"}}), now));
        assert!(!wanted(&json!({"updatedAt": days15, "github": {"pr": 1, "state": "OPEN"}}), now));
        assert!(wanted(&json!({"updatedAt": fresh, "source": {"kind": "base", "branch": "b"}}), now));
        assert!(!wanted(&json!({"updatedAt": days3, "source": {"kind": "base", "branch": "b"}}), now));
        assert!(!wanted(&json!({"updatedAt": fresh, "source": {"kind": "patch", "branch": "b"}}), now));
    }
}
