# Golden files

Bytes the crew probes hold `seamux` to where nothing else does. Each file is
one case that used to be checked only by comparing seamux against crew's
Python twin. Every file here was first recorded from that Python on
2026-11-07, before plan `sunset-crew-python` deleted it. Until a change
re-records a file, it holds the Python's bytes.

| Folder | Probe | Cases |
|---|---|---|
| `board/` | `crew/board/board_probe.mjs` | `news --compose` over every badge and family, `judgments --apply` and `--record`, `crew-board state` (JSON and text, with and without workspaces), and the usage an unknown subcommand prints |
| `core/` | `crew/tools/core_probe.py` | `families` (with and without a family, and 400 17-digit floats), `pricing --merge` and `--compare` (with and without upstream), `costs --attribute` (0.1 + 0.2, 1e-07, and 17-digit floats) |
| `artifacts/` | `crew/tools/artifacts_probe.py` | the `crew-artifacts` CLI's non-ASCII searches, the FTS syntax error, `keep` and an unknown verb, plus `row`, `workspaces`, `search --limit`, `keep --json` and `keep-all --json` |

The probe replaces machine paths with `<T>`. `artifacts/` also masks rows
made at run time (`<NOW>`) and the `kept/` folder's hash. Those searches run
with `TZ=UTC`.

To re-record, run the probe with `CREW_GOLDEN=write`, then read the diff. Do
it only when a change is meant to move these bytes, and say so in the PR.
`golden.expect` records under that flag and `golden.same` never does
(`crew/tools/golden.py`, `golden.mjs`).
