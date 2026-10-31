# 0044. Add text-role colour tokens to theme/everforest.css and point every page's text at them

Date: 2026-10-31

## Status

Accepted

## Context

The stock Everforest greys and light-mode hues fail 4.5:1 as text but read fine as dots, fills and borders. Separate text tokens fix the words without moving the palette the terminals and cmux share.

## Decision

Add text-role colour tokens to theme/everforest.css and point every page's text at them

## Consequences

Two tokens per role where text and fill differ (--ef-dim for a dot, a text token for words). New page CSS has to pick the text token for words, and theme_sync.py --check fails CI when a text token drops under 4.5:1.
