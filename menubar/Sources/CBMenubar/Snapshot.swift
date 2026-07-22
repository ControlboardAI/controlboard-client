import Foundation

// MARK: - Model

struct RunningRow {
    let title: String
    let claimer: String
    let minutes: Int
}

struct QueuedRow {
    let title: String
    /// Normalized display tag like "P1", nil if no priority set.
    let priorityTag: String?
}

struct AgentRow {
    let label: String
    /// e.g. "5h 34% · 7d 26%", nil when no usable usage data.
    let usage: String?
    let model: String?

    var display: String {
        var s = "\(label) — \(usage ?? "no usage reported")"
        if let model = model, !model.isEmpty {
            s += " · \(model)"
        }
        return s
    }
}

struct Snapshot {
    /// True when a key was found and the tasks endpoint answered 200.
    var ok = false
    var running: [RunningRow] = []
    var queued: [QueuedRow] = []
    var inboxCount = 0
    var agents: [AgentRow] = []

    var titleText: String {
        ok ? "▸\(running.count) ●\(queued.count)" : "—"
    }
}

struct ClientStatus {
    /// Installed cb version parsed from ~/.controlboard/cb.mjs ("pre-1.1" if unparseable).
    var installed: String
    /// Latest version from /api/v1/meta, nil when unknown (e.g. endpoint 404s).
    var latest: String?

    var isUpToDate: Bool {
        if let latest = latest { return installed == latest }
        return false
    }
}

// MARK: - Snapshot building

private let runningWindowMs: Double = 30 * 60 * 1000

private func priorityRank(_ tag: String?) -> Int {
    switch tag {
    case "P1": return 1
    case "P2": return 2
    case "P3": return 3
    case .some: return 4  // set but unrecognized: after p3
    case nil: return 5    // none last
    }
}

private func normalizedPriorityTag(_ v: Any?) -> String? {
    guard let s = (v as? String)?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
    return s.uppercased()
}

