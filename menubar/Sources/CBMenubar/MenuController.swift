import AppKit

/// Owns the NSStatusItem, timers, and menu construction.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var refreshTimer: Timer?
    private var metaTimer: Timer?

    private var snapshot = Snapshot()
    private var latestCLI: String?
    private var refreshInFlight = false
    private var updateInFlight = false

    private let siteURL = URL(string: "https://controlboard.ai")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button, let logo = Logo.statusImage() {
            button.image = logo
            button.imagePosition = .imageLeading
        }
        statusItem.button?.title = " —"
        rebuildMenu()

        refreshMeta()
        refresh()

        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        refreshTimer?.tolerance = 5
        metaTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            self?.refreshMeta()
        }
        metaTimer?.tolerance = 60
    }

    // MARK: Refresh

    private func refresh() {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let snap = buildSnapshot(key: CB.apiKey())
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.refreshInFlight = false
                self.snapshot = snap
                self.statusItem.button?.title = " " + snap.titleText
                self.rebuildMenu()
            }
        }
    }

    private func refreshMeta() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let latest = fetchLatestCLIVersion()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.latestCLI = latest
                self.rebuildMenu()
            }
        }
    }

    // MARK: Menu

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        // Running
        menu.addItem(header("Running (\(snapshot.running.count))"))
        for r in snapshot.running.prefix(maxMenuRows) {
            menu.addItem(actionRow(runningRowText(r), action: #selector(openSite)))
        }

        // Up next
        menu.addItem(header("Up next (\(snapshot.queued.count))"))
        for (i, r) in snapshot.queued.prefix(maxMenuRows).enumerated() {
            menu.addItem(actionRow(queuedRowText(index: i + 1, r), action: #selector(openSite)))
        }

        // Inbox
        if snapshot.inboxCount > 0 {
            let item = actionRow(inboxRowText(snapshot.inboxCount), action: #selector(openSite))
            item.indentationLevel = 0
            menu.addItem(item)
        }

        // Agents
        menu.addItem(header("Agents"))
        for a in snapshot.agents {
            let item = NSMenuItem(title: a.display, action: nil, keyEquivalent: "")
            item.isEnabled = false
            item.indentationLevel = 1
            menu.addItem(item)
        }

        // Client
        menu.addItem(.separator())
        let client = currentClientStatus(latest: latestCLI)
        if client.isUpToDate || client.latest == nil {
            let item = NSMenuItem(title: clientRowText(client), action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            let title = updateInFlight ? "Updating client…" : clientRowText(client)
            let item = NSMenuItem(title: title, action: #selector(updateClient), keyEquivalent: "")
            item.target = self
            item.isEnabled = !updateInFlight
            menu.addItem(item)
        }

        // Standard actions
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open ControlBoard", action: #selector(openSite), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        let refresh = NSMenuItem(title: "Refresh now", action: #selector(refreshNow), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)
        let quit = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    private func header(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func actionRow(_ title: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.isEnabled = true
        item.indentationLevel = 1
        return item
    }

    // MARK: Actions

    @objc private func openSite() {
        NSWorkspace.shared.open(siteURL)
    }

    @objc private func refreshNow() {
        refreshMeta()
        refresh()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    @objc private func updateClient() {
        guard !updateInFlight else { return }
        updateInFlight = true
        rebuildMenu()
        let expected = latestCLI
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let outcome = Updater.performUpdate(expectedLatest: expected)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.updateInFlight = false
                self.rebuildMenu()
                let alert = NSAlert()
                alert.alertStyle = outcome.ok ? .informational : .warning
                alert.messageText = outcome.ok ? "ControlBoard client update" : "ControlBoard client update failed"
                alert.informativeText = outcome.message
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }
}
