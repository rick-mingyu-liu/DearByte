// DearByte WeChat desktop helper. Talks JSON lines over stdin/stdout.
//
// It only touches WeChat's main window through macOS Accessibility:
//   {"cmd":"snapshot"}                    → the open chat's name and message rows
//   {"cmd":"check"}                       → whether Return would reach the composer (read-only)
//   {"cmd":"send","chat":"…","text":"…"}  → type into the composer, press Return, confirm
//   {"cmd":"capture_photo"}               → 4.x: the newest photo in the chat, as JPEG (base64)
// Sending refuses unless the open chat is the bound one and the composer is
// empty, so it never types into another chat or over someone's draft.
// Nothing here reads WeChat's files or clipboard. The only picture taken is of
// WeChat's own window, cropped to a photo the user sent: 4.x stores received
// photos encrypted, and we don't decrypt them.

import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)
let bundleId = "com.tencent.xinWeChat"

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String? { attr(e, name) as? String }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func bool(_ e: AXUIElement, _ name: String) -> Bool? { attr(e, name) as? Bool }

/// WeChat 4.x names its controls; 3.8.4 doesn't.
func find(_ e: AXUIElement, identifier: String, depth: Int = 0) -> AXUIElement? {
    if str(e, "AXIdentifier") == identifier { return e }
    if depth > 14 { return nil }
    for k in kids(e) { if let f = find(k, identifier: identifier, depth: depth + 1) { return f } }
    return nil
}

func find(_ e: AXUIElement, role: String, description: String? = nil, depth: Int = 0) -> AXUIElement? {
    if str(e, kAXRoleAttribute) == role, description == nil || str(e, kAXDescriptionAttribute) == description { return e }
    if depth > 8 { return nil }
    for k in kids(e) { if let f = find(k, role: role, description: description, depth: depth + 1) { return f } }
    return nil
}

struct HelperError: Error { let message: String }

/// How many of the newest rows a snapshot returns.
let recentRows = 60

struct Chat {
    let app: NSRunningApplication
    let root: AXUIElement
    let window: AXUIElement
    let table: AXUIElement
    let composer: AXUIElement
    /// WeChat 4.x: rows carry only the text, not who sent it.
    let modern: Bool
    /// Return goes to WeChat's key window and its focused element, so both must
    /// be this chat's composer. WeChat reports the focused window and element
    /// even from another Space; the window list is empty there, so it's only a
    /// fallback. When neither can be read, refuse rather than guess.
    func returnTarget() -> String? {
        if let w = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
            guard CFEqual(w, window) else { return "other_window_open" }
        } else {
            let windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
            guard windows.count == 1 else { return windows.isEmpty ? "window_unknown" : "other_window_open" }
        }
        if let f = attr(root, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() {
            guard CFEqual(f, composer) else { return "not_focused" }
        } else if bool(composer, kAXFocusedAttribute) != true {
            return "not_focused"
        }
        return nil
    }

    /// The composer's title is the open chat's name.
    var name: String { str(composer, kAXTitleAttribute) ?? "" }
    var draft: String { str(composer, kAXValueAttribute) ?? "" }
    /// The composer's text, or nil when Accessibility didn't answer.
    var draftIfRead: String? { str(composer, kAXValueAttribute) }

    /// Row titles, oldest first.
    /// 3.8.4: "MeSaid:…", "<nickname>Said:…", "<nickname>:Sent aPhoto", time labels, notices.
    /// 4.x: "Bubble:…" for any message (the sender isn't exposed), time labels,
    /// notices, and "" for rows scrolled out of view, which WeChat leaves unrendered.
    /// Throws rather than returning a short list when Accessibility doesn't answer,
    /// so a failed read never looks like an emptied chat.
    /// The newest rows, and on 4.x where they start in the whole list (`offset`).
    /// 4.x keeps a placeholder for every row ever scrolled past and only appends,
    /// so the offset tells the channel exactly how far the window moved; reading
    /// every row each time cost more Accessibility calls as the day went on.
    func recent() throws -> (rows: [String], offset: Int?) {
        guard let all = attr(table, kAXChildrenAttribute) as? [AXUIElement] else {
            throw HelperError(message: "read_failed")
        }
        if modern {
            let children = all.suffix(recentRows)
            return (children.map { row in
                switch str(row, "AXIdentifier") {
                case "virtual_cell": return ""
                case "chat_bubble_item_view": return "Bubble:" + (str(row, kAXTitleAttribute) ?? "")
                default: return str(row, kAXTitleAttribute) ?? ""
                }
            }, all.count - children.count)
        }
        // 3.8.4 drops old rows from the top itself, so there's no stable offset.
        let rows = try all
            .filter { str($0, kAXRoleAttribute) == "AXRow" }
            .suffix(recentRows)
            .map { row in
                guard let cells = attr(row, kAXChildrenAttribute) as? [AXUIElement] else { throw HelperError(message: "read_failed") }
                return cells.flatMap { kids($0) }.compactMap { str($0, kAXTitleAttribute) }.joined()
            }
        return (rows, nil)
    }
}

