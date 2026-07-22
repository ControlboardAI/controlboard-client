import Foundation

/// Native client updater: downloads cb.mjs + controlboard-mcp.mjs, sanity-checks,
/// and atomically replaces the files in ~/.controlboard, preserving the exec bit.
enum Updater {
    struct Outcome {
        let ok: Bool
        let message: String
    }

    private static let shebang = "#!/usr/bin/env node"
    private static let minBytes = 10_000

    /// Blocking; call from a background queue.
    static func performUpdate(expectedLatest: String?) -> Outcome {
        let targets: [(remote: String, localName: String)] = [
            ("/cli/cb.mjs", "cb.mjs"),
            ("/mcp/controlboard-mcp.mjs", "controlboard-mcp.mjs"),
        ]

        let dir = CB.home.appendingPathComponent(".controlboard", isDirectory: true)
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        // Download and validate everything before touching any file on disk.
        var payloads: [(dest: URL, data: Data)] = []
        for t in targets {
            let (data, status) = CB.getSync(t.remote, key: nil)
            guard status == 200, let data = data else {
                return Outcome(ok: false, message: "Download failed for \(t.remote) (HTTP \(status)).")
            }
            guard data.count > minBytes,
                  let head = String(data: data.prefix(64), encoding: .utf8),
                  head.hasPrefix(shebang) else {
                return Outcome(ok: false, message: "Sanity check failed for \(t.remote) (unexpected content).")
            }
            payloads.append((dir.appendingPathComponent(t.localName), data))
        }

        // Atomic install: write a temp file alongside, fix permissions, rename over.
        for p in payloads {
            var perms: Int = 0o755
            if let attrs = try? fm.attributesOfItem(atPath: p.dest.path),
               let existing = attrs[.posixPermissions] as? Int {
                perms = existing | 0o100  // preserve prior mode, keep it executable
            }
            let tmp = dir.appendingPathComponent(".\(p.dest.lastPathComponent).tmp.\(ProcessInfo.processInfo.processIdentifier)")
            do {
                try p.data.write(to: tmp)
                try fm.setAttributes([.posixPermissions: perms], ofItemAtPath: tmp.path)
                if rename(tmp.path, p.dest.path) != 0 {
                    try? fm.removeItem(at: tmp)
                    return Outcome(ok: false, message: "Could not replace \(p.dest.lastPathComponent).")
                }
            } catch {
                try? fm.removeItem(at: tmp)
                return Outcome(ok: false, message: "Could not write \(p.dest.lastPathComponent): \(error.localizedDescription)")
            }
        }

        // Re-check what is now installed.
        let installedNow = installedCLIVersion()
        if let expected = expectedLatest, installedNow == expected {
            return Outcome(ok: true, message: "Client updated to cb \(installedNow).")
        }
        return Outcome(ok: true, message: "Files replaced; installed version now reads \(installedNow).")
    }
}
