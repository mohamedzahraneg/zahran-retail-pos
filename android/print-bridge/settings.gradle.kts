// Print Bridge — root settings.gradle.kts.
//
// Single-module project: just `app`.  Plugin + dependency resolution
// pulls from Google's Maven (Android Gradle Plugin) + Maven Central
// (NanoHTTPD, Kotlin, JUnit).

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "PrintBridge"
include(":app")
