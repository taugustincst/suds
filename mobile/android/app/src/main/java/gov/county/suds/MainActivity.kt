package gov.county.suds

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.webkit.*
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebViewAssetLoader
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.io.File
import java.security.cert.X509Certificate

/**
 * SUDS on the phone. The complete SUDS web app is bundled in the APK and runs entirely on the device
 * (local kernel: SQLite in WebAssembly, encrypted at rest). No server is needed to install or use it.
 * "Sync" in the app talks to the office SUDS server when the user chooses; this activity provides the
 * native pieces: office-server discovery (DNS-SD), certificate trust by fingerprint, QR scanning,
 * device unlock on return, and saving downloaded files.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var prefs: Prefs
    private var lastPaused = 0L
    private var discovered: String? = null
    private var nsdListener: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('suds-scan',{detail:${JSONObjectQuote(text)}}))", null)
    }
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val data = result.data
        val uris: Array<Uri>? = when {
            result.resultCode != RESULT_OK || data == null -> null
            data.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        cb.onReceiveValue(uris)
    }
    private fun JSONObjectQuote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        val swipe = findViewById<SwipeRefreshLayout>(R.id.swipe)
        swipe.setOnRefreshListener { web.reload(); swipe.isRefreshing = false }
        with(web.settings) {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true; allowFileAccess = false; allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT; mediaPlaybackRequiresUserGesture = true; setSupportZoom(false)
            userAgentString = "$userAgentString SUDSApp/1.1"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.addJavascriptInterface(Bridge(), "SudsNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.shouldInterceptRequest(request.url)
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // Only the office server's self-signed certificate is ever accepted, after the user confirmed its fingerprint.
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
                return if (u.host == "appassets.androidplatform.net") false else { startActivity(Intent(Intent.ACTION_VIEW, u)); true }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // <input type="file"> (resource pictures): open the system picker; nothing else in the app uploads files
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = callback
                return try { filePicker.launch(params.createIntent().apply { putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true) }); true } catch (e: Exception) { fileCallback = null; false }
            }
        }
        if (savedInstanceState == null) web.loadUrl("https://appassets.androidplatform.net/assets/index.html?local=1") else web.restoreState(savedInstanceState)
        startDiscovery()
    }

    /** Database encryption keys, generated on first use and kept in an Android Keystore-encrypted preferences file. */
    private val secrets by lazy {
        val master = MasterKey.Builder(this).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(this, "suds_secrets", master, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    }
    private fun secret(name: String): String {
        secrets.getString(name, null)?.let { return it }
        val b = ByteArray(32); SecureRandom().nextBytes(b); val hex = b.joinToString("") { "%02x".format(it) }
        secrets.edit().putString(name, hex).apply(); return hex
    }

    /** Exposed to the web app as window.SudsNative */
    inner class Bridge {
        @JavascriptInterface fun getSecret(name: String): String? = if (name.startsWith("suds.local.")) secret(name) else null
        @JavascriptInterface fun discover(): String? = discovered?.let { "\"$it\"" }
        @JavascriptInterface fun scanQr() { runOnUiThread { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the office SUDS QR code").setBeepEnabled(false)) } }
        @JavascriptInterface fun forgetCertificate() { prefs.certFingerprint = null }
        @JavascriptInterface fun saveFile(name: String, base64: String, mime: String) {
            val dir = File(cacheDir, "downloads").apply { mkdirs() }
            val f = File(dir, name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
            f.writeBytes(Base64.decode(base64, Base64.DEFAULT))
            val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", f)
            runOnUiThread { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Save or share $name")) }
        }
    }

    private fun startDiscovery() {
        try { val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager; multicast = wm.createMulticastLock("suds").apply { setReferenceCounted(false); acquire() } } catch (_: Exception) {}
        val nsd = getSystemService(Context.NSD_SERVICE) as NsdManager
        val l = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(t: String, e: Int) {} override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onDiscoveryStarted(t: String) {} override fun onDiscoveryStopped(t: String) {} override fun onServiceLost(s: NsdServiceInfo) {}
            override fun onServiceFound(s: NsdServiceInfo) {
                if (!s.serviceType.contains("_suds._tcp")) return
                @Suppress("DEPRECATION")
                nsd.resolveService(s, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(i: NsdServiceInfo, e: Int) {}
                    override fun onServiceResolved(i: NsdServiceInfo) {
                        val tls = i.attributes["tls"]?.let { String(it) } != "0"; val host = i.host?.hostAddress ?: return; val port = i.port
                        val std = (tls && port == 443) || (!tls && port == 80)
                        discovered = (if (tls) "https://" else "http://") + host + (if (std) "" else ":$port")
                    }
                })
            }
        }
        nsdListener = l
        try { nsd.discoverServices("_suds._tcp", NsdManager.PROTOCOL_DNS_SD, l) } catch (_: Exception) {}
    }

    private fun askTrust(fp: String, cert: X509Certificate, cb: (Boolean) -> Unit) {
        runOnUiThread { AlertDialog.Builder(this).setTitle(R.string.trust_title).setMessage(getString(R.string.trust_body, fp + "\n\n" + cert.subjectX500Principal.name))
            .setPositiveButton(R.string.trust) { _, _ -> cb(true) }.setNegativeButton(R.string.cancel) { _, _ -> cb(false) }.setCancelable(false).show() }
    }
    private fun certChanged() {
        runOnUiThread { AlertDialog.Builder(this).setMessage(R.string.cert_changed).setPositiveButton(R.string.forget_server) { _, _ -> prefs.certFingerprint = null }.setNegativeButton(R.string.cancel, null).show() }
    }

    // Require device unlock when returning after 2 minutes in the background (PHI on screen and on device).
    override fun onPause() { super.onPause(); lastPaused = System.currentTimeMillis(); if (::web.isInitialized) { web.evaluateJavascript("window.SUDS_LOCAL&&window.SUDS_LOCAL.flush()", null); web.visibility = View.INVISIBLE } }
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
    override fun onDestroy() { nsdListener?.let { try { (getSystemService(Context.NSD_SERVICE) as NsdManager).stopServiceDiscovery(it) } catch (_: Exception) {} }; try { multicast?.release() } catch (_: Exception) {}; super.onDestroy() }
}
