import SwiftUI
import WebKit
import LocalAuthentication

/// Hosts the SUDS web app served by the server (same code as the computer, always in sync).
struct WebScreen: View {
    let url: URL
    @ObservedObject var model: ConnectionModel
    @State private var locked = false
    @State private var pausedAt = Date()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        ZStack {
            WebView(url: url, model: model).ignoresSafeArea(.keyboard)
            if locked { Color(.systemBackground).ignoresSafeArea().overlay(VStack { Text("SUDS").font(.title.bold()); Button("Unlock") { unlock() }.buttonStyle(.borderedProminent) }) }
        }
        .onChange(of: phase) { p in
            if p == .background { pausedAt = Date() }
            if p == .active && Date().timeIntervalSince(pausedAt) > 120 { locked = true; unlock() }
        }
    }
    private func unlock() {
        let ctx = LAContext(); var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { locked = false; return }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock SUDS") { ok, _ in DispatchQueue.main.async { locked = !ok } }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    let model: ConnectionModel
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration(); cfg.websiteDataStore = .default(); cfg.allowsInlineMediaPlayback = true
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.navigationDelegate = context.coordinator; w.uiDelegate = context.coordinator
        w.allowsBackForwardNavigationGestures = true
        w.customUserAgent = (w.value(forKey: "userAgent") as? String ?? "") + " SUDSApp/1.0"
        w.scrollView.refreshControl = UIRefreshControl(); w.scrollView.refreshControl?.addTarget(context.coordinator, action: #selector(Coordinator.refresh(_:)), for: .valueChanged)
        context.coordinator.web = w
        w.load(URLRequest(url: url))
        return w
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let model: ConnectionModel; weak var web: WKWebView?
        init(model: ConnectionModel) { self.model = model }
        @objc func refresh(_ c: UIRefreshControl) { web?.reload(); c.endRefreshing() }
        // Self-signed SUDS certificate: trusted once by fingerprint, confirmed by the user.
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust, let fp = ConnectionModel.fingerprint(trust) else { completionHandler(.performDefaultHandling, nil); return }
            if SecTrustEvaluateWithError(trust, nil) { completionHandler(.useCredential, URLCredential(trust: trust)); return }
            if let t = model.trustedFingerprint { if t == fp { completionHandler(.useCredential, URLCredential(trust: trust)) } else { completionHandler(.cancelAuthenticationChallenge, nil); DispatchQueue.main.async { self.certChanged() } }; return }
            DispatchQueue.main.async {
                let a = UIAlertController(title: "First connection to this SUDS", message: "Compare this fingerprint with the one shown under Settings → Network & devices, then tap Trust.\n\n\(fp)", preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(.cancelAuthenticationChallenge, nil) })
                a.addAction(UIAlertAction(title: "Trust", style: .default) { _ in self.model.trustedFingerprint = fp; completionHandler(.useCredential, URLCredential(trust: trust)) })
                self.present(a)
            }
        }
        private func certChanged() {
            let a = UIAlertController(title: "Certificate changed", message: "The server certificate has changed. If your administrator renewed it, forget the server and connect again.", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Forget server", style: .destructive) { _ in self.model.forget() }); a.addAction(UIAlertAction(title: "Cancel", style: .cancel)); present(a)
        }
        private func present(_ vc: UIViewController) { UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController?.present(vc, animated: true) }
        // Open external links in Safari; downloads (CSV exports) via the share sheet
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let u = navigationAction.request.url, let host = u.host, host != webView.url?.host, navigationAction.navigationType == .linkActivated { UIApplication.shared.open(u); decisionHandler(.cancel) } else { decisionHandler(.allow) }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if let r = navigationResponse.response as? HTTPURLResponse, (r.value(forHTTPHeaderField: "Content-Disposition") ?? "").contains("attachment"), let u = r.url {
                decisionHandler(.cancel)
                let cfg = URLSessionConfiguration.default; cfg.httpCookieStorage = .shared
                WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                    cookies.forEach { HTTPCookieStorage.shared.setCookie($0) }
                    URLSession(configuration: cfg, delegate: PermissiveDelegate(), delegateQueue: nil).downloadTask(with: u) { tmp, resp, _ in
                        guard let tmp else { return }
                        let name = resp?.suggestedFilename ?? "download"; let dest = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                        try? FileManager.default.removeItem(at: dest); try? FileManager.default.moveItem(at: tmp, to: dest)
                        DispatchQueue.main.async { let s = UIActivityViewController(activityItems: [dest], applicationActivities: nil); self.present(s) }
                    }.resume()
                }
            } else { decisionHandler(.allow) }
        }
    }
}
