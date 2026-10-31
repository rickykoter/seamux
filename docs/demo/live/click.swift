// click — a real left click, or a drag, at screen points: the cursor moves
// there, as a person's would. Web content that ignores accessibility presses
// (the board's cards, a splitter's handle) takes these. The app under the
// point must be in front.
//
//   swiftc -O click.swift -o click
//   ./click X Y                  click at X Y (screen points, top-left origin)
//   ./click X Y X2 Y2            press at X Y, drag to X2 Y2, release
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 3 || a.count == 5, let x = Double(a[1]), let y = Double(a[2]) else {
  print("usage: click X Y [X2 Y2]"); exit(2)
}
let to = CGPoint(x: x, y: y)

func post(_ type: CGEventType, _ p: CGPoint) {
  let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
  e.setIntegerValueField(.mouseEventClickState, value: 1)
  e.post(tap: .cghidEventTap)
}
// Glide from one point to another over ~0.35s, so a film of it reads as a hand.
func glide(_ from: CGPoint, _ to: CGPoint, _ type: CGEventType) {
  for i in 1...14 {
    let t = Double(i) / 14, e = t * t * (3 - 2 * t)
    post(type, CGPoint(x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e))
    Thread.sleep(forTimeInterval: 0.025)
  }
}

glide(CGEvent(source: nil)?.location ?? to, to, .mouseMoved)
Thread.sleep(forTimeInterval: 0.08)
post(.leftMouseDown, to)
Thread.sleep(forTimeInterval: 0.06)
if a.count == 5, let x2 = Double(a[3]), let y2 = Double(a[4]) {
  let end = CGPoint(x: x2, y: y2)
  glide(to, end, .leftMouseDragged)
  Thread.sleep(forTimeInterval: 0.06)
  post(.leftMouseUp, end)
  print("dragged \(Int(x)),\(Int(y)) to \(Int(x2)),\(Int(y2))")
} else {
  post(.leftMouseUp, to)
  print("clicked \(Int(x)),\(Int(y))")
}
