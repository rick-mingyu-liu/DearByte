// DearByte WeChat desktop helper. Talks JSON lines over stdin/stdout.
//
// It only touches WeChat's main window through macOS Accessibility:
//   {"cmd":"snapshot"}                    → the open chat's name and message rows
//   {"cmd":"check"}                       → whether Return would reach the composer (read-only)
//   {"cmd":"send","chat":"…","text":"…"}  → type into the composer, press Return, confirm
//   {"cmd":"capture_photo"}               → 4.x: the newest photo in the chat, as JPEG (base64)
// Sending refuses unless the open chat is the bound one. In automatic mode it
// replaces any existing text in that chat's composer with the generated reply.
// Nothing here reads WeChat's files or clipboard. The only picture taken is of
// WeChat's own window, cropped to a photo the user sent: 4.x stores received
// photos encrypted, and we don't decrypt them.

import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit
import Vision

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
// Chromium-based Mac apps can expose only their window shell until an
// assistive client requests the enhanced accessibility tree. Keep the request
// scoped to this helper's lifetime, and undo it on a normal shutdown.
var enhancedAccessibilityRoot: AXUIElement?
var enhancedAccessibilityPID: pid_t?

func requestEnhancedAccessibility(_ root: AXUIElement, pid: pid_t) {
    guard enhancedAccessibilityPID != pid else { return }
    enhancedAccessibilityPID = pid
    let result = AXUIElementSetAttributeValue(
        root,
        "AXEnhancedUserInterface" as CFString,
        kCFBooleanTrue
    )
    if result == .success {
        enhancedAccessibilityRoot = root
        // Chromium waits briefly before exposing its complete screen-reader tree.
        usleep(2_100_000)
    }
}

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
    requestEnhancedAccessibility(root, pid: app.processIdentifier)
    // Prefer the main window (reported even when WeChat is on another Space),
    // then inspect the focused and listed windows. Some 4.x builds expose the
    // chat view on a different AX window than AXMainWindow.
    var windows: [AXUIElement] = []
    for key in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
        if let value = attr(root, key), CFGetTypeID(value) == AXUIElementGetTypeID() {
            let candidate = value as! AXUIElement
            if !windows.contains(where: { CFEqual($0, candidate) }) { windows.append(candidate) }
        }
    }
    if let listed = attr(root, kAXWindowsAttribute) as? [AXUIElement] {
        for candidate in listed where !windows.contains(where: { CFEqual($0, candidate) }) { windows.append(candidate) }
    }
    guard !windows.isEmpty else { throw HelperError(message: "no_wechat_window") }

    for window in windows {
        if let list = find(window, identifier: "chat_message_list"),
           let composer = find(window, identifier: "chat_input_field") {
            return Chat(app: app, root: root, window: window, table: list, composer: composer, modern: true)
        }
        if let table = find(window, role: "AXTable", description: "Messages"),
           let composer = find(window, role: "AXTextArea") {
            return Chat(app: app, root: root, window: window, table: table, composer: composer, modern: false)
        }
    }
    throw HelperError(message: "no_open_chat")
}

/// Deliver a normal Return through the system keyboard event path. postToPid
/// can reach a background process without activating its window, but that is
/// not the same as pressing Return in WeChat. Only use this while the verified
/// WeChat chat is frontmost and its composer still contains the exact reply.
func pressReturnToFrontmost(_ app: NSRunningApplication) throws {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        throw HelperError(message: "wechat_not_frontmost")
    }
    let source = CGEventSource(stateID: .privateState)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0x24, keyDown: down) else {
            throw HelperError(message: "fill_failed")
        }
        event.post(tap: .cghidEventTap)
        usleep(40_000)
    }
}

