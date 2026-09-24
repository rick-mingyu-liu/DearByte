import AppKit
import ApplicationServices
import Foundation

// One-shot, read-only probe. No AX writes/actions, screenshots, network, or disk output.
// Run from the terminal whose Accessibility permission you have enabled.
let args = Set(CommandLine.arguments.dropFirst())
if args.contains("--help") {
    print("Usage: inspect-wechat [--include-text | --request-permission]\nDefault: structure only. --include-text prints visible UI strings locally, including sidebar labels. --request-permission asks macOS for Accessibility authorization and exits without inspecting WeChat.")
    exit(0)
}
guard args.subtracting(["--include-text", "--request-permission"]).isEmpty else {
    print("Unknown option. Use --help.")
    exit(2)
}
if args.contains("--request-permission") {
    let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(options)
    print(trusted
        ? "Accessibility already authorized. Run the inspector again without --request-permission."
        : "Requested Accessibility authorization. Follow the macOS prompt for the application it identifies, then rerun this helper. No WeChat inspection performed.")
    exit(trusted ? 0 : 3)
}
guard AXIsProcessTrusted() else {
    print("Accessibility access unavailable for this launch context. Run from Ghostty; if still blocked, authorize the application macOS identifies. This probe does not request or change permissions.")
    exit(3)
}
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat")
guard apps.count == 1, let app = apps.first else {
    print("Expected one running com.tencent.xinWeChat application; found \(apps.count). No other app inspected.")
    exit(4)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(root, 1.0)
guard let value = attribute(root, kAXFocusedWindowAttribute),
      CFGetTypeID(value) == AXUIElementGetTypeID() else {
    print("WeChat exposes no focused window. Select the intended chat manually, then retry.")
    exit(5)
}
let window = unsafeBitCast(value, to: AXUIElement.self)
let includeText = args.contains("--include-text")
var count = 0
var seen: [AXUIElement] = []
let deadline = Date().addingTimeInterval(15)
func visit(_ element: AXUIElement, depth: Int) {
    guard count < 350, depth <= 16, Date() < deadline,
          !seen.contains(where: { CFEqual($0, element) }) else { return }
    seen.append(element)
    count += 1
    var row: [String: Any] = ["index": count, "depth": depth]
    for (key, name) in [("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute)] {
        if let text = attribute(element, name) as? String { row[key] = text }
    }
    for (key, name) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("value", kAXValueAttribute)] {
        if let text = attribute(element, name) as? String, !text.isEmpty {
            row[key] = includeText ? String(text.prefix(200)) : "[text present]"
        }
    }
    if let bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]),
       let line = String(data: bytes, encoding: .utf8) { print(line) }
    // Do not enumerate editable text-field children or read other windows.
    if let role = row["role"] as? String, ["AXTextArea", "AXTextField", "AXSecureTextField"].contains(role) { return }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { visit(child, depth: depth + 1) }
    }
}
print("Read-only WeChat window probe; text=\(includeText ? "included" : "redacted"). No clicks, typing, sending, or screenshots.")
visit(window, depth: 0)
print("Finished: \(count) elements; bounded to 350 elements, depth 16, approximately 15 seconds. Missing elements do not prove inaccessible content.")
