plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val keposVersionName = providers.gradleProperty("keposVersionName")
val keposVersionCode = providers.gradleProperty("keposVersionCode").map(String::toInt)

android {
  namespace = "io.github.ttalab.kepos"
  compileSdk = 35

  defaultConfig {
    applicationId = "io.github.ttalab.kepos"
    minSdk = 31
    targetSdk = 35
    versionCode = keposVersionCode.getOrElse(1)
    versionName = keposVersionName.getOrElse("0.1.0")
    buildConfigField("int", "GATEWAY_PORT", "17480")
    buildConfigField("int", "MIHOMO_PORT", "17890")
    buildConfigField("int", "DSH_PORT", "13080")
    buildConfigField("int", "OPENCLAW_PORT", "18789")
    buildConfigField("int", "SSH_PORT", "2222")

    ndk {
      abiFilters += "arm64-v8a"
    }

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    getByName("release") {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }

    create("deviceTest") {
      initWith(getByName("debug"))
      applicationIdSuffix = ".devicetest"
      matchingFallbacks += listOf("debug")
      buildConfigField("int", "GATEWAY_PORT", "18480")
      buildConfigField("int", "MIHOMO_PORT", "18490")
      buildConfigField("int", "DSH_PORT", "18380")
      buildConfigField("int", "OPENCLAW_PORT", "19789")
      buildConfigField("int", "SSH_PORT", "18222")
    }
  }

  testBuildType = "deviceTest"

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  buildFeatures {
    buildConfig = true
    compose = true
  }

  composeOptions {
    kotlinCompilerExtensionVersion = "1.5.13"
  }

  sourceSets {
    getByName("main") {
      jniLibs.srcDirs("src/main/addons")
      assets.srcDir("../../.build/android-assets")
    }
  }
}

dependencies {
  implementation(project(":barekit-host"))
  implementation(platform("androidx.compose:compose-bom:2024.09.03"))
  implementation("androidx.activity:activity-compose:1.9.2")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
  implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.6")
  implementation("com.composables:icons-lucide:1.1.0")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")

  debugImplementation("androidx.compose.ui:ui-tooling")
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation(platform("androidx.compose:compose-bom:2024.09.03"))
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  androidTestImplementation("androidx.test:core:1.7.0")
  androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
  androidTestImplementation("androidx.test.ext:junit:1.3.0")
  androidTestImplementation("androidx.test:runner:1.7.0")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
  "deviceTestImplementation"("androidx.compose.ui:ui-test-manifest")
}
