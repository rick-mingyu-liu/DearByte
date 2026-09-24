// DearByte WeChat desktop helper. Talks JSON lines over stdin/stdout.
//
// It only touches WeChat's main window through macOS Accessibility:
//   {"cmd":"snapshot"}                    → the open chat's name and message rows
//   {"cmd":"send","chat":"…","text":"…"}  → type into the composer, press Return, confirm
// Sending refuses unless the open chat is the bound one and the composer is
// empty, so it never types into another chat or over someone's draft.
// Nothing here reads WeChat's files, clipboard or screen.

import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let bundleId = "com.tencent.xinWeChat"

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String? { attr(e, name) as? String }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func bool(_ e: AXUIElement, _ name: String) -> Bool? { attr(e, name) as? Bool }

func find(_ e: AXUIElement, role: String, description: String? = nil, depth: Int = 0) -> AXUIElement? {
    if str(e, kAXRoleAttribute) == role, description == nil || str(e, kAXDescriptionAttribute) == description { return e }
    if depth > 8 { return nil }
    for k in kids(e) { if let f = find(k, role: role, description: description, depth: depth + 1) { return f } }
    return nil
}

struct HelperError: Error { let message: String }

struct Chat {
    let app: NSRunningApplication
    let table: AXUIElement
    let composer: AXUIElement
    let windowCount: Int
    /// The composer's title is the open chat's name.
    var name: String { str(composer, kAXTitleAttribute) ?? "" }
    var draft: String { str(composer, kAXValueAttribute) ?? "" }

    /// Row titles, oldest first: "MeSaid:…", "<nickname>Said:…", "<nickname>:Sent aPhoto", time labels, notices.
    /// Throws rather than returning a short list when Accessibility doesn't answer,
    /// so a failed read never looks like an emptied chat.
    func rows() throws -> [String] {
        guard let children = attr(table, kAXChildrenAttribute) as? [AXUIElement] else {
            throw HelperError(message: "read_failed")
        }
        return try children
            .filter { str($0, kAXRoleAttribute) == "AXRow" }
            .map { row in
                guard let cells = attr(row, kAXChildrenAttribute) as? [AXUIElement] else { throw HelperError(message: "read_failed") }
                return cells.flatMap { kids($0) }.compactMap { str($0, kAXTitleAttribute) }.joined()
            }
    }
}

var lastWindowCount = 1

func openChat() throws -> Chat {
    guard AXIsProcessTrusted() else { throw HelperError(message: "no_accessibility_permission") }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
    guard let app = apps.first else { throw HelperError(message: "wechat_not_running") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2.0)
    // The main window is reported even when WeChat is on another Space.
    guard let w = attr(root, kAXMainWindowAttribute) ?? attr(root, kAXFocusedWindowAttribute),
          CFGetTypeID(w) == AXUIElementGetTypeID() else { throw HelperError(message: "no_wechat_window") }
    let window = w as! AXUIElement
    guard let table = find(window, role: "AXTable", description: "Messages"),
          let composer = find(window, role: "AXTextArea") else { throw HelperError(message: "no_open_chat") }
    // Return goes to WeChat's key window. A second (detached chat) window could
    // take it, so refuse while one is open. The list is empty when WeChat is on
    // another Space; the checks after Return still catch a misdirected key.
    // The list is empty when WeChat is on another Space, so remember the last
    // count we could read.
    let windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    if !windows.isEmpty { lastWindowCount = windows.count }
    return Chat(app: app, table: table, composer: composer, windowCount: windows.isEmpty ? lastWindowCount : windows.count)
}

func pressReturn(_ app: NSRunningApplication) {
    let source = CGEventSource(stateID: .privateState)
    for down in [true, false] {
        CGEvent(keyboardEventSource: source, virtualKey: 0x24, keyDown: down)?.postToPid(app.processIdentifier)
        usleep(40_000)
    }
}

func send(chat boundName: String, text: String) throws -> [String: Any] {
    let chat = try openChat()
    guard chat.name == boundName else { throw HelperError(message: "wrong_chat") }
    guard chat.draft.isEmpty else { throw HelperError(message: "composer_not_empty") }
    guard chat.windowCount <= 1 else { throw HelperError(message: "other_window_open") }
    let before = try chat.rows()
    let expected = "MeSaid:\(text)"
    let tail = 3

    guard AXUIElementSetAttributeValue(chat.composer, kAXValueAttribute as CFString, text as CFString) == .success else {
        throw HelperError(message: "fill_failed")
    }
    // Make the composer the element that receives Return.
    AXUIElementSetAttributeValue(chat.composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(150_000)
    // Recheck just before sending: the chat, draft or focus could have changed meanwhile.
    guard chat.draft == text, chat.name == boundName, bool(chat.composer, kAXFocusedAttribute) != false else {
        let code = bool(chat.composer, kAXFocusedAttribute) == false ? "not_focused" : "changed_before_send"
        clear(chat, text, boundName)
        throw HelperError(message: code)
    }
    pressReturn(chat.app)

    // Sent means: Return took our text out of the composer, and a new "MeSaid"
    // row with it appeared. The table can drop rows from the top, so look at
    // the rows appended after the old ones, not at the row count.
    let beforeCount = before.suffix(tail).filter { $0 == expected }.count
    for _ in 0..<24 {
        usleep(250_000)
        guard let rows = try? chat.rows(), chat.draft.isEmpty else { continue }
        if appended(before, rows).contains(expected) || rows.suffix(tail).filter({ $0 == expected }).count > beforeCount {
            return ["ok": true]
        }
    }
    // Return may or may not have gone through; never retry blindly.
    if chat.draft.hasPrefix(text) {
        clear(chat, text, boundName)
        throw HelperError(message: "not_sent")
    }
    throw HelperError(message: "unconfirmed")
}

/// Takes our text back out of the composer. The composer was empty when we
/// filled it, so our text is at the start; anything a person typed after it is
/// kept. Nothing is touched if another chat is open now.
func clear(_ chat: Chat, _ text: String, _ boundName: String) {
    let draft = chat.draft
    guard chat.name == boundName, draft.hasPrefix(text) else { return }
    let rest = String(draft.dropFirst(text.count))
    AXUIElementSetAttributeValue(chat.composer, kAXValueAttribute as CFString, rest as CFString)
}

/// Rows added after `before`, allowing rows dropped from the top.
func appended(_ before: [String], _ rows: [String]) -> [String] {
    if before.isEmpty { return rows }
    // Keep at least one old row as an anchor, or anything would "line up".
    for dropped in 0..<before.count {
        let kept = before[dropped...]
        if rows.count >= kept.count, Array(rows.prefix(kept.count)) == Array(kept) {
            return Array(rows.dropFirst(kept.count))
        }
    }
    return []
}

func reply(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let cmd = request["cmd"] as? String else {
        reply(["ok": false, "error": "bad_request"])
        continue
    }
    let id = request["id"] ?? NSNull()
    do {
        switch cmd {
        case "snapshot":
            let chat = try openChat()
            reply(["id": id, "ok": true, "chat": chat.name, "rows": try chat.rows(), "draft": !chat.draft.isEmpty])
        case "send":
            guard let boundName = request["chat"] as? String, let text = request["text"] as? String, !text.isEmpty else {
                throw HelperError(message: "bad_request")
            }
            reply(try send(chat: boundName, text: text).merging(["id": id]) { a, _ in a })
        default:
            throw HelperError(message: "unknown_command")
        }
    } catch let error as HelperError {
        reply(["id": id, "ok": false, "error": error.message])
    } catch {
        reply(["id": id, "ok": false, "error": "\(error)"])
    }
}
