// crew — the who-needs-me board.
//
// cmux binds no agent lifecycle, no CI, and no review state, so crew publishes
// all of it as tokens in `description` — the one bindable, writable field — and
// this decodes them. See FINDINGS.md.
//
//   Needs you   phase:waiting     Claude is blocked on you — and only that.
//                                 Not "a terminal is open", not unread output:
//                                 the hook publishes this on Claude's own
//                                 Notification event and clears it on Stop.
//   Working     phase:working     it is mid-turn (latestAt cannot tell you this)
//   Review      an open PR, a dirty tree, or a finished checklist
//   Merged      gone:merged       the branch shipped; the worktree can go
//   Idle        everything else
//
// Badges: ci:fail/run/pass, review:approved/changes, pr:conflict, pr:draft.
//
// The glyph before the title is the "what is this row doing" slot: ◇ plan mode,
// ◈ a deep-plan awaiting its check, ◆ a locked plan whose gate is shut, ▷ a locked
// plan being worked, ⠹ mid-turn, ✦ merged. Planning outranks the
// spinner — see statusGlyph.
//
// Chips are tappable, underlined text opens something elsewhere, bare text is
// just a status. That convention is doing the work a hover cursor would — see
// the affordance note above chipRPC.
//
// ── whimsy ───────────────────────────────────────────────────────────────────
// There is no @State and no animation API here, but the sidebar re-evaluates
// about once a second and `clock` is bound — so anything that is a pure
// function of clock.second animates. A 1Hz frame clock. That is also why it
// costs nothing: no timers, no state, just arithmetic, in the spirit of the
// Ghostty whimsy engine's zero-idle-cost rule.

func age(_ w: Any) -> Int {
    if let t = w.latestAt {
        return max(0, clock.epoch - t)
    }
    return 999999
}

// crew mirrors the agent phase into `description`, because nothing else here
// can see it: there is no agentLifecycle binding, and `latestAt` is the last
// *message* — it stands still for minutes while Claude thinks, so a hard-working
// agent looks idle. Phase wins over every other signal.
func phase(_ w: Any) -> String {
    if let d = w.description { return d }
    return ""
}

func has(_ w: Any, _ token: String) -> Bool {
    return phase(w).contains(token)
}

// Pull one token's value out of the description, e.g. feedby:1786...
//
// Loop-free on purpose. A `return` inside a `for` body does NOT escape the loop
// in this interpreter — it is ignored and the function falls through to its
// final `return`. The obvious version of this helper therefore compiled, parsed,
// validated, and returned "" for every key on every row, which silently took the
// whole Feed control strip off the board. `.filter` + index is the shape that
// works, because the value comes out of an expression instead of a jump.
func tokenValue(_ w: Any, _ key: String) -> String {
    let hit = phase(w).split(separator: " ").filter { $0.hasPrefix("\(key):") }
    if hit.count < 1 { return "" }
    return hit[0].split(separator: ":")[1]
}

// deep-plan label helpers.
//
// These exist for one reason: a string interpolation whose expression contains its
// own string literal -- Text("\u25c8 \(tokenValue(w, "planinc"))") -- silently
// renders nothing. Not a validate error, not an interpreter error: the whole `if`
// block vanishes from the IR. Taking the literal out by passing the value in as a
// parameter is what makes it render, and it is the same class of silent failure as
// the top-level-`let` one below.
func planCount(_ v: String) -> String {
    return "◈ \(v)"
}

func planGoLabel(_ v: String) -> String {
    return "go \(v)"
}

func planGoTip(_ v: String) -> String {
    return "Authorize increment \(v) — until you do, nothing in this worktree can be edited"
}

func planUrl(_ v: String) -> String {
    return "file://\(v)"
}

func planWorkTip(_ v: String) -> String {
    return "Working a locked plan — \(v) increments done"
}

// Seconds left in the 120s Feed window. Zero means the ask is dead and the
// board must not offer to answer it.
//
// The empty-string guard matters: `Int("")` is nil here, and a nil propagates
// through `<` as *false* rather than an error, so without it both `feedLeft > 0`
// and `feedLeft < 1` are false at once and every branch that depends on the
// window vanishes.
func feedLeft(_ w: Any) -> Int {
    let raw = tokenValue(w, "feedby")
    if raw == "" { return 0 }
    let by = Int(raw)
    if by < 1 { return 0 }
    return max(0, by - clock.epoch)
}

// --- freshness ----------------------------------------------------------------
// When crew-sync last reconciled, read off the `synced:` stamp it publishes on
// one workspace. Newest wins, so a leftover stamp on a workspace that used to be
// the carrier is outvoted rather than believed. 0 means no stamp anywhere.
//
// This matters because the two clocks on this board are wildly different: the
// sidebar re-renders about once a second, so the time in the corner and every
// `elapsed()` are always live — but CI, review, Jira, sandbox and phase only move
// when crew-sync runs. Without this, a board nothing has reconciled in an hour
// looks exactly like a board where nothing is happening.
func syncedAt() -> Int {
    let stamped = workspaces.filter { has($0, "synced:") }
    if stamped.count < 1 { return 0 }
    let vals = stamped.map { Int(tokenValue($0, "synced")) }.sorted { $0 > $1 }
    return vals[0]
}

func syncAge() -> Int {
    let at = syncedAt()
    if at < 1 { return 999999 }
    return max(0, clock.epoch - at)
}

// Turn-end reconciles are throttled to 120s, so anything under ~4 minutes is
// simply the normal cadence and should read as calm. Past that the board is
// drifting, and past a quarter of an hour it is stale enough that the CI and
// review badges should not be trusted without tapping ↻.
func syncLabel() -> String {
    let a = syncAge()
    if a > 99999 { return "never" }
    if a < 60 { return "\(a)s" }
    if a < 3600 { return "\(a / 60)m" }
    return "\(a / 3600)h"
}

func syncTint() -> String {
    let a = syncAge()
    if a > 900 { return "#F97066" }
    if a > 240 { return "#F5A524" }
    return "#8E8E93"
}

// "reconciled never ago" is not a sentence, and the no-stamp case is worth
// spelling out anyway — it means crew-sync has not completed a run since these
// workspaces were opened, not that it is one tick late.
func syncTip() -> String {
    if syncAge() > 99999 {
        return "crew-sync has not run yet — CI, review and Jira badges may be missing entirely. Tap ↻."
    }
    return "Signals last reconciled \(syncLabel()) ago — tap ↻ to refresh"
}

