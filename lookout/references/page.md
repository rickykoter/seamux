# The page

What the human sees on the review page, and the keys that drive it. Read this when they ask how the page works.

The page is live when a server serves it: crew's in cmux, lookout's own
(`lookout serve`, started on demand) everywhere else. Live, it takes
comments and closes and polls for replies. Opened as a file it is
read-only. lookout's server stops after 30 idle minutes; `lookout open`
again (or `lookout serve --url /review/<id>`) gives a fresh link.

VS Code's Source Control layout: changed files on the left as a directory
tree (single-child folders folded together), one file's diff on the right.

- **Overview** (`o`, or the header button): a review with notes opens on
  it. Every group riskiest first, each note in full: watch items link to
  their lines, touches show as chips, drift findings are listed, and stale
  or partial notes are marked. Each file shows its group's note as a strip
  above the diff that expands.

- **Split or Unified** (header toggle, or `v`). Narrow panes and one-sided
  files (added, deleted) draw unified.
- **`j` / `k`** step through files in the side list's order; **`n` / `p`**
  through open findings.
- **Risk / Path** (side toggle). Risk puts files in high, medium and low
  bands, riskiest first, with related files grouped on a rail that says why
  they belong together (one imports the other, a test and its source, a
  finding naming both, a small shared folder). Risk blends deterministic
  signals with one Jev score per file; by default only paths and line counts
  leave the machine, and `.seamux/lookout.json` `{"sendContent": true}`
  lets hunk text go too. Without TypeSafe the page says it is ranking on
  signals alone.
- **Findings** sit under the line they name, with severity, category,
  verdict, status and their thread; the header shows the gate. Findings on
  lines the diff does not show are listed at the top of the file. Closed
  ones fold to one line.
- **Highlighting** is highlight.js over each side's whole file, so a change
  inside a block comment or a template string reads right. Changed words in
  a paired removed/added line are marked.
- **Collapsed files**: lockfiles, minified bundles, `linguist-generated`
  paths, binaries and changes over 1500 lines start collapsed behind a
  "Show diff" button (binaries and very large files cannot be drawn).

If highlight.js is missing the page is drawn plain with a banner naming why;
`lookout setup` fixes it.
