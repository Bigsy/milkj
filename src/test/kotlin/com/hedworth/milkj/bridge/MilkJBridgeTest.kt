package com.hedworth.milkj.bridge

import com.hedworth.milkj.editor.MilkJEditorState
import com.hedworth.milkj.navigation.FileLinkNavigator
import com.hedworth.milkj.settings.MilkJSettings
import com.hedworth.milkj.settings.WeirpackSetting
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ide.ui.LafManager
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.util.Base64

/**
 * Drives the [MilkJBridge] state machine through a [FakeBrowserConnection] instead of a real JCEF
 * browser. Page messages are what the frontend would send via `window.milkjSendToIde`; pushed
 * scripts are what the frontend would receive through `window.milkjReceive`.
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

        val zoomScales = mutableListOf<Double>()

        override fun setZoom(scale: Double) {
            zoomScales += scale
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
    private val openedUrls = mutableListOf<String>()
    private lateinit var bridge: MilkJBridge

    private fun setUpBridge(initialText: String) {
        file = myFixture.configureByText("test.md", initialText).virtualFile
        document = FileDocumentManager.getInstance().getDocument(file)!!
        FileDocumentManager.getInstance().saveAllDocuments()
        connection = FakeBrowserConnection()
        navigator = FakeFileLinkNavigator()
        openedUrls.clear()
        bridge = MilkJBridge(project, file, connection, navigator, openInBrowser = { openedUrls += it })
        Disposer.register(testRootDisposable, bridge)
        bridge.install()
    }

    private val pngBase64 = Base64.getEncoder().encodeToString(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))

    /** Sends raw text the way the page would and lets the bridge's EDT hop run. */
    private fun sendRawFromPage(message: String) {
        connection.pageMessageHandler!!(message)
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
    }

    private fun sendFromPage(type: String, fields: JsonObjectBuilder.() -> Unit = {}) {
        sendRawFromPage(
            buildJsonObject {
                put("type", type)
                fields()
            }.toString(),
        )
    }

    private fun sendMarkdownFromPage(markdown: String, revision: Long = latestPageRevision()) {
        sendFromPage("markdown") {
            put("revision", revision)
            put("markdown", markdown)
        }
    }

    private fun sendImageUpload(requestId: String, fileName: String, mimeType: String, base64: String) {
        sendFromPage("imageUpload") {
            put("requestId", requestId)
            put("fileName", fileName)
            put("mimeType", mimeType)
            put("base64", base64)
        }
    }

    /** Every message the bridge pushed to the page, in order. */
    private fun pushedMessages(): List<JsonObject> =
        connection.executedScripts.map { script ->
            assertTrue(script, script.startsWith(RECEIVE_PREFIX) && script.endsWith(");"))
            Json.parseToJsonElement(script.removePrefix(RECEIVE_PREFIX).removeSuffix(");")).jsonObject
        }

    private fun pushes(type: String): List<JsonObject> =
        pushedMessages().filter { it.getValue("type").jsonPrimitive.content == type }

    private fun indexOfFirstPush(type: String): Int =
        pushedMessages().indexOfFirst { it.getValue("type").jsonPrimitive.content == type }

    private fun markdownPushes(): List<String> = pushes("setMarkdown").map { it.getValue("markdown").jsonPrimitive.content }

    private fun configPushes(): List<JsonObject> = pushes("applyConfig").map { it.getValue("config").jsonObject }

    private fun imageUploadReplies(): List<Pair<String, String?>> =
        pushes("imageUploaded").map {
            val path = it.getValue("path").jsonPrimitive
            it.getValue("requestId").jsonPrimitive.content to path.takeIf(JsonPrimitive::isString)?.content
        }

    private fun latestPageRevision(): Long = pushes("setMarkdown").last().getValue("revision").jsonPrimitive.long

    private fun isDocumentUnsaved(): Boolean =
        FileDocumentManager.getInstance().isDocumentUnsaved(document)

    // --- Item 1 regression: opening a file and reaching page-ready must not dirty the document ---

    fun testPageReadyPushesContentAndConfigWithoutDirtyingDocument() {
        setUpBridge("* item one\n")

        sendFromPage("ready")

        assertFalse("page-ready alone must never leave unsaved document changes", isDocumentUnsaved())
        val markdownIndex = indexOfFirstPush("setMarkdown")
        val configIndex = indexOfFirstPush("applyConfig")
        assertTrue("ready should push the document text to the page", markdownIndex >= 0)
        assertEquals(listOf("* item one\n"), markdownPushes())
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

        sendFromPage("markdown") {
            put("revision", 0)
            put("markdown", "should be ignored\n")
        }
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("original\n", document.text)
        assertFalse(isDocumentUnsaved())
    }

    private fun sendNavigateFile(href: String) = sendFromPage("navigateFile") { put("href", href) }

    private fun sendNavigateUrl(href: String) = sendFromPage("navigateUrl") { put("href", href) }

    fun testFileNavigationPassesTheHrefThroughUnchangedAndRequiresReady() {
        setUpBridge("original\n")

        sendNavigateFile("src/Foo.kt#L2")
        assertEmpty(navigator.targets)

        sendFromPage("ready")
        sendNavigateFile("src/Foo.kt#L2")
        sendNavigateFile("C++.kt#L1")
        // Percent escapes are the link's own; the navigator decodes them, the transport must not.
        sendNavigateFile("name%23part.kt#L3")

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

        listOf("", "   ", "\u0000file.kt", "a".repeat(PageMessage.MAX_NAVIGATION_TARGET_CHARS + 1))
            .forEach(::sendNavigateFile)
        listOf(
            """{"type":"navigateFile"}""",
            """{"type":"navigateFile","href":7}""",
            """navigate:file:src%2FFoo.kt""",
        ).forEach(::sendRawFromPage)
        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEmpty(navigator.targets)
        assertEquals(documentText, document.text)
        assertEquals(scriptsBefore, connection.executedScripts)
        assertFalse(isDocumentUnsaved())
    }

    fun testExternalUrlOpensSystemBrowserAfterReady() {
        setUpBridge("original\n")

        sendNavigateUrl("https://example.com/docs?q=a+b#top")
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertEmpty("external URLs must wait for page-ready like other page messages", openedUrls)

        sendFromPage("ready")
        sendNavigateUrl("https://example.com/docs?q=a+b#top")
        sendNavigateUrl("mailto:user@example.com")

        assertEquals(
            listOf("https://example.com/docs?q=a+b#top", "mailto:user@example.com"),
            openedUrls,
        )
    }

    fun testInvalidAndUnsafeExternalUrlsAreDropped() {
        setUpBridge("original\n")
        sendFromPage("ready")

        listOf(
            "",
            "%",
            "\u0000https://example.com",
            "https://example.com/${"a".repeat(PageMessage.MAX_NAVIGATION_TARGET_CHARS)}",
            "javascript:alert(1)",
            "data:text/html,hello",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "http:example.com",
            "mailto:",
        ).forEach(::sendNavigateUrl)
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEmpty(openedUrls)
        assertEquals("original\n", document.text)
    }

    // --- Live theme ---

    fun testLookAndFeelChangeRepushesConfig() {
        setUpBridge("original\n")
        val publisher = ApplicationManager.getApplication().messageBus.syncPublisher(LafManagerListener.TOPIC)
        publisher.lookAndFeelChanged(LafManager.getInstance())
        assertTrue(
            "before ready nothing is pushed",
            configPushes().isEmpty(),
        )

        sendFromPage("ready")
        connection.executedScripts.clear()
        publisher.lookAndFeelChanged(LafManager.getInstance())

        assertEquals(1, configPushes().size)
        assertFalse(isDocumentUnsaved())
    }

    // --- Caret and scroll position ---

    private fun viewStatePushes(): List<Pair<Int, Int>> =
        pushes("setViewState").map { it.getValue("anchor").jsonPrimitive.int to it.getValue("scrollTop").jsonPrimitive.int }

    private fun sendViewState(anchor: Int, scrollTop: Int) = sendFromPage("viewState") {
        put("anchor", anchor)
        put("scrollTop", scrollTop)
    }

    fun testRestoredViewStateWaitsForTheContentAndIsPushedAfterIt() {
        setUpBridge("# Doc\n")

        bridge.restoreViewState(MilkJEditorState(anchor = 12, scrollTop = 340))
        assertEmpty("nothing can be restored before the page exists", viewStatePushes())
        assertEquals(
            "the platform may ask for the state back before the page confirms it",
            MilkJEditorState(12, 340),
            bridge.viewState,
        )

        sendFromPage("ready")

        assertEquals(listOf(12 to 340), viewStatePushes())
        val markdownIndex = indexOfFirstPush("setMarkdown")
        val viewStateIndex = indexOfFirstPush("setViewState")
        assertTrue("the position refers to the content, so the content must land first", markdownIndex < viewStateIndex)
        assertFalse(isDocumentUnsaved())
    }

    fun testViewStateRestoredAfterReadyIsPushedAtOnce() {
        setUpBridge("# Doc\n")
        sendFromPage("ready")
        connection.executedScripts.clear()

        bridge.restoreViewState(MilkJEditorState(anchor = 3, scrollTop = 0))

        assertEquals(listOf(3 to 0), viewStatePushes())
    }

    fun testPageReportedViewStateIsCachedForGetState() {
        setUpBridge("# Doc\n")
        assertNull(bridge.viewState)

        sendViewState(5, 50)
        assertNull("reports before ready belong to an editor without content", bridge.viewState)

        sendFromPage("ready")
        sendViewState(40, 1200)
        assertEquals(MilkJEditorState(40, 1200), bridge.viewState)

        listOf(
            """{"type":"viewState"}""",
            """{"type":"viewState","anchor":"a","scrollTop":"b"}""",
            """{"type":"viewState","anchor":-1,"scrollTop":0}""",
            """{"type":"viewState","anchor":1,"scrollTop":-2}""",
            """{"type":"viewState","anchor":1.5,"scrollTop":2}""",
            "viewstate:1:2",
        ).forEach(::sendRawFromPage)
        assertEquals("malformed reports must not disturb the cached state", MilkJEditorState(40, 1200), bridge.viewState)
        assertEquals("# Doc\n", document.text)
        assertFalse(isDocumentUnsaved())
    }

    // --- Zoom ---

    private fun sendZoom(command: String) = sendFromPage("zoom") { put("command", command) }

    fun testZoomIsAppliedWithTheConfigOnceThePageIsReady() {
        settings.update(settings.state.copy().apply { zoomPercent = 125 })
        setUpBridge("# Doc\n")
        assertEmpty("the browser has no page to zoom before ready", connection.zoomScales)

        sendFromPage("ready")

        assertEquals(listOf(1.25), connection.zoomScales)
    }

    fun testZoomKeysFromThePageStepTheSharedSettingAndReachTheBrowser() {
        setUpBridge("# Doc\n")
        sendZoom("in")
        assertEquals("must require ready", 100, settings.state.zoomPercent)

        sendFromPage("ready")
        connection.zoomScales.clear()

        sendZoom("in")
        assertEquals(110, settings.state.zoomPercent)
        sendZoom("in")
        assertEquals(125, settings.state.zoomPercent)
        sendZoom("out")
        assertEquals(110, settings.state.zoomPercent)
        sendZoom("reset")
        assertEquals(100, settings.state.zoomPercent)
        sendZoom("reset")
        sendZoom("sideways")
        sendZoom("")
        assertEquals(100, settings.state.zoomPercent)

        assertEquals(
            "each real change is applied to the browser through the settings listener, no-ops are not",
            listOf(1.1, 1.25, 1.1, 1.0),
            connection.zoomScales,
        )
        assertEquals("# Doc\n", document.text)
        assertFalse(isDocumentUnsaved())
    }

    fun testZoomStopsAtTheEndsOfTheLadder() {
        settings.update(settings.state.copy().apply { zoomPercent = 300 })
        setUpBridge("# Doc\n")
        sendFromPage("ready")

        sendZoom("in")
        assertEquals(300, settings.state.zoomPercent)

        settings.update(settings.state.copy().apply { zoomPercent = 50 })
        sendZoom("out")
        assertEquals(50, settings.state.zoomPercent)
    }

    // --- Image uploads ---

    fun testImageUploadWritesIntoTheConfiguredFolderAndRepliesWithARelativePath() {
        setUpBridge("# Doc\n")
        sendFromPage("ready")

        sendImageUpload("req-1", "diagram.png", "image/png", "$pngBase64")

        val created = file.parent.findFileByRelativePath("images/diagram.png")
        assertNotNull("the image must be written under images/ next to the Markdown file", created)
        assertEquals(4, created!!.length)
        assertEquals(
            listOf("req-1" to "images/diagram.png"),
            imageUploadReplies(),
        )
        assertEquals("# Doc\n", document.text)
        assertFalse("storing an image must not touch the Markdown document", isDocumentUnsaved())
    }

    fun testImageUploadNeverOverwritesAndHonoursTheFolderSetting() {
        settings.update(settings.state.copy().apply { imageUploadDirectory = "  assets/img/ " })
        setUpBridge("# Doc\n")
        sendFromPage("ready")

        sendImageUpload("a", "shot.png", "image/png", "$pngBase64")
        sendImageUpload("b", "shot.png", "image/png", "$pngBase64")

        assertNotNull(file.parent.findFileByRelativePath("assets/img/shot.png"))
        assertNotNull(file.parent.findFileByRelativePath("assets/img/shot-2.png"))
        assertEquals(
            listOf(
                "a" to "assets/img/shot.png",
                "b" to "assets/img/shot-2.png",
            ),
            imageUploadReplies(),
        )
    }

    fun testBlankFolderSettingStoresBesideTheMarkdownFile() {
        settings.update(settings.state.copy().apply { imageUploadDirectory = "" })
        setUpBridge("# Doc\n")
        sendFromPage("ready")

        sendImageUpload("r", "image.png", "image/png", "$pngBase64")

        val (requestId, path) = imageUploadReplies().single()
        assertEquals("r", requestId)
        assertTrue(path.toString(), Regex("""image-\d{8}-\d{6}\.png""").matches(path!!))
        assertTrue(file.parent.children.any { it.name.startsWith("image-") && it.extension == "png" })
    }

    fun testInvalidImageUploadsAreRefusedWithANullReply() {
        setUpBridge("# Doc\n")
        sendImageUpload("early", "shot.png", "image/png", "$pngBase64")
        sendFromPage("ready")

        sendImageUpload("pdf", "doc.pdf", "application/pdf", "$pngBase64")
        sendImageUpload("junk", "shot.png", "image/png", "%%%")
        sendImageUpload("bad id", "shot.png", "image/png", "$pngBase64")

        assertEquals(
            listOf(
                "pdf" to null,
                "junk" to null,
            ),
            imageUploadReplies(),
        )
        assertNull(file.parent.findChild("images"))
    }

    fun testImageUploadIsRefusedWhileSyncIsBlocked() {
        file = myFixture.configureByText("test.md", "document\n").virtualFile
        document = FileDocumentManager.getInstance().getDocument(file)!!
        FileDocumentManager.getInstance().saveAllDocuments()
        connection = FakeBrowserConnection()
        navigator = FakeFileLinkNavigator()
        bridge = MilkJBridge(project, file, connection, navigator)
        bridge.setDiskTextForTest("newer disk content\n")
        Disposer.register(testRootDisposable, bridge)
        bridge.install()
        sendFromPage("ready")

        sendImageUpload("blocked", "shot.png", "image/png", "$pngBase64")

        assertEquals(listOf<Pair<String, String?>>("blocked" to null), imageUploadReplies())
        assertNull(file.parent.findChild("images"))
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
            configPushes().any { it.getValue("readonly").jsonPrimitive.boolean },
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
            configPushes().any { it.getValue("readonly").jsonPrimitive.boolean },
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
            markdownPushes().isEmpty(),
        )

        bridge.drainDebouncesForTest()
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()

        assertEquals("document change should be pushed to the page", listOf("after\n"), markdownPushes())
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
            markdownPushes().isNotEmpty(),
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
            "# External Change\n" in markdownPushes(),
        )
    }

    // --- Frontend config (encoding itself is covered by BridgeProtocolTest against the fixtures) ---

    private fun configJson(state: MilkJSettings.State, readonly: Boolean = false): JsonObject =
        FrontendConfig.from(state, readonly = readonly, ideIsDark = false).toJson()

    fun testFrontendConfigCarriesReadonlyAndProofingIndependently() {
        val readonly = configJson(MilkJSettings.State(), readonly = true)
        assertTrue(readonly.getValue("readonly").jsonPrimitive.boolean)
        assertTrue(readonly.getValue("proofingEnabled").jsonPrimitive.boolean)
        assertEquals("BRITISH", readonly.getValue("proofingDialect").jsonPrimitive.content)

        val proofingOff = configJson(MilkJSettings.State().apply { spellcheckEnabled = false })
        assertFalse(proofingOff.getValue("proofingEnabled").jsonPrimitive.boolean)
        assertFalse(proofingOff.getValue("readonly").jsonPrimitive.boolean)
    }

    fun testFrontendConfigCarriesTheNormalizedDictionaryAndOnlyEnabledWeirpacks() {
        val state = MilkJSettings.State().apply {
            customDictionary = mutableListOf("MilkJ", " C++ ", "two words", "MilkJ")
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

        val json = configJson(state)

        assertEquals(listOf("C++", "MilkJ"), json.getValue("customDictionary").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("YWJj"), json.getValue("weirpacks").jsonArray.map { it.jsonPrimitive.content })
    }

    fun testFollowIdeResolvesTheThemeFromTheLookAndFeel() {
        val state = MilkJSettings.State().apply { theme = MilkJSettings.ThemeMode.FOLLOW_IDE }
        assertEquals("dark", FrontendConfig.from(state, readonly = false, ideIsDark = true).theme)
        assertEquals("light", FrontendConfig.from(state, readonly = false, ideIsDark = false).theme)
        val pinned = MilkJSettings.State().apply { theme = MilkJSettings.ThemeMode.LIGHT }
        assertEquals("light", FrontendConfig.from(pinned, readonly = false, ideIsDark = true).theme)
    }

    fun testEncodedDictionaryMessagePersistsWithoutModifyingDocument() {
        setUpBridge("original\n")
        sendFromPage("ready")
        val wasUnsaved = isDocumentUnsaved()
        connection.executedScripts.clear()

        sendFromPage("dictionaryAdd") { put("word", "C++") }

        assertEquals(listOf("C++"), settings.state.customDictionary)
        assertEquals("original\n", document.text)
        assertEquals(wasUnsaved, isDocumentUnsaved())
        assertTrue(configPushes().any { config ->
            config.getValue("customDictionary").jsonArray.map { it.jsonPrimitive.content } == listOf("C++")
        })
        assertTrue(markdownPushes().isEmpty())
    }

    fun testInvalidMalformedAndPreReadyDictionaryMessagesAreIgnored() {
        setUpBridge("original\n")
        sendFromPage("dictionaryAdd") { put("word", "Proofly") }
        sendFromPage("ready")
        sendRawFromPage("""{"type":"dictionaryAdd","word":7}""")
        sendFromPage("dictionaryAdd") { put("word", "two words") }
        sendFromPage("dictionaryAdd") { put("word", "x".repeat(65)) }
        assertEmpty(settings.state.customDictionary)
        assertEquals("original\n", document.text)
    }

    fun testSettingsCopyPreservesProofingState() {
        val state = MilkJSettings.State().apply {
            imageUploadDirectory = "assets"
            spellcheckEnabled = false
            proofingDialect = MilkJSettings.ProofingDialect.CANADIAN
            customDictionary = mutableListOf("MilkJ")
            weirpacks = mutableListOf(WeirpackSetting().apply {
                name = "House style"
                data = "YWJj"
            })
        }
        val copy = state.copy()
        assertEquals("assets", copy.imageUploadDirectory)
        assertFalse(copy.spellcheckEnabled)
        assertEquals(MilkJSettings.ProofingDialect.CANADIAN, copy.proofingDialect)
        assertEquals(listOf("MilkJ"), copy.customDictionary)
        assertEquals("YWJj", copy.weirpacks.single().data)
        state.customDictionary += "Proofly"
        state.weirpacks.single().data = "changed"
        assertEquals(listOf("MilkJ"), copy.customDictionary)
        assertEquals("YWJj", copy.weirpacks.single().data)
    }

    private companion object {
        const val RECEIVE_PREFIX = "window.milkjReceive?.("
    }
}
