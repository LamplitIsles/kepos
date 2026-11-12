import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "io.lamplitisles.kepos"
  compileSdk = 36
  // Only SDK Build Tools 36.0.0 and 37.0.0 are installed; 8.13 would otherwise
  // ask for its 35.0.0 default.
  buildToolsVersion = "36.0.0"

  defaultConfig {
    applicationId = "io.lamplitisles.kepos"
    minSdk = 29
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"

    // The worklet bundle and the linked Bare addons are arm64 only.
    ndk { abiFilters += "arm64-v8a" }
  }

  buildTypes {
    getByName("debug") {
      isMinifyEnabled = false
    }
    getByName("release") {
      // Release shrinking and packaging are not verified for this app; a
      // debug build is the only artifact this change claims.
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    compose = true
    buildConfig = false
  }

  testOptions {
    unitTests.isIncludeAndroidResources = false
    // The JVM tests are small; a bounded heap keeps the whole build inside the
    // documented memory budget.
    unitTests.all { test -> test.maxHeapSize = "384m" }
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_17)
    allWarningsAsErrors.set(false)
  }
}

dependencies {
  implementation(libs.bare.kit.kotlin)
  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)
  // Seed to Ed25519 public key derivation only; the lightweight API is used
  // and no global JCA provider is installed.
  implementation(libs.bouncycastle)

  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.foundation)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  debugImplementation(libs.androidx.compose.ui.tooling)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
