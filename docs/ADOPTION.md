# Adoption prep — what stands between this repo and a public push

Written 2026-09-13 as the seamux cutover's final increment. Everything here is
audit and plan; nothing has been pushed or published. Line numbers were read
that day — re-verify before acting on one.

## Linux portability audit

Already portable:

- `sha256()` falls back shasum → sha256sum (`install.sh:48-51`).
- md5 hashing falls back `md5 -q` → `md5sum` (`crew/bin/crew-sandbox:134`,
  `crew/bin/crew-reclaim:246`).
- `install.sh:140` only warns on non-Darwin rather than dying.
- `date +%s` / `date +%Y%m%d-%H%M%S` everywhere — no BSD `date -v`.

Mac-only by nature (degrade gracefully, don't port):

- cmux itself, the Dock, the sidebar — the whole board layer is display; the
  CLI/gate/probes are the portable core.
- `launchctl` checks (`crew/bin/crew:268,272,367,457,654`) — retired-job
  detection; would need a systemd equivalent or a platform guard.
- `/Applications/cmux*.app` discovery (`crew/bin/crew-cmux-bin:29`,
  `crew/hooks/lib.sh:14`, `crew/hooks/crew-hook.sh:40`,
  `crew/board/crew-board-diag:124`).
- VS Code at `/Applications/…` (`crew/bin/crew-code:28`,
  `crew/bin/crew-code-open:35`, `crew/bin/crew:544`) — `CREW_CODE_BIN` and the
  PATH fallback already cover Linux.
- Claude credentials from the macOS Keychain (`crew/bin/crew-sandbox:289`) —
  Linux stores them elsewhere; sandbox needs a per-platform credential source.

Real portability bugs to fix before claiming Linux support:

- `mktemp -t crew-diff` (`crew/bin/crew-diff:76`): BSD and GNU `mktemp -t`
  disagree; use `mktemp "${TMPDIR:-/tmp}/crew-diff.XXXXXX"`.
- bash 3.2 assumptions are load-bearing in reverse (`crew/bin/crew-sandbox:393`
  works around it); nothing should *require* bash 4+ without a guard.
- The probes have never run on Linux. CI (below) is the fix, not a local audit.

## CI

Workflow at `.github/workflows/probes.yml`, live since the repo was pushed
(the "draft" header was stale and is gone). Shape: ubuntu + macos matrix, node
22, python 3.12, the scrub check first, then fetch mermaid with the same pin +
sha256 the installer uses, then both probes.

Honest caveats baked into it:

- No cmux in CI. `deep-plan/probe.mjs` is cmux-free. `board_probe.mjs` renders
  the board without a live cmux — that claim is tested on macOS runners but was
  never true-tested on Linux; the first CI run is the test.
- The mermaid fetch is the only network step; it fails closed on a sha
  mismatch, same as `install.sh:250-253`.

## Machine-local overlay

The package genericizes everything company-shaped: `crew-spec` is a stack
detector rather than one repo's test harness, `cmux.jsonc` names
`~/code/main-repo` rather than your monorepo, and there is no database control in
the Dock. That is correct for a public package and wrong for the machine it came
off. The overlay is how a real install keeps its own answers without either
carrying them in the repo or losing them on the next `./install.sh`.

It lives at `~/.config/cmux/crew-local/` — overridable with `$CREW_LOCAL`, and
deliberately a **sibling** of `~/.config/cmux/crew/`, not a child. `install.sh`
moves the whole crew tree aside on upgrade (`mv "$DEST"`), and `drift_check`
only walks `$HERE/crew`, `$HERE/deep-plan` and `$DEST`. A sibling therefore
survives the move *and* stays silent in the check — no entry to whitelist, no
`live-only:` line to learn to ignore. Nothing in it is ever in the repo.

Three hook shapes, one per kind of thing you need to override:

| File | Shape | What it does |
|---|---|---|
| `crew-spec` | executable | `crew/bin/crew-spec` `exec`s it and never runs its own detection |
| `config.json` | JSON | crew's own machine-local settings (`billing`, `monthBudget`) read by the status line and the intent server |
| `cmux.json` | JSON(C) | deep-merged over the rendered `config/cmux.jsonc` |
| `dock.json`, `dock.global.json` | JSON(C) | same, over their templates |

Merge rules (`crew/bin/crew-overlay`): dicts recurse, scalars and lists replace
wholesale, and **`controls` lists merge by `id`** — so an overlay can add one
Dock control, or amend one field of an existing control, without restating the
other eight. Both sides go through `render` first, so overlay content may use
`__HOME__` and `__INTENT_PORT__` exactly like a template.

Two properties worth relying on:

- **A machine with no overlay is byte-identical to before.** `render_local`
  falls straight through to `render`, comments and all — the merge path only
  runs when a file is actually there. Verified against all three configs.
- **A broken overlay fails loudly.** Invalid JSON exits non-zero with the
  overlay's real path and writes nothing to stdout, rather than quietly shipping
  an unmerged config. "My overlay is being ignored" is the bug class this whole
  mechanism exists to remove, so it is never the failure mode.

`crew doctor` reports the overlay and its file count, `note`s its absence (a
machine without one is the normal case, not a symptom), and hard-fails on two
things that would otherwise be silent: a `crew-spec` that is present but not
executable — `[ -x ]` makes that a no-op, the same shape as the go chip that
sent `workspace_id` to a reader expecting `workspaceId` — and an overlay JSON
file that will not parse.

**The trap:** `chmod +x` your `crew-spec`. A copy made with `cp` from a
non-executable source is silently skipped, which is why doctor checks for it.

For a second machine, make the directory a symlink into a private repo:

```sh
ln -s ~/code/dotfiles-private/cmux/crew-local ~/.config/cmux/crew-local
```

No extra code — crew resolves the path through `${CREW_LOCAL:-...}`, so a
symlink is indistinguishable from a directory. There are deliberately no example
overlay files in this repo: anything tracked under `crew/` gets copied into
`$DEST` and compared by `drift_check`, which is noise for nothing.

## Releases

- `CHANGELOG.md` seeded at 0.1.0 (the live-install snapshot) with an
  Unreleased section carrying the cutover work.
- Tag `v0.1.0` on the commit that seeded the repo; tag from `main` after each
  merged batch. Annotated tags (`git tag -a`), version in `VERSION` bumped in
  the same commit. No release automation on a personal repo — `gh release
  create v0.x.0 --notes-from-tag` when it matters.

## Security pass

Intent server (`crew/board/crew-board-intent`):

- Binds 127.0.0.1 only (`:658,664,694`); nothing off-box reaches it.
- Loopback is not trust: any local browser page can GET localhost, so /open
  and /inc require the token (0600, regenerated per start) compared with
  `secrets.compare_digest` (`:586-597`). Fixed action allowlist; row ids come
  from the collector's snapshot, not the URL; nothing passes through a shell.
- `/mermaid.js` is deliberately unauthenticated (`:544-546`): a public library
  file, and tokens in `<script src>` URLs leak into the URL bar. Sound.
- Residual risk (accepted, personal machine): any local process running as the
  user can read the token file and drive the board. The board drives cmux,
  which that process could drive anyway.

Deep-plan gate:

- Fails open by design outside a tracked root and on a vanished root — the
  latter now loud (BROKEN ROOT in status, systemMessage from the hook).
- `bashMutates` is heuristically false-negative-friendly; a determined agent
  can evade it. It is a discipline tool, not a security boundary — say so in
  any public README.
- `open-gate` is logged; the log lives in the state file the human can read.

crew-sandbox:

- Copies the Claude login out of the Keychain into the sandbox as a plaintext
  `.credentials.json` (`crew/bin/crew-sandbox:64-65`, warned at `:269-275`).
  Documented and deliberate, but a public README must carry that warning too.

## Before the first public push — checklist

1. Squash-review history for secrets/paths (`git log -p | grep -iE
   'token|password|key'` and a read of the seeded commit).
2. Fix the `mktemp -t` bug; decide the launchctl guard.
3. Enable CI; get both probes green on ubuntu.
4. Public README: what it is, mac-only scope statement, the sandbox
   credentials warning, the gate-is-not-a-boundary note.
5. LICENSE file (none exists yet).
6. Tag v0.1.0, push `main` only — worktree branches stay local.

## Telemetry emission — deferred, shaped (2026-09-13)

seamux now READS observability stacks for planning (the `observability` entry
in integrations.json / `.seamux/observability.json`). Emitting seamux's own
events — session phases, gate go/done, per-workspace cost — to Datadog,
Splunk or Grafana is deferred, not rejected. The shaped slot: a canonical
`events.jsonl` stream first (every vendor's agent tails files natively), an
optional OTLP/HEC push second, configured beside the read block so the two
never tangle. Nothing should claim that block's name in the meantime.
