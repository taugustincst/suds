package gov.county.suds

import android.content.Context

/** Stored server connection: base URL and the SHA-256 fingerprint of the certificate the user trusted. */
class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("suds", Context.MODE_PRIVATE)
    var serverUrl: String?
        get() = p.getString("server_url", null)
        set(v) = p.edit().putString("server_url", v).apply()
    var certFingerprint: String?
        get() = p.getString("cert_sha256", null)
        set(v) = p.edit().putString("cert_sha256", v).apply()
    fun forget() = p.edit().clear().apply()
}