func buildSnapshot(key: String?) -> Snapshot {
    var snap = Snapshot()
    guard let key = key else { return snap }

    // Tasks (drives reachability / title)
    let (tasksObj, _) = CB.getJSON("/api/v1/tasks?full=true", key: key)
    guard let tasksObj = tasksObj, let tasks = tasksObj["tasks"] as? [[String: Any]] else {
        return snap
    }
    snap.ok = true

    let nowMs = Date().timeIntervalSince1970 * 1000
    var queued: [(rank: Double, prio: Int, order: Int, row: QueuedRow)] = []

    for (i, t) in tasks.enumerated() {
        if (t["done"] as? Bool) == true { continue }
        let title = (t["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "(untitled)"
        let claimedBy = t["claimedBy"] as? String
        let claimedAt = jsonNumber(t["claimedAt"])

        if let claimedBy = claimedBy, !claimedBy.isEmpty,
           let claimedAt = claimedAt, nowMs - claimedAt < runningWindowMs {
            var claimer = claimedBy
            if claimer.hasPrefix("agent:") {
                claimer = String(claimer.dropFirst("agent:".count))
            }
            let minutes = max(0, Int(((nowMs - claimedAt) / 60000).rounded(.down)))
            snap.running.append(RunningRow(title: title, claimer: claimer, minutes: minutes))
        } else {
            let rank = jsonNumber(t["rank"]) ?? .infinity  // missing rank sorts last
            let tag = normalizedPriorityTag(t["priority"])
            queued.append((rank, priorityRank(tag), i, QueuedRow(title: title, priorityTag: tag)))
        }
    }

    queued.sort {
        ($0.rank, $0.prio, $0.order) < ($1.rank, $1.prio, $1.order)
    }
    snap.queued = queued.map { $0.row }

    // Agents (best effort)
    if let agentsObj = CB.getJSON("/api/v1/agents", key: key).obj,
       let agents = agentsObj["agents"] as? [[String: Any]] {
        for a in agents {
            let label = (a["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (a["slug"] as? String) ?? "unknown"
            var usageText: String?
            if let usage = a["usage"] as? [String: Any],
               let windows = usage["windows"] as? [[String: Any]] {
                let parts: [String] = windows.compactMap { w in
                    guard let wl = w["label"] as? String, !wl.isEmpty,
                          let pct = jsonNumber(w["usedPct"]) else { return nil }
                    return "\(wl) \(Int(pct.rounded()))%"
                }
                if !parts.isEmpty { usageText = parts.joined(separator: " · ") }
            }
            let model = (a["model"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            snap.agents.append(AgentRow(label: label, usage: usageText, model: model))
        }
    }

    // Inbox (best effort)
    if let inboxObj = CB.getJSON("/api/v1/inbox", key: key).obj,
       let proposals = inboxObj["proposals"] as? [Any] {
        snap.inboxCount = proposals.count
    }

    return snap
}

// MARK: - Meta / client version

/// Latest cb version from /api/v1/meta (no auth). nil when the endpoint is
/// missing (404 — expected until it deploys) or unreachable.
func fetchLatestCLIVersion() -> String? {
    let (obj, _) = CB.getJSON("/api/v1/meta", key: nil)
    guard let latest = obj?["cliLatest"] as? String, !latest.isEmpty else { return nil }
    return latest
}

func installedCLIVersion() -> String {
    let path = CB.home.appendingPathComponent(".controlboard/cb.mjs").path
    guard let content = try? String(contentsOfFile: path, encoding: .utf8),
          let re = try? NSRegularExpression(pattern: #"CB_VERSION\s*=\s*(?:true\s*\?\s*)?"([^"]+)""#),
          let m = re.firstMatch(in: content, range: NSRange(content.startIndex..., in: content)),
          let r = Range(m.range(at: 1), in: content) else {
        return "pre-1.1"
    }
    return String(content[r])
}

func currentClientStatus(latest: String?) -> ClientStatus {
    ClientStatus(installed: installedCLIVersion(), latest: latest)
}

// MARK: - Shared row formatting (used by the menu and by --print)

func runningRowText(_ r: RunningRow) -> String {
    "「\(r.title)」 — \(r.claimer) · \(r.minutes)m"
}

func queuedRowText(index: Int, _ r: QueuedRow) -> String {
    var s = "\(index). \(r.title)"
    if let tag = r.priorityTag {
        s += "  [\(tag)]"
    }
    return s
}

func inboxRowText(_ count: Int) -> String {
    "Inbox: \(count) awaiting approval"
}

func clientRowText(_ c: ClientStatus) -> String {
    if c.isUpToDate {
        return "Client: cb \(c.installed) (up to date)"
    }
    if let latest = c.latest {
        return "Update client → \(latest)"
    }
    return "Client: cb \(c.installed) (latest unknown)"
}

let maxMenuRows = 5

// MARK: - Headless dump (--print)

func renderPlainText(snapshot s: Snapshot, client: ClientStatus) -> String {
    var lines: [String] = []
    lines.append(s.titleText)
    lines.append("Running (\(s.running.count))")
    for r in s.running.prefix(maxMenuRows) {
        lines.append("  " + runningRowText(r))
    }
    lines.append("Up next (\(s.queued.count))")
    for (i, r) in s.queued.prefix(maxMenuRows).enumerated() {
        lines.append("  " + queuedRowText(index: i + 1, r))
    }
    if s.inboxCount > 0 {
        lines.append(inboxRowText(s.inboxCount))
    }
    lines.append("Agents")
    if s.agents.isEmpty {
        lines.append("  (none)")
    }
    for a in s.agents {
        lines.append("  " + a.display)
    }
    var clientLine = clientRowText(client)
    if !client.isUpToDate && client.latest != nil {
        clientLine += " (installed: \(client.installed))"
    }
    lines.append(clientLine)
    return lines.joined(separator: "\n")
}
