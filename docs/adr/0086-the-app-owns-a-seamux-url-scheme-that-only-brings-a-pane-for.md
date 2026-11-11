# 0086. The app owns a seamux:// URL scheme that only brings a pane forward

Date: 2026-11-11

## Status

Accepted

## Context

crew-resume, the sweep and the board in a plain browser need to show a pane in the app. The app's notify:jump event does that, but only code inside the app can raise it.

## Decision

You chose a URL scheme over a request file: a browser link and a CLI can both use it, and it acts at once. Tauri 2.12 hands macOS open-URL events to the app as RunEvent::Opened, so no plugin is needed.

## Consequences

install.sh registers the seamux scheme in Info.plist (CFBundleURLTypes). seamux://focus?ws=<uuid>&pane=<uuid> summons the app and emits notify:jump. Any web page can open such a link, so the scheme only focuses: it never types, answers, closes or runs anything, and it drops any id that is not a UUID. Callers run `open seamux://focus?...`; it fails quietly when the app is not installed.
