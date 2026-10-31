// click — a real left click at a screen point: the cursor moves there, as a
// person's would. Web content that ignores accessibility presses (the board's
// cards) takes these. The app under the point must be in front.
//
//   swiftc -O click.swift -o click
//   ./click X Y                  X Y in screen points (top-left origin)
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 3, let x = Double(a[1]), let y = Double(a[2]) else { print("usage: click X Y"); exit(2) }
let to = CGPoint(x: x, y: y)
let from = CGEvent(source: nil)?.location ?? to
// Glide there over ~0.35s, so a film of it reads as a hand on a mouse.
for i in 1...14 {
  let t = Double(i) / 14, e = t * t * (3 - 2 * t)
  let p = CGPoint(x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.025)
}
Thread.sleep(forTimeInterval: 0.08)
for type in [CGEventType.leftMouseDown, .leftMouseUp] {
  let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: to, mouseButton: .left)!
  e.setIntegerValueField(.mouseEventClickState, value: 1)
  e.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.06)
}
print("clicked \(Int(x)),\(Int(y))")
