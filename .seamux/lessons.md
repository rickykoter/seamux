# Lessons

Rules this repo's plans learned from their misses. `deep-plan retro` adds,
merges and retires them, at most 30. Each names the paths it applies to;
a plan that touches them says how it heeds the rule (cite its id).

<!-- next: L3 -->

## L1
applies: **
from: seamux-additions inc 2 (correction cd84e8a97), 2026-11-05; seamux-additions inc 14 (correction ca4fddbf5), 2026-11-05

Never edit a plan root while any check run, detached ones included, is still going. Before the first edit, run deep-plan status: the increment you edit must be the authorized one, and the one before it done.

## L2
applies: **/probe.mjs, app/**
from: seamux-additions inc 1 (retry c4fdba2a8), 2026-11-05

When a full probe or Rust suite fails, rerun the failing section alone and on main before counting it as yours; timing tests fail under load, and a run killed for a hang still counts toward the three-failure block.
