//! Create adapter: the prompt for a new session that writes an adapter for
//! background work nothing reads yet (docs/adapters.md).
//!
//! The board's notice row ("2 background tasks from teammate: no adapter",
//! or "adapter x failed: ...") offers it. The prompt names the guide and the
//! template, and carries a sample of what is there to read: the background
//! task entries of that type, and a listing of the session's folder.

use std::path::Path;

use super::host::{Context, Notice};

/// The listing stops here: enough to see the layout, never a whole tree.
pub const LIST_MAX: usize = 80;
const DEPTH_MAX: usize = 4;

/// The session folder's files, relative, with sizes: folders first by name,
/// at most LIST_MAX lines, DEPTH_MAX deep.
pub fn listing(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, d: &Path, depth: usize, out: &mut Vec<String>) {
        if depth > DEPTH_MAX || out.len() >= LIST_MAX {
            return;
        }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut es: Vec<_> = rd.flatten().collect();
        es.sort_by_key(|e| (!e.path().is_dir(), e.file_name()));
        for e in es {
            if out.len() >= LIST_MAX {
                out.push("…".into());
                return;
            }
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap_or(&p).display().to_string();
            if p.is_dir() {
                out.push(format!("{rel}/"));
                walk(base, &p, depth + 1, out);
            } else {
                let n = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(format!("{rel}  ({n} bytes)"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, 1, &mut out);
    out
}

/// The prompt a Create adapter session starts on.
pub fn prompt(ctx: &Context, notice: &Notice, template: &Path) -> String {
    let what = match (notice.kind.as_str(), &notice.adapter, &notice.task_type) {
        ("failed", Some(a), _) => format!("The seamux adapter `{a}` failed: {}. Fix it so its output validates.", notice.why),
        (_, _, Some(t)) => format!("This Claude session runs background work of type `{t}` that no seamux adapter reads. Write an adapter for it."),
        _ => "Write a seamux adapter for this session's background work.".to_string(),
    };
    let tasks: Vec<String> = ctx.background.iter()
        .filter(|b| notice.task_type.as_deref().is_none_or(|t| b.kind == t))
        .map(|b| b.to_json().to_string()).collect();
    let files = listing(&ctx.session_dir);
    let name = notice.task_type.clone().or_else(|| notice.adapter.clone()).unwrap_or_else(|| "my-orchestrator".into());
    format!(
"{what}

An adapter is a folder under ~/.config/seamux/adapters/ with an adapter.json manifest and a program. seamux runs the program with a context (seamux.context/1) on stdin; the program prints one seamux.run/1 document on stdout within its timeout. The authoring guide is docs/adapters.md in the seamux checkout, and the schema is docs/RUNS.md. A working template is at {template}: copy it to ~/.config/seamux/adapters/{name}/, set `recognizes` to [\"{type_}\"], and change the program to read this orchestrator's files.

What is there to read:

- Session: {session}
- Session folder: {dir}
- Background tasks of this type, as Claude Code's hooks listed them:
{tasks}
- The session folder ({count} entries shown):
{files}

Check it with `seamux runs {session} --all`: the runs should appear, and any notice says which field did not validate. Read the orchestrator's files; never write to them.",
        what = what,
        template = template.display(),
        name = name,
        type_ = notice.task_type.as_deref().unwrap_or("<task type>"),
        session = ctx.session,
        dir = ctx.session_dir.display(),
        tasks = if tasks.is_empty() { "  (none listed now)".to_string() } else { tasks.iter().map(|t| format!("  {t}")).collect::<Vec<_>>().join("\n") },
        count = files.len(),
        files = if files.is_empty() { "  (empty)".to_string() } else { files.iter().map(|f| format!("  {f}")).collect::<Vec<_>>().join("\n") },
    )
}
