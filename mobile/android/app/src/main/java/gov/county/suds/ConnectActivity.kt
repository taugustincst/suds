package gov.county.suds

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * First-run screen. Finds the SUDS server automatically through mDNS/DNS-SD (_suds._tcp, advertised by the
 * server), falling back to https://suds.local, a QR scan, or a typed address. Explains clearly when the phone
 * is not on Wi-Fi or no server answers, and verifies a typed address before switching to it.
 */
class ConnectActivity : AppCompatActivity() {
    private lateinit var nsd: NsdManager
    private var listener: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null
    private val ui = Handler(Looper.getMainLooper())
    private var resolved = false
    private var searching = false

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { text -> if (text.startsWith("http")) verifyThenFinish(text) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_connect)
        nsd = getSystemService(Context.NSD_SERVICE) as NsdManager
        findViewById<Button>(R.id.scan).setOnClickListener {
            scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the SUDS QR code").setBeepEnabled(false))
        }
        findViewById<Button>(R.id.connect).setOnClickListener {
            var a = findViewById<EditText>(R.id.address).text.toString().trim()
            if (a.isNotEmpty()) { if (!a.startsWith("http")) a = "https://$a"; verifyThenFinish(a) }
        }
        findViewById<Button>(R.id.retry).setOnClickListener { search() }
        findViewById<Button>(R.id.wifi).setOnClickListener { startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) }
        search()
    }

    override fun onResume() { super.onResume(); if (!searching && !resolved && !onWifi()) search() }

    private fun onWifi(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    private fun search() {
        if (searching) return
        val status = findViewById<TextView>(R.id.status)
        if (!onWifi()) {
            status.text = getString(R.string.no_wifi)
            findViewById<View>(R.id.progress).visibility = View.GONE
            findViewById<View>(R.id.manual).visibility = View.VISIBLE
            findViewById<View>(R.id.wifi).visibility = View.VISIBLE
            return
        }
        searching = true
        findViewById<View>(R.id.wifi).visibility = View.GONE
        findViewById<View>(R.id.manual).visibility = View.GONE
        findViewById<View>(R.id.progress).visibility = View.VISIBLE
        status.text = getString(R.string.searching)
        startDiscovery()
        // Give discovery a few seconds; then try the well-known name; then show manual options.
        ui.postDelayed({ if (!resolved) tryWellKnown() }, 5000)
    }

    private fun startDiscovery() {
        try { val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager; multicast = wm.createMulticastLock("suds-discovery").apply { setReferenceCounted(false); acquire() } } catch (_: Exception) {}
        val l = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(t: String, e: Int) {}
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onServiceLost(s: NsdServiceInfo) {}
            override fun onServiceFound(s: NsdServiceInfo) {
                if (!s.serviceType.contains("_suds._tcp")) return
                @Suppress("DEPRECATION")
                nsd.resolveService(s, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(i: NsdServiceInfo, e: Int) {}
                    override fun onServiceResolved(i: NsdServiceInfo) {
                        val tls = i.attributes["tls"]?.let { String(it) } != "0"
                        val host = i.host?.hostAddress ?: return
                        val port = i.port
                        val std = (tls && port == 443) || (!tls && port == 80)
                        val url = (if (tls) "https://" else "http://") + host + (if (std) "" else ":$port")
                        ui.post { finishWith(url) }
                    }
                })
            }
        }
        listener = l
        try { nsd.discoverServices("_suds._tcp", NsdManager.PROTOCOL_DNS_SD, l) } catch (_: Exception) {}
    }

    /** Probe /api/app/info on the given base URL; returns null on success or an error description. */
    private fun probe(base: String): String? = try {
        val c = java.net.URL("$base/api/app/info").openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 4000; c.readTimeout = 4000
        if (c is javax.net.ssl.HttpsURLConnection) { c.sslSocketFactory = Tls.permissive(); c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true } }
        if (c.responseCode == 200) null else "HTTP ${c.responseCode}"
    } catch (e: Exception) { e.javaClass.simpleName + (e.message?.let { ": $it" } ?: "") }

    private fun tryWellKnown() {
        Thread {
            val err = probe("https://suds.local")
            ui.post { if (err == null) finishWith("https://suds.local") else if (!resolved) showManual() }
        }.start()
    }

    private fun verifyThenFinish(url: String) {
        val base = url.trimEnd('/').substringBefore("#").substringBefore("/api").substringBefore("/app")
        val status = findViewById<TextView>(R.id.status)
        status.text = getString(R.string.testing, base)
        findViewById<View>(R.id.progress).visibility = View.VISIBLE
        Thread {
            val err = probe(base)
            ui.post {
                findViewById<View>(R.id.progress).visibility = View.GONE
                if (err == null) finishWith(base) else status.text = getString(R.string.unreachable, base, err)
            }
        }.start()
    }

    private fun showManual() {
        searching = false
        stopDiscovery()
        findViewById<TextView>(R.id.status).text = getString(R.string.not_found)
        findViewById<View>(R.id.progress).visibility = View.GONE
        findViewById<View>(R.id.manual).visibility = View.VISIBLE
    }

    private fun finishWith(url: String) {
        if (resolved) return
        resolved = true
        stopDiscovery()
        val base = url.trimEnd('/').substringBefore("#").substringBefore("/api").substringBefore("/app")
        findViewById<TextView>(R.id.status).text = getString(R.string.found, base)
        Prefs(this).serverUrl = base
        startActivity(Intent(this, MainActivity::class.java)); finish()
    }

    private fun stopDiscovery() {
        listener?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }; listener = null
        try { multicast?.release() } catch (_: Exception) {}; multicast = null
        searching = false
    }
    override fun onDestroy() { stopDiscovery(); super.onDestroy() }
}
