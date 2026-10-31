// axfind — where a piece of text sits on screen in one app, through
// accessibility (web content included): the center of the first element
// whose value, title or description is exactly TEXT.
//
//   swiftc -O axfind.swift -o axfind
//   ./axfind PID TEXT [N]        prints "X Y" in screen points; N picks the Nth match (1-based)
//   ./axfind PID ^TEXT [N]       the same, for a value, title or description that starts with TEXT
//   ./axfind --press PID TEXT [N]  scroll that control into view and press it
//                                (it, or the nearest ancestor that takes a press)
import ApplicationServices
import Foundation

var a = CommandLine.arguments
let press = a.count > 1 && a[1] == "--press"
if press { a.remove(at: 1) }
guard a.count >= 3, let pid = Int32(a[1]) else { print("usage: axfind PID TEXT [N]"); exit(2) }
let prefix = a[2].hasPrefix("^")
let want = prefix ? String(a[2].dropFirst()) : a[2]
var nth = a.count > 3 ? Int(a[3]) ?? 1 : 1

func str(_ e: AXUIElement, _ k: String) -> String {
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(e, k as CFString, &v)
  return (v as? String) ?? ""
}
func center(_ e: AXUIElement) -> CGPoint? {
  var p: CFTypeRef?, s: CFTypeRef?
  guard AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &p) == .success,
    AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &s) == .success else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGPoint(x: pt.x + sz.width / 2, y: pt.y + sz.height / 2)
}
var seen = 0
var found: AXUIElement?
func walk(_ e: AXUIElement, _ depth: Int) -> CGPoint? {
  if depth > 60 || seen > 20000 { return nil }
  seen += 1
  for k in [kAXValueAttribute as String, kAXTitleAttribute as String, kAXDescriptionAttribute as String]
    where prefix ? str(e, k).hasPrefix(want) : str(e, k) == want {
    nth -= 1
    if nth == 0, let c = center(e) { found = e; return c }
    break
  }
  var kids: CFTypeRef?
  guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids) == .success, let list = kids as? [AXUIElement] else { return nil }
  for k in list { if let c = walk(k, depth + 1) { return c } }
  return nil
}
let app = AXUIElementCreateApplication(pid)
if let c = walk(app, 0) {
  guard press, var el = found else { print("\(Int(c.x)) \(Int(c.y))"); exit(0) }
  AXUIElementPerformAction(el, "AXScrollToVisible" as CFString)
  for _ in 0..<8 {
    var names: CFArray?
    AXUIElementCopyActionNames(el, &names)
    if let n = names as? [String], n.contains(kAXPressAction as String) {
      let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
      print(r == .success ? "pressed \(want)" : "press failed (\(r.rawValue))"); exit(r == .success ? 0 : 1)
    }
    var p: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &p) == .success, let parent = p else { break }
    el = parent as! AXUIElement
  }
  print("axfind: \(want) takes no press"); exit(1)
}
FileHandle.standardError.write("axfind: no \(want)\n".data(using: .utf8)!)
exit(1)
