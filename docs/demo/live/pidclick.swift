// pidclick — a left click posted to one process at a screen point, so the
// real cursor never moves. For web content with no accessible button (the
// board's chips), where axpress has nothing to press.
//
//   swiftc -O pidclick.swift -o pidclick
//   ./pidclick PID X Y           X Y in screen points (top-left origin)
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 4, let pid = Int32(a[1]), let x = Double(a[2]), let y = Double(a[3]) else {
  print("usage: pidclick PID X Y"); exit(2)
}
let p = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .hidSystemState)
for (type, wait) in [(CGEventType.mouseMoved, 0.05), (.leftMouseDown, 0.06), (.leftMouseUp, 0.0)] {
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
  e.setIntegerValueField(.mouseEventClickState, value: 1)
  e.postToPid(pid)
  Thread.sleep(forTimeInterval: wait)
}
print("clicked \(x),\(y)")
