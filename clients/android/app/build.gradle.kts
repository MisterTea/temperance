plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "org.temperance.app"
    compileSdk = 36
    defaultConfig { applicationId = "org.temperance.app"; minSdk = 26; targetSdk = 36; versionCode = 2; versionName = "0.4.0" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17; isCoreLibraryDesugaringEnabled = true }
    kotlinOptions { jvmTarget = "17" }
}
// Shared Rust business logic (core/temperance-core) via UniFFI + JNA.
val buildRustCore by tasks.registering(Exec::class) {
    workingDir = rootDir.resolve("../../core")
    commandLine("./build-bindings.sh", "android")
    inputs.dir(rootDir.resolve("../../core/temperance-core/src"))
    inputs.file(rootDir.resolve("../../core/Cargo.lock"))
    outputs.dir(projectDir.resolve("src/main/jniLibs"))
    outputs.dir(projectDir.resolve("src/main/java/uniffi"))
    onlyIf { System.getenv("TEMPERANCE_SKIP_RUST") == null }
}
tasks.named("preBuild") { dependsOn(buildRustCore) }
dependencies {
    implementation("com.wireguard.android:tunnel:1.0.20260102")
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
