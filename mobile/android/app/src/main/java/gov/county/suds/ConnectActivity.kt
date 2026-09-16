package gov.county.suds

import android.content.Context
import android.content.Intent
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * First-run screen. Finds the SUDS server automatically through mDNS/DNS-SD (_suds._tcp, advertised by the
 * server), falling back to https://suds.local, a QR scan, or a typed address.
 */
class ConnectActivity : AppCompatActivity() {
    private lateinit var nsd: NsdManager
    private var listener: NsdManager.DiscoveryListener? = null
    private val ui = Handler(Looper.getMainLooper())
    private var resolved = false

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { text -> if (text.startsWith("http")) finishWith(text) }
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
            if (a.isNotEmpty()) { if (!a.startsWith("http")) a = "https://$a"; finishWith(a) }
        }
        startDiscovery()
        // Give discovery a few seconds; then try the well-known name; then show manual options.
        ui.postDelayed({ if (!resolved) tryWellKnown() }, 4000)
    }

    private fun startDiscovery() {
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

    private fun tryWellKnown() {
        findViewById<TextView>(R.id.status).text = getString(R.string.searching)
        Thread {
            val ok = try {
                val c = java.net.URL("https://suds.local/api/app/info").openConnection() as javax.net.ssl.HttpsURLConnection
                c.connectTimeout = 3000; c.readTimeout = 3000
                c.sslSocketFactory = Tls.permissive(); c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
                c.responseCode == 200
            } catch (_: Exception) { false }
            ui.post { if (ok) finishWith("https://suds.local") else if (!resolved) showManual() }
        }.start()
    }

    private fun showManual() {
        findViewById<TextView>(R.id.status).text = getString(R.string.not_found)
        findViewById<View>(R.id.progress).visibility = View.GONE
        findViewById<View>(R.id.manual).visibility = View.VISIBLE
    }

    private fun finishWith(url: String) {
        if (resolved) return
        resolved = true
        stopDiscovery()
        val base = url.trimEnd('/').substringBefore("#").substringBefore("/api")
        findViewById<TextView>(R.id.status).text = getString(R.string.found, base)
        Prefs(this).serverUrl = base
        startActivity(Intent(this, MainActivity::class.java)); finish()
    }

    private fun stopDiscovery() { listener?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }; listener = null }
    override fun onDestroy() { stopDiscovery(); super.onDestroy() }
}
