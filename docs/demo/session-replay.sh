#!/bin/zsh
# session-replay — a scripted Claude Code transcript for the checkout-flow demo
# row. Companion to board-demo.py: run it in a cmux terminal pane so the left
# side of the screen tells the same story the board is telling on the right.
#
#   cmux new-pane --type terminal --workspace workspace:3 \
#        --command 'docs/demo/session-replay.sh; exec zsh'
#
# Nothing here is a real session: it types a plausible transcript and stops at
# the moment the story needs — increment 3 gated, waiting for your `go 3`.
# --fast skips the typing delays.

FAST=""; [[ "$1" == "--fast" ]] && FAST=1

# Claude Code-ish palette on 256 colors: orange bullets, dim tool results,
# red for the gate refusal, bold user line.
B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'
OR=$'\e[38;5;173m'; RD=$'\e[38;5;167m'; GN=$'\e[38;5;108m'

say() {  # one line, typed
  local s="$1"
  if [[ -n $FAST ]]; then print -r -- "$s"; return; fi
  local i
  for ((i=1; i<=${#s}; i++)); do print -rn -- "${s[i]}"; sleep 0.004; done
  print
}
pause() { [[ -z $FAST ]] && sleep "$1"; }

clear
pause 1.2
say "${B}> Implement increment 2 of the coupon plan${R}"
pause 0.8
say ""
say "${OR}⏺${R} Increment 2 — ${B}Apply coupon at capture${R}. Reading the plan and the capture path."
pause 0.6
say "${OR}⏺${R} Read(app/checkout/capture.rb)"
say "  ${D}⎿  212 lines${R}"
pause 0.7
say "${OR}⏺${R} Edit(app/checkout/capture.rb)"
say "  ${D}⎿  Updated app/checkout/capture.rb with 34 additions and 6 removals${R}"
pause 0.5
say "${OR}⏺${R} Write(spec/checkout/capture_coupon_spec.rb)"
say "  ${D}⎿  Wrote 61 lines${R}"
pause 0.7
say "${OR}⏺${R} Bash(bundle exec rspec spec/checkout/capture_coupon_spec.rb)"
pause 1.0
say "  ${D}⎿  9 examples, 0 failures${R}"
pause 0.6
say "${OR}⏺${R} Increment 2 done — capture now applies the coupon before settle,"
say "  and the ledger line carries the discounted amount. Marked done in the plan."
pause 0.9
say ""
say "${OR}⏺${R} Moving to increment 3 — ${B}coupon at capture edge cases${R}:"
say "${OR}⏺${R} Edit(app/checkout/capture.rb)"
pause 0.6
say "  ${RD}⎿  deep-plan gate [checkout-flow]: increment 3 is not authorized.${R}"
say "  ${RD}   Ask the human, then: deep-plan go checkout-flow 3   (or the board's go chip)${R}"
pause 0.9
say ""
say "${OR}⏺${R} Increment 3 is ready but gated. ${GN}Approve it with ${B}go 3${R}${GN} on the crew"
say "  board, or take the review page with you — nothing gets edited until then.${R}"
pause 0.4
print -n "\n${D}╭──────────────────────────────────────────────────────────────╮${R}\n"
print -n "${D}│${R} ${B}>${R} █                                                            ${D}│${R}\n"
print -n "${D}╰──────────────────────────────────────────────────────────────╯${R}\n"
print -n "  ${D}checkout-flow · dev/checkout-flow · 2/4 increments · waiting on go 3${R}\n"
