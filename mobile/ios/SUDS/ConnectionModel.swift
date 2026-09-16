import Foundation
import Network
import CryptoKit
import Security

/// Discovers the office SUDS server (Bonjour `_suds._tcp`) for the in-app Sync screen, and remembers the
/// fingerprint of the office server's self-signed certificate once the user has trusted it.
final class ConnectionModel: ObservableObject {
    @Published var discovered: String? = nil
    var trustedFingerprint: String? {
        get { UserDefaults.standard.string(forKey: "cert_sha256") }
        set { UserDefaults.standard.set(newValue, forKey: "cert_sha256") }
    }
    private var browser: NWBrowser?

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
                    DispatchQueue.main.async { self.discovered = (tls ? "https://" : "http://") + h + (std ? "" : ":\(port.rawValue)") }
                    conn.cancel()
                }
            }
            conn.start(queue: .global())
        }
        b.start(queue: .global())
    }

    static func fingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        let data = SecCertificateCopyData(leaf) as Data
        return SHA256.hash(data: data).map { String(format: "%02X", $0) }.joined(separator: ":")
    }
}
