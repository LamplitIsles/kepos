# The Bare Kit Kotlin binding is called back from native threads and publishes
# its own consumer keep rules; this file documents the app-side requirements.
-keepclasseswithmembers,allowoptimization class to.holepunch.bare.kit.** { *; }
-dontwarn org.bouncycastle.**
