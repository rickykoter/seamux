# 0065. Three failures in a row block the increment

Date: 2026-11-02

## Status

Accepted

## Context

The tenet is to stop and re-plan when something goes sideways; a block is the existing state that stops an auto chain and waits for a person's go

## Decision

Three failures in a row block the increment

## Consequences

Each runner-recorded fail of a recipe-backed or ci check bumps a `fails` count on its verdict, and a pass clears it. At the cap (3, or the spec's `retry.max`) check run marks the increment blocked with "stop and re-plan", files a lesson candidate, and prints how to amend the spec. A blocked increment needs a person's go (deep_plan.mjs:1906), so an auto plan stops there. Manual fails and a review with no reviewer yet do not count.
