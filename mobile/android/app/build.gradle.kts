plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "gov.county.suds"
    compileSdk = 34
    defaultConfig {
        applicationId = "gov.county.suds"
        minSdk = 29 // Android 10+: SslCertificate.x509Certificate, NSD attributes
        targetSdk = 34
        versionCode = 3
        versionName = "1.1.0"
    }
    signingConfigs {
        // Release signing: set SUDS_KEYSTORE, SUDS_KEYSTORE_PASSWORD, SUDS_KEY_ALIAS, SUDS_KEY_PASSWORD (CI secrets or local env).
        // Without them the release build is signed with the debug key so it still installs for testing.
        create("release") {
            val ks = System.getenv("SUDS_KEYSTORE")
            if (ks != null) { storeFile = file(ks); storePassword = System.getenv("SUDS_KEYSTORE_PASSWORD"); keyAlias = System.getenv("SUDS_KEY_ALIAS"); keyPassword = System.getenv("SUDS_KEY_PASSWORD") }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("SUDS_KEYSTORE") != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    // The web app (public/) is bundled into the APK so SUDS runs entirely on the device.
    sourceSets { getByName("main") { assets.srcDirs("../../../public") } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
