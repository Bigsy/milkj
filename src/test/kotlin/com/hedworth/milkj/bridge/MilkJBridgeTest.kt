package com.hedworth.milkj.bridge

import com.hedworth.milkj.navigation.FileLinkNavigator
import com.hedworth.milkj.settings.MilkJSettings
import com.hedworth.milkj.settings.WeirpackSetting
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

    private lateinit var settings: MilkJSettings
    private lateinit var originalSettings: MilkJSettings.State

    override fun setUp() {
        super.setUp()
        settings = MilkJSettings.getInstance()
        originalSettings = settings.state.copy()
        settings.loadState(MilkJSettings.State())
    }

    override fun tearDown() {
        try {
            settings.loadState(originalSettings)
        } finally {
            super.tearDown()
        }
    }

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

    private class FakeFileLinkNavigator : FileLinkNavigator {
        val targets = mutableListOf<String>()

        override fun navigate(rawHref: String) {
            targets += rawHref
        }
    }

    private lateinit var file: VirtualFile
    private lateinit var document: Document
    private lateinit var connection: FakeBrowserConnection
    private lateinit var navigator: FakeFileLinkNavigator
    private lateinit var bridge: MilkJBridge

    private fun setUpBridge(initialText: String) {
        file = myFixture.configureByText("test.md", initialText).virtualFile
        document = FileDocumentManager.getInstance().getDocument(file)!!
        FileDocumentManager.getInstance().saveAllDocuments()
        connection = FakeBrowserConnection()
        navigator = FakeFileLinkNavigator()
        bridge = MilkJBridge(project, file, connection, navigator)
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

    fun testNavigationProtocolDecodesAndRequiresReady() {
        setUpBridge("original\n")

        sendFromPage("navigate:file:src%2FFoo.kt%23L2")
        assertEmpty(navigator.targets)

        sendFromPage("ready")
        sendFromPage("navigate:file:src%2FFoo.kt%23L2")
        sendFromPage("navigate:file:C%2B%2B.kt%23L1")
        sendFromPage("navigate:file:name%2523part.kt%23L3")

        assertEquals(
            listOf("src/Foo.kt#L2", "C++.kt#L1", "name%23part.kt#L3"),
            navigator.targets,
        )
    }

    fun testMalformedNavigationTransportIsIgnored() {
        setUpBridge("original\n")
        sendFromPage("ready")
        val documentText = document.text
        val scriptsBefore = connection.executedScripts.toList()

        listOf(
            "navigate:file:",
            "navigate:file:%",
            "navigate:file:%C3%28",
            "navigate:file:%00file.kt",
            "navigate:file:${"a".repeat(8 * 1024 + 1)}",
        ).forEach(::sendFromPage)
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEmpty(navigator.targets)
        assertEquals(documentText, document.text)
        assertEquals(scriptsBefore, connection.executedScripts)
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
        navigator = FakeFileLinkNavigator()
        bridge = MilkJBridge(project, file, connection, navigator)
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

    fun testSavingThePagesOwnEditDoesNotPushItBackToThePage() {
        setUpBridge("# Title\n")
        sendFromPage("ready")

        sendMarkdownFromPage("# Edited Title\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertEquals("# Edited Title\n", document.text)
        connection.executedScripts.clear()

        // Autosave of the page's write fires a VFS content change like an external edit would.
        FileDocumentManager.getInstance().saveAllDocuments()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertFalse(
            "saving the page's own edit must not echo the markdown back (it resets the caret)",
            connection.executedScripts.any { it.startsWith("window.milkjSetMarkdown") },
        )
    }

    fun testExternalDiskChangeIsStillPushedAfterAPageEdit() {
        setUpBridge("# Title\n")
        sendFromPage("ready")

        sendMarkdownFromPage("# Edited Title\n")
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        FileDocumentManager.getInstance().saveAllDocuments()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        connection.executedScripts.clear()

        WriteCommandAction.runWriteCommandAction(project) {
            document.setText("# External Change\n")
        }
        FileDocumentManager.getInstance().saveAllDocuments()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertTrue(
            "a genuine external change must still reach the page",
            connection.executedScripts.any {
                it.startsWith("window.milkjSetMarkdown") && it.contains("External Change")
            },
        )
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
        assertTrue(json.contains("\"proofingDialect\":\"BRITISH\""))
    }

    fun testFrontendConfigJsonCarriesEscapedLocalImageEndpoint() {
        val json = MilkJBridge.frontendConfigJson(
            MilkJSettings.State(),
            readonly = false,
            localImageBaseUrl = "http://milkj.localhost/local-image/a token/",
        )
        assertTrue(json.contains("\"localImageBaseUrl\":\"http://milkj.localhost/local-image/a token/\""))
    }

    fun testFrontendConfigJsonEscapesCustomDictionary() {
        val state = MilkJSettings.State().apply {
            customDictionary = mutableListOf("C++", "MilkJ's", "quote\"slash\\", "Ångström")
        }
        val json = MilkJBridge.frontendConfigJson(state, readonly = false)
        assertTrue(json.contains("\"customDictionary\":[\"C++\",\"MilkJ's\",\"quote\\\"slash\\\\\",\"Ångström\"]"))
    }

    fun testFrontendConfigJsonCarriesOnlyEnabledWeirpacks() {
        val state = MilkJSettings.State().apply {
            customDictionary = mutableListOf("MilkJ")
            weirpacks = mutableListOf(
                WeirpackSetting().apply {
                    name = "House style"
                    data = "YWJj"
                },
                WeirpackSetting().apply {
                    name = "Disabled"
                    enabled = false
                    data = "ZGVm"
                },
            )
        }

        val json = MilkJBridge.frontendConfigJson(state, readonly = false)

        assertTrue(json.contains("\"customDictionary\":[\"MilkJ\"]"))
        assertTrue(json.contains("\"weirpacks\":[\"YWJj\"]"))
        assertFalse(json.contains("ZGVm"))
    }

    fun testEncodedDictionaryMessagePersistsWithoutModifyingDocument() {
        setUpBridge("original\n")
        sendFromPage("ready")
        val wasUnsaved = isDocumentUnsaved()
        connection.executedScripts.clear()

        sendFromPage("dictionary:add:C%2B%2B")

        assertEquals(listOf("C++"), settings.state.customDictionary)
        assertEquals("original\n", document.text)
        assertEquals(wasUnsaved, isDocumentUnsaved())
        assertTrue(connection.executedScripts.any {
            it.startsWith("window.milkjApplyConfig") && it.contains("\"customDictionary\":[\"C++\"]")
        })
        assertFalse(connection.executedScripts.any { it.startsWith("window.milkjSetMarkdown") })
    }

    fun testInvalidMalformedAndPreReadyDictionaryMessagesAreIgnored() {
        setUpBridge("original\n")
        sendFromPage("dictionary:add:Proofly")
        sendFromPage("ready")
        sendFromPage("dictionary:add:%ZZ")
        sendFromPage("dictionary:add:two%20words")
        sendFromPage("dictionary:add:${"x".repeat(65)}")
        assertEmpty(settings.state.customDictionary)
        assertEquals("original\n", document.text)
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
            customDictionary = mutableListOf("MilkJ")
            weirpacks = mutableListOf(WeirpackSetting().apply {
                name = "House style"
                data = "YWJj"
            })
        }
        val copy = state.copy()
        assertFalse(copy.spellcheckEnabled)
        assertEquals(MilkJSettings.ProofingDialect.CANADIAN, copy.proofingDialect)
        assertEquals(listOf("MilkJ"), copy.customDictionary)
        assertEquals("YWJj", copy.weirpacks.single().data)
        state.customDictionary += "Proofly"
        state.weirpacks.single().data = "changed"
        assertEquals(listOf("MilkJ"), copy.customDictionary)
        assertEquals("YWJj", copy.weirpacks.single().data)
    }
}
