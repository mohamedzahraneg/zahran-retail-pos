// Print Bridge — root build.gradle.kts.
//
// Just declares the plugin versions used by the `:app` subproject.
// AGP 8.2 + Kotlin 1.9 are the current LTS-ish combo at the time of
// scaffolding (matches Android Studio Iguana / Jellyfish).

plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}
