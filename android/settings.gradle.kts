pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
    // The official Bare Kit Kotlin binding is published only on JitPack.
    maven("https://jitpack.io") {
      content { includeGroup("com.github.holepunchto.bare-kit-kotlin") }
    }
  }
}

rootProject.name = "kepos-android"

include(":app")
