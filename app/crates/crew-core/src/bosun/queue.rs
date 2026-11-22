//! The Bosun's queue and its answers.
//!
//! ```text
//! <bosun>/queue/<at ms, 13 digits>-<id>.json   {id, at, text, source}
//! <bosun>/answers/<id>.md                       an ask's answer
//! ```
//!
//! Anyone may enqueue (a workspace's `seamux bosun ask`, a loop, the app).
//! The supervisor types the oldest item into the Bosun each time it goes
//! idle, then removes it. An answer is written only by `seamux bosun answer`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// One queued prompt.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    /// Milliseconds since the epoch it was queued.
    pub at: u64,
    pub text: String,
    /// Who queued it: `ask:<who>`, `send`, `loop:<id>`, `app`.
    pub source: String,
    /// The file it is in.
    pub path: PathBuf,
}

pub fn queue_dir(dir: &Path) -> PathBuf {
    dir.join("queue")
}

pub fn answers_dir(dir: &Path) -> PathBuf {
    dir.join("answers")
}

/// An id that is safe as a file name: letters, digits and dashes.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("no folder")?;
    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".{}.{}.tmp", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), std::process::id()));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Queue `text` from `source` with id `id`: the item.
pub fn enqueue_as(dir: &Path, id: &str, text: &str, source: &str) -> Result<Item, String> {
    if !valid_id(id) {
        return Err(format!("not an id: {id:?}"));
    }
    if text.trim().is_empty() {
        return Err("nothing to queue".into());
    }
    let at = crate::history::now_ms();
    let path = queue_dir(dir).join(format!("{at:013}-{id}.json"));
    write_atomic(&path, &json!({"id": id, "at": at, "text": text, "source": source}).to_string())?;
    Ok(Item { id: id.into(), at, text: text.into(), source: source.into(), path })
}

/// Queue `text` from `source` under a new id: the item.
pub fn enqueue(dir: &Path, text: &str, source: &str) -> Result<Item, String> {
    enqueue_as(dir, &crate::backend::tmux::new_id().to_ascii_lowercase(), text, source)
}

fn read_item(path: &Path) -> Option<Item> {
    let v: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some(Item { id: s("id"), at: v.get("at").and_then(Value::as_u64).unwrap_or(0), text: s("text"), source: s("source"), path: path.to_path_buf() })
        .filter(|i| valid_id(&i.id) && !i.text.trim().is_empty())
}

/// The items still waiting, oldest first. A file that can't be read is
/// skipped (and left for a person to look at).
pub fn waiting(dir: &Path) -> Vec<Item> {
    let mut names: Vec<PathBuf> = fs::read_dir(queue_dir(dir))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json") && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .collect();
    names.sort();
    names.iter().filter_map(|p| read_item(p)).collect()
}

/// The item has been typed: it leaves the queue.
pub fn done(item: &Item) {
    let _ = fs::remove_file(&item.path);
}

/// Write the answer to ask `id`.
pub fn answer(dir: &Path, id: &str, text: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("not an id: {id:?}"));
    }
    if text.trim().is_empty() {
        return Err("an empty answer".into());
    }
    let path = answers_dir(dir).join(format!("{id}.md"));
    write_atomic(&path, text)?;
    Ok(path)
}

/// Wait up to `timeout` for ask `id`'s answer: its text, or None.
pub fn wait_answer(dir: &Path, id: &str, timeout: Duration) -> Option<String> {
    let path = answers_dir(dir).join(format!("{id}.md"));
    let start = Instant::now();
    loop {
        if let Ok(t) = fs::read_to_string(&path) {
            return Some(t);
        }
        if start.elapsed() >= timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(500).min(timeout.saturating_sub(start.elapsed())));
    }
}

/// The prompt an ask puts in front of the Bosun.
pub fn ask_prompt(id: &str, who: &str, question: &str, seamux: &str) -> String {
    let q = crate::native::sh_quote(seamux);
    format!(
        "[Ask {id} from {who}]\n{question}\n\n\
Answer it, saying where each fact comes from. Then send the answer back with `{q} bosun answer {id}` (the answer on stdin), \
and log it with `{q} bosun log add` (one JSON entry on stdin: question, answer, sources [{{kind, ref, label}}], asker \"{who}\", id \"{id}\")."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bosun-queue-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn items_wait_oldest_first_and_leave_when_done() {
        let d = tmp("order");
        let a = enqueue_as(&d, "a1", "first", "send").unwrap();
        std::thread::sleep(Duration::from_millis(3));
        enqueue_as(&d, "b2", "second", "loop:daily").unwrap();
        let w = waiting(&d);
        assert_eq!(w.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["a1", "b2"]);
        assert_eq!(w[1].source, "loop:daily");
        done(&a);
        assert_eq!(waiting(&d).len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn bad_ids_and_empty_text_are_refused() {
        let d = tmp("bad");
        assert!(enqueue_as(&d, "../x", "t", "send").is_err());
        assert!(enqueue(&d, "  ", "send").is_err());
        assert!(answer(&d, "a/b", "x").is_err());
        assert!(answer(&d, "ok-1", " ").is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_answer_is_waited_for() {
        let d = tmp("ans");
        assert_eq!(wait_answer(&d, "q1", Duration::from_millis(50)), None);
        answer(&d, "q1", "it is 42").unwrap();
        assert_eq!(wait_answer(&d, "q1", Duration::from_millis(50)).as_deref(), Some("it is 42"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_ask_prompt_names_the_id_and_how_to_answer() {
        let p = ask_prompt("q1", "ws shop", "is X true?", "/bin/seamux");
        assert!(p.starts_with("[Ask q1 from ws shop]\nis X true?"));
        assert!(p.contains("/bin/seamux bosun answer q1") && p.contains("bosun log add"));
    }
}
