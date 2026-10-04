# Syncing — who owns which path, and how a change travels

The repo is the source of truth, and since 0.3.0 most of it is also what runs.
`install.sh` adds the checkout as the `seamux` marketplace, a folder
marketplace, so Claude Code reads deep-plan, restack, bash-guard and
seamux-mods straight from it: an edit plus `/reload-plugins` is live, with no
version bump and no copy. crew is the one plugin that is also copied, because
cmux, launchd and the intent server address it by a path that must not move.
`crew doctor` compares that copy with the plugin every time, so an edit made
in the live tree is a red check rather than a thing you have to remember.

## Per-path ownership

**The repo owns** every tracked file. On a machine they are used from:

| Repo | Used from |
|---|---|
| `deep-plan/`, `restack/`, `bash-guard/`, `seamux-mods/` | the checkout itself (folder marketplace; `claude plugin list` says "Read from") or, with `install.sh --github`, Claude's cached copy of the published version |
| `crew/` | the checkout for Claude's hooks; `~/.config/cmux/crew/` for everything else, copied there by `crew apply` (replace-with-backup) |
| `crew/claude/statusline.py` | `~/.config/cmux/crew/claude/statusline.py`, which `crew apply` points `statusLine` at |
| `deep-plan/lib/deep-plan.shim`, `restack/lib/restack.shim` | `~/.local/bin/{deep-plan,restack}`, written by each engine's `setup` |
| `crew/config/*` | rendered by `crew apply` into `cmux.json` and the Dock files |

Never edit the crew tree in place: `crew doctor` (or `crew drift`, or
`install.sh --check`) finds it, and the fix is to make the change in the
plugin and run `crew apply`. The five baked files (`bin/crew crew-worktree
crew-sandbox crew-reclaim crew-digest`) carry your main-repo path where the
repo has `__MAIN_REPO__`; the drift check puts it back before comparing.

`crew apply` takes its source from `.seamux-source` in the live tree, unless
Claude has since installed a different version of crew, in which case that
one. For a folder marketplace the source is the folder, never the cache
snapshot `installed_plugins.json` records (`crew/bin/crew-plugin-root`).

**The machine owns**, and no sync ever touches:

- `~/.config/cmux/crew/integrations.json` and `.seamux-source` — install-time
  state; the drift check skips both by name. `integrations.json` is rendered
  from the crew plugin's options (`crew/hooks/options.py`) once one is set,
  and keeps every key it does not own.
- `~/.config/cmux/crew-local/` — the overlay. Outside the live tree and
  outside every comparison. See `docs/ADOPTION.md`.
- `~/.claude/deep-plan/{state,keys,active}` and `~/.claude/plans/` — your actual
  plans. `--uninstall` preserves these deliberately.
- `~/.claude/deep-plan/vendor/mermaid.min.js` — the pinned diagram engine,
  fetched by `deep-plan setup` or the first render. A plugin root is replaced
  on every update, so the 3.4MB file lives in the data tree.
- `~/.claude/deep-plan/engine.json` and `~/.claude/restack/engine.json` — the
  engine pointers (`{root, version, mermaid?}`), written by each plugin's
  SessionStart hook and refreshed by every run. The board's go chip, triage,
  the intent server and the shims find the engines through them. Regenerable:
  losing one costs one run.
- `~/.claude/deep-plan/ext/` — extension verbs (`$DEEP_PLAN_EXT`).
  `deep-plan <verb>` falls through to `ext/<verb>.mjs` when no built-in matches,
  so work that cannot be public lives here and the repo ships only the contract.
  Under the data tree on purpose: a plugin update replaces the plugin root
  wholesale. A built-in verb always wins, and `deep-plan --help` lists what is
  installed, including marking a file that a built-in shadows.
- `~/.claude/deep-plan/tools/` — one-shot scripts (the data migrator lives
  here), kept out of the plugin for the same reason.
- **restack keeps one file under `~`: its engine pointer.** Everything else
  stays out of `~`. Its config is `.seamux/restack.json` in each work repo
  (committed, because "this repo checks in a generated client" is a property
  of the repo), and its run state is
  `$(git rev-parse --absolute-git-dir)/seamux-restack.json` — per worktree,
  never in the work tree, gone when the clone is.
- `~/.config/cmux/cmux.json` — owned by `crew apply`, which renders it whole
  because cmux has no config include mechanism (`docs/FINDINGS.md`).
