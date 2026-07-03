package com.hedworth.milkj.bridge

import com.hedworth.milkj.settings.MilkJSettings
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Drives the [MilkJBridge] state machine through a [FakeBrowserConnection] instead of a real JCEF
 * browser. Page messages are what the frontend would send via `window.milkjSendToIde`; pushed
 * scripts are what the frontend would receive.
 */
class MilkJBridgeTest : BasePlatformTestCase() {

    private class FakeBrowserConnection : MilkJBrowserConnection {
        val executedScripts = mutableListOf<String>()
        var pageMessageHandler: ((String) -> Unit)? = null

        override fun connect(onMessageFromPage: (String) -> Unit) {
            pageMessageHandler = onMessageFromPage
        }

        override fun executeJavaScript(script: String) {
            executedScripts += script
        }
    }

    private lateinit var file: VirtualFile
    private lateinit var document: Document
    private lateinit var connection: FakeBrowserConnection
    private lateinit var bridge: MilkJBridge

    private fun setUpBridge(initialText: String) {
        file = myFixture.configureByText("test.md", initialText).virtualFile
        document = FileDocumentManager.getInstance().getDocument(file)!!
        FileDocumentManager.getInstance().saveAllDocuments()
        connection = FakeBrowserConnection()
        bridge = MilkJBridge(project, file, connection)
        Disposer.register(testRootDisposable, bridge)
        bridge.install()
    }

    /** Sends a message the way the page would and lets the bridge's EDT hop run. */
    private fun sendFromPage(message: String) {
        connection.pageMessageHandler!!(message)
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
    }

    private fun isDocumentUnsaved(): Boolean =
        FileDocumentManager.getInstance().isDocumentUnsaved(document)

    // --- Item 1 regression: opening a file and reaching page-ready must not dirty the document ---

    fun testPageReadyPushesContentAndConfigWithoutDirtyingDocument() {
        setUpBridge("* item one\n")

        sendFromPage("ready")

        assertFalse("page-ready alone must never leave unsaved document changes", isDocumentUnsaved())
        val markdownIndex = connection.executedScripts.indexOfFirst { it.startsWith("window.milkjSetMarkdown") }
        val configIndex = connection.executedScripts.indexOfFirst { it.startsWith("window.milkjApplyConfig") }
        assertTrue("ready should push the document text to the page", markdownIndex >= 0)
        assertTrue(connection.executedScripts[markdownIndex].contains("* item one"))
        assertTrue("ready should push the frontend config", configIndex >= 0)
        assertTrue(
            "config must be pushed before content so the page sets up the editor before it lands",
            configIndex < markdownIndex,
        )
    }

    fun testEqualTextEchoDoesNotDirtyDocument() {
        setUpBridge("# Title\n")

        sendFromPage("ready")
        sendFromPage("markdown:# Title\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertFalse("an echo identical to the document must be a no-op", isDocumentUnsaved())
        assertEquals("# Title\n", document.text)
    }

    // --- Page edits reaching the document ---

    fun testPageEditIsWrittenToDocumentAfterDebounce() {
        setUpBridge("# Title\n")
        sendFromPage("ready")

        sendFromPage("markdown:# Edited Title\n")
        assertEquals("write must be debounced, not immediate", "# Title\n", document.text)

        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("# Edited Title\n", document.text)
        assertTrue("a real page edit leaves the document modified", isDocumentUnsaved())
    }

    fun testPageEditReplacesOnlyChangedRange() {
        setUpBridge("line one\nline two\nline three\n")
        sendFromPage("ready")

        var changeOffset = -1
        var changeOldLength = -1
        var changeNewLength = -1
        document.addDocumentListener(
            object : com.intellij.openapi.editor.event.DocumentListener {
                override fun documentChanged(event: com.intellij.openapi.editor.event.DocumentEvent) {
                    changeOffset = event.offset
                    changeOldLength = event.oldLength
                    changeNewLength = event.newLength
                }
            },
            testRootDisposable,
        )

        sendFromPage("markdown:line one\nline 2\nline three\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("line one\nline 2\nline three\n", document.text)
        assertEquals("write should start at the changed region, not offset 0", 14, changeOffset)
        assertEquals("only the differing range should be replaced", "two".length, changeOldLength)
        assertEquals("2".length, changeNewLength)
    }

    fun testMarkdownMessageBeforeReadyIsIgnored() {
        setUpBridge("original\n")

        sendFromPage("markdown:should be ignored\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("original\n", document.text)
        assertFalse(isDocumentUnsaved())
    }

    fun testNativeEditDuringPendingPageWriteWins() {
        setUpBridge("original\n")
        sendFromPage("ready")

        sendFromPage("markdown:page edit\n")
        // Before the debounced write fires, the document changes from outside the page
        // (e.g. typing in the native source tab). The stale page write must be dropped.
        WriteCommandAction.runWriteCommandAction(project) {
            document.setText("native edit\n")
        }
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("native edit\n", document.text)
    }

    // --- IDE -> page pushes ---

    fun testExternalDocumentChangeIsPushedToPageDebounced() {
        setUpBridge("before\n")
        sendFromPage("ready")
        connection.executedScripts.clear()

        WriteCommandAction.runWriteCommandAction(project) {
            document.setText("after\n")
        }
        assertTrue(
            "push must be debounced, not immediate",
            connection.executedScripts.none { it.startsWith("window.milkjSetMarkdown") },
        )

        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        val push = connection.executedScripts.singleOrNull { it.startsWith("window.milkjSetMarkdown") }
        assertNotNull("document change should be pushed to the page", push)
        assertTrue(push!!.contains("after"))
    }

    // --- Frontend config JSON ---

    fun testFrontendConfigJsonEscapesPlaceholderText() {
        val state = MilkJSettings.State().apply {
            placeholderText = "say \"hello\"\nworld \\ backslash"
        }

        val json = MilkJBridge.frontendConfigJson(state, readonly = false)

        assertTrue("quotes must be escaped", json.contains("""say \"hello\""""))
        assertTrue("newlines must be escaped", json.contains("""\nworld"""))
        assertFalse("raw newlines would break the injected script", json.contains("\n"))
        assertTrue(json.contains("\"readonly\":false"))
    }

    fun testFrontendConfigJsonCarriesReadonlyFlag() {
        val json = MilkJBridge.frontendConfigJson(MilkJSettings.State(), readonly = true)
        assertTrue(json.contains("\"readonly\":true"))
    }
}
