// axpress — press the control at a screen point in one app, through
// accessibility: no mouse move, no focus change.
//
//   swiftc -O axpress.swift -o axpress
//   ./axpress PID X Y            X Y in screen points (top-left origin)
//
// Walks up from the element at the point to the first one that offers
// AXPress and performs it; prints its role and title.
import ApplicationServices
import Foundation

let a = CommandLine.arguments
guard a.count == 4, let pid = Int32(a[1]), let x = Float(a[2]), let y = Float(a[3]) else {
  print("usage: axpress PID X Y"); exit(2)
}
let app = AXUIElementCreateApplication(pid)
var hit: AXUIElement?
guard AXUIElementCopyElementAtPosition(app, x, y, &hit) == .success, var el = hit else {
  print("axpress: nothing at \(x),\(y)"); exit(1)
}
func attr(_ e: AXUIElement, _ k: String) -> String {
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(e, k as CFString, &v)
  return (v as? String) ?? ""
}
for _ in 0..<8 {
  var names: CFArray?
  AXUIElementCopyActionNames(el, &names)
  if let n = names as? [String], n.contains(kAXPressAction as String) {
    let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
    print("pressed \(attr(el, kAXRoleAttribute)) \(attr(el, kAXTitleAttribute))\(attr(el, kAXDescriptionAttribute)) \(r == .success ? "" : "(\(r.rawValue))")")
    exit(r == .success ? 0 : 1)
  }
  var p: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &p) == .success, let parent = p else { break }
  el = parent as! AXUIElement
}
print("axpress: nothing pressable at \(x),\(y)"); exit(1)
