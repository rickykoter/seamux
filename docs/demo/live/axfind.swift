// axfind — where a piece of text sits on screen in one app, through
// accessibility (web content included): the center of the first element
// whose value, title or description is exactly TEXT.
//
//   swiftc -O axfind.swift -o axfind
//   ./axfind PID TEXT [N]        prints "X Y" in screen points; N picks the Nth match (1-based)
import ApplicationServices
import Foundation

let a = CommandLine.arguments
guard a.count >= 3, let pid = Int32(a[1]) else { print("usage: axfind PID TEXT [N]"); exit(2) }
let want = a[2]
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
func walk(_ e: AXUIElement, _ depth: Int) -> CGPoint? {
  if depth > 60 || seen > 20000 { return nil }
  seen += 1
  for k in [kAXValueAttribute as String, kAXTitleAttribute as String, kAXDescriptionAttribute as String] where str(e, k) == want {
    nth -= 1
    if nth == 0, let c = center(e) { return c }
    break
  }
  var kids: CFTypeRef?
  guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids) == .success, let list = kids as? [AXUIElement] else { return nil }
  for k in list { if let c = walk(k, depth + 1) { return c } }
  return nil
}
let app = AXUIElementCreateApplication(pid)
if let c = walk(app, 0) { print("\(Int(c.x)) \(Int(c.y))"); exit(0) }
FileHandle.standardError.write("axfind: no \(want)\n".data(using: .utf8)!)
exit(1)
