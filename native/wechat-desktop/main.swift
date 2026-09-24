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
    /// The composer's title is the open chat's name.
    var name: String { str(composer, kAXTitleAttribute) ?? "" }
    var draft: String { str(composer, kAXValueAttribute) ?? "" }

    /// Row titles, oldest first: "MeSaid:…", "<name>Said:…", "<name>:Sent aPhoto", time labels, notices.
    func rows() -> [String] {
        kids(table)
            .filter { str($0, kAXRoleAttribute) == "AXRow" }
            .map { kids($0).flatMap { kids($0) }.compactMap { str($0, kAXTitleAttribute) }.joined() }
    }
}

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
    return Chat(app: app, table: table, composer: composer)
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
    let before = chat.rows()

    guard AXUIElementSetAttributeValue(chat.composer, kAXValueAttribute as CFString, text as CFString) == .success else {
        throw HelperError(message: "fill_failed")
    }
    usleep(150_000)
    // Recheck just before sending: the chat could have changed meanwhile.
    guard chat.draft == text, chat.name == boundName else {
        if chat.draft == text { AXUIElementSetAttributeValue(chat.composer, kAXValueAttribute as CFString, "" as CFString) }
        throw HelperError(message: "changed_before_send")
    }
    pressReturn(chat.app)

    let expected = "MeSaid:\(text)"
    for _ in 0..<24 {
        usleep(250_000)
        let rows = chat.rows()
        if rows.count > before.count, rows.suffix(rows.count - before.count).contains(expected) {
            return ["ok": true]
        }
    }
    // Return may or may not have gone through; never retry blindly.
    if chat.draft == text {
        AXUIElementSetAttributeValue(chat.composer, kAXValueAttribute as CFString, "" as CFString)
        throw HelperError(message: "not_sent")
    }
    throw HelperError(message: "unconfirmed")
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
            reply(["id": id, "ok": true, "chat": chat.name, "rows": chat.rows(), "draft": !chat.draft.isEmpty])
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