func send(chat boundName: String, text: String) throws -> [String: Any] {
    let chat: Chat
    do {
        chat = try openChat()
    } catch let error as HelperError where ["no_open_chat", "no_accessibility_permission"].contains(error.message) {
        try sendVisual(chat: boundName, text: text)
        return ["ok": true]
    }
    // WeChat 4.1.x can expose a stale or inconsistent composer title through
    // Accessibility. Before refusing, let the visual path independently verify
    // the visible group title; it still refuses unless that title matches.
    guard sameChatName(chat.name, boundName) else {
        try sendVisual(chat: boundName, text: text)
        return ["ok": true]
    }
    if let problem = chat.returnTarget(), problem != "not_focused" { throw HelperError(message: problem) }
    // Setting AXValue replaces any existing text draft with this reply.
    guard AXUIElementSetAttributeValue(chat.composer, kAXValueAttribute as CFString, text as CFString) == .success else {
        throw HelperError(message: "fill_failed")
    }
    // Make the composer the element that receives Return.
    AXUIElementSetAttributeValue(chat.composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(150_000)
    // Recheck just before sending: the chat, composer text or focus could have changed meanwhile.
    let target = chat.returnTarget()
    guard chat.draft == text, sameChatName(chat.name, boundName), target == nil else {
        clear(chat, text, boundName)
        throw HelperError(message: target ?? "changed_before_send")
    }
    // A PID-targeted key event can fill a background composer without activating
    // WeChat, but Return may not send there. Bring the verified chat forward so
    // the same ordinary Return the user presses reaches its composer.
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != chat.app.processIdentifier {
        _ = chat.app.activate(options: [.activateAllWindows])
        for _ in 0..<20 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == chat.app.processIdentifier { break }
            usleep(50_000)
        }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == chat.app.processIdentifier else {
        clear(chat, text, boundName)
        throw HelperError(message: "wechat_not_frontmost")
    }
    AXUIElementSetAttributeValue(chat.composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(100_000)
    guard sameChatName(chat.name, boundName),
          normalizedText(chat.draft) == normalizedText(text),
          chat.returnTarget() == nil else {
        clear(chat, text, boundName)
        throw HelperError(message: "changed_before_send")
    }
    // The helper has just verified the bound chat and composer, filled it with
    // this exact text, and pressed Return while WeChat was frontmost. WeChat
    // 4.x can lag or omit virtualized bubbles from AX, so a cleared composer is
    // the quick acknowledgement; don't wait several seconds for a row that
    // Accessibility may never expose.
    func confirmed() -> Bool {
        guard sameChatName(chat.name, boundName),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == chat.app.processIdentifier,
              let draft = str(chat.composer, kAXValueAttribute) else { return false }
        return draft.isEmpty
    }
    func waitForConfirmation() -> Bool {
        for _ in 0..<24 {
            usleep(250_000)
            if confirmed() { return true }
        }
        return false
    }
    try pressReturnToFrontmost(chat.app)
    if waitForConfirmation() { return ["ok": true] }

    if normalizedText(chat.draft) == normalizedText(text) {
        guard sameChatName(chat.name, boundName) else { throw HelperError(message: "wrong_chat") }
        if let problem = chat.returnTarget() { throw HelperError(message: problem) }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == chat.app.processIdentifier,
              normalizedText(chat.draft) == normalizedText(text) else {
            throw HelperError(message: "unconfirmed")
        }
        try pressReturnToFrontmost(chat.app)
        if waitForConfirmation() { return ["ok": true] }
    }
    // Return may or may not have gone through; never retry blindly.
    if chat.draft.hasPrefix(text) {
        clear(chat, text, boundName)
        throw HelperError(message: "not_sent")
    }
    throw HelperError(message: "unconfirmed")
}

/// Takes our text back out if Return did not send it. Text typed after our
/// reply is kept. Nothing is touched if another chat is open now.
func clear(_ chat: Chat, _ text: String, _ boundName: String) {
    let draft = chat.draft
    guard sameChatName(chat.name, boundName), draft.hasPrefix(text) else { return }
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

/// ScreenCaptureKit on WeChat 4.1.x can return a blank image for a one-shot
/// window capture. Start with an app filter, then switch the running stream to
/// the main-window filter. Frames and OCR stay in this process and are never
/// written to disk.
final class AsyncResult<T>: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var result: Result<T, Error>?

    func finish(_ result: Result<T, Error>) {
        lock.lock()
        self.result = result
        lock.unlock()
        semaphore.signal()
    }

    func value(timeout: TimeInterval = 10) throws -> T {
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw HelperError(message: "capture_failed")
        }
        lock.lock()
        let result = self.result
        lock.unlock()
        guard let result else { throw HelperError(message: "capture_failed") }
        return try result.get()
    }
}

func waitAsync<T>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
    let result = AsyncResult<T>()
    Task.detached {
        do { result.finish(.success(try await operation())) }
        catch { result.finish(.failure(error)) }
    }
    return try result.value()
}

