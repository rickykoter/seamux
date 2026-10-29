# Troubleshooting

Symptoms keyed on the engine's real error strings.

| symptom | cause |
|---|---|
| `deep-plan gate [slug]: No increment is authorized` | working ahead of the go-ahead — ask, then `deep-plan go <slug> next` |
| `go refused: waits on <parent> increment N` | the family's parent has not landed what this workstream's `after` names; ask the human (`go --force` overrides, logged) |
| `spec refused — family: … already belongs to family …` | a plan joins at most one family; drop it from one parent |
| `spec refused — family: roots collide` | two members share a worktree or one sits inside another; give each its own worktree |
| a note says a file is outside this plan's claims | the family guard: the edit went through and was recorded; `deep-plan family check <parent>` lists every overlap |
| `spec refused — diagram floor: …` | draw the mechanism; do not `--force` past it without saying so |
| `contract "…": external scope defaults toward ADR` | flag the owning decision `adr` (with consequences), or write a `waiver` and say so |
| `alignment check FAILED — … no quiz question covers` | add a question whose `decisionRef` names that contract decision, re-render |
| plan row on the board but no `plan →` chip | intent server down: `crew listen on`, or open the board once |
| `not served: deep-plan serve did not start` | read the log it names; `deep-plan serve --status` says whether one is running |
| a page's buttons say "the deep-plan server did not answer" | the server stopped after 30 idle minutes, or another copy restarted it: `deep-plan page <slug>` gives a fresh link |
| `served at` names the wrong host | `deep-plan doctor` prints how the host was detected; set `SEAMUX_HOST=cmux\|desktop\|terminal\|remote` to override |
| `go`/`done` buttons dead on the plan page | port moved; the next `crew sync` push re-injects it |
| `rehydrate` says REWRITTEN (differs) | someone hand-edited a surface; the spec is the artifact, the rewrite is the fix |
| `no recorded start sha — give one: deep-plan review\|diff\|deliver … --base <sha>` | the increment was authorized before `go` recorded a start sha; pass the commit its work started from as `--base` (for `deliver`, increment 1's); it is recorded, so later runs need no flag |
| `--base refused: a start sha is recorded` | the recorded sha is the base; drop `--base` |
| `done refused: <id> pending` (or `fail`) | `deep-plan check list <slug> <n>`; `check run` for recipe-backed ones, `check pass\|fail … <id> "<what you saw>"` for the rest |
| `done refused: <id> stale` | the tree changed after the pass (an edit, a new file): run it again — a commit of what passed never stales it |
| `done refused: <id> needs-variant` | its acquire step is the human's: ask them to run what `check status` prints, then `check run <slug> <n> <id> --from wait` |
| `done refused: <id> running` | a detached runner is still going: `check wait <slug> <n>` |
| `runner lost: pid N exited without a verdict` | the detached runner died (killed, machine slept); read its log, then `check run` again |
| `<id> recipe-backed — a hand pass needs --force` | run it (`check run`); hand-pass only when the human says to, and say so |
| `spec refused — checks: … has no checks` | declare one, add a default recipe whose match covers the files (`verify resolve` shows what applies; `verify init` if there are none), or write a `waiver` saying why nothing can prove it |
| `no recipe "x" where its files land` / `is ambiguous here` | `deep-plan verify resolve <files>` shows the configs and keys; name it as `id@project` when two projects define it |
| `recipe … changed in … since render` (warning) | the run used the reviewed version; re-render to adopt the edit (a pass against the old recipe goes back to pending) |
| an extension verb you added does nothing | a built-in of the same name wins; `deep-plan --help` marks it SHADOWED |
| render says `vendor/mermaid.min.js is missing` | `deep-plan setup` fetches the pinned build into `~/.claude/deep-plan/vendor` |
| the board's go chip or `deep-plan` in your own shell runs an old copy | `deep-plan engine` prints the root the pointer names; a run from the plugin rewrites it |
| gate seems silent | run the probe from the engine root (`deep-plan engine` names it): `node <root>/probe.mjs`; sentinel-test per DEVELOPING.md |

Verify any change with `node deep-plan/probe.mjs` from the checkout — throwaway
state, both directions, no arguments.
