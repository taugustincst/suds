import Foundation
import WebKit

/// Serves the bundled web app (public/ folder) at suds://app/… so ES modules, fetch() and WebAssembly work
/// like a normal https origin (file:// blocks module scripts and fetch in WKWebView).
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "suds"
    private let root: URL
    init(root: URL) { self.root = root }
    private static let mime: [String: String] = ["html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "json": "application/json", "wasm": "application/wasm", "svg": "image/svg+xml", "png": "image/png", "webmanifest": "application/manifest+json", "txt": "text/plain", "md": "text/markdown"]
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(path)
        guard file.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!); task.didReceive(Data("Not found".utf8)); task.didFinish(); return
        }
        let type = AppSchemeHandler.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let headers = ["Content-Type": type + (type.hasPrefix("text/") ? "; charset=utf-8" : ""), "Content-Length": String(data.count), "Cache-Control": "no-store"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// Device encryption keys for the local database, stored in the iOS Keychain (hardware-backed on modern devices).
enum DeviceSecrets {
    static func hex(_ name: String) -> String {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "gov.county.suds", kSecAttrAccount as String: name, kSecReturnData as String: true]
        var out: AnyObject?
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) { return s }
        var bytes = [UInt8](repeating: 0, count: 32); _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
        let s = bytes.map { String(format: "%02x", $0) }.joined()
        let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "gov.county.suds", kSecAttrAccount as String: name, kSecValueData as String: Data(s.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        SecItemAdd(add as CFDictionary, nil)
        return s
    }
}
