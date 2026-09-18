plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

// Refuse to produce an unsigned-for-release APK rather than shipping one signed with a throwaway key.
gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { it.name.contains("Release") && (it.name.startsWith("assemble") || it.name.startsWith("bundle") || it.name.startsWith("package")) }
    if (buildsRelease && System.getenv("SUDS_KEYSTORE") == null) {
        throw GradleException(
            "A release build needs SUDS_KEYSTORE, SUDS_KEYSTORE_PASSWORD, SUDS_KEY_ALIAS and SUDS_KEY_PASSWORD. " +
            "Use ./gradlew assembleDebug for a test build."
        )
    }
}

android {
    namespace = "gov.county.suds"
    compileSdk = 34
    defaultConfig {
        applicationId = "gov.county.suds"
        minSdk = 29 // Android 10+: SslCertificate.x509Certificate, NSD attributes
        targetSdk = 34
        versionCode = 10700
        versionName = "1.7.0"
    }
    signingConfigs {
        // Release signing: set SUDS_KEYSTORE, SUDS_KEYSTORE_PASSWORD, SUDS_KEY_ALIAS, SUDS_KEY_PASSWORD (CI secrets or local env).
        // A release APK must be signed with the county's own key. Falling back to the debug key looks
        // harmless but the CI runner generates a fresh one each time, so every release is signed by a
        // different key and Android refuses to install it over the previous version
        // (INSTALL_FAILED_UPDATE_INCOMPATIBLE) — staff would have to uninstall, losing the data on the
        // device. Debug builds still work with no keystore configured.
        create("release") {
            val ks = System.getenv("SUDS_KEYSTORE")
            if (ks != null) { storeFile = file(ks); storePassword = System.getenv("SUDS_KEYSTORE_PASSWORD"); keyAlias = System.getenv("SUDS_KEY_ALIAS"); keyPassword = System.getenv("SUDS_KEY_PASSWORD") }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
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
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
