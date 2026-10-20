# Review surfaces beyond the browser page

Read this when the review page is not the right surface, or when the work needs to go into a ticket tracker.

**Two fallbacks when a browser is not the right surface**, both rendered for
every plan and both lettered identically to the review page:
`<slug>.widget.html` is a fragment for a rich client's inline widget (it
sends a runnable `grade` command back when answered), and
`<slug>.quiz.txt` is the plain-text quiz for a terminal session — `cat` it,
let the human answer, then run the command it prints. Reach for the text
quiz rather than reading questions out of the HTML.

**To park the work in a tracker**, use `~/.claude/plans/<slug>.cutover/`,
written on every render: one self-contained `.epic.html` for the parent
(diagrams render offline) and one `NN-*.md` per increment, each written to
be read alone by someone who will not open the epic first. Its `README.md`
says what goes where. The quiz and the answer key are deliberately not in
it — both carry the answers, and a directory attached to a ticket is the
worst place for them.

**To bring older plans onto the current pages** (a new engine, or the human
asks to redraw or replan them): `deep-plan redraw --all --dry-run` lists
every plan and how many diagrams lack an overview, and `deep-plan redraw
--all` (or one slug) re-renders their surfaces with spec and state untouched.
Overviews need an author: `deep-plan overviews <slug>` prints each diagram's
mermaid; draft a plain-words version of each (four to six boxes, no code
names), write them as `{"<n>": "<mermaid>"}` to a file, and run `deep-plan
overviews <slug> <file>`. It refuses the whole file if any overview fails to
parse, then patches the archived and authored specs and redraws. An overview
is not an amendment: it moves no spec hash, so no drift is flagged. Ask the
human before drafting overviews for many plans at once.