func bucket(_ w: Any) -> Int {
    if has(w, "phase:waiting") { return 0 }
    // Planning is its own state, above working and below blocked. "Thinking" and
    // "typing code" are the two things you most want to tell apart on a board of
    // twenty worktrees, and neither the spinner nor the phase token separates
    // them. It does not outrank phase:waiting: an agent blocked on a question is
    // the more urgent fact, and the ◇/◈ glyph still says it is planning.
    //
    // Only the two states where nothing is being edited yet. plan:gate and
    // plan:work are post-agreement — the plan is signed off and increments are
    // being authorized — so those rows belong with the work.
    if has(w, "plan:mode") { return 5 }
    if has(w, "plan:deep") { return 5 }
    if has(w, "phase:working") { return 1 }
    if has(w, "gone:merged") { return 3 }
    // No phase published (a session that predates crew, or one whose hooks are
    // not live) — fall back to the weaker signals.
    //
    // `unread` is deliberately NOT one of them. It counts anything cmux recorded
    // for the workspace that you have not looked at, which any pane can produce —
    // a shell bell, a finished command, output in a background split. None of
    // that is Claude asking you something, and using it here meant a workspace
    // with a couple of busy terminals in it sat in "Needs you" on its own.
    // Only phase:waiting, which the Notification hook publishes, opens bucket 0.
    // The unread count still shows as the header badge.
    if age(w) < 90 { return 1 }
    // `if let`, not `w.pr != nil`. Comparing an object binding to nil does not
    // evaluate to a Bool here, and a non-Bool condition is read as false — so the
    // nil test never fired and a row whose only Review signal was an open PR fell
    // through to Idle.
    if let p = w.pr { return 2 }
    if let d = w.dirty {
        if d { return 2 }
    }
    if let pr = w.progress {
        if pr.value >= 1.0 { return 2 }
    }
    return 4
}


// `latestMessage` is whatever cmux last saw in the conversation, which includes
// harness plumbing: <task-notification> envelopes when a background task
// finishes, <system-reminder> blocks, slash-command echoes, and image
// placeholders. None of that is a message, and a row rendering raw XML is worse
// than a row rendering nothing.
func isReadable(_ t: String) -> Bool {
    if t == "" { return false }
    if t.hasPrefix("<") { return false }
    if t.contains("<task-notification>") { return false }
    if t.contains("<system-reminder>") { return false }
    if t.contains("<local-command") { return false }
    if t.contains("<command-name>") { return false }
    return true
}

// A bracket placeholder is a PREFIX on a real message, not a message in itself —
// "[Image #8] It looks like you are rendering…" is worth showing once the
// placeholder is gone. Rejecting the whole string loses the sentence, which is
// the opposite mistake to rendering raw XML.
//
// split(separator:) is the only string surgery available here, so a message
// containing a later "]" is clipped at it. Acceptable: the case this exists for
// is a leading placeholder.
func cleanMessage(_ t: String) -> String {
    if t.hasPrefix("[") {
        let parts = t.split(separator: "]")
        if parts.count > 1 { return parts[1] }
        return ""
    }
    return t
}

// Prefer the last real message; fall back to the last thing you asked, which is
// more use than a blank line when the newest entry is an envelope.
func rowMessage(_ w: Any) -> String {
    if let m = w.latestMessage {
        if isReadable(m) {
            let c = cleanMessage(m)
            if c != "" { return c }
        }
    }
    if let p = w.latestPrompt {
        if isReadable(p) {
            let c = cleanMessage(p)
            if c != "" { return c }
        }
    }
    return ""
}

func elapsed(_ w: Any) -> String {
    let s = age(w)
    if s > 99999 { return "" }
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m" }
    return "\(s / 3600)h \((s % 3600) / 60)m"
}

func dotColor(_ w: Any) -> String {
    let b = bucket(w)
    if b == 0 { return "#F97066" }
    if b == 1 { return "#4C8DFF" }
    if b == 2 { return "#F5A524" }
    if b == 3 { return "#8B5CF6" }
    if b == 5 { return "#A78BFA" }
    return "#6B7280"
}

// --- animation off the 1Hz clock ---------------------------------------------

// Triangle wave over 4s. Only a working agent's dot breathes, so any motion on
// the board means something is genuinely running.
func breath() -> Double {
    let n = clock.second % 4
    if n == 0 { return 0.60 }
    if n == 1 { return 0.82 }
    if n == 2 { return 1.00 }
    return 0.82
}

// Wilt. A row waiting on you fades the longer it goes unanswered.
//
// Tuned against measured reply times: the median is 203s and 40% run past five
// minutes, so the hold has to cover an ordinary reply or every row wilts and
// the signal means nothing. It holds full for 5 minutes, then eases to a 0.72
// floor over the next hour — p90 is ~28 minutes, which lands mid-gradient, so
// only genuinely forgotten rows ever reach bottom.
//
//   5m 1.00   15m 0.95   30m 0.87   45m 0.79   60m+ 0.72
//
// The floor is deliberately shallow. Wilt should read as "this has been sitting
// a while", not as "this row is disabled" — it still has to be legible at a
// glance, which the earlier 0.40 was not.
func wilt(_ w: Any) -> Double {
    if bucket(w) != 0 { return 1.0 }
    let a = age(w)
    if a < 300 { return 1.0 }
    if a > 3600 { return 0.72 }
    return 1.0 - 0.28 * (Double(a - 300) / 3300.0)
}

func spinner() -> String {
    return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][clock.second % 10]
}

func twinkle() -> String {
    return ["✦", "✧", "·", "✧"][clock.second % 4]
}

// --- the "what is this row doing" slot ----------------------------------------
// One glyph, four possible tenants, explicit precedence. Previously the spinner
// (bucket 1) and the merged twinkle (bucket 3) each had their own `if` in the
// title row; they could never collide because the buckets are exclusive, but
// planning can overlap either, so the slot needs a single owner.
//
// Planning wins. Both the spinner and this answer the same question, and
// "planning" is the more specific answer — a row showing ⠹ ◈ together would be
// two glyphs arguing about the same fact.
//
// `has()` rather than tokenValue: it is the proven Bool shape in this file, and
// the plan tokens are exact strings, so a substring test is enough.
// Four plan states now, and they do not all outrank the spinner. A gated plan is
// waiting on a human decision, which is the most actionable thing a row can say, so
// it wins outright. A plan being *worked* is less specific than "mid-turn" — the
// spinner already tells you something is happening — so it sits below, and the
// chip strip carries the increment count either way.
func statusGlyph(_ w: Any) -> String {
    if has(w, "plan:deep") { return "◈" }
    if has(w, "plan:gate") { return "◆" }
    if has(w, "plan:mode") { return "◇" }
    if bucket(w) == 1 { return spinner() }
    if has(w, "plan:work") { return "▷" }
    if bucket(w) == 3 { return twinkle() }
    return ""
}

