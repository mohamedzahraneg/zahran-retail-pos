// Print Bridge — :app build.gradle.kts.
//
// Single Android module.  Application id is `com.zahran.printbridge`;
// keep it stable across releases so future updates can replace the
// installed APK without uninstall/reinstall.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.zahran.printbridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.zahran.printbridge"
        minSdk = 24             // Android 7.0 — covers ~95% of devices
        targetSdk = 34          // Android 14 — required by current Play rules,
                                //              also opts us into the BT runtime
                                //              permission model + Android 14
                                //              foregroundServiceType.
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            // R8 / shrinker on for the release build only.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            // Sideload-friendly: no shrinking so stack traces are readable.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/DEPENDENCIES",
            )
        }
    }
}

dependencies {
    // AndroidX core
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("com.google.android.material:material:1.11.0")
    // Lifecycle for the foreground service + activity glue.
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")

    // Embedded HTTP server for the bridge endpoints.  30 KB jar, no
    // dependencies, Apache 2.0.  We only use the synchronous `serve()`
    // hook — no websocket / SSL extensions.
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // Tests
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.11.1")
    testImplementation("androidx.test:core:1.5.0")
    testImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test:core:1.5.0")
}
