plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
}

android {
  namespace = "io.github.ttalab.barekit.host"
  compileSdk = 35

  defaultConfig {
    minSdk = 31
    consumerProguardFiles("consumer-rules.pro")
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  sourceSets {
    getByName("main") {
      jniLibs.srcDirs("libs/bare-kit/jni")
    }
    getByName("test") {
      resources.srcDir("../../packages/bare-host-protocol/fixtures")
    }
  }
}

dependencies {
  api(files("libs/bare-kit/classes.jar"))
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
  testImplementation("junit:junit:4.13.2")
}