func statusTint(_ w: Any) -> String {
    // Amber, not purple: a closed gate is the same kind of fact as needs-attention.
    if has(w, "plan:gate") { return "#F5A524" }
    if has(w, "plan:") { return "#A78BFA" }
    if bucket(w) == 1 { return "#4C8DFF" }
    return "#C4B5FD"
}

func statusTip(_ w: Any) -> String {
    if has(w, "plan:deep") {
        return "A deep-plan is on the table and its alignment check has not passed yet"
    }
    if has(w, "plan:gate") {
        return "A locked plan is waiting on you: no increment is authorized, so nothing can be edited"
    }
    if has(w, "plan:work") {
        return planWorkTip(tokenValue(w, "planinc"))
    }
    if has(w, "plan:mode") {
        return "In plan mode — reading and proposing, not editing"
    }
    if bucket(w) == 1 { return "The agent is mid-turn" }
    return "Merged — reclaim the worktree when you are done with it"
}

func dotSize(_ w: Any) -> Double {
    if bucket(w) == 1 { return 6.0 + 3.0 * breath() }
    return 7.0
}

// --- affordance ---------------------------------------------------------------
// Nothing here can change the mouse cursor. The interpreter's entire interaction
// surface is .onTapGesture / .contextMenu / .help / .disabled; .onHover is
// explicitly unimplemented, and the host attaches only
// `.contentShape(Rectangle()).onTapGesture { }.reportTapTarget(action)` to a
// tappable node — no pointerStyle anywhere in that path. See FINDINGS.md.
//
// So "clickable" has to be legible at rest. One rule, applied everywhere:
//
//   a chip does something when you tap it
//   underlined text opens something elsewhere (VS Code, GitHub)
//   bare text is a status and does nothing
//
// Every chip also carries .help, so resting on one names the action even though
// the cursor never changes.
//
// Three chip helpers rather than one, because the tap body cannot be a parameter
// — the interpreter has no closure arguments — so each variant closes over its
// own call. They are deliberately self-contained: modifiers applied to a *helper's
// result* are not a documented form, and none of cmux's own examples do it, so
// .help and .onTapGesture live inside.

// Posts a crew:<verb> notification, the board→shell channel crew's notification
// hook turns back into a command.
func chipRPC(_ label: String, _ tint: String, _ tip: String, _ verb: String, _ w: Any) -> some View {
    Text(label)
        .font(.system(size: 10))
        .foregroundColor(tint)
        .padding(3)
        .background {
            RoundedRectangle(cornerRadius: 4)
                .fill(tint).opacity(0.14)
        }
        .help(tip)
        .onTapGesture {
            cmux("notification.create", title: "crew", subtitle: verb,
                 body: w.title, workspace_id: w.id)
        }
}

// Hands a URL to the system default browser. `openURL` is a first-class action
// command here, alongside `cmux` and `log`, and the host runs it as
// `NSWorkspace.shared.open` — so the link lands in the browser you are already
// signed into GitHub with.
//
// It does NOT select the row's workspace on the way. The old browser-split form
// had to, or the split landed on whatever workspace you were standing on; a
// system-browser handoff has no such ambiguity, and selecting would mean tapping
// a PR link yanks you out of the workspace you are working in.
func chipURL(_ label: String, _ tint: String, _ tip: String, _ url: String, _ w: Any) -> some View {
    Text(label)
        .font(.system(size: 10))
        .foregroundColor(tint)
        .padding(3)
        .background {
            RoundedRectangle(cornerRadius: 4)
                .fill(tint).opacity(0.14)
        }
        .help(tip)
        .onTapGesture { openURL(url) }
}

func chipJump(_ label: String, _ tint: String, _ tip: String, _ w: Any) -> some View {
    Text(label)
        .font(.system(size: 10))
        .foregroundColor(tint)
        .padding(3)
        .background {
            RoundedRectangle(cornerRadius: 4)
                .fill(tint).opacity(0.14)
        }
        .help(tip)
        .onTapGesture { cmux("workspace.select", workspace_id: w.id) }
}

// Status dot, wrapped in a progress ring when there is a plan. Replaces the old
// 150pt bar: it reads at a glance and gives the row's width back to the message.
func dotRing(_ w: Any) -> some View {
    ZStack {
        if let p = w.progress {
            Circle()
                .stroke("#48484A", lineWidth: 2)
                .frame(width: 18, height: 18)
            Circle()
                .trim(from: 0, to: p.value)
                .stroke(dotColor(w), lineWidth: 2)
                .frame(width: 18, height: 18)
                .rotationEffect(.degrees(-90))
        }
        Circle()
            .fill(dotColor(w))
            .frame(width: dotSize(w), height: dotSize(w))
            .opacity(bucket(w) == 1 ? breath() : 1.0)
    }
    .frame(width: 20, height: 20)
}

