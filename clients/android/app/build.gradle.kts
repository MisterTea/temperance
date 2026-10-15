plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); jacoco }
android {
    namespace = "org.temperance.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "org.temperance.app"; minSdk = 26; targetSdk = 36; versionCode = System.getenv("TEMPERANCE_BUILD_NUMBER")?.toInt() ?: 7; versionName = System.getenv("TEMPERANCE_VERSION") ?: "0.5.6"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
    }
    signingConfigs {
        create("release") {
            System.getenv("TEMPERANCE_ANDROID_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("TEMPERANCE_ANDROID_STORE_PASSWORD")
            keyAlias = System.getenv("TEMPERANCE_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("TEMPERANCE_ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes { release { signingConfig = signingConfigs.getByName("release") } }
    testOptions {
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty("jna.library.path", rootDir.resolve("../../core/target/debug").absolutePath)
            it.dependsOn(buildRustHost)
            // Robolectric loads app classes without a code source.
            it.extensions.configure<JacocoTaskExtension> { isIncludeNoLocationClasses = true; excludes = listOf("jdk.internal.*") }
        }
    }
    sourceSets {
        getByName("test").java.srcDir("src/sharedTest/java")
        getByName("androidTest").java.srcDir("src/sharedTest/java")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17; isCoreLibraryDesugaringEnabled = true }
    kotlinOptions { jvmTarget = "17" }
}
// Refuse production packaging before any tasks run if release signing is missing.
gradle.taskGraph.whenReady {
    if (allTasks.any { it.name == "assembleRelease" || it.name == "bundleRelease" || it.name.startsWith("packageRelease") }) {
        listOf("TEMPERANCE_ANDROID_KEYSTORE", "TEMPERANCE_ANDROID_STORE_PASSWORD", "TEMPERANCE_ANDROID_KEY_ALIAS", "TEMPERANCE_ANDROID_KEY_PASSWORD", "TEMPERANCE_VERSION", "TEMPERANCE_BUILD_NUMBER").forEach {
            require(!System.getenv(it).isNullOrBlank()) { "Release packaging requires $it; debug signing is never used for releases." }
        }
        require(System.getenv("TEMPERANCE_BUILD_NUMBER").toInt() > 7) { "Release build number must exceed the last distributed build (7)." }
    }
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
// JVM unit tests load the host build of the same core.
val buildRustHost by tasks.registering(Exec::class) {
    workingDir = rootDir.resolve("../../core")
    commandLine("cargo", "build", "-p", "temperance-core", "--features", "remote")
}
tasks.named("preBuild") { dependsOn(buildRustCore) }

// Line coverage of the app's own code by JVM unit tests; the UniFFI bindings are generated.
fun JacocoReportBase.unitTestCoverage() {
    dependsOn("testDebugUnitTest")
    classDirectories.setFrom(fileTree(layout.buildDirectory.dir("tmp/kotlin-classes/debug")) { exclude("uniffi/**") })
    sourceDirectories.setFrom("src/main/java")
    executionData.setFrom(layout.buildDirectory.file("jacoco/testDebugUnitTest.exec"))
}
val unitTestCoverage by tasks.registering(JacocoReport::class) {
    unitTestCoverage()
    reports { xml.required = true; html.required = true; csv.required = true }
}
tasks.register<JacocoCoverageVerification>("unitTestCoverageCheck") {
    unitTestCoverage()
    dependsOn(unitTestCoverage)
    violationRules { rule { limit { counter = "LINE"; minimum = "0.80".toBigDecimal() } } }
}

dependencies {
    implementation("com.wireguard.android:tunnel:1.0.20260102")
    implementation("net.java.dev.jna:jna:5.19.1@aar")
    // Parent mode: scan the dashboard's pairing QR code.
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    // The sign-in password field's show/hide toggle (TextInputLayout).
    implementation("com.google.android.material:material:1.14.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    testImplementation("junit:junit:4.13.2")
    testImplementation("net.java.dev.jna:jna:5.19.1")
    testImplementation("org.robolectric:robolectric:4.16")

    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestUtil("androidx.test:orchestrator:1.6.1")
}
