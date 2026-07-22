import AppKit
import Foundation

// Headless verify mode: one synchronous fetch, plain-text dump of the menu,
// exit 0 — without ever initializing NSApplication.
if CommandLine.arguments.contains("--print") {
    let snapshot = buildSnapshot(key: CB.apiKey())
    let client = currentClientStatus(latest: fetchLatestCLIVersion())
    print(renderPlainText(snapshot: snapshot, client: client))
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
