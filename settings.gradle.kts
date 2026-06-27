// Auto-provisions the JDK declared by the Kotlin toolchain (Java 17) if it isn't installed locally.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

rootProject.name = "milkj"
