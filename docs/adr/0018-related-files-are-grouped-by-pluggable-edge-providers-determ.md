# 0018. Related files are grouped by pluggable edge providers; deterministic providers ship now

Date: 2026-10-09

## Status

Accepted

## Context

The second sort key is relevance between files. References between changed files, test-to-source names, shared findings and shared directories are cheap and explainable. You want Jev-based grouping later, so the grouping step takes a list of providers that each return weighted edges, and adding a Jev provider changes nothing else.

## Decision

Related files are grouped by pluggable edge providers; deterministic providers ship now

## Consequences

A provider is `{name, edges(files, ctx) -> [{a, b, why, weight}]}`; groups are connected components over the union of edges above a weight floor; groups sort by their riskiest file and files within a group by risk; each edge's `why` is shown on the page; a Jev provider later is one new module plus a `.seamux/lookout.json` entry.
