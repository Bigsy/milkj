import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

// MilkJ — IntelliJ plugin: a Milkdown-powered WYSIWYG Markdown editor (JCEF) that sits as a
// switchable editor tab alongside the built-in IntelliJ Markdown editor.
//
// NOTE: This uses the modern IntelliJ Platform Gradle Plugin 2.x, not the legacy
// org.jetbrains.intellij 1.x plugin.
// Verify/bump the plugin + Kotlin versions to the latest before the first real build.

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.0"
    id("org.jetbrains.intellij.platform") version "2.17.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()

    // Required by the IntelliJ Platform Gradle Plugin 2.x to resolve the IDE + bundled plugins.
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(
            providers.gradleProperty("platformType").map { IntelliJPlatformType.fromCode(it) },
            providers.gradleProperty("platformVersion"),
        )

        pluginVerifier()
        zipSigner()
        testFramework(TestFrameworkType.Platform)
    }

    // BasePlatformTestCase is JUnit3/4-based; the platform test framework doesn't bring JUnit itself.
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")

        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null } // open-ended; handler uses the modern JCEF API (262+)
        }
    }

    // Signing + publishing read from environment variables in CI.
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }

    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }

    pluginVerification {
        ides {
            recommended()
        }
    }
}

kotlin {
    jvmToolchain(providers.gradleProperty("javaVersion").get().toInt())

    compilerOptions {
        // Platform 2024.1 bundles the Kotlin 1.9 stdlib; pinning apiVersion makes 2.x-only stdlib
        // APIs fail at compile time instead of NoSuchMethodError at runtime on older IDEs.
        apiVersion = org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_1_9
    }
}

val frontendInstall = tasks.register<Exec>("frontendInstall") {
    workingDir = layout.projectDirectory.dir("frontend").asFile
    commandLine("pnpm", "install", "--frozen-lockfile")
    environment("CI", "true")

    inputs.file("frontend/package.json")
    inputs.file("frontend/pnpm-lock.yaml")
    inputs.file("frontend/pnpm-workspace.yaml")
    outputs.dir("frontend/node_modules")
    // pnpm's node_modules is symlinks into the global store; snapshotting it for the build cache
    // is fragile (and huge). Up-to-date checks via the outputs still work.
    outputs.cacheIf { false }
}

val frontendBuild = tasks.register<Exec>("frontendBuild") {
    dependsOn(frontendInstall)
    workingDir = layout.projectDirectory.dir("frontend").asFile
    commandLine("pnpm", "run", "build")
    environment("CI", "true")

    inputs.file("frontend/index.html")
    inputs.file("frontend/package.json")
    inputs.file("frontend/pnpm-lock.yaml")
    inputs.file("frontend/pnpm-workspace.yaml")
    inputs.file("frontend/tsconfig.json")
    inputs.file("frontend/vite.config.ts")
    inputs.dir("frontend/src")
    outputs.dir("src/main/resources/web")
}

tasks {
    processResources {
        dependsOn(frontendBuild)
    }
}
