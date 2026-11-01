# 0055. The app posts notifications through UNUserNotificationCenter, and a click or the hotkey only ever brings a hidden window forward

Date: 2026-11-01

## Status

Accepted

## Context

ADR 0054's banners posted, but no click ever reached the app. tauri-plugin-notification goes through notify-rust's default NSUserNotificationCenter path. That path waits for a click, and treats a banner missing from `deliveredNotifications` as dismissed. On current macOS that list comes back without the banner almost at once, so the wait ended about 0.7 s after posting with no response. Clicking the banner afterwards still activated seamux, but did not raise its window. The hotkey then read the app as in front and hid the unseen window, so it took two presses to show it.

## Decision

The app turns on notify-rust's `preview-macos-un` feature, so the plugin posts through UNUserNotificationCenter, which waits for the response itself. At start the notifier asks macOS for permission once.

A notification click and the hotkey both count the window as in front only when some of it is on screen (`shell::seen`: on the active Space and not covered). Otherwise both bring it forward: they order it out, place it again on the screen and Space in front, show it and activate the app.

## Consequences

The first launch of this build asks whether seamux may send notifications. If you decline, no banners appear until you allow seamux in System Settings → Notifications.

The hotkey's hide now needs the window visibly in front. A window that is open but covered comes forward on the first press. It is raised in place. Ordering it out and back in, which makes it blink, happens only when it is hidden, on another Space, or on another screen.
