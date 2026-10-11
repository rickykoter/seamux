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
