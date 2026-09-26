// DearByte calendar helper: reads the Mac's calendars (which iCloud keeps in
// sync with the iPhone) through EventKit and prints JSON. One command per run:
//
//   dearbyte-calendar status               → whether DearByte may read calendars
//   dearbyte-calendar access               → asks macOS for access (shows the system prompt once)
//   dearbyte-calendar events FROM TO       → events overlapping FROM..TO (ISO 8601), sorted by start
//
// Only each event's title, start, end and whether it's all-day are printed.
// Notes, locations and URLs are never read, and attendees only to see whether
// the user declined. Left out: cancelled events, invites the user declined or
// hasn't answered, and subscribed and birthday calendars (holidays, sports
// fixtures), which aren't the user's plans. The helper never writes to a
// calendar.

import EventKit
import Foundation

let store = EKEventStore()

func printJSON(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func access() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return "granted"
    case .notDetermined: return "not_determined"
    case .writeOnly: return "write_only"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "denied"
    }
}

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
let args = CommandLine.arguments

switch args.count > 1 ? args[1] : "" {
case "status":
    printJSON(["status": access()])

case "access":
    if access() != "not_determined" {
        printJSON(["status": access()])
        break
    }
    let done = DispatchSemaphore(value: 0)
    var problem: String? = nil
    store.requestFullAccessToEvents { _, error in
        problem = error?.localizedDescription
        done.signal()
    }
    done.wait()
    // The answer can come back before the user has clicked, while the dialog is still open: keep checking for a minute.
    let deadline = Date().addingTimeInterval(60)
    while access() == "not_determined" && Date() < deadline { Thread.sleep(forTimeInterval: 0.5) }
    var out: [String: Any] = ["status": access()]
    if let problem { out["message"] = problem }
    printJSON(out)

case "events":
    guard args.count == 4, let from = iso.date(from: args[2]), let to = iso.date(from: args[3]), from < to else {
        printJSON(["status": "error", "message": "usage: events FROM TO (ISO 8601)"])
        exit(2)
    }
    guard access() == "granted" else {
        printJSON(["status": access()])
        break
    }
    let own = store.calendars(for: .event).filter { $0.type != .subscription && $0.type != .birthday }
    // All-day events float: their dates are the Mac's calendar dates, printed as such so no time zone can shift them.
    let day = DateFormatter()
    day.dateFormat = "yyyy-MM-dd"
    day.timeZone = TimeZone.current
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: own)
    let events = store.events(matching: predicate)
        .filter { e in
            if e.status == .canceled { return false }
            let me = e.attendees?.first { $0.isCurrentUser }
            return me == nil || me!.participantStatus == .accepted || me!.participantStatus == .tentative
        }
        .sorted { $0.startDate < $1.startDate }
        .map { e -> [String: Any] in
            var out: [String: Any] = ["title": e.title ?? "", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate), "allDay": e.isAllDay]
            if e.isAllDay {
                out["firstDay"] = day.string(from: e.startDate)
                out["lastDay"] = day.string(from: e.endDate.addingTimeInterval(-1))
            }
            return out
        }
    printJSON(["status": "granted", "events": events])

default:
    printJSON(["status": "error", "message": "usage: status | access | events FROM TO"])
    exit(2)
}