/// The chat found last time. Finding it walks WeChat's whole window, so it's
/// reused while its controls still answer; switching chats in WeChat keeps
/// them, and a closed window or restarted WeChat makes it look again.
var cachedChat: Chat?

extension Chat {
    var stillThere: Bool {
        guard !app.isTerminated,
              let main = attr(root, kAXMainWindowAttribute), CFGetTypeID(main) == AXUIElementGetTypeID(), CFEqual(main, window),
              str(table, kAXRoleAttribute) != nil, str(composer, kAXRoleAttribute) != nil,
              let owner = attr(composer, kAXWindowAttribute), CFGetTypeID(owner) == AXUIElementGetTypeID(), CFEqual(owner, window) else { return false }
        return !modern || (str(table, "AXIdentifier") == "chat_message_list" && str(composer, "AXIdentifier") == "chat_input_field")
    }
}

func openChat() throws -> Chat {
    guard AXIsProcessTrusted() else { throw HelperError(message: "no_accessibility_permission") }
    if let chat = cachedChat, chat.stillThere { return chat }
    cachedChat = nil
    let chat = try findChat()
    cachedChat = chat
    return chat
}

func findChat() throws -> Chat {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
    guard let app = apps.first else { throw HelperError(message: "wechat_not_running") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2.0)
    // The main window is reported even when WeChat is on another Space.
    guard let w = attr(root, kAXMainWindowAttribute) ?? attr(root, kAXFocusedWindowAttribute),
          CFGetTypeID(w) == AXUIElementGetTypeID() else { throw HelperError(message: "no_wechat_window") }
    let window = w as! AXUIElement
    if let list = find(window, identifier: "chat_message_list"), let composer = find(window, identifier: "chat_input_field") {
        return Chat(app: app, root: root, window: window, table: list, composer: composer, modern: true)
    }
    guard let table = find(window, role: "AXTable", description: "Messages"),
          let composer = find(window, role: "AXTextArea") else { throw HelperError(message: "no_open_chat") }
    return Chat(app: app, root: root, window: window, table: table, composer: composer, modern: false)
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
    if let problem = chat.returnTarget(), problem != "not_focused" { throw HelperError(message: problem) }
    guard AXUIElementSetAttributeValue(chat.composer, kAXValueAttribute as CFString, text as CFString) == .success else {
        throw HelperError(message: "fill_failed")
    }
    // Make the composer the element that receives Return.
    AXUIElementSetAttributeValue(chat.composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(150_000)
    // Recheck just before sending: the chat, draft or focus could have changed meanwhile.
    let target = chat.returnTarget()
    guard chat.draft == text, chat.name == boundName, target == nil else {
        clear(chat, text, boundName)
        throw HelperError(message: target ?? "changed_before_send")
    }
    pressReturn(chat.app)

    // Sent means Return took our text out of the composer. Which row is ours
    // is the channel's call (rows.ts), so matching rules live in one place.
    // An unanswered read isn't "empty", and another chat's empty draft isn't ours:
    // those end as unconfirmed, never as sent.
    var emptyReads = 0
    for _ in 0..<24 {
        usleep(250_000)
        guard chat.name == boundName else { throw HelperError(message: "unconfirmed") }
        emptyReads = chat.draftIfRead == "" ? emptyReads + 1 : 0
        if emptyReads >= 2 { return ["ok": true] }
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

func rect(_ e: AXUIElement) -> CGRect? {
    var p = CGPoint.zero, z = CGSize.zero
    guard let pv = attr(e, kAXPositionAttribute), let sv = attr(e, kAXSizeAttribute),
          AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &z) else { return nil }
    return CGRect(origin: p, size: z)
}

/// Waits for a completion-handler API; the helper's loop is synchronous.
func wait<T>(_ body: (@escaping (T?, Error?) -> Void) -> Void) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: T?, failure: Error?
    body { value, error in result = value; failure = error; done.signal() }
    guard done.wait(timeout: .now() + 8) == .success else { throw HelperError(message: "capture_failed") }
    if let failure { throw failure }
    guard let result else { throw HelperError(message: "capture_failed") }
    return result
}

/// The newest photo in the open chat (4.x), cut out of a capture of WeChat's
/// window. Row frames come from Accessibility in screen points, top-left origin,
/// as do ScreenCaptureKit's window frames.
func capturePhoto() throws -> String {
    let chat = try openChat()
    guard chat.modern else { throw HelperError(message: "capture_unsupported") }
    guard CGPreflightScreenCaptureAccess() else {
        CGRequestScreenCaptureAccess()
        throw HelperError(message: "no_screen_permission")
    }
    guard let row = kids(chat.table).last(where: {
              str($0, "AXIdentifier") == "chat_bubble_item_view" && ["Image", "Photo", "[Image]", "[Photo]"].contains(str($0, kAXTitleAttribute) ?? "")
          }),
          let rowRect = rect(row), let listRect = rect(chat.table), let windowRect = rect(chat.window) else {
        throw HelperError(message: "photo_not_visible")
    }
    // Only the part of the row that's on screen inside the chat list.
    let visible = rowRect.intersection(listRect)
    guard visible.height >= 20 else { throw HelperError(message: "photo_not_visible") }

    let content: SCShareableContent = try wait { done in
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { c, e in done(c, e) }
    }
    let candidates = content.windows.filter { $0.owningApplication?.processID == chat.app.processIdentifier && $0.windowLayer == 0 }
    guard let window = candidates.min(by: { distance($0.frame, windowRect) < distance($1.frame, windowRect) }) else {
        throw HelperError(message: "capture_failed")
    }
    let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
    let config = SCStreamConfiguration()
    config.width = Int(window.frame.width * scale)
    config.height = Int(window.frame.height * scale)
    config.showsCursor = false
    let image: CGImage = try wait { done in
        SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config) { i, e in done(i, e) }
    }
    let px = CGFloat(image.width) / window.frame.width
    let crop = CGRect(x: (visible.minX - window.frame.minX) * px, y: (visible.minY - window.frame.minY) * px,
                      width: visible.width * px, height: visible.height * px).integral
    guard let cut = image.cropping(to: crop),
          let jpeg = NSBitmapImageRep(cgImage: cut).representation(using: .jpeg, properties: [.compressionFactor: 0.9]) else {
        throw HelperError(message: "capture_failed")
    }
    return jpeg.base64EncodedString()
}

func distance(_ a: CGRect, _ b: CGRect) -> CGFloat {
    abs(a.minX - b.minX) + abs(a.minY - b.minY) + abs(a.width - b.width) + abs(a.height - b.height)
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
            let recent = try chat.recent()
            reply(["id": id, "ok": true, "chat": chat.name, "rows": recent.rows, "offset": recent.offset ?? NSNull(), "draft": !chat.draft.isEmpty])
        case "check":
            // Read-only: would a send go to this chat's composer right now?
            let chat = try openChat()
            reply(["id": id, "ok": true, "chat": chat.name, "problem": chat.returnTarget() ?? NSNull()])
        case "send":
            guard let boundName = request["chat"] as? String, let text = request["text"] as? String, !text.isEmpty else {
                throw HelperError(message: "bad_request")
            }
            reply(try send(chat: boundName, text: text).merging(["id": id]) { a, _ in a })
        case "capture_photo":
            reply(["id": id, "ok": true, "jpeg": try capturePhoto()])
        default:
            throw HelperError(message: "unknown_command")
        }
    } catch let error as HelperError {
        reply(["id": id, "ok": false, "error": error.message])
    } catch {
        reply(["id": id, "ok": false, "error": "\(error)"])
    }
}
