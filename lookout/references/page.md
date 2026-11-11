# The page

What the human sees on the review page, and the keys that drive it. Read this when they ask how the page works.

The page is live when a server serves it: crew's in cmux, lookout's own
(`lookout serve`, started on demand) everywhere else. Live, it takes
comments and closes and polls for replies. Opened as a file it is
read-only. lookout's server stops after 30 idle minutes; `lookout open`
again (or `lookout serve --url /review/<id>`) gives a fresh link.

VS Code's Source Control layout: changed files on the left as a directory
tree (single-child folders folded together), one file's diff on the right.

## Contents

- [Views](#views)
- [Findings and the pull request](#findings-and-the-pull-request)
- [In the seamux app](#in-the-seamux-app)
- [Drawing](#drawing)

## Views

- **Overview** (`o`, or the header button): a review with notes opens on
  it. Each group is one folded row, riskiest first: its band, a headline
  (the first sentence of its note's direction), and its counts of files,
  open findings and lines to watch. Low-risk groups without notes share
  one line at the end. A click, Enter or Space opens a group, and several
  can be open at once; the page remembers which for the tab. ↑ and ↓
  move between rows, Home and End jump to the ends, and Esc inside an open
  group folds it. An open group shows why it is risky and its direction as
  two short paragraphs, then its watch items (each `file:line` goes to its
  line), any drift from the plan, touches as chips, and its files. A row
  marks a stale or partial note. With the quiz on, a row whose note still
  waits on a question says "answer first", and opening it shows the
  question in place of the note. The group's id and why its files belong
  together are in the row's tooltip. Each file shows its group's note as a
  strip above the diff that expands.

- **Map** (`m`, or the header button): the plan's End state map held
  against the diff, when the review was opened with `--plan-map` (deep-plan
  passes its plan's `~/.claude/plans/<slug>.map.json` on every review it
  opens). Each file the plan named for this increment is marked as planned
  and touched, or planned but not touched. Each file the diff touched that
  the plan never named is marked touched but not planned. A click shows a
  card's details; a second click, or **Open its diff**, opens a touched
  file's diff. The details panel sits beside the map in a wide pane and
  pins to the bottom of a narrow one, and each section's header folds it to
  one row. Each card with findings carries a flag: the
  count still open, in the worst one's severity colour, or a faint tick
  when all are closed. The panel lists them, and a click on one jumps to
  its line. Without a map the view says so.

- **Split or Unified** (header toggle, or `v`). A diff column under 900px
  and one-sided files (added, deleted) draw unified.
- **`j` / `k`** step through files in the side list's order; **`n` / `p`**
  through open findings.
- **Risk / Path** (side toggle). Risk puts files in high, medium and low
  bands, riskiest first, with related files grouped on a rail. Why they
  belong together (one imports the other, a test and its source, a finding
  naming both, a small shared folder) is the group's line in the Overview
  and each row's tooltip, not a line in the list. A row at rest is its risk
  dot, its name and its open-findings count; its folder, +/− counts and
  status letter show on the selected row and on hover, and its tooltip
  names them all. Risk blends deterministic
  signals with one Jev score per file; by default only paths and line counts
  leave the machine, and `.seamux/lookout.json` `{"sendContent": true}`
  lets hunk text go too. Without TypeSafe the page says it is ranking on
  signals alone. The file header says "high risk" (or medium, or low) and
  any plain reason ("auth or secrets"); its tooltip gives the score and
  what Jev read.

## Findings and the pull request

- **Findings** sit under the line they name, with severity, category,
  verdict, status and their thread; the header shows the gate. Findings on
  lines the diff does not show are listed at the top of the file. Blocker
  and major cards stay open. A minor, a nit or a comment folds to one row
  (its severity and short title) until it becomes the current card, by a
  click, Enter or `n`/`p`. A resolved or dismissed one looks closed: one
  row with its severity chip and title muted and a muted "resolved" or
  "dismissed" chip. A click or Enter opens it to its thread and Reopen (no
  Resolve); its head folds it again. A line that
  carries open findings has a dot per severity in its line-number gutter.
  Hover the dots for the findings' titles, or click one to go to the worst.
  The current card, where its Reply, Resolve and Dismiss show, has an
  accent edge on its left, and its head adds the category and verdict in
  plain words ("correctness · confirmed"); the title's tooltip names them
  with the finding's id.
- **The pull request**: once `lookout gh sync` has linked the review to a
  PR (the page's server asks for a sync while the page is in view, at most
  once a minute), a strip under the header shows the PR and its state. It
  says how many commits the PR's head is past the reviewed one; in the
  seamux app it also offers Re-review. It counts open items that are stale
  or still pending, and the checks as passed, failed and running. A click
  on the checks lists them, failed first, each linked to its run. GitHub's
  own review threads are cards on their lines, marked GitHub, while the
  review is at the PR's head, and are otherwise listed above the diff. You
  reply to them on GitHub. A card the review posted links to its comment
  (posted ↗) and carries GitHub's replies under its own thread. One not
  posted says pending. One whose code changed on the PR's head says stale,
  and its tooltip says why.

## In the seamux app

- **In the seamux app** the header row has one findings button, "N open ▾"
  or "N open · M picked ▾", filled only while something is picked. N is
  the number the gate pill counts ("blocked · N open"): every finding not
  resolved or dismissed. Both tooltips give the breakdown by severity, and
  a resolve on the page moves both. The button opens one panel: Pick all,
  Blockers and majors and Clear over the list of open findings (each row
  its severity, place and title, wrapped to two lines), then Edit, Fix
  with commits and Post comments on the picks, and Push. A picked finding has a check at its card's left.
  Overview, Map, Split or Unified and the keys sit in one **View** menu,
  each with its key; when only one of them applies (a narrow window
  without a map), it sits in ⋯ instead.

## Drawing

- A file's status letter (M, A, D, R) names itself in its tooltip.
- **Highlighting** is highlight.js over each side's whole file, so a change
  inside a block comment or a template string reads right. Changed words in
  a paired removed/added line are marked.
- **Collapsed files**: lockfiles, minified bundles, `linguist-generated`
  paths, binaries and changes over 1500 lines start collapsed behind a
  "Show diff" button (binaries and very large files cannot be drawn).

If highlight.js is missing the page is drawn plain with a banner naming why;
`lookout setup` fixes it.
