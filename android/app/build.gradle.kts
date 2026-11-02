// Bolli DR for Android TV and Google TV: the web app (apps/bolli-dr,
// copied into app/src/main/assets: see README.md) in a full-screen web view.
// The id, name and version come from apps/bolli-dr/appinfo.json; version
// x.y.z is versionCode x * 1000000 + y * 1000 + z.
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

val info = JsonSlurper().parse(rootProject.file("../apps/bolli-dr/appinfo.json")) as Map<*, *>
val appVersion = info["version"] as String

fun versionCodeOf(version: String): Int {
    val parts = version.split(".").map { it.toIntOrNull() ?: -1 }
    require(parts.size == 3 && parts.all { it in 0..999 }) { "appinfo.json's version must be x.y.z, each below 1000: $version" }
    return parts[0] * 1000000 + parts[1] * 1000 + parts[2]
}

/** A Java string literal for BuildConfig */
fun quoted(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "org.bolli.dr"
    compileSdk = 36

    defaultConfig {
        applicationId = info["id"] as String
        // Android TV 5.1 and newer
        minSdk = 22
        targetSdk = 36
        versionName = appVersion
        versionCode = versionCodeOf(appVersion)
        manifestPlaceholders["label"] = info["title"] as String
        // The web view's own user agent
        buildConfigField("String", "USER_AGENT", "null")
        // Søg's microphone: Danish
        buildConfigField("String", "SPEECH_LANGUAGE", quoted("da-DK"))
        buildConfigField("String", "SPEECH_PROMPT", quoted("Sig, hvad du søger efter"))
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