final class WeChatFrameReceiver: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let context = CIContext()
    private var latestImage: CGImage?
    private var failure: Error?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let pixelBuffer = sampleBuffer.imageBuffer else { return }
        let input = CIImage(cvPixelBuffer: pixelBuffer)
        guard let image = context.createCGImage(input, from: input.extent) else { return }
        lock.lock()
        latestImage = image
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        failure = error
        lock.unlock()
    }

    func image() throws -> CGImage? {
        lock.lock()
        defer { lock.unlock() }
        if let failure { throw failure }
        return latestImage
    }
}

struct VisibleWeChatWindow {
    let app: NSRunningApplication
    let window: SCWindow
    let display: SCDisplay
    let image: CGImage
}

final class WeChatWindowCapture {
    private var stream: SCStream?
    private var receiver: WeChatFrameReceiver?
    private var key: String?

    func capture() throws -> VisibleWeChatWindow {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError(message: "no_screen_permission") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            throw HelperError(message: "wechat_not_running")
        }
        let content: SCShareableContent = try wait { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { value, error in done(value, error) }
        }
        let candidates = content.windows.filter {
            $0.owningApplication?.processID == app.processIdentifier &&
            ["Weixin", "WeChat", "微信"].contains($0.title ?? "") &&
            $0.frame.width > 600 && $0.frame.height > 450
        }
        guard let window = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw HelperError(message: "wechat_window_not_visible")
        }
        guard let display = content.displays.first(where: { $0.frame.contains(window.frame) }) else {
            throw HelperError(message: "wechat_window_spans_displays")
        }
        guard let owner = window.owningApplication else { throw HelperError(message: "wechat_not_running") }
        let captureKey = "\(window.windowID):\(window.frame):\(display.displayID)"
        if key != captureKey || stream == nil {
            stop()
            let newReceiver = WeChatFrameReceiver()
            let config = SCStreamConfiguration()
            config.width = Int(window.frame.width)
            config.height = Int(window.frame.height)
            config.showsCursor = false
            config.minimumFrameInterval = CMTime(value: 1, timescale: 8)
            config.queueDepth = 3
            config.sourceRect = CGRect(
                x: window.frame.minX - display.frame.minX,
                y: window.frame.minY - display.frame.minY,
                width: window.frame.width,
                height: window.frame.height
            )
            let initial = SCContentFilter(display: display, including: [owner], exceptingWindows: [])
            let newStream = SCStream(filter: initial, configuration: config, delegate: newReceiver)
            try newStream.addStreamOutput(newReceiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "dearbyte.wechat.frames"))
            stream = newStream
            receiver = newReceiver
            key = captureKey
            try waitAsync { try await newStream.startCapture() }
            Thread.sleep(forTimeInterval: 0.25)
            let target = SCContentFilter(display: display, including: [window])
            try waitAsync { try await newStream.updateContentFilter(target) }
            Thread.sleep(forTimeInterval: 0.55)
        }
        guard let receiver else { throw HelperError(message: "capture_failed") }
        for _ in 0..<30 {
            if let image = try receiver.image() { return VisibleWeChatWindow(app: app, window: window, display: display, image: image) }
            Thread.sleep(forTimeInterval: 0.05)
        }
        throw HelperError(message: "capture_failed")
    }

    func stop() {
        if let stream {
            try? waitAsync { try await stream.stopCapture() }
        }
        stream = nil
        receiver = nil
        key = nil
    }
}

struct OCRLine {
    let text: String
    let alternatives: [String]
    let box: CGRect
    let confidence: Float
    var top: CGFloat { 1 - box.maxY }
    var midX: CGFloat { box.midX }
}

struct VisualChatSnapshot {
    let chat: String
    let rows: [String]
    let composerText: String
    let draft: Bool
    let visible: VisibleWeChatWindow
    let panelLeft: CGFloat
}

let windowCapture = WeChatWindowCapture()

func recognizeText(_ image: CGImage) throws -> [OCRLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { observation in
        let candidates = observation.topCandidates(5)
        guard let candidate = candidates.first else { return nil }
        return OCRLine(text: candidate.string, alternatives: candidates.map(\.string), box: observation.boundingBox, confidence: candidate.confidence)
    }.sorted { $0.top < $1.top }
}

func normalizedLabel(_ text: String) -> String {
    text.precomposedStringWithCompatibilityMapping
        .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        .filter { !$0.isWhitespace && !$0.isPunctuation }
}

