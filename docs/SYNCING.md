# Syncing — who owns which path, and how a change travels

The repo is the source of truth. `install.sh` puts it on a machine; `crew
doctor` runs `install.sh --check` every time, so an edit made in the live
install is a red check rather than a thing you have to remember.

That loop already worked for same-generation, file-level drift. What it never
covered — and what cost a week of a stale live install and two days of internal
repo names in a public tree — is everything below.

## Per-path ownership

**The repo owns** every tracked file. On a machine they appear at:

| Repo | Installed to |
|---|---|
| `crew/` | `~/.config/cmux/crew/` (replace-with-backup) |
| `deep-plan/` | `~/.claude/skills/deep-plan/` (additive rsync, **no `--delete`**) |
| `bin/deep-plan.shim` | `~/.local/bin/deep-plan` |
| `claude/statusline.py` | `~/.claude/statusline.py` |
| `claude/hooks/guard_bash.sh` | `~/.claude/hooks/cmux/guard_bash.sh` (never overwritten if present) |
| `crew/config/*` | rendered by `crew apply` into `cmux.json` and the Dock files |

Never edit those in place. `--check` will find it, and the fix is to copy the
change back into the repo — reverse-substituting `$MAIN` → `__MAIN_REPO__` in
the five baked files (`bin/crew crew-worktree crew-sandbox crew-reclaim
crew-digest`) — then commit and reinstall.

**The machine owns**, and no sync ever touches:

- `~/.config/cmux/crew/integrations.json` and `.seamux-source` — install-time
  state. `drift_check` exempts both by name.
- `~/.config/cmux/crew-local/` — the overlay. Outside `$DEST` and outside every
  `find` root, so it is invisible to the check. See `docs/ADOPTION.md`.
- `~/.claude/deep-plan/{state,keys,active}` and `~/.claude/plans/` — your actual
  plans. `--uninstall` preserves these deliberately.
- `~/.claude/deep-plan/ext/` — extension verbs (`$DEEP_PLAN_EXT`).
  `deep-plan <verb>` falls through to `ext/<verb>.mjs` when no built-in matches,
  so work that cannot be public lives here and the repo ships only the contract.
  Under the **data** tree rather than inside the skill on purpose: `--uninstall`
  does `rm -rf` on the skill, and installing with `rsync --delete` removes
  anything the repo does not have. Same reasoning as `crew-local/` being a
  sibling. A built-in verb always wins, and `deep-plan --help` lists what is
  installed — including marking a file that a built-in shadows.
- `~/.claude/deep-plan/tools/` — one-shot scripts (the data migrator lives
  here), kept out of the skill for the same two reasons.
- `~/.config/cmux/cmux.json` — owned by `crew apply`, which renders it whole
  because cmux has no config include mechanism (`docs/FINDINGS.md`).
- `activePaneBorderColor` inside it — **runtime state, not a preference.** It is
  global in cmux, and `crew-frame` rewrites it on every workspace switch to
  follow the selected workspace's identity colour. Do not put it in an overlay:
  the merge lands, and the next switch overwrites it. Diffing a rendered
  `cmux.json` before and after a change will also show this key moving for
  reasons unrelated to what you changed.

**Hand-tuned, never rebuild from the script:** the deep-plan gate entry in
`~/.claude/settings.json` may carry a `timeout` and `statusMessage` that
`merge_settings.py` does not write. The script's duplicate check is a substring
match on the gate path, so re-running it is a no-op and safe — but rebuilding
that entry by hand drops both silently.

## Traps that have actually bitten

**`--main-repo` must be shell-expanded.** `resolve_main` reads the path back out
of the live `bin/crew`, and if that line was hand-written with `$HOME` you get
the literal four characters. Unexpanded, `[ -d "$MAIN/.git" ]` fails so `crew
apply` skips the project Dock, and `crew-digest`'s Python default becomes the
string `"$HOME/code/..."`, which Python never expands. Always:

```sh
./install.sh --main-repo "$HOME/code/your-repo"
```

**A dry run cannot prove the substitution.** The `__MAIN_REPO__` replacement,
the `chmod +x` and the integrations write all sit inside `if [ "$DRY" = 0 ]`.
After a real install, assert it:

```sh
grep -rn CREW_MONOLITH ~/.config/cmux/crew/bin/ | grep -c '\$HOME'   # must be 0
test "$(grep -rl __MAIN_REPO__ ~/.config/cmux/crew | wc -l)" -eq 0
```

**The statusline is not behind a flag.** It installs even with `--no-crew
--no-deep-plan --no-claude-settings`, and its backup
(`statusline.py.pre-seamux.bak`) has no timestamp — a second differing run
overwrites the first. Keep your own copy if it matters.

**`crew apply` takes no backup when it has already run here.** Its guards are
`! grep -q crew-triage` on `cmux.json` and `! grep -q crew-hook.sh` on
`settings.json`. Once crew is wired both greps hit, so it deliberately keeps the
*pre-crew* backup (so `crew uninstall` can still get you home) and takes no new
one — while rewriting the current file. Back both up yourself before an apply
you are unsure about.

**A non-tty run does not stop.** The drift confirmation is gated on `[ -t 0 ]`.
Piped or run by an agent, `install.sh` prints the warning and proceeds. Run it
from a real terminal when you want the stop button.

**Hooks bind at session start.** Every Claude session older than an install is
on the old wiring and fails *silently*. Per session: `crew status` → `crew
adopt` (one back-fill, no live updates) → `crew-resume` + `^T`, which is the
only thing that actually rebinds.

## Importing a divergent generation

`install.sh` rsyncs `deep-plan/` **without `--delete`**, on purpose: a
locally-added `vendor/mermaid.min.js` should survive. The cost is that if the
live skill is a *different generation* rather than an older copy of the same
one, an install leaves a hybrid — the shared filenames overwritten, every
live-only module still on disk, and `SKILL.md` no longer documenting the
commands those modules implement. Nothing errors. That is the worst shape a
failure can take.

Before installing over a live tree that has files the repo never had:

1. `install.sh --check` and read the `repo-only:` and `live-only:` lines. Only
   `differs:` sets the exit code — the other two are informational, so a "clean"
   exit does not mean the trees match.
2. If there are live-only *modules* (not just data), stop. Either port them into
   the repo first, or move them behind a documented extension point. An orphaned
   module with no caller and no mention in `SKILL.md` is invisible.
3. Check the on-disk contracts, not just the file list: state and key schemas,
   timestamp units, and env var names all drifted at least once between
   generations here.
4. `--no-deep-plan` suppresses the whole skill block — rsync, shim `cp` and
   mermaid fetch together — when you want to install only the crew layer.

**`~/.local/bin/deep-plan` may be a symlink into the skill.** If it is,
`install.sh`'s `cp` of the shim writes *through* it and replaces the live engine
with a 14-line `/bin/sh` script that then execs itself. Check with `readlink`
before an install that includes deep-plan, and back the skill tree up with
`cp -a`, which preserves the link rather than dereferencing it.

## Guards that make this stick

- `tools/scrub_check.py` — internal identifiers in tracked files, first step in
  CI, before the network. The leak it exists to stop happened because the only
  such check lived in the export script that produced a now-retired bundle.
- `.github/workflows/probes.yml` — scrub check, then both probes, on ubuntu and
  macos.
- `crew doctor` — the drift check, plus the overlay's own state.
- `install.sh --check` — repo vs live, any time.
