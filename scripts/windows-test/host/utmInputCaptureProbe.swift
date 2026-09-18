import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum ProbeError: Error {
    case invalidArguments(String)
    case utmProcessCount(Int)
    case targetWindowUnavailable(String)
    case captureControlUnavailable(String)
}

struct ProbeResult: Codable {
    let windowTitle: String
    let windowAvailable: Bool
    let before: Int
    let after: Int
    let frontmostPid: Int32
    let utmPid: Int32
    let action: String
}

struct WindowSnapshot: Codable {
    let enumerationAvailable: Bool
    let screenCapturePreflight: Bool
    let accessibilityTrusted: Bool
    let windowNumbers: [Int]
    let windows: [[String: String]]
    let utmPid: Int32
    let frontmostPid: Int32
}

func snapshotWindows(for pid: pid_t) -> WindowSnapshot {
    guard let rawWindows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
        return WindowSnapshot(enumerationAvailable: false, screenCapturePreflight: CGPreflightScreenCaptureAccess(), accessibilityTrusted: AXIsProcessTrusted(), windowNumbers: [], windows: [], utmPid: Int32(pid), frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
    }
    let windows = rawWindows.compactMap { window -> [String: String]? in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == Int(pid),
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = (window[kCGWindowNumber as String] as? NSNumber)?.intValue
        else { return nil }
        let bounds = window[kCGWindowBounds as String] as? [String: Any]
        return [
            "number": String(number),
            "width": String((bounds?["Width"] as? NSNumber)?.intValue ?? -1),
            "height": String((bounds?["Height"] as? NSNumber)?.intValue ?? -1),
            "owner": (window[kCGWindowOwnerName as String] as? String) ?? "",
        ]
    }
    return WindowSnapshot(
        enumerationAvailable: true,
        screenCapturePreflight: CGPreflightScreenCaptureAccess(),
        accessibilityTrusted: AXIsProcessTrusted(),
        windowNumbers: windows.compactMap { Int($0["number"] ?? "") },
        windows: windows,
        utmPid: Int32(pid),
        frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
    )
}

func targetWindowPresence(for pid: pid_t, title: String) -> Bool? {
    guard let rawWindows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    let ownerWindows = rawWindows.filter { window in
        (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == Int(pid)
    }
    if ownerWindows.isEmpty {
        return false
    }
    let namedWindows = ownerWindows.compactMap { $0[kCGWindowName as String] as? String }
    if namedWindows.isEmpty {
        return nil
    }
    return namedWindows.contains(title)
}

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &result) == .success else {
        return nil
    }
    return result
}

func stringAttribute(_ element: AXUIElement, _ key: String) -> String? {
    attribute(element, key) as? String
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func findCaptureControl(_ element: AXUIElement) -> AXUIElement? {
    let role = stringAttribute(element, kAXRoleAttribute) ?? ""
    let title = stringAttribute(element, kAXTitleAttribute) ?? ""
    let description = stringAttribute(element, kAXDescriptionAttribute) ?? ""
    let help = stringAttribute(element, kAXHelpAttribute) ?? ""
    let label = "\(title) \(description) \(help)".lowercased()
    if role == "AXCheckBox" && label.contains("capture") && label.contains("input") {
        return element
    }
    for child in children(element) {
        if let found = findCaptureControl(child) {
            return found
        }
    }
    return nil
}

func checkboxValue(_ control: AXUIElement) -> Int? {
    guard let value = attribute(control, kAXValueAttribute) else {
        return nil
    }
    if let number = value as? NSNumber {
        return number.intValue
    }
    if let boolean = value as? Bool {
        return boolean ? 1 : 0
    }
    return nil
}

func findWindow(_ application: AXUIElement, title: String) -> AXUIElement? {
    guard let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement] else {
        return nil
    }
    return windows.first { stringAttribute($0, kAXTitleAttribute) == title }
}

func releaseCapture(for pid: pid_t) {
    let commandKey: CGKeyCode = 55
    let optionKey: CGKeyCode = 58
    let events = [
        CGEvent(keyboardEventSource: nil, virtualKey: commandKey, keyDown: true),
        CGEvent(keyboardEventSource: nil, virtualKey: optionKey, keyDown: true),
        CGEvent(keyboardEventSource: nil, virtualKey: optionKey, keyDown: false),
        CGEvent(keyboardEventSource: nil, virtualKey: commandKey, keyDown: false),
    ]
    for event in events {
        event?.postToPid(pid)
    }
}

func hideApplication(_ pid: pid_t) -> Bool {
    let application = AXUIElementCreateApplication(pid)
    return AXUIElementSetAttributeValue(
        application,
        kAXHiddenAttribute as CFString,
        kCFBooleanTrue,
    ) == .success
}