/// WeChat group titles may inconsistently include their member count, and
/// Vision may read full-width brackets differently from Accessibility.
func chatNameKey(_ text: String) -> String {
    let compatible = text.precomposedStringWithCompatibilityMapping
    let withoutMemberCount = compatible.replacingOccurrences(
        of: #"\s*\(\s*\d+\s*\)\s*$"#,
        with: "",
        options: .regularExpression
    )
    return normalizedLabel(withoutMemberCount)
}

func sameChatName(_ lhs: String, _ rhs: String) -> Bool {
    chatNameKey(lhs) == chatNameKey(rhs)
}

func normalizedText(_ text: String) -> String {
    text.precomposedStringWithCompatibilityMapping
        .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        .filter { !$0.isWhitespace }
}

func isVisualMeta(_ text: String) -> Bool {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.range(of: #"^\d{1,2}:\d{2}$"#, options: .regularExpression) != nil ||
        value.range(of: #"^(Yesterday|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}:\d{2}$"#, options: [.regularExpression, .caseInsensitive]) != nil ||
        value.range(of: #"^(昨天|今天|星期[一二三四五六日天])"#, options: .regularExpression) != nil
}

func visualBubbleText(_ row: String) -> String? {
    if row.hasPrefix("MeBubble:") { return String(row.dropFirst("MeBubble:".count)) }
    if row.hasPrefix("Bubble:") {
        let content = String(row.dropFirst("Bubble:".count))
        return content.components(separatedBy: "\u{001F}").last
    }
    return nil
}

func accessibilityBubbleText(_ row: String) -> String? {
    guard row.hasPrefix("Bubble:") else { return nil }
    return String(row.dropFirst("Bubble:".count))
}

func visualSnapshot(expectedChats: [String]?, includeSenders: Bool = false, knownMessageTexts: [String] = []) throws -> VisualChatSnapshot {
    let visible = try windowCapture.capture()
    let lines = try recognizeText(visible.image)
    // Group titles can sit slightly lower or have weaker OCR confidence than
    // message text, especially with Chinese names and member-count brackets.
    let header = lines.filter { $0.top < 0.20 && $0.box.minX > 0.12 && $0.confidence >= 0.15 }
    let titleCandidates = header.filter { $0.box.minX > 0.22 }
    let titleLine: OCRLine?
    let matchedChat: String?
    if let expectedChats, !expectedChats.isEmpty {
        if let match = expectedChats.compactMap({ expected in
            titleCandidates.first(where: { line in line.alternatives.contains(where: { sameChatName($0, expected) }) }).map { (expected, $0) }
        }).first {
            matchedChat = match.0
            titleLine = match.1
        } else {
            // The heading was read, but it doesn't match the bound chat. Keep
            // that distinction so callers refuse a wrong chat instead of
            // reporting that the title was unreadable.
            titleLine = titleCandidates.max { $0.confidence < $1.confidence }
            matchedChat = titleLine?.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    } else {
        titleLine = titleCandidates.max { $0.confidence < $1.confidence }
        matchedChat = titleLine?.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard let titleLine else { throw HelperError(message: "chat_title_not_readable") }
    guard let chat = matchedChat else { throw HelperError(message: "chat_title_not_readable") }
    if let expectedChats, !expectedChats.isEmpty,
       !expectedChats.contains(where: { sameChatName($0, chat) }) {
        throw HelperError(message: "wrong_chat")
    }
    let panelLeft = max(CGFloat(0.18), titleLine.box.minX - 0.02)
    let panelMiddle = (panelLeft + 1) / 2
    let knownMessageKeys = Set(knownMessageTexts.map(normalizedText))
    let body = lines.filter { line in
        line.top >= 0.12 && line.top < 0.70 && line.box.minX >= panelLeft &&
        line.confidence >= 0.25 && !isVisualMeta(line.text)
    }

    struct Bubble {
        var text: String
        var first: OCRLine
        var last: OCRLine
        let rightAligned: Bool
        var sender: String?
    }
    var bubbles: [Bubble] = []
    for line in body {
        let isRight = line.midX > panelMiddle
        if let last = bubbles.last {
            let gap = line.top - last.last.top
            let aligned = isRight
                ? abs(line.box.maxX - last.last.box.maxX) < 0.06
                : abs(line.box.minX - last.last.box.minX) < 0.06
            // Group chats place the sender nickname on a short line directly
            // above the incoming bubble. Keep that line separate so it can be
            // associated with the message instead of becoming message text.
            let priorIsKnownMessage = includeSenders && !isRight && knownMessageKeys.contains(normalizedText(last.text))
            let possibleSenderLine = includeSenders && !isRight && last.text.count <= 16 && !priorIsKnownMessage
            let keepSenderSeparate = possibleSenderLine && gap >= 0 && gap < 0.05
            // Accessibility confirms a short line is a complete message row;
            // keep it separate from the next bubble instead of merging it.
            let keepKnownMessageSeparate = priorIsKnownMessage && gap >= 0 && gap < 0.03 && aligned
            if last.rightAligned == isRight && gap >= 0 && gap < 0.03 && aligned &&
                !keepSenderSeparate && !keepKnownMessageSeparate {
                bubbles[bubbles.count - 1].text += " " + line.text
                bubbles[bubbles.count - 1].last = line
                continue
            }
        }
        bubbles.append(Bubble(text: line.text, first: line, last: line, rightAligned: isRight, sender: nil))
    }

    // WeChat 4.1.13 omits group sender names from Accessibility rows, but the
    // visible group nickname is normally printed immediately above its left
    // aligned bubble. Match only short, nearby, left-aligned labels; unmatched
    // bubbles stay explicitly unidentified in the caller.
    var senderLabels = Set<Int>()
    for messageIndex in bubbles.indices where includeSenders && !bubbles[messageIndex].rightAligned {
        let message = bubbles[messageIndex]
        let candidate = (0..<messageIndex).reversed().first { labelIndex in
            guard !senderLabels.contains(labelIndex) else { return false }
            let label = bubbles[labelIndex]
            let gap = message.first.top - label.last.top
            let confirmedLabel = !knownMessageKeys.isEmpty &&
                !knownMessageKeys.contains(normalizedText(label.text)) &&
                knownMessageKeys.contains(normalizedText(message.text))
            let visualSizeHint = knownMessageKeys.isEmpty && label.first.box.height < message.first.box.height * 0.9
            return !label.rightAligned &&
                !label.text.isEmpty && label.text.count <= 16 &&
                (confirmedLabel || visualSizeHint) &&
                gap >= 0.008 && gap <= 0.05 &&
                abs(label.first.box.minX - message.first.box.minX) < 0.04
        }
        if let candidate {
            bubbles[messageIndex].sender = bubbles[candidate].text
            senderLabels.insert(candidate)
        }
    }

    // Vision sees the empty editor's placeholder and toolbar labels as text.
    // Ignore those; otherwise an actually empty composer looks occupied and
    // the send path correctly-but-incorrectly refuses to proceed.
    let ignoredComposerHints = Set([
        "holdmousetoinputbyvoice", "holdtotalk", "按住说话", "输入消息", "输入内容",
        "typeamessage", "enteramessage", "entermessage", "enteryourmessage", "writeamessage", "typemessage", "message",
        "clickheretotype", "clicktotypemessage", "pressentertosend", "enterstosend", "点击输入消息"
    ])
    let composerText = lines.filter {
        $0.top >= 0.76 && $0.top < 0.96 &&
        $0.box.minX >= panelLeft + 0.06 && $0.box.minX < 0.88
    }
        .map(\.text)
        .filter { !ignoredComposerHints.contains(normalizedLabel($0)) }
        .joined(separator: " ")
    return VisualChatSnapshot(
        chat: chat,
        rows: bubbles.enumerated().compactMap { index, bubble in
            if senderLabels.contains(index) { return nil }
            if bubble.rightAligned { return "MeBubble:" + bubble.text }
            let sender = bubble.sender.map { $0 + "\u{001F}" } ?? ""
            return "Bubble:" + sender + bubble.text
        },
        composerText: composerText,
        draft: !normalizedText(composerText).isEmpty,
        visible: visible,
        panelLeft: panelLeft
    )
}

var cachedGroupSnapshotChat = ""
var cachedGroupAccessibilityRows: [String]?
var cachedGroupVisibleRows: [String]?

/// In 4.x group chats Accessibility omits senders. Use visual rows when the
/// screen reader's newest bubble matches OCR, keeping the two snapshots in the
/// same order. Cache unchanged AX rows so screenshot recognition isn't needed
/// during every idle poll.
func rowsForSnapshot(_ chat: Chat, rows: [String], groupChat: Bool) -> [String] {
    guard groupChat && chat.modern else { return rows }
    if cachedGroupSnapshotChat == chat.name,
       cachedGroupAccessibilityRows == rows,
       let cachedGroupVisibleRows {
        return cachedGroupVisibleRows
    }

    func rememberUnlabelledRows() {
        // OCR can be slow or miss a frame. Keep the Accessibility rows for this
        // snapshot so idle polls don't repeat the same expensive capture; try
        // again when WeChat exposes a changed row list.
        cachedGroupSnapshotChat = chat.name
        cachedGroupAccessibilityRows = rows
        cachedGroupVisibleRows = rows
    }

    let knownMessages = rows.compactMap(accessibilityBubbleText)
    guard let visual = try? visualSnapshot(expectedChats: [chat.name], includeSenders: true, knownMessageTexts: knownMessages), visual.chat == chat.name else {
        rememberUnlabelledRows()
        return rows
    }
    guard let newestAX = rows.reversed().compactMap(accessibilityBubbleText).first,
          let newestVisual = visual.rows.reversed().compactMap(visualBubbleText).first,
          normalizedText(newestAX) == normalizedText(newestVisual) else {
        rememberUnlabelledRows()
        return rows
    }
    cachedGroupSnapshotChat = chat.name
    cachedGroupAccessibilityRows = rows
    cachedGroupVisibleRows = visual.rows
    return visual.rows
}

func requireFrontmost(_ pid: pid_t) throws {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw HelperError(message: "not_focused")
    }
}

func clickPoint(_ point: CGPoint) throws {
    for kind in [CGEventType.leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: point, mouseButton: .left) else {
            throw HelperError(message: "fill_failed")
        }
        event.post(tap: .cghidEventTap)
        usleep(35_000)
    }
}

func typeUnicode(_ text: String, pid: pid_t) throws {
    let units = Array(text.utf16)
    var offset = 0
    while offset < units.count {
        try requireFrontmost(pid)
        var end = min(offset + 16, units.count)
        if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
        let part = Array(units[offset..<end])
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else {
                throw HelperError(message: "fill_failed")
            }
            part.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress!) }
            event.postToPid(pid)
        }
        usleep(25_000)
        offset = end
    }
}

