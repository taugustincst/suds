import SwiftUI
import WebKit
import LocalAuthentication

/// SUDS on the phone: the complete web app is bundled in the app (public/ folder) and runs entirely on the
/// device. Sync talks to the office server only when the user asks.
struct WebScreen: View {
    @ObservedObject var model: ConnectionModel
    @State private var locked = false
    @State private var pausedAt = Date()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        ZStack {
            WebView(model: model).ignoresSafeArea(.keyboard)
            if locked { Color(.systemBackground).ignoresSafeArea().overlay(VStack { Text("SUDS").font(.title.bold()); Button("Unlock") { unlock() }.buttonStyle(.borderedProminent) }) }
        }
        .onAppear { model.discover() }
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
    let model: ConnectionModel
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration(); cfg.websiteDataStore = .default(); cfg.allowsInlineMediaPlayback = true
        cfg.userContentController.add(context.coordinator, name: "suds")
        // window.SudsNative shim: same surface as the Android bridge, implemented with message handlers
        let bridge = """
        window.SudsNative = { discover: function(){ return window.__sudsDiscovered ? JSON.stringify(window.__sudsDiscovered) : null; },
          saveFile: function(name, b64, mime){ webkit.messageHandlers.suds.postMessage({type:'saveFile', name:name, data:b64, mime:mime}); },
          forgetCertificate: function(){ webkit.messageHandlers.suds.postMessage({type:'forgetCertificate'}); } };
        """
        cfg.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.navigationDelegate = context.coordinator; w.uiDelegate = context.coordinator
        w.customUserAgent = (w.value(forKey: "userAgent") as? String ?? "") + " SUDSApp/1.1"
        w.scrollView.refreshControl = UIRefreshControl(); w.scrollView.refreshControl?.addTarget(context.coordinator, action: #selector(Coordinator.refresh(_:)), for: .valueChanged)
        context.coordinator.web = w
        if let dir = Bundle.main.url(forResource: "public", withExtension: nil) {
            var c = URLComponents(url: dir.appendingPathComponent("index.html"), resolvingAgainstBaseURL: false)!; c.query = "local=1"
            w.loadFileURL(c.url!, allowingReadAccessTo: dir)
        }
        return w
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {
        if let d = model.discovered { uiView.evaluateJavaScript("window.__sudsDiscovered = \(String(data: try! JSONEncoder().encode(d), encoding: .utf8)!)") }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let model: ConnectionModel; weak var web: WKWebView?
        init(model: ConnectionModel) { self.model = model }
        @objc func refresh(_ c: UIRefreshControl) { web?.reload(); c.endRefreshing() }
        func userContentController(_ u: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let m = message.body as? [String: Any], let type = m["type"] as? String else { return }
            if type == "forgetCertificate" { model.trustedFingerprint = nil }
            if type == "saveFile", let name = m["name"] as? String, let b64 = m["data"] as? String, let data = Data(base64Encoded: b64) {
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent(name.replacingOccurrences(of: "/", with: "_"))
                try? data.write(to: dest)
                present(UIActivityViewController(activityItems: [dest], applicationActivities: nil))
            }
        }
        // Office server's self-signed certificate (used by Sync): trusted once by fingerprint, confirmed by the user.
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust, let fp = ConnectionModel.fingerprint(trust) else { completionHandler(.performDefaultHandling, nil); return }
            if SecTrustEvaluateWithError(trust, nil) { completionHandler(.useCredential, URLCredential(trust: trust)); return }
            if let t = model.trustedFingerprint { if t == fp { completionHandler(.useCredential, URLCredential(trust: trust)) } else { completionHandler(.cancelAuthenticationChallenge, nil); DispatchQueue.main.async { self.certChanged() } }; return }
            DispatchQueue.main.async {
                let a = UIAlertController(title: "First connection to the office SUDS", message: "Compare this fingerprint with the one shown under Settings → Network & devices, then tap Trust.\n\n\(fp)", preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(.cancelAuthenticationChallenge, nil) })
                a.addAction(UIAlertAction(title: "Trust", style: .default) { _ in self.model.trustedFingerprint = fp; completionHandler(.useCredential, URLCredential(trust: trust)) })
                self.present(a)
            }
        }
        private func certChanged() {
            let a = UIAlertController(title: "Certificate changed", message: "The office server certificate has changed. If your administrator renewed it, forget it and sync again.", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Forget certificate", style: .destructive) { _ in self.model.trustedFingerprint = nil }); a.addAction(UIAlertAction(title: "Cancel", style: .cancel)); present(a)
        }
        private func present(_ vc: UIViewController) { UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController?.present(vc, animated: true) }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let u = navigationAction.request.url, u.scheme?.hasPrefix("http") == true, navigationAction.navigationType == .linkActivated { UIApplication.shared.open(u); decisionHandler(.cancel) } else { decisionHandler(.allow) }
        }
    }
}