- `activePaneBorderColor` inside it — **runtime state, not a preference.** It is
  global in cmux, and `crew-frame` rewrites it on every workspace switch to
  follow the selected workspace's identity colour. Do not put it in an overlay:
  the merge lands, and the next switch overwrites it. Diffing a rendered
  `cmux.json` before and after a change will also show this key moving for
  reasons unrelated to what you changed.
- `~/.claude/settings.json` — Claude's. seamux writes two things there, through
  `crew/claude/merge_settings.py`: `statusLine` (only when absent, or when it is
  crew's own) and the two push flags (only when absent). No hook entries: each
  plugin's `hooks/hooks.json` carries its own.

## Traps that have actually bitten

**`--main-repo` must be shell-expanded.** The path is baked into the live tree,
and if it reaches `crew apply` as the literal `$HOME/...` you get those four
characters: `[ -d "$MAIN/.git" ]` fails, so the project Dock is skipped, and
`crew-digest`'s Python default becomes a string Python never expands. Always:

```sh
./install.sh --main-repo "$HOME/code/your-repo"
```

The crew plugin's `main_repo` option takes the same path, and wins over the
one already baked in.

**A dry run cannot prove the substitution.** `crew apply --dry-run` says which
path it would bake; only a real apply does it. Afterwards, assert it:

```sh
grep -rn CREW_MONOLITH ~/.config/cmux/crew/bin/ | grep -c '\$HOME'   # must be 0
test "$(grep -rl __MAIN_REPO__ ~/.config/cmux/crew | wc -l)" -eq 0
```

**The placeholder is spelled in two halves inside crew's own code.** The bake
rewrites every whole `__MAIN_REPO__` in the live tree, including any the code
compares against. The comparisons in `crew/bin/crew` are written
`"__MAIN_""REPO__"` so the baked copy still recognises an unbaked file.

**`crew apply` takes no new `cmux.json` backup when it has already run here.**
Its guard is `! grep -q crew-triage` on `cmux.json`. Once crew has rendered it,
the grep hits, so apply deliberately keeps the *pre-crew* backup (so `crew
uninstall` can still get you home) and takes no new one while rewriting the
file. Back it up yourself before an apply you are unsure about.

**Hooks bind at session start.** Every Claude session older than an install is
on the old wiring and fails *silently*. Per session: `crew status` → `crew
adopt` (one back-fill, no live updates) → `crew-resume` + `^T`, which is the
only thing that actually rebinds.

**A folder marketplace follows the folder.** Run `install.sh` from a worktree
and the plugins run from that worktree; remove it and they break. Re-run
`install.sh` from the checkout you keep: adding the marketplace again re-points
it, and installed plugins follow.

**A github-source install updates only on a version bump.** With `--github`,
Claude runs a cached copy and fetches a new one only when a plugin's
`plugin.json` version changes. A change shipped without the bump ships nothing.

## Migrating from the old installer

Before 0.3.0, `install.sh` rsynced the skills into `~/.claude/skills`, copied
shims into `~/.local/bin`, and wired the gate, the guard and crew's hooks into
`settings.json`. The bootstrap migrates that: each old piece is moved into
`~/.claude/seamux-migrated/<time>/` (never deleted), and only once `claude
plugin list` shows the plugin replacing it installed and enabled, so a machine
is never left without a gate or a guard. A failed plugin install stops the
script before the migration. `--no-migrate` leaves everything where it is.

**`~/.local/bin/deep-plan` may have been a symlink into the skill.** `setup`
replaces a symlink at the shim's path rather than writing through it, which
would have overwritten the engine it pointed at.

## Guards that make this stick

- `tools/scrub_check.py` — internal identifiers in tracked files, first step in
  CI, before the network. The leak it exists to stop happened because the only
  such check lived in the export script that produced a now-retired bundle.
- `.github/workflows/probes.yml` — scrub check, `deep-plan setup` for the
  pinned mermaid, `claude plugin validate` on the marketplace and every plugin,
  the seamux-mods tests, then the probes, on ubuntu and macos.
- `crew doctor` — the drift check, an unapplied crew update, double-wired
  hooks, the engine pointer, plus the overlay's own state.
- `install.sh --check` — the marketplace, each plugin and where it runs from,
  anything the old installer left, and drift in the crew tree.
