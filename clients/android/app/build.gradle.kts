plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "org.temperance.app"
    compileSdk = 36
    defaultConfig { applicationId = "org.temperance.app"; minSdk = 26; targetSdk = 36; versionCode = 1; versionName = "0.2.0" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17; isCoreLibraryDesugaringEnabled = true }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("com.wireguard.android:tunnel:1.0.20260102")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