func clearComposer(_ app: NSRunningApplication) throws {
    try requireFrontmost(app.processIdentifier)
    let source = CGEventSource(stateID: .privateState)
    // Command+A selects the existing text in WeChat's focused composer. Replace
    // it with the generated reply because the user explicitly requested forced
    // sending even when an unsent text draft is present.
    guard let commandDown = CGEvent(keyboardEventSource: source, virtualKey: 0x37, keyDown: true),
          let selectDown = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: true),
          let selectUp = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: false),
          let commandUp = CGEvent(keyboardEventSource: source, virtualKey: 0x37, keyDown: false) else {
        throw HelperError(message: "fill_failed")
    }
    selectDown.flags = .maskCommand
    selectUp.flags = .maskCommand
    commandDown.postToPid(app.processIdentifier)
    usleep(35_000)
    selectDown.postToPid(app.processIdentifier)
    selectUp.postToPid(app.processIdentifier)
    commandUp.postToPid(app.processIdentifier)
    usleep(35_000)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0x33, keyDown: down) else {
            throw HelperError(message: "fill_failed")
        }
        event.postToPid(app.processIdentifier)
        usleep(35_000)
    }
}

func sendVisual(chat boundName: String, text: String) throws {
    guard AXIsProcessTrusted() else { throw HelperError(message: "no_accessibility_permission") }
    guard !text.isEmpty, !text.contains("\n"), !text.contains("\r") else { throw HelperError(message: "bad_request") }
    var visual = try visualSnapshot(expectedChats: [boundName])
    let app = visual.visible.app
    _ = app.activate(options: [.activateAllWindows])
    usleep(350_000)
    try requireFrontmost(app.processIdentifier)
    visual = try visualSnapshot(expectedChats: [boundName])

    let window = visual.visible.window
    let image = visual.visible.image
    let scaleX = CGFloat(image.width) / window.frame.width
    let scaleY = CGFloat(image.height) / window.frame.height
    guard scaleX > 0, scaleY > 0 else { throw HelperError(message: "capture_failed") }
    let clickX = visual.panelLeft * CGFloat(image.width) + (CGFloat(image.width) - visual.panelLeft * CGFloat(image.width)) * 0.22
    let clickY = CGFloat(image.height) * 0.83
    let point = CGPoint(x: window.frame.minX + clickX / scaleX, y: window.frame.minY + clickY / scaleY)
    try clickPoint(point)
    usleep(100_000)
    visual = try visualSnapshot(expectedChats: [boundName])
    try requireFrontmost(app.processIdentifier)
    try clearComposer(app)
    try typeUnicode(text, pid: app.processIdentifier)
    // OCR on WeChat 4.1.x often cannot read the composer's text reliably. The
    // chat title was confirmed immediately before typing, the composer was
    // clicked, and text input completed; don't let a missed OCR read prevent
    // the requested automatic send.
    usleep(180_000)
    let expectedText = normalizedText(text)
    let previousMatches = visual.rows.compactMap(visualBubbleText).filter {
        normalizedText($0) == expectedText
    }.count
    let previousLastRow = visual.rows.last
    func confirmed() throws -> Bool {
        visual = try visualSnapshot(expectedChats: [boundName])
        let matches = visual.rows.compactMap(visualBubbleText).filter {
            normalizedText($0) == expectedText
        }.count
        return visual.rows.last.flatMap(visualBubbleText).map {
            normalizedText($0) == expectedText
        } == true && (matches > previousMatches || visual.rows.last != previousLastRow)
    }
    func waitForConfirmation() throws -> Bool {
        for _ in 0..<10 {
            usleep(300_000)
            if try confirmed() { return true }
        }
        return false
    }

    try requireFrontmost(app.processIdentifier)
    try pressReturnToFrontmost(app)
    if try waitForConfirmation() { return }

    // If OCR confirms the exact text is still in the composer, a second normal
    // Return is safe to try once. If OCR cannot read the composer, never press
    // again: the first send may have succeeded, so avoid a duplicate.
    if normalizedText(visual.composerText) == expectedText {
        try requireFrontmost(app.processIdentifier)
        visual = try visualSnapshot(expectedChats: [boundName])
        guard normalizedText(visual.composerText) == expectedText else {
            throw HelperError(message: "unconfirmed")
        }
        try pressReturnToFrontmost(app)
        if try waitForConfirmation() { return }
    }
    throw HelperError(message: "unconfirmed")
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
            let groupChat = request["groupChat"] as? Bool ?? false
            let expectedChats = request["chat"] as? [String] ?? (request["chat"] as? String).map { [$0] } ?? []
            do {
                let chat = try openChat()
                if !expectedChats.isEmpty && !expectedChats.contains(where: { sameChatName($0, chat.name) }) {
                    // A wrong AX title can come from WeChat 4.1.x's composer.
                    // Accept the snapshot only when OCR independently confirms
                    // one of the explicitly configured chat names on screen.
                    let visual = try visualSnapshot(expectedChats: expectedChats, includeSenders: groupChat)
                    reply(["id": id, "ok": true, "chat": visual.chat, "rows": visual.rows, "offset": NSNull(), "draft": visual.draft])
                } else {
                    let recent = try chat.recent()
                    let rows = rowsForSnapshot(chat, rows: recent.rows, groupChat: groupChat)
                    reply(["id": id, "ok": true, "chat": chat.name, "rows": rows, "offset": recent.offset ?? NSNull(), "draft": !chat.draft.isEmpty])
                }
            } catch let error as HelperError where ["no_open_chat", "no_accessibility_permission"].contains(error.message) {
                let visual = try visualSnapshot(expectedChats: expectedChats.isEmpty ? nil : expectedChats, includeSenders: groupChat)
                reply(["id": id, "ok": true, "chat": visual.chat, "rows": visual.rows, "offset": NSNull(), "draft": visual.draft])
            }
        case "check":
            // Read-only: would a send go to this chat's composer right now?
            do {
                let chat = try openChat()
                reply(["id": id, "ok": true, "chat": chat.name, "problem": chat.returnTarget() ?? NSNull()])
            } catch let error as HelperError where ["no_open_chat", "no_accessibility_permission"].contains(error.message) {
                let expectedChats = request["chat"] as? [String] ?? (request["chat"] as? String).map { [$0] }
                let visual = try visualSnapshot(expectedChats: expectedChats)
                reply(["id": id, "ok": true, "chat": visual.chat, "problem": "visual_only"])
            }
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

if let root = enhancedAccessibilityRoot {
    _ = AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
}
windowCapture.stop()
