import Foundation
import Network
import CryptoKit
import Security

/// Finds the SUDS server on the local network (Bonjour `_suds._tcp`, then https://suds.local) and remembers it,
/// together with the fingerprint of the self-signed certificate the user trusted.
final class ConnectionModel: ObservableObject {
    @Published var serverURL: URL? = UserDefaults.standard.url(forKey: "server_url")
    @Published var status = "Looking for SUDS on this Wi-Fi…"
    @Published var showManual = false
    var trustedFingerprint: String? {
        get { UserDefaults.standard.string(forKey: "cert_sha256") }
        set { UserDefaults.standard.set(newValue, forKey: "cert_sha256") }
    }
    private var browser: NWBrowser?

    func forget() { UserDefaults.standard.removeObject(forKey: "server_url"); UserDefaults.standard.removeObject(forKey: "cert_sha256"); serverURL = nil; showManual = false; discover() }

    func setServer(_ text: String) {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.hasPrefix("http") { t = "https://" + t }
        guard let u = URL(string: t), let scheme = u.scheme, let host = u.host else { return }
        var c = URLComponents(); c.scheme = scheme; c.host = host; c.port = u.port
        if let base = c.url { UserDefaults.standard.set(base, forKey: "server_url"); browser?.cancel(); DispatchQueue.main.async { self.serverURL = base } }
    }

    func discover() {
        let b = NWBrowser(for: .bonjour(type: "_suds._tcp", domain: nil), using: .tcp)
        browser = b
        b.browseResultsChangedHandler = { results, _ in
            guard let r = results.first else { return }
            let conn = NWConnection(to: r.endpoint, using: .tcp)
            conn.stateUpdateHandler = { st in
                if case .ready = st, let path = conn.currentPath, let ep = path.remoteEndpoint, case let .hostPort(host, port) = ep {
                    var tls = true
                    if case let .bonjour(txt) = r.metadata, let v = txt.dictionary["tls"] { tls = v != "0" }
                    let h = "\(host)".components(separatedBy: "%").first ?? "\(host)"
                    let std = (tls && port.rawValue == 443) || (!tls && port.rawValue == 80)
                    self.setServer((tls ? "https://" : "http://") + h + (std ? "" : ":\(port.rawValue)"))
                    conn.cancel()
                }
            }
            conn.start(queue: .global())
        }
        b.start(queue: .global())
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, self.serverURL == nil else { return }
            self.probeWellKnown()
        }
    }

    private func probeWellKnown() {
        let session = URLSession(configuration: .ephemeral, delegate: PermissiveDelegate(), delegateQueue: nil)
        var req = URLRequest(url: URL(string: "https://suds.local/api/app/info")!); req.timeoutInterval = 3
        session.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async {
                if (resp as? HTTPURLResponse)?.statusCode == 200 { self.setServer("https://suds.local") }
                else if self.serverURL == nil { self.status = "SUDS was not found automatically. Make sure the phone is on the office Wi-Fi, then type the address shown under Settings → Network & devices."; self.showManual = true }
            }
        }.resume()
    }

    static func fingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        let data = SecCertificateCopyData(leaf) as Data
        return SHA256.hash(data: data).map { String(format: "%02X", $0) }.joined(separator: ":")
    }
}

/// Used only for the discovery probe: accepts any certificate. App traffic goes through WebScreen's trust check.
final class PermissiveDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let t = challenge.protectionSpace.serverTrust { completionHandler(.useCredential, URLCredential(trust: t)) } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
}
