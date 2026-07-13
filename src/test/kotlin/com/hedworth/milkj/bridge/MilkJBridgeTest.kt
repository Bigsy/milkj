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

    private fun sendMarkdownFromPage(markdown: String, revision: Long = latestPageRevision()) {
        sendFromPage("markdown:$revision\n$markdown")
    }

    private fun latestPageRevision(): Long {
        val script = connection.executedScripts.last { it.startsWith("window.milkjSetMarkdown") }
        return Regex(", (\\d+)\\);$").find(script)!!.groupValues[1].toLong()
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
        sendMarkdownFromPage("# Title\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertFalse("an echo identical to the document must be a no-op", isDocumentUnsaved())
        assertEquals("# Title\n", document.text)
    }

    // --- Page edits reaching the document ---

    fun testPageEditIsWrittenToDocumentAfterDebounce() {
        setUpBridge("# Title\n")
        sendFromPage("ready")

        sendMarkdownFromPage("# Edited Title\n")
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

        sendMarkdownFromPage("line one\nline 2\nline three\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("line one\nline 2\nline three\n", document.text)
        assertEquals("write should start at the changed region, not offset 0", 14, changeOffset)
        assertEquals("only the differing range should be replaced", "two".length, changeOldLength)
        assertEquals("2".length, changeNewLength)
    }

    fun testMarkdownMessageBeforeReadyIsIgnored() {
        setUpBridge("original\n")

        sendFromPage("markdown:0\nshould be ignored\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("original\n", document.text)
        assertFalse(isDocumentUnsaved())
    }

    fun testNativeEditDuringPendingPageWriteWins() {
        setUpBridge("original\n")
        sendFromPage("ready")

        sendMarkdownFromPage("page edit\n")
        // Before the debounced write fires, the document changes from outside the page
        // (e.g. typing in the native source tab). The stale page write must be dropped.
        WriteCommandAction.runWriteCommandAction(project) {
            document.setText("native edit\n")
        }
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("native edit\n", document.text)
    }

    fun testStalePageRevisionCannotOverwriteNewerDocument() {
        setUpBridge("original\n")
        sendFromPage("ready")
        val staleRevision = latestPageRevision()

        WriteCommandAction.runWriteCommandAction(project) {
            document.setText("newer native edit\n")
        }
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertTrue(latestPageRevision() > staleRevision)

        sendMarkdownFromPage("stale page edit\n", staleRevision)
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("newer native edit\n", document.text)
    }

    fun testPhysicalDiskChangeCannotBeOverwrittenBeforeVfsNotification() {
        setUpBridge("original\n")
        sendFromPage("ready")

        // Simulate another IntelliJ process writing the file before this process receives a VFS
        // event. The content hash guard must catch it even though the page revision is current.
        bridge.setDiskTextForTest("newer content from other IDE\n")
        sendMarkdownFromPage("stale page edit\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertFalse(
            "the stale page edit must not reach the Document",
            document.text == "stale page edit\n",
        )
        assertTrue(
            "a conflict makes MilkJ read-only until IntelliJ reconciles the file",
            connection.executedScripts.any {
                it.startsWith("window.milkjApplyConfig") && it.contains("\"readonly\":true")
            },
        )
    }

    fun testStartupRefreshProtectsDiskFromAnOldRestoredTab() {
        file = myFixture.configureByText("test.md", "old restored tab\n").virtualFile
        document = FileDocumentManager.getInstance().getDocument(file)!!
        FileDocumentManager.getInstance().saveAllDocuments()
        connection = FakeBrowserConnection()
        bridge = MilkJBridge(project, file, connection)
        bridge.setDiskTextForTest("latest disk version\n")
        Disposer.register(testRootDisposable, bridge)
        bridge.install()
        sendFromPage("ready")

        // Whether IntelliJ reloads the clean Document immediately or briefly reports a conflict,
        // the old page content must never be allowed to travel back into the file.
        sendMarkdownFromPage("old restored tab normalized\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertFalse(document.text == "old restored tab normalized\n")
        assertTrue(
            connection.executedScripts.any {
                it.startsWith("window.milkjApplyConfig") && it.contains("\"readonly\":true")
            },
        )
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
        assertTrue(json.contains("\"proofingEnabled\":true"))
        assertTrue(json.contains("\"proofingDialect\":\"AUTO\""))
    }

    fun testFrontendConfigJsonCarriesDisabledProofingIndependentlyFromReadonly() {
        val state = MilkJSettings.State().apply {
            spellcheckEnabled = false
            proofingDialect = MilkJSettings.ProofingDialect.BRITISH
        }
        val json = MilkJBridge.frontendConfigJson(state, readonly = false)
        assertTrue(json.contains("\"proofingEnabled\":false"))
        assertTrue(json.contains("\"proofingDialect\":\"BRITISH\""))
        assertTrue(json.contains("\"readonly\":false"))
    }

    fun testEveryProofingDialectSerializes() {
        MilkJSettings.ProofingDialect.entries.forEach { dialect ->
            val state = MilkJSettings.State().apply { proofingDialect = dialect }
            assertTrue(
                MilkJBridge.frontendConfigJson(state, readonly = false)
                    .contains("\"proofingDialect\":\"${dialect.name}\""),
            )
        }
    }

    fun testSettingsCopyPreservesProofingState() {
        val state = MilkJSettings.State().apply {
            spellcheckEnabled = false
            proofingDialect = MilkJSettings.ProofingDialect.CANADIAN
        }
        val copy = state.copy()
        assertFalse(copy.spellcheckEnabled)
        assertEquals(MilkJSettings.ProofingDialect.CANADIAN, copy.proofingDialect)
    }
}
