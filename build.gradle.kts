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
    id("org.jetbrains.intellij.platform") version "2.1.0"
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

        // The built-in Markdown editor we live alongside (gives us the Markdown FileType + native editor tab).
        bundledPlugin("org.intellij.plugins.markdown")

        pluginVerifier()
        zipSigner()
        instrumentationTools()
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")

        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null } // open-ended forward compatibility
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
}

val frontendInstall by tasks.registering(Exec::class) {
    workingDir = layout.projectDirectory.dir("frontend").asFile
    commandLine("pnpm", "install", "--frozen-lockfile")
    environment("CI", "true")

    inputs.file("frontend/package.json")
    inputs.file("frontend/pnpm-lock.yaml")
    inputs.file("frontend/pnpm-workspace.yaml")
    outputs.dir("frontend/node_modules")
}

val frontendBuild by tasks.registering(Exec::class) {
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
