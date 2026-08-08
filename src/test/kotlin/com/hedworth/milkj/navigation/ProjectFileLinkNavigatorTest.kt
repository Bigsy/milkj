package com.hedworth.milkj.navigation

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.HeavyPlatformTestCase
import com.intellij.testFramework.PlatformTestUtil
import java.nio.file.Files
import java.nio.file.Paths
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

class ProjectFileLinkNavigatorTest : HeavyPlatformTestCase() {
    fun testResolvedAndCurrentFilesUseDocumentLineCounts() {
        val fixture = fixture()
        try {
            fixture.navigator.navigate("target.kt#L2")
            fixture.runTask()
            assertEquals(fixture.target to 1, fixture.opened.single())

            fixture.opened.clear()
            fixture.navigator.navigate("#L3")
            fixture.runTask()
            assertEquals(fixture.source to 2, fixture.opened.single())

            fixture.opened.clear()
            fixture.navigator.navigate("target.kt#L4")
            fixture.runTask()
            assertEmpty(fixture.opened)
            assertEquals("The requested line is outside the file", fixture.warnings.single().second)
        } finally {
            fixture.navigator.dispose()
        }
    }

    fun testRangeEndMustExistEvenThoughOnlyStartLineOpens() {
        val fixture = fixture()
        try {
            fixture.navigator.navigate("target.kt#L1-L3")
            fixture.runTask()
            assertEquals(fixture.target to 0, fixture.opened.single())

            fixture.opened.clear()
            fixture.navigator.navigate("target.kt#L1-L4")
            fixture.runTask()
            assertEmpty(fixture.opened)
            assertEquals("The requested line is outside the file", fixture.warnings.single().second)
        } finally {
            fixture.navigator.dispose()
        }
    }

    fun testGenerationAndDisposalDropStaleCompletions() {
        val fixture = fixture()
        try {
            fixture.navigator.navigate("target.kt#L1")
            fixture.navigator.navigate("target.kt#L2")
            fixture.runTask(1)
            fixture.runTask(0)
            assertEquals(listOf(fixture.target to 1), fixture.opened)

            fixture.opened.clear()
            fixture.navigator.navigate("target.kt#L3")
            fixture.navigator.dispose()
            fixture.runTask(0)
            assertEmpty(fixture.opened)
            assertEmpty(fixture.warnings)
        } finally {
            fixture.navigator.dispose()
        }
    }

    private fun fixture(): NavigatorFixture {
        val root = createTestProjectStructure()
        val rootPath = Paths.get(root.path)
        Files.writeString(rootPath.resolve("source.md"), "one\ntwo\nthree")
        Files.writeString(rootPath.resolve("target.kt"), "one\ntwo\nthree")
        root.refresh(false, true)
        val source = root.findChild("source.md")!!
        val target = root.findChild("target.kt")!!
        val tasks = mutableListOf<Runnable>()
        val opened = mutableListOf<Pair<VirtualFile, Int>>()
        val warnings = mutableListOf<Pair<String, String>>()
        val navigator = ProjectFileLinkNavigator(
            project,
            source,
            submit = { task ->
                tasks += task
                NonCancellableFuture
            },
            openEditor = { file, line -> opened += file to line },
            notifyWarning = { targetText, reason -> warnings += targetText to reason },
        )
        return NavigatorFixture(navigator, source, target, tasks, opened, warnings)
    }

    private data class NavigatorFixture(
        val navigator: ProjectFileLinkNavigator,
        val source: VirtualFile,
        val target: VirtualFile,
        val tasks: MutableList<Runnable>,
        val opened: MutableList<Pair<VirtualFile, Int>>,
        val warnings: MutableList<Pair<String, String>>,
    ) {
        fun runTask(index: Int = 0) {
            val task = tasks.removeAt(index)
            ApplicationManager.getApplication().executeOnPooledThread(task).get(10, TimeUnit.SECONDS)
            PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        }
    }

    private data object NonCancellableFuture : Future<Unit> {
        override fun cancel(mayInterruptIfRunning: Boolean): Boolean = false
        override fun isCancelled(): Boolean = false
        override fun isDone(): Boolean = false
        override fun get() = Unit
        override fun get(timeout: Long, unit: TimeUnit) = Unit
    }
}
