# Where charts live, and sharing them

Read this when the person asks where charts are kept, wants them on another
machine or with a teammate, or wants them out of a repo.

## The folder

`chartroom doctor` says where this repo's charts are and why. In order:

1. A committed `.chartroom.json` at the repo's top naming `{"dir": "docs/charts"}`:
   that folder, tracked like any file. A team sets this once it adopts charts.
2. A shared repo (`chartroom share on` was run here, or `.chartroom/` already
   holds committed files): `.chartroom/` in this worktree, visible to git.
3. Any other git repo: `.chartroom/` in the main checkout, listed in
   `.git/info/exclude` so git never sees it. Every worktree of the repo uses
   this one folder. This is the default, so a work repo sees no change.
4. Outside git: `~/.claude/chartroom/<hash of the folder>/`.

Each chart is a folder: `chart.json` (kind, title, status, versions, links),
`threads.json` (comments and picks), and `v<n>/<pane>.html` per version.

## Sharing

`chartroom share on` takes `.chartroom/` out of `.git/info/exclude`, so the
person can commit it and pull it on another laptop. Run from a worktree, it
also copies the main checkout's hidden charts into that worktree.
`chartroom share off` hides the folder again; charts already committed stay
in git until the person runs `git rm -r --cached .chartroom`.

Tell the person before they share that comments and picks are committed with
the charts: the record of why an option won travels with the repo.

Never run `share on`, commit charts, write `.chartroom.json`, or move charts
unless the person asks for it.