// The interpreter honours .padding(n) but silently drops the edge forms, and
// scopes a Button's hit area to its label's drawn content — hence .onTapGesture
// on the outermost view, and a background that is never fully transparent.
func row(_ w: Any) -> some View {
    HStack(alignment: .top, spacing: 6) {
        dotRing(w)

        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                if statusGlyph(w) != "" {
                    Text(statusGlyph(w))
                        .font(.system(size: 10))
                        .foregroundColor(statusTint(w))
                        .help(statusTip(w))
                }
                Text(w.title)
                    .font(.system(size: 12))
                    .fontWeight(w.selected ? .semibold : .regular)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                Text(elapsed(w))
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .foregroundColor(.secondary)
            }

            HStack(spacing: 6) {
                // Tapping the branch opens that worktree in the VS Code desktop
                // app — a new window, or focus for the one already on it. It
                // goes through the notification-hook RPC because a sidebar can
                // only call cmux dispatcher methods, and this has to run a
                // command; the row's workspace id rides along for free and is
                // what resolves the worktree.
                if let b = w.branch {
                    Text(b)
                        .font(.system(size: 10))
                        .fontDesign(.monospaced)
                        .foregroundColor(.secondary)
                        .underline()
                        .lineLimit(1)
                        .truncationMode(.head)
                        .help("Open this worktree in VS Code")
                        .onTapGesture {
                            cmux("notification.create", title: "crew",
                                 subtitle: "crew:code", body: b, workspace_id: w.id)
                        }
                }
                if let d = w.dirty {
                    if d {
                        Text("●")
                            .font(.system(size: 8))
                            .foregroundColor("#F5A524")
                            .help("Uncommitted changes in this worktree")
                    }
                }
                // openURL, not browser.open_split. The cmux browser is a separate
                // cookie jar, so every PR and every checks page meant signing
                // into GitHub again in a browser that is not the one holding the
                // session — which is a worse tax than the split was worth.
                //
                // The old form also had to select the row's workspace first, or
                // the split opened on whatever row you were standing on. Handing
                // off to the system browser needs no workspace at all, so the
                // select is gone with it: tapping a link no longer moves you.
                if let pr = w.pr {
                    Text("#\(pr.number)")
                        .font(.system(size: 10))
                        .monospacedDigit()
                        .foregroundColor(pr.status == "open" ? "#4ADE80" : "#9CA3AF")
                        .underline()
                        .help("Open the pull request in your default browser")
                        .onTapGesture { openURL(pr.url) }
                }
                Spacer()
            }

            // Signals crew publishes through `description` — CI, review and
            // merge state. cmux binds none of these directly.
            if has(w, "ci:") || has(w, "review:") || has(w, "pr:conflict")
                || has(w, "sandbox:") || has(w, "planinc:") {
                HStack(spacing: 6) {
                    if let pr = w.pr {
                        // Inlined rather than chipURL for one reason: failing CI
                        // is the loudest thing this row can say and it has always
                        // been bold. Adding a weight parameter would make every
                        // chip call a six-argument positional soup, so this one
                        // pays for itself in duplication.
                        if has(w, "ci:fail") {
                            Text("✗ CI")
                                .font(.system(size: 10)).bold()
                                .foregroundColor("#F97066")
                                .padding(3)
                                .background {
                                    RoundedRectangle(cornerRadius: 4)
                                        .fill("#F97066").opacity(0.14)
                                }
                                .help("Open the failing checks in your default browser")
                                .onTapGesture { openURL("\(pr.url)/checks") }
                        }
                        if has(w, "ci:run") {
                            chipURL("● CI", "#F5A524", "Open the running checks in your default browser",
                                    "\(pr.url)/checks", w)
                        }
                        if has(w, "ci:pass") {
                            chipURL("✓ CI", "#4ADE80", "Open the passing checks in your default browser",
                                    "\(pr.url)/checks", w)
                        }
                    }
                    if has(w, "review:approved") {
                        Text("✓ approved").font(.system(size: 10)).foregroundColor("#4ADE80")
                            .help("A reviewer approved this PR")
                    }
                    if has(w, "review:changes") {
                        Text("↻ changes").font(.system(size: 10)).foregroundColor("#F97066")
                            .help("A reviewer asked for changes")
                    }
                    if has(w, "pr:conflict") {
                        Text("⚠ conflicts").font(.system(size: 10)).foregroundColor("#F97066")
                            .help("This branch conflicts with its base")
                    }
                    if has(w, "pr:draft") {
                        Text("draft").font(.system(size: 10)).foregroundColor(.secondary)
                            .help("The PR is still a draft")
                    }
                    if has(w, "stack:blocked") {
                        Text("⇣ parent open").font(.system(size: 10)).foregroundColor("#F5A524")
                            .help("Stacked on a branch that has not merged yet")
                    }
                    if has(w, "stack:ready") {
                        Text("⇣ stacked").font(.system(size: 10)).foregroundColor(.secondary)
                            .help("Stacked on a branch that has already merged")
                    }
                    // Jira, from the slugged token crew publishes. Only the
                    // statuses this board actually sees are mapped; adding one
                    // is a single line. An unmapped status shows nothing rather
                    // than a slug, since the token cannot be un-slugged here.
                    if has(w, "jira:blocked") {
                        Text("⊘ blocked").font(.system(size: 10)).foregroundColor("#F97066")
                            .help("Jira: Blocked")
                    }
                    if has(w, "jira:in-review") {
                        Text("⊙ in review").font(.system(size: 10)).foregroundColor("#F5A524")
                            .help("Jira: In Review")
                    }
                    if has(w, "jira:in-progress") {
                        Text("⊙ in progress").font(.system(size: 10)).foregroundColor("#60A5FA")
                            .help("Jira: In Progress")
                    }
                    if has(w, "jira:ready") {
                        Text("⊙ ready").font(.system(size: 10)).foregroundColor(.secondary)
                            .help("Jira: Ready for Development")
                    }
                    if has(w, "jira:done") {
                        Text("⊙ done").font(.system(size: 10)).foregroundColor("#4ADE80")
                            .help("Jira: Done")
                    }
                    // This worktree's agent runs in a Docker Sandboxes microVM.
                    // Tappable both ways through the notification-hook RPC, the
                    // same channel the reclaim button below uses — the sidebar
                    // has no way to run a shell command directly.
                    if has(w, "sandbox:running") {
                        chipRPC("▣ sandbox", "#60A5FA",
                                "Running in a Docker sandbox — tap to stop it",
                                "crew:sandbox-down", w)
                    }
                    if has(w, "sandbox:stopped") {
                        chipRPC("▢ sandbox", "#8E8E93",
                                "Sandbox is stopped — tap to start it",
                                "crew:sandbox-up", w)
                    }
                    // --- deep-plan increments ----------------------------
                    // The count is a status and stays bare text; the two chips do
                    // something, and that distinction is the whole affordance rule
                    // above chipRPC.
                    if has(w, "planinc:") {
                        Text(planCount(tokenValue(w, "planinc")))
                            .font(.system(size: 10))
                            .monospacedDigit()
                            .foregroundColor(has(w, "plan:gate") ? "#F5A524" : "#A78BFA")
                            .help("Increments done in this plan")
                    }
                    // The go-ahead, from the board. It authorizes the NEXT increment
                    // only — the one the label names — because that is the single
                    // decision a tap can carry unambiguously.
                    if has(w, "plannext:") {
                        chipRPC(planGoLabel(tokenValue(w, "plannext")), "#F5A524",
                                planGoTip(tokenValue(w, "plannext")),
                                "crew:plan-go", w)
                    }
                    // Opens the plan's live page in your default browser: the review
                    // surface before the check passes, the working surface after.
                    // A file:// URL through openURL, not a cmux browser split — a
                    // fired command is detached and the cmux CLI refuses those.
                    if has(w, "planpath:") {
                        chipURL("plan →", "#A78BFA",
                                "Open this plan's live page",
                                planUrl(tokenValue(w, "planpath")), w)
                    }
                    Spacer()
                }
            }

            // --- the blocked ask -----------------------------------------
            // Reply is offered only while crew has proved the ask is live:
            // pending, inside the 120s window, and an agent with a live pid
            // actually waiting. Everything else gets jump, which always works.
            if has(w, "feed:") {
                HStack(spacing: 6) {
                    if feedLeft(w) > 0 {
                        Text("\(feedLeft(w))s")
                            .font(.system(size: 10))
                            .monospacedDigit()
                            .foregroundColor(feedLeft(w) < 30 ? "#F97066" : "#F5A524")
                        if has(w, "feedgate:allow") {
                            chipRPC("allow", "#4ADE80", "Approve what the agent asked for",
                                    "crew:feed-allow", w)
                        }
                        // Denying is safe even if the window closed under you:
                        // the worst case is a no-op and the agent keeps waiting.
                        chipRPC("deny", "#F97066", "Refuse it; the agent keeps waiting",
                                "crew:feed-deny", w)
                        if has(w, "feedgate:read") {
                            chipJump("read it →", "#F5A524",
                                     "Too long to answer from here — jump to the workspace", w)
                        }
                    }
                    if feedLeft(w) < 1 {
                        chipJump("jump →", "#60A5FA",
                                 "The reply window has closed — answer in the workspace", w)
                    }
                    Spacer()
                }
            }

            // The plan's label stays; the bar it used to sit under is now the
            // ring around the dot.
            if let p = w.progress {
                Text(p.label)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            // Merged rows twinkle for a while, then start asking for the disk
            // back. 94 sessions here already point at worktrees removed without
            // anything noticing; this is the nudge that stops the next 94.
            if bucket(w) == 3 {
                if age(w) > 3600 {
                    // Rides the same notification-hook RPC channel as the
                    // refresh button; the hook reads the workspace id straight
                    // off the notification payload.
                    //
                    // Unlike every other chip, this one does not perform its
                    // verb. The hook opens a terminal in whichever workspace
                    // you are looking at, runs the dry run there and leaves a
                    // y/N sitting at the bottom — a stray click on a row you
                    // were only scrolling past should not cost you a gigabyte
                    // of worktree and a branch.
                    Text("shipped · reclaim this worktree")
                        .font(.system(size: 10))
                        .foregroundColor("#C4B5FD")
                        .padding(3)
                        .background {
                            RoundedRectangle(cornerRadius: 4)
                                .fill("#8B5CF6").opacity(0.18)
                        }
                        .help("Dry-run the reclaim in a terminal, and ask before deleting anything")
                        .onTapGesture {
                            cmux("notification.create", title: "crew",
                                 subtitle: "crew:reclaim", body: w.title,
                                 workspace_id: w.id)
                        }
                }
            }

            if isReadable(rowMessage(w)) {
                Text(rowMessage(w))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .opacity(0.75)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
        }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(6)
    // Always drawn, never fully transparent: a view at opacity 0 is not
    // reliably hit-testable, so an invisible resting state would leave gaps in
    // the click target.
    .background {
        RoundedRectangle(cornerRadius: 5)
            .fill("#8E8E93")
            .opacity(w.selected ? 0.18 : 0.05)
    }
    // Idle rows recede so the board foregrounds what matters; waiting rows wilt
    // with age. Never to zero, for the hit-testing reason above.
    //
    // Greyscale already does most of the receding, so the opacity only needs to
    // nudge — combining a hard desaturate with a deep fade made idle rows
    // harder to read than "quiet" warrants.
    .saturation(bucket(w) == 4 ? 0.0 : 1.0)
    .opacity(bucket(w) == 4 ? 0.68 : wilt(w))
    // The worktree's identity color, worn on the leading edge.
    //
    // `w.color` IS cmux's custom_color — the field its own workspace strip uses —
    // which crew-sync sets with `workspace-action set-color`. So this is the one
    // crew signal that needs no description token: the DSL already binds it, and
    // the same hex reaches VS Code through Peacock. See bin/crew-color.
    //
    // Placed after .saturation and .opacity on purpose. Those two exist to make
    // idle rows recede, and desaturating the sliver would turn every idle row's
    // stripe the same grey — which is precisely the rows you scan when you are
    // hunting for a worktree. It keeps its hue and dims itself instead.
    //
    // An overlay, not another HStack element: overlay content is sized to its
    // parent, so the bar spans the row's full height without needing a height
    // constant that would have to be re-guessed every time a chip strip is added.
    // `.frame(width:)` alone constrains one axis and lets the other fill.
    //
    // Before .onTapGesture, so the composed view carries the gesture and the
    // stripe selects the row like the rest of it rather than swallowing the tap.
    .overlay(alignment: .leading) {
        if let c = w.color {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(c)
                .frame(width: 3)
                .opacity(bucket(w) == 4 ? 0.55 : 0.9)
        }
    }
    // Deliberately no .help here. A tooltip on the whole row fires whenever the
    // pointer rests anywhere on the board, which is most of the time you are
    // reading it; the selection background is affordance enough for "this is a
    // row you can click". Tooltips are reserved for the small targets inside.
    .onTapGesture { cmux("workspace.select", workspace_id: w.id) }
}

func section(_ title: String, _ tint: String, _ b: Int) -> some View {
    let items = workspaces.filter { bucket($0) == b }
    return VStack(alignment: .leading, spacing: 1) {
        if items.count > 0 {
            HStack(spacing: 5) {
                Text(title)
                    .font(.system(size: 10))
                    .fontWeight(.semibold)
                    .textCase(.uppercase)
                    .foregroundColor(tint)
                Text("\(items.count)")
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .foregroundColor(.secondary)
                Spacer()
            }
            .frame(height: 22)
            .padding(6)

            ForEach(items.prefix(12)) { w in
                row(w)
            }
        }
    }
}

// --- time of day --------------------------------------------------------------
// Measured peak here is 9am-1pm with a 20:00 tail, so the header tracks the
// actual working day rather than being decoration.
func dayGlyph() -> String {
    let h = clock.hour
    if h < 6 { return "★" }
    if h < 9 { return "☀" }
    if h < 17 { return "☀" }
    if h < 20 { return "◑" }
    return "☾"
}

func dayTint() -> String {
    let h = clock.hour
    if h < 6 { return "#5B6494" }
    if h < 9 { return "#F0A868" }
    if h < 17 { return "#E8C468" }
    if h < 20 { return "#E08D5A" }
    return "#8B7BC0"
}


// --- mascot ------------------------------------------------------------------
// A tuxedo cat, drawn as rectangles because the interpreter has no image
// loading (Image is SF Symbols only; .resizable and AsyncImage are unsupported).
// Each pose is a list of [x, y, colour]; only opaque pixels are emitted, so the
// worst pose costs 92 nodes — inside the evaluation budget.
//
// The sprite data and the pixel size live INSIDE mascot() on purpose. A
// top-level `let` is not visible from inside a func body in this interpreter —
// built-in bindings like `workspaces` are, user constants are not — so hoisting
// them out silently yields nothing and the cat never draws. See FINDINGS.md.
//
// It reads the same signals the board does:
//   swat   a "needs you" row that is actually recent, or a live Feed ask
//   pace   anything working
//   nap    otherwise

// The sidebar background is near-black, so a true-black cat is a hole in the
// screen — only its white markings read. The body is a charcoal instead, with a
// darker shade for depth, which is what makes the tuxedo pattern legible.
func catColor(_ i: Int) -> String {
    if i == 1 { return "#36363F" }        // body — charcoal, not black
    if i == 2 { return "#F5F5F7" }        // bib, paws, muzzle, tail tip
    if i == 3 { return "#8BE07C" }        // eye
    if i == 4 { return "#F4A6B8" }        // nose
    if i == 6 { return "#22222A" }        // inner ear / shading
    return "#5A5A62"                      // closed eye
}

// 2 = swat, 1 = pace, 0 = nap.
func catMood() -> Int {
    let urgent = workspaces.filter { bucket($0) == 0 && (feedLeft($0) > 0 || age($0) < 120) }
    if urgent.count > 0 { return 2 }
    if workspaces.filter { bucket($0) == 1 || bucket($0) == 5 }.count > 0 { return 1 }
    return 0
}

// Triangle wave: out along the shelf, then back. 16s round trip.
func catStep() -> Int {
    let n = clock.second % 16
    return n < 8 ? n : (15 - n)
}

func catX() -> Double {
    if catMood() != 1 { return 0.0 }
    return Double(catStep()) * 5.0
}

// Mirror by remapping x rather than negative-scaling, which is not supported.
func catFlip() -> Bool {
    if catMood() != 1 { return false }
    return (clock.second % 16) > 7
}

// Vertical motion. The nap rides a slow 8s curve so the whole cat rises and
// settles rather than ticking between two positions; the walk gets a 1px bounce
// on the closed-stride frame, which is what sells it as weight shifting.
func catBob() -> Double {
    let m = catMood()
    if m == 0 {
        let n = clock.second % 8
        if n < 2 { return 0.0 }
        if n < 4 { return 1.0 }
        if n < 6 { return 2.0 }
        return 1.0
    }
    if m == 1 { return (clock.second % 2) == 0 ? 0.0 : 1.0 }
    return 0.0
}

func catLunge() -> Double {
    if catMood() == 2 { return (clock.second % 2) == 0 ? 0.0 : 3.0 }
    return 0.0
}

func catSays() -> String {
    let m = catMood()
    if m == 2 { return "hey. hey. HEY." }
    if m == 1 { return "supervising" }
    return "off duty"
}

func mascot() -> some View {
    let px = 3.0
    let NAP_A = [[5,1,1],[6,1,1],[12,1,1],[13,1,1],[4,2,1],[5,2,6],[6,2,1],[7,2,1],[8,2,1],[9,2,1],[10,2,1],[11,2,1],[12,2,6],[13,2,1],[3,3,1],[4,3,1],[5,3,1],[6,3,1],[7,3,1],[8,3,1],[9,3,1],[10,3,1],[11,3,1],[12,3,1],[13,3,1],[14,3,1],[3,4,1],[4,4,1],[5,4,5],[6,4,5],[7,4,1],[8,4,1],[9,4,1],[10,4,1],[11,4,5],[12,4,5],[13,4,1],[14,4,1],[15,4,1],[2,5,1],[3,5,1],[4,5,1],[5,5,1],[6,5,1],[7,5,2],[8,5,2],[9,5,2],[10,5,2],[11,5,1],[12,5,1],[13,5,1],[14,5,1],[15,5,1],[2,6,1],[3,6,1],[4,6,1],[5,6,1],[6,6,1],[7,6,2],[8,6,4],[9,6,2],[10,6,1],[11,6,1],[12,6,1],[13,6,1],[14,6,1],[15,6,1],[16,6,1],[1,7,1],[2,7,1],[3,7,1],[4,7,2],[5,7,2],[6,7,2],[7,7,2],[8,7,2],[9,7,2],[10,7,2],[11,7,2],[12,7,1],[13,7,1],[14,7,1],[15,7,1],[16,7,1],[17,7,2],[1,8,1],[2,8,1],[3,8,2],[4,8,2],[5,8,2],[6,8,2],[7,8,2],[8,8,2],[9,8,2],[10,8,2],[11,8,2],[12,8,2],[13,8,1],[14,8,1],[15,8,1],[16,8,2],[17,8,2],[2,9,1],[3,9,2],[4,9,2],[5,9,2],[6,9,2],[7,9,2],[8,9,2],[9,9,2],[10,9,2],[11,9,2],[12,9,2],[13,9,1],[14,9,1],[15,9,1],[16,9,2],[3,10,1],[4,10,1],[5,10,1],[6,10,1],[7,10,1],[8,10,1],[9,10,1],[10,10,1],[11,10,1],[12,10,1],[13,10,1],[14,10,1]]
    let NAP_B = [[5,1,1],[6,1,1],[12,1,1],[13,1,1],[4,2,1],[5,2,6],[6,2,1],[7,2,1],[8,2,1],[9,2,1],[10,2,1],[11,2,1],[12,2,6],[13,2,1],[2,3,1],[3,3,1],[4,3,1],[5,3,1],[6,3,1],[7,3,1],[8,3,1],[9,3,1],[10,3,1],[11,3,1],[12,3,1],[13,3,1],[14,3,1],[15,3,1],[2,4,1],[3,4,1],[4,4,1],[5,4,5],[6,4,5],[7,4,1],[8,4,1],[9,4,1],[10,4,1],[11,4,5],[12,4,5],[13,4,1],[14,4,1],[15,4,1],[16,4,1],[2,5,1],[3,5,1],[4,5,1],[5,5,1],[6,5,1],[7,5,2],[8,5,2],[9,5,2],[10,5,2],[11,5,1],[12,5,1],[13,5,1],[14,5,1],[15,5,1],[16,5,1],[1,6,1],[2,6,1],[3,6,1],[4,6,1],[5,6,1],[6,6,1],[7,6,2],[8,6,4],[9,6,2],[10,6,1],[11,6,1],[12,6,1],[13,6,1],[14,6,1],[15,6,1],[16,6,1],[17,6,1],[1,7,1],[2,7,1],[3,7,1],[4,7,2],[5,7,2],[6,7,2],[7,7,2],[8,7,2],[9,7,2],[10,7,2],[11,7,2],[12,7,1],[13,7,1],[14,7,1],[15,7,1],[16,7,1],[17,7,2],[1,8,1],[2,8,1],[3,8,2],[4,8,2],[5,8,2],[6,8,2],[7,8,2],[8,8,2],[9,8,2],[10,8,2],[11,8,2],[12,8,2],[13,8,1],[14,8,1],[15,8,1],[16,8,2],[17,8,2],[2,9,1],[3,9,2],[4,9,2],[5,9,2],[6,9,2],[7,9,2],[8,9,2],[9,9,2],[10,9,2],[11,9,2],[12,9,2],[13,9,1],[14,9,1],[15,9,1],[16,9,2],[3,10,1],[4,10,1],[5,10,1],[6,10,1],[7,10,1],[8,10,1],[9,10,1],[10,10,1],[11,10,1],[12,10,1],[13,10,1],[14,10,1]]
    let WALK_A = [[10,0,1],[14,0,1],[0,1,2],[9,1,1],[10,1,1],[11,1,1],[12,1,1],[13,1,1],[14,1,1],[15,1,1],[0,2,2],[1,2,1],[9,2,1],[10,2,1],[11,2,3],[12,2,1],[13,2,1],[14,2,1],[15,2,1],[16,2,1],[1,3,1],[2,3,1],[8,3,1],[9,3,1],[10,3,1],[11,3,1],[12,3,1],[13,3,1],[14,3,2],[15,3,2],[16,3,4],[1,4,1],[2,4,1],[3,4,1],[4,4,1],[5,4,1],[6,4,1],[7,4,1],[8,4,1],[9,4,1],[10,4,1],[11,4,1],[12,4,1],[13,4,1],[14,4,1],[15,4,2],[16,4,2],[2,5,1],[3,5,1],[4,5,1],[5,5,1],[6,5,1],[7,5,1],[8,5,1],[9,5,1],[10,5,1],[11,5,1],[12,5,1],[13,5,1],[14,5,1],[15,5,2],[2,6,1],[3,6,1],[4,6,1],[5,6,1],[6,6,1],[7,6,1],[8,6,1],[9,6,1],[10,6,1],[11,6,1],[12,6,1],[13,6,1],[14,6,1],[2,7,1],[3,7,1],[4,7,1],[5,7,1],[6,7,1],[7,7,1],[8,7,1],[9,7,1],[10,7,1],[11,7,1],[12,7,1],[13,7,1],[14,7,1],[2,8,1],[3,8,1],[7,8,1],[8,8,1],[11,8,1],[12,8,1],[16,8,1],[17,8,1],[2,9,1],[3,9,1],[7,9,1],[8,9,1],[11,9,1],[12,9,1],[16,9,1],[17,9,1],[2,10,2],[3,10,2],[7,10,2],[8,10,2],[11,10,2],[12,10,2],[16,10,2],[17,10,2]]
    let WALK_B = [[0,1,2],[10,1,1],[14,1,1],[0,2,2],[1,2,1],[9,2,1],[10,2,1],[11,2,1],[12,2,1],[13,2,1],[14,2,1],[15,2,1],[1,3,1],[2,3,1],[9,3,1],[10,3,1],[11,3,3],[12,3,1],[13,3,1],[14,3,1],[15,3,1],[16,3,1],[1,4,1],[2,4,1],[3,4,1],[4,4,1],[5,4,1],[6,4,1],[7,4,1],[8,4,1],[9,4,1],[10,4,1],[11,4,1],[12,4,1],[13,4,1],[14,4,2],[15,4,2],[16,4,4],[2,5,1],[3,5,1],[4,5,1],[5,5,1],[6,5,1],[7,5,1],[8,5,1],[9,5,1],[10,5,1],[11,5,1],[12,5,1],[13,5,1],[14,5,1],[15,5,2],[16,5,2],[2,6,1],[3,6,1],[4,6,1],[5,6,1],[6,6,1],[7,6,1],[8,6,1],[9,6,1],[10,6,1],[11,6,1],[12,6,1],[13,6,1],[14,6,1],[15,6,2],[2,7,1],[3,7,1],[4,7,1],[5,7,1],[6,7,1],[7,7,1],[8,7,1],[9,7,1],[10,7,1],[11,7,1],[12,7,1],[13,7,1],[14,7,1],[4,8,1],[5,8,1],[6,8,1],[7,8,1],[12,8,1],[13,8,1],[14,8,1],[15,8,1],[4,9,1],[5,9,1],[6,9,1],[7,9,1],[12,9,1],[13,9,1],[14,9,1],[15,9,1],[4,10,2],[5,10,2],[7,10,2],[12,10,2],[13,10,2],[15,10,2]]
    let SWAT_A = [[4,1,1],[5,1,1],[12,1,1],[13,1,1],[4,2,1],[5,2,6],[6,2,1],[11,2,1],[12,2,6],[13,2,1],[3,3,1],[4,3,1],[5,3,1],[6,3,1],[7,3,1],[8,3,1],[9,3,1],[10,3,1],[11,3,1],[12,3,1],[13,3,1],[14,3,1],[3,4,1],[4,4,1],[5,4,3],[6,4,1],[7,4,1],[8,4,1],[9,4,1],[10,4,1],[11,4,1],[12,4,3],[13,4,1],[14,4,1],[3,5,1],[4,5,1],[5,5,1],[6,5,1],[7,5,1],[8,5,2],[9,5,2],[10,5,1],[11,5,1],[12,5,1],[13,5,1],[14,5,1],[2,6,1],[3,6,1],[4,6,1],[5,6,1],[6,6,1],[7,6,2],[8,6,4],[9,6,2],[10,6,2],[11,6,1],[12,6,1],[13,6,1],[14,6,1],[15,6,1],[2,7,1],[3,7,1],[4,7,1],[5,7,2],[6,7,2],[7,7,2],[8,7,2],[9,7,2],[10,7,2],[11,7,2],[12,7,2],[13,7,1],[14,7,1],[15,7,1],[1,8,1],[2,8,1],[3,8,1],[4,8,2],[5,8,2],[6,8,2],[7,8,2],[8,8,2],[9,8,2],[10,8,2],[11,8,2],[12,8,2],[13,8,2],[14,8,1],[15,8,1],[16,8,1],[1,9,1],[2,9,1],[3,9,2],[4,9,2],[5,9,2],[6,9,2],[7,9,2],[8,9,2],[9,9,2],[10,9,2],[11,9,2],[12,9,2],[13,9,2],[14,9,2],[15,9,1],[16,9,1],[2,10,1],[3,10,1],[4,10,2],[5,10,2],[6,10,2],[7,10,2],[8,10,2],[9,10,2],[10,10,2],[11,10,2],[12,10,2],[13,10,2],[14,10,1],[15,10,1],[3,11,2],[4,11,2],[13,11,2],[14,11,2]]
    let SWAT_B = [[4,1,1],[5,1,1],[12,1,1],[13,1,1],[4,2,1],[5,2,6],[6,2,1],[11,2,1],[12,2,6],[13,2,1],[3,3,1],[4,3,1],[5,3,1],[6,3,1],[7,3,1],[8,3,1],[9,3,1],[10,3,1],[11,3,1],[12,3,1],[13,3,1],[14,3,1],[3,4,1],[4,4,1],[5,4,3],[6,4,1],[7,4,1],[8,4,1],[9,4,1],[10,4,1],[11,4,1],[12,4,3],[13,4,1],[14,4,1],[3,5,1],[4,5,1],[5,5,1],[6,5,1],[7,5,1],[8,5,2],[9,5,2],[10,5,1],[11,5,1],[12,5,1],[13,5,1],[14,5,1],[2,6,1],[3,6,1],[4,6,1],[5,6,1],[6,6,1],[7,6,2],[8,6,4],[9,6,2],[10,6,2],[11,6,1],[12,6,1],[13,6,1],[14,6,1],[15,6,1],[2,7,1],[3,7,1],[4,7,1],[5,7,2],[6,7,2],[7,7,2],[8,7,2],[9,7,2],[10,7,2],[11,7,2],[12,7,2],[13,7,1],[14,7,1],[15,7,1],[1,8,1],[2,8,1],[3,8,1],[4,8,2],[5,8,2],[6,8,2],[7,8,2],[8,8,2],[9,8,2],[10,8,2],[11,8,2],[12,8,2],[13,8,2],[14,8,1],[15,8,1],[16,8,1],[17,8,1],[1,9,1],[2,9,1],[3,9,2],[4,9,2],[5,9,2],[6,9,2],[7,9,2],[8,9,2],[9,9,2],[10,9,2],[11,9,2],[12,9,2],[13,9,2],[14,9,2],[15,9,1],[16,9,2],[17,9,2],[2,10,1],[3,10,1],[4,10,2],[5,10,2],[6,10,2],[7,10,2],[8,10,2],[9,10,2],[10,10,2],[11,10,2],[12,10,2],[13,10,2],[14,10,1],[15,10,1],[3,11,2],[4,11,2]]
    let mood = catMood()
    let even = (clock.second % 2) == 0
    // A sleeping cat breathes slower than a walking one strides.
    let inhale = (clock.second % 6) < 3
    let frame = mood == 2 ? (even ? SWAT_A : SWAT_B)
              : mood == 1 ? (even ? WALK_A : WALK_B)
              : (inhale ? NAP_B : NAP_A)
    let flip = catFlip()
    let dx = catX() + catLunge()
    let dy = catBob()

    return HStack(spacing: 8) {
        ZStack(alignment: .topLeading) {
            // Sleep needs a cue that survives a glance: a breathing curve alone
            // reads as "static sprite" at 1Hz. Three z's on staggered phases
            // drift up and fade, which is unmistakable and costs three nodes.
            if mood == 0 {
                ForEach([0, 1, 2]) { i in
                    Text("z")
                        .font(.system(size: 7 + i * 2))
                        .foregroundColor("#8BA3C7")
                        .opacity(0.75 - 0.22 * Double((clock.second + i * 2) % 6))
                        .offset(x: 44.0 + Double(i) * 5.0,
                                y: 8.0 - Double((clock.second + i * 2) % 6) * 2.0)
                }
            }
            ForEach(frame) { p in
                Rectangle()
                    .fill(catColor(p[2]))
                    .frame(width: px, height: px)
                    .offset(x: (flip ? Double(17 - p[0]) : Double(p[0])) * px + dx,
                            y: Double(p[1]) * px + dy)
            }
        }
        .frame(width: 112, height: 40, alignment: .leading)
        Spacer()
        Text(catSays())
            .font(.system(size: 9))
            .foregroundColor(.secondary)
            .opacity(0.55)
    }
    .frame(height: 46)
    .padding(6)
}

VStack(alignment: .leading, spacing: 0) {
    HStack(spacing: 6) {
        Text(dayGlyph())
            .font(.system(size: 11))
            .foregroundColor(dayTint())
        Text("crew")
            .font(.system(size: 12))
            .bold()
        Spacer()
        if unreadTotal > 0 {
            Text("\(unreadTotal)")
                .font(.system(size: 10))
                .monospacedDigit()
                .bold()
                .foregroundColor("#FFFFFF")
                .frame(width: 17, height: 17)
                .background { Circle().fill("#F97066") }
        }
        // Force a reconcile. The interpreter can only invoke cmux dispatcher
        // methods — no shell, and no "run this action id" — so this posts a
        // notification carrying a marker, and crew's notification hook turns it
        // into `crew-sync` and swallows every effect. See FINDINGS.md.
        //
        // The rotation is the only feedback available without @State: it ticks
        // continuously, so the control always looks live rather than dead.
        Text("↻")
            .font(.system(size: 12))
            .foregroundColor(.secondary)
            .rotationEffect(.degrees(clock.second * 6))
            .frame(width: 18, height: 18)
            .background { Circle().fill("#8E8E93").opacity(0.10) }
            .help("Force a full reconcile")
            .onTapGesture {
                cmux("notification.create", title: "crew", subtitle: "crew:sync-now", body: "refresh")
            }

        // How long ago that last happened. Sits against the ↻ on purpose: the
        // number is the reason to press the button, and reading it as one control
        // is the point. Bare text, not a chip — under the board's own convention
        // that means it is a status and does nothing, which is true.
        Text(syncLabel())
            .font(.system(size: 9))
            .monospacedDigit()
            .foregroundColor(syncTint())
            .help(syncTip())

        Text(clock.time)
            .font(.system(size: 10))
            .monospacedDigit()
            .foregroundColor(dayTint())
            .opacity(0.85)
    }
    .frame(height: 26)
    .padding(6)

    Divider()

    ScrollView {
        VStack(alignment: .leading, spacing: 0) {
            section("Needs you", "#F97066", 0)
            section("Planning · not editing yet", "#A78BFA", 5)
            section("Working", "#4C8DFF", 1)
            section("Review", "#F5A524", 2)
            section("Merged · can clean up", "#8B5CF6", 3)
            section("Idle", "#6B7280", 4)

            if workspaceCount == 0 {
                Text("No workspaces")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .padding(12)
            }
        }
        .padding(6)
    }

    Divider()
    mascot()
}