func parseArguments() throws -> (title: String?, action: String) {
    let arguments = CommandLine.arguments
    var title: String?
    var action = "status"
    var index = 1
    while index < arguments.count {
        switch arguments[index] {
        case "--window-title":
            index += 1
            guard index < arguments.count else {
                throw ProbeError.invalidArguments("missing window title")
            }
            title = arguments[index]
        case "--release":
            action = "release"
        case "--restore":
            action = "restore"
        case "--status":
            action = "status"
        case "--snapshot":
            action = "snapshot"
        default:
            throw ProbeError.invalidArguments("unknown argument")
        }
        index += 1
    }
    if action == "snapshot" {
        return (title, action)
    }
    guard let title, !title.isEmpty else {
        throw ProbeError.invalidArguments("missing window title")
    }
    return (title, action)
}

let arguments = try parseArguments()
let applications = NSRunningApplication.runningApplications(withBundleIdentifier: "com.utmapp.UTM")
guard applications.count == 1, let application = applications.first else {
    throw ProbeError.utmProcessCount(applications.count)
}

let pid = application.processIdentifier
if arguments.action == "snapshot" {
    let encoded = try JSONEncoder().encode(snapshotWindows(for: pid))
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data([10]))
    exit(EXIT_SUCCESS)
}
let axApplication = AXUIElementCreateApplication(pid)
guard let title = arguments.title else {
    throw ProbeError.invalidArguments("missing window title")
}
guard let targetPresence = targetWindowPresence(for: pid, title: title) else {
    throw ProbeError.targetWindowUnavailable("UTM window enumeration was unavailable")
}
if !targetPresence {
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    let output = ProbeResult(
        windowTitle: title,
        windowAvailable: false,
        before: 0,
        after: 0,
        frontmostPid: frontmostPid,
        utmPid: pid,
        action: arguments.action,
    )
    let encoded = try JSONEncoder().encode(output)
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data([10]))
    exit(EXIT_SUCCESS)
}
guard let window = findWindow(axApplication, title: title) else {
    throw ProbeError.targetWindowUnavailable(title)
}
// UTM puts Capture Input in an overflow menu when a fresh display window is
// narrow. Expand only this owned window without making it key or frontmost.
if findCaptureControl(window) == nil {
    if let sizeValue = attribute(window, kAXSizeAttribute), CFGetTypeID(sizeValue) == AXValueGetTypeID() {
        var size = CGSize.zero
        if AXValueGetValue(unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size) {
            let availableWidth = NSScreen.main?.visibleFrame.width ?? size.width
            size.width = min(availableWidth, max(size.width, 1_024))
            if let expandedSize = AXValueCreate(.cgSize, &size) {
                _ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, expandedSize)
                // AXSetAttributeValue returns before AppKit rebuilds the toolbar.
                // Wait for that specific layout transition, then validate its value.
                let layoutDeadline = Date().addingTimeInterval(2)
                while findCaptureControl(window) == nil && Date() < layoutDeadline {
                    usleep(50_000)
                }
            }
        }
    }
}
guard let control = findCaptureControl(window), let before = checkboxValue(control) else {
    func describeControls(_ element: AXUIElement) -> [[String: String]] {
        let role = stringAttribute(element, kAXRoleAttribute) ?? ""
        var records: [[String: String]] = []
        if role != "AXStaticText" && role != "AXTextArea" && role != "AXTextField" {
            records.append([
                "role": role,
                "title": stringAttribute(element, kAXTitleAttribute) ?? "",
                "description": stringAttribute(element, kAXDescriptionAttribute) ?? "",
                "help": stringAttribute(element, kAXHelpAttribute) ?? "",
                "value": checkboxValue(element).map(String.init) ?? "unavailable",
                "subrole": stringAttribute(element, kAXSubroleAttribute) ?? "",
            ])
        }
        for child in children(element) { records += describeControls(child) }
        return records
    }
    let diagnostic = try JSONEncoder().encode(describeControls(window))
    FileHandle.standardError.write(Data("Capture Input control unavailable. Controls: ".utf8))
    FileHandle.standardError.write(diagnostic)
    FileHandle.standardError.write(Data([10]))
    exit(EXIT_FAILURE)
}

if (arguments.action == "release" || arguments.action == "restore") && before != 0 {
    releaseCapture(for: pid)
    for _ in 0..<10 {
        usleep(100_000)
        if checkboxValue(control) == 0 {
            break
        }
    }
}

let after = checkboxValue(control) ?? -1
let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
if (arguments.action == "release" || arguments.action == "restore") && frontmostPid == pid {
    _ = hideApplication(pid)
}
var restoredFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
if arguments.action == "release" || arguments.action == "restore" {
    for _ in 0..<10 {
        if restoredFrontmostPid != pid {
            break
        }
        usleep(100_000)
        restoredFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    }
}
let output = ProbeResult(
    windowTitle: title,
    windowAvailable: true,
    before: before,
    after: after,
    frontmostPid: restoredFrontmostPid,
    utmPid: pid,
    action: arguments.action,
)
let encoded = try JSONEncoder().encode(output)
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data([10]))
if arguments.action == "release" && after != 0 {
    exit(EXIT_FAILURE)
}
