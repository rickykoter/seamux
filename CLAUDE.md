# seamux

**Setting up or updating seamux for someone?** Follow
[README.md → Install or update with an agent](README.md#install-or-update-with-an-agent).
In short: install from the checkout the person will keep (never a git
worktree), ask them which plugins and integrations they want instead of
guessing, preview with `./install.sh --dry-run`, verify with
`./install.sh --check` and `crew doctor`, and leave slash commands
(`/plugin`, `/reload-plugins`) to them.

**Changing seamux itself?**

- Each plugin is a folder: `deep-plan/`, `restack/`, `crew/`, `bash-guard/`,
  `seamux-mods/`. Start with its `SKILL.md` or `README.md` (bash-guard is
  only `hooks/`); deep-plan and restack also have a `DEVELOPING.md`. A
  skill's detail lives in `references/` beside its SKILL.md, each file linked
  straight from it; `python3 tools/skill_lint.py` holds every skill to
  Anthropic's authoring rules (ADR 0019), and CI runs it.
- The plugins run from this checkout, so an edit is live after
  `/reload-plugins`. crew is the exception: `crew apply` copies it to
  `~/.config/cmux/crew` (see `docs/SYNCING.md`).
- Tests: `node deep-plan/probe.mjs`, `node restack/probe.mjs`,
  `node crew/board/board_probe.mjs`, `python3 crew/tools/family_sync_probe.py`,
  `claude plugin test seamux-mods`, `python3 tools/skill_lint_probe.py`,
  `python3 tools/skill_evals_probe.py`, and for `app/`
  `cargo test --manifest-path app/Cargo.toml --workspace` and
  `cd app && npm ci && npm run build`. `.seamux/verify.json` holds each as a
  recipe matched to the files it tests, so `deep-plan check run` picks them.
- `app/` is the seamux app (Tauri: Rust in `app/crates`, Vite + TypeScript
  pages in `app/ui`). Unlike the plugins it is not live from the checkout:
  `./install.sh --app` builds it and copies the bundle to `~/Applications`.
- A change to a skill's text is held to its eval baseline:
  `python3 tools/skill_evals.py compare <plugin> --model opus --model haiku`
  (the `evals-<plugin>` recipes; real model spend, so name them on purpose).
  Re-record with `record` only when a change is meant to move the scores,
  and say so in the PR.
- Type-check seamux-mods after changing it: copy
  `~/.claude/plugins/cache/seamux/seamux-mods/<version>/.claude-plugin/types`
  to `seamux-mods/.claude-plugin/types` (git ignores the copy), then
  `npx -y -p typescript@5 tsc -p seamux-mods`. The plugin tests do not
  type-check.
- bash-guard refuses any Bash command containing `--no-verify` or a signing
  bypass, even inside a heredoc or script, and even a commit message that
  only names the flag. Don't route around it: let a
  commit's hooks run, including a commit the code itself makes.
- `python3 tools/scrub_check.py` must pass before any push; CI runs it first.
- Architecture decisions live in `docs/adr/`.
