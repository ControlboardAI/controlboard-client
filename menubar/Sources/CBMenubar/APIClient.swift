import Foundation

/// Low-level ControlBoard API access: config/key resolution and synchronous HTTP GETs.
/// Foundation-only (no AppKit) so it is usable from headless --print mode.
enum CB {
    static var home: URL {
        FileManager.default.homeDirectoryForCurrentUser
    }

    static var baseURL: URL {
        if let s = ProcessInfo.processInfo.environment["CONTROLBOARD_URL"],
           let u = URL(string: s), u.scheme != nil {
            return u
        }
        return URL(string: "https://controlboard.ai")!
    }

    /// Resolve the API key: default agent's key from config.json, else legacy
    /// top-level "key", else CONTROLBOARD_API_KEY. Never log or print this value.
    static func apiKey() -> String? {
        let cfg = home.appendingPathComponent(".config/controlboard/config.json")
        if let data = try? Data(contentsOf: cfg),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if let def = obj["default"] as? String,
               let agents = obj["agents"] as? [String: Any],
               let agent = agents[def] as? [String: Any],
               let key = agent["key"] as? String, !key.isEmpty {
                return key
            }
            if let key = obj["key"] as? String, !key.isEmpty {
                return key
            }
        }
        if let key = ProcessInfo.processInfo.environment["CONTROLBOARD_API_KEY"], !key.isEmpty {
            return key
        }
        return nil
    }

    static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 30
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    /// Synchronous GET. Returns (body, http status). status 0 means transport error.
    /// Callers must invoke this off the main thread (or in --print mode).
    static func getSync(_ path: String, key: String?) -> (data: Data?, status: Int) {
        guard let url = URL(string: path, relativeTo: baseURL) else { return (nil, 0) }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        if let key = key {
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        let sem = DispatchSemaphore(value: 0)
        var result: (Data?, Int) = (nil, 0)
        let task = session.dataTask(with: req) { data, resp, _ in
            result = (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
            sem.signal()
        }
        task.resume()
        sem.wait()
        return result
    }

    /// GET + parse a top-level JSON object.
    static func getJSON(_ path: String, key: String?) -> (obj: [String: Any]?, status: Int) {
        let (data, status) = getSync(path, key: key)
        guard status == 200, let data = data,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return (nil, status)
        }
        return (obj, status)
    }
}

/// Defensive numeric coercion for JSON values (NSNumber, Int, Double, numeric String).
func jsonNumber(_ v: Any?) -> Double? {
    switch v {
    case let n as NSNumber:
        return n.doubleValue
    case let d as Double:
        return d
    case let i as Int:
        return Double(i)
    case let s as String:
        return Double(s)
    default:
        return nil
    }
}
