package gov.county.suds

import android.app.DownloadManager
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.*
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import java.security.cert.X509Certificate

/**
 * Hosts the SUDS web app. The web app itself is served by the SUDS server (same code as on the computer), so
 * everything stays in sync automatically. This wrapper adds: server discovery, certificate trust by fingerprint,
 * device unlock (biometric / PIN) when the app is reopened, file downloads (CSV exports, backups), and back navigation.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var prefs: Prefs
    private var lastPaused = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val base = prefs.serverUrl
        if (base == null) { startActivity(Intent(this, ConnectActivity::class.java)); finish(); return }
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        val swipe = findViewById<SwipeRefreshLayout>(R.id.swipe)
        swipe.setOnRefreshListener { web.reload(); swipe.isRefreshing = false }
        with(web.settings) {
            javaScriptEnabled = true; domStorageEnabled = true; allowFileAccess = false; allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT; mediaPlaybackRequiresUserGesture = true; setSupportZoom(false)
            userAgentString = "$userAgentString SUDSApp/1.0"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // Only the self-signed SUDS certificate is ever accepted, and only after the user confirmed its fingerprint.
                val cert = error.certificate.x509Certificate
                if (cert == null) { handler.cancel(); return }
                val fp = Tls.fingerprint(cert)
                val trusted = prefs.certFingerprint
                when {
                    trusted == fp -> handler.proceed()
                    trusted == null -> askTrust(fp, cert) { ok -> if (ok) { prefs.certFingerprint = fp; handler.proceed() } else handler.cancel() }
                    else -> { handler.cancel(); certChanged() }
                }
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                return if (u.toString().startsWith(base)) false else { startActivity(Intent(Intent.ACTION_VIEW, u)); true }
            }
        }
        web.webChromeClient = WebChromeClient()
        web.setDownloadListener { url, ua, contentDisposition, mime, _ ->
            val req = DownloadManager.Request(Uri.parse(url)).setMimeType(mime).setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            req.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url)); req.addRequestHeader("User-Agent", ua)
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, contentDisposition, mime))
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
        }
        if (savedInstanceState == null) web.loadUrl("$base/") else web.restoreState(savedInstanceState)
    }

    private fun askTrust(fp: String, cert: X509Certificate, cb: (Boolean) -> Unit) {
        AlertDialog.Builder(this).setTitle(R.string.trust_title).setMessage(getString(R.string.trust_body, fp + "\n\n" + cert.subjectX500Principal.name))
            .setPositiveButton(R.string.trust) { _, _ -> cb(true) }.setNegativeButton(R.string.cancel) { _, _ -> cb(false) }.setCancelable(false).show()
    }
    private fun certChanged() {
        AlertDialog.Builder(this).setMessage(R.string.cert_changed).setPositiveButton(R.string.forget_server) { _, _ -> prefs.forget(); recreate() }.setNegativeButton(R.string.cancel, null).show()
    }

    // Require device unlock when returning after 2 minutes in the background (PHI on screen).
    override fun onPause() { super.onPause(); lastPaused = System.currentTimeMillis(); if (::web.isInitialized) web.visibility = View.INVISIBLE }
    override fun onResume() {
        super.onResume()
        if (!::web.isInitialized) return
        if (System.currentTimeMillis() - lastPaused < 120_000 || lastPaused == 0L) { web.visibility = View.VISIBLE; return }
        val bm = BiometricManager.from(this)
        val auths = BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        if (bm.canAuthenticate(auths) != BiometricManager.BIOMETRIC_SUCCESS) { web.visibility = View.VISIBLE; return }
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) { web.visibility = View.VISIBLE }
            override fun onAuthenticationError(code: Int, s: CharSequence) { finish() }
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(getString(R.string.unlock)).setAllowedAuthenticators(auths).build())
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed() }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); if (::web.isInitialized) web.saveState(outState) }
}
