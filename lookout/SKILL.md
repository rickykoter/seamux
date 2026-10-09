---
name: lookout
description: Review a diff in a browser pane beside the terminal — a branch against its base, a commit range, the uncommitted working tree, or a patch file — with files in a VS Code-style tree, highlighted split or unified diffs, and word-level change marks. Use when the user asks to review a branch, a diff, a PR's changes or an increment, to "look at the diff", or runs /lookout.
---

# lookout

A review is a source, the diff it yields, and (later) what you and the human
say about it. `lookout` is on the Bash tool's PATH from the plugin's `bin/`
while the plugin is enabled; `lookout setup` adds a `~/.local/bin/lookout`
shim for the human's own shell and fetches the pinned highlight.js.

## Open a review

```
lookout open                      # this branch vs origin's default branch (else main/master),
                                  # uncommitted and untracked work included
lookout open --base REF           # merge-base(REF, HEAD) vs the working tree
lookout open --worktree           # uncommitted work only (HEAD vs the working tree)
lookout open --range A..B         # two commits; A...B diffs from their merge base
lookout open --patch FILE         # a patch file, no repository needed
```

It prints the review id, the page and the store, and puts the page in a
browser tab beside the terminal without taking focus (a second open of the
same review refreshes that tab instead of adding one). `--no-open` skips the
tab, `--json` prints the same as JSON, `--id` names the review yourself.

The working tree is read through a scratch git index, never the real one:
opening a review does not change what `git commit` would do.

The id is stable per source (`<repo>-<branch>`, `<repo>-<branch>-wt`, …), so
re-opening a branch after more work updates its review and keeps everything
said on it.

## The page

VS Code's Source Control layout: changed files on the left as a directory
tree (single-child folders folded together), one file's diff on the right.

- **Split or Unified** (header toggle, or `v`). Narrow panes and one-sided
  files (added, deleted) draw unified.
- **`j` / `k`** step through files in tree order.
- **Highlighting** is highlight.js over each side's whole file, so a change
  inside a block comment or a template string reads right. Changed words in
  a paired removed/added line are marked.
- **Collapsed files**: lockfiles, minified bundles, `linguist-generated`
  paths, binaries and changes over 1500 lines start collapsed behind a
  "Show diff" button (binaries and very large files cannot be drawn).

If highlight.js is missing the page is drawn plain with a banner naming why;
`lookout setup` fixes it.

## Other verbs

```
lookout show <id> [--json]   files of a review (or the whole store as JSON)
lookout list [--json]        every review, newest first
lookout render <id>          redraw the page from the store
lookout setup                engine pointer, ~/.local/bin shim, pinned highlight.js
lookout engine               which copy of the engine runs
```

The store is `~/.claude/plans/reviews/<id>.json`, beside the patch, the drawn
rows and the page.
