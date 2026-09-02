package com.hedworth.milkj.bridge

import com.hedworth.milkj.editor.MilkJEditorState
import com.hedworth.milkj.images.ImageUploads
import com.hedworth.milkj.navigation.FileLinkNavigator
import com.hedworth.milkj.navigation.ProjectFileLinkNavigator
import com.hedworth.milkj.navigation.hasIsoControlCharacters
import com.hedworth.milkj.navigation.strictPercentDecode
import com.hedworth.milkj.settings.MilkJSettings
import com.hedworth.milkj.settings.enabledWeirpacks
import com.hedworth.milkj.settings.normalizeDictionary
import com.intellij.ide.ui.LafManagerListener
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.impl.LoadTextUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.diagnostic.Logger
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.StandardFileSystems
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.util.Alarm
import com.intellij.util.messages.MessageBusConnection
import com.intellij.ui.JBColor
import org.jetbrains.annotations.TestOnly
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.nio.file.Files
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/**
 * Two-way bridge between the Milkdown editor (JS, in JCEF) and the IntelliJ document model.
 *
 *  - JS -> IDE: the page calls `window.milkjSendToIde` on every Milkdown change; the handler writes
 *    the new Markdown into the file's `Document` (inside a write command), so undo/redo/save flow
 *    normally.
 *  - IDE -> JS: a `DocumentListener` that, on external edits (e.g. edits made in the native Markdown
 *    tab), pushes the updated Markdown back into Milkdown via [MilkJBrowserConnection.executeJavaScript].
 *  - Debounce + loop-guard so the two directions don't fight each other.
 */
class MilkJBridge(
    private val project: Project,
    private val file: VirtualFile,
    private val connection: MilkJBrowserConnection,
    navigator: FileLinkNavigator? = null,
    private val openInBrowser: (String) -> Unit = { BrowserUtil.browse(it) },
    private val localImageBaseUrl: String? = null,
) : Disposable {
    private val fileLinkNavigator: FileLinkNavigator
    private val settings: MilkJSettings = MilkJSettings.getInstance()
    private val messageBusConnection: MessageBusConnection =
        ApplicationManager.getApplication().messageBus.connect(this)
    private val writeDebounce = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val pushDebounce = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var pageReady = false
    private var applyingFromPage = false
    private var pageRevision = 0L
    private var trustedDiskFingerprint: DiskFingerprint? = null
    private var syncBlocked = false
    private var roundTripFailureNotified = false

    /**
     * The caret and scroll position the page last reported (debounced on its side), or the one the
     * platform handed to [restoreViewState] until the page confirms. Null until either happens.
     */
    var viewState: MilkJEditorState? = null
        private set
    private var pendingViewState: MilkJEditorState? = null

    // The markdown most recently written into the Document on the page's behalf. Saving that write
    // fires a VFileContentChangeEvent like any external change would; pushing the identical text
    // back would make the page rebuild its document (and lose the caret) after every edit.
    private var lastPageWriteMarkdown: String? = null
    private var testDiskSnapshot: DiskSnapshot? = null
    private var testDiskVersion = 0L

    // One notification per conflict burst; reset only after disk and Document agree again.
    private var conflictNotified = false

    init {
        if (navigator != null) {
            fileLinkNavigator = navigator
        } else {
            val productionNavigator = ProjectFileLinkNavigator(project, file)
            fileLinkNavigator = productionNavigator
            Disposer.register(this, productionNavigator)
        }
    }

    fun install() {
        connection.connect { message -> handlePageMessage(message) }

        FileDocumentManager.getInstance().getDocument(file)?.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    if (!applyingFromPage && pageReady) {
                        // The document changed under the page: any pending page->IDE write is stale.
                        writeDebounce.cancelAllRequests()
                        // Coalesce keystrokes in the native tab into one push to the page.
                        pushDebounce.cancelAllRequests()
                        pushDebounce.addRequest(
                            {
                                if (syncBlocked) {
                                    reconcileDiskAndDocument(pushResolvedContent = true)
                                } else {
                                    pushMarkdown(currentMarkdown())
                                }
                            },
                            IDE_TO_EDITOR_DEBOUNCE_MS,
                        )
                    }
                }
            },
            this,
        )

        messageBusConnection.subscribe(
            VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: List<VFileEvent>) {
                    if (events.any { it is VFileContentChangeEvent && it.file.url == file.url }) {
                        writeDebounce.cancelAllRequests()
                        ApplicationManager.getApplication().invokeLater {
                            if (!project.isDisposed && file.isValid) {
                                reconcileDiskAndDocument(pushResolvedContent = pageReady)
                            }
                        }
                    }
                    val writabilityChanged = events.any {
                        it is VFilePropertyChangeEvent &&
                            it.file.url == file.url &&
                            it.propertyName == VirtualFile.PROP_WRITABLE
                    }
                    if (writabilityChanged && pageReady) {
                        pushConfig()
                    }
                }
            },
        )

        messageBusConnection.subscribe(
            MilkJSettings.TOPIC,
            object : MilkJSettings.Listener {
                override fun settingsChanged() {
                    if (pageReady) {
                        pushConfig()
                    }
                }
            },
        )

        // "Follow IDE" resolves the theme when the config is built, so a look-and-feel switch must
        // trigger a fresh push or the page keeps the colours it started with.
        messageBusConnection.subscribe(
            LafManagerListener.TOPIC,
            LafManagerListener {
                if (pageReady) {
                    pushConfig()
                }
            },
        )
    }

    override fun dispose() {
        writeDebounce.cancelAllRequests()
    }

    /**
     * Restores a caret and scroll position on the page. The platform calls the editor's `setState`
     * right after constructing it, long before the page is ready, so the state is parked until the
     * content it refers to has been pushed; a later call (Back / Forward navigation) applies at once.
     */
    fun restoreViewState(state: MilkJEditorState) {
        viewState = state
        if (pageReady) {
            pushViewState(state)
        } else {
            pendingViewState = state
        }
    }

    @TestOnly
    internal fun drainDebouncesForTest() {
        writeDebounce.drainRequestsInTest()
        pushDebounce.drainRequestsInTest()
    }

    @TestOnly
    internal fun setDiskTextForTest(markdown: String) {
        testDiskVersion++
        val bytes = markdown.toByteArray(file.charset)
        testDiskSnapshot = DiskSnapshot(
            markdown,
            fingerprint(bytes, testDiskVersion),
        )
    }

    private fun handlePageMessage(message: String) {
        // JCEF delivers page messages on a browser thread; everything below (document text, stamps,
        // VFS) must be read on the EDT — newer platform builds assert on off-EDT document access.
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed || !file.isValid) {
                return@invokeLater
            }
            when {
                message == "ready" -> {
                    pageReady = true
                    // A restored IntelliJ Document can predate the physical file. Refresh first,
                    // then refuse page writes if IntelliJ still holds different text; otherwise a
                    // delayed Milkdown normalization echo could dirty and later autosave the stale
                    // Document over the newer file.
                    reconcileDiskAndDocument(pushResolvedContent = false)
                    // Config first: the page applies theme/placeholder/readonly before the content
                    // lands, so a config-driven editor rebuild happens while it's still empty.
                    pushConfig()
                    pushMarkdown(currentMarkdown())
                    pendingViewState?.let { state ->
                        pendingViewState = null
                        pushViewState(state)
                    }
                }
                message.startsWith(VIEW_STATE_PREFIX) && pageReady -> {
                    MilkJEditorState.parse(message.removePrefix(VIEW_STATE_PREFIX))?.let { viewState = it }
                }
                message.startsWith("markdown:") && pageReady -> {
                    parsePageMarkdown(message.removePrefix("markdown:"))?.let { pageEdit ->
                        roundTripFailureNotified = false
                        scheduleDocumentWrite(pageEdit)
                    }
                }
                message.startsWith(ROUNDTRIP_ERROR_PREFIX) && pageReady -> {
                    notifyRoundTripFailure(message.removePrefix(ROUNDTRIP_ERROR_PREFIX))
                }
                message.startsWith("dictionary:add:") && pageReady -> {
                    runCatching {
                        URLDecoder.decode(
                            message.removePrefix("dictionary:add:"),
                            StandardCharsets.UTF_8,
                        )
                    }.getOrNull()?.let(settings::addDictionaryWord)
                }
                message.startsWith(NAVIGATION_PREFIX) && pageReady -> {
                    handleNavigationPayload(message.removePrefix(NAVIGATION_PREFIX))
                }
                message.startsWith(IMAGE_UPLOAD_PREFIX) && pageReady -> {
                    handleImageUpload(message.removePrefix(IMAGE_UPLOAD_PREFIX))
                }
                message.startsWith(EXTERNAL_URL_PREFIX) && pageReady -> {
                    handleExternalUrlPayload(message.removePrefix(EXTERNAL_URL_PREFIX))
                }
            }
        }
    }

    private fun handleNavigationPayload(payload: String) {
        val target = decodeValidatedTarget(payload) ?: return
        fileLinkNavigator.navigate(target)
    }

    /**
     * Opens a web link from the page in the OS default browser. JCEF's embedded frame has no
     * popup/navigation handling, so the page forwards clicks here instead of navigating itself.
     */
    private fun handleExternalUrlPayload(payload: String) {
        val url = decodeValidatedTarget(payload) ?: return
        val uri = try {
            URI(url)
        } catch (_: URISyntaxException) {
            LOG.warn("Dropped invalid MilkJ external URL message: not a parsable URI")
            return
        }
        // Allow-list: only schemes that are safe to hand to a browser. Everything else — most
        // importantly javascript:, data:, and file: — must never leave the page as an open request.
        val schemeAllowed = when (uri.scheme?.lowercase()) {
            "http", "https" -> !uri.host.isNullOrBlank()
            "mailto" -> uri.schemeSpecificPart.isNotBlank()
            else -> false
        }
        if (!schemeAllowed) {
            LOG.warn("Dropped unsupported MilkJ external URL message: scheme is not browser-safe")
            return
        }
        openInBrowser(uri.toString())
    }

    /** Shared transport-level validation for the `navigate:*` message family; null means dropped. */
    private fun decodeValidatedTarget(payload: String): String? {
        if (payload.length > MAX_NAVIGATION_PAYLOAD_CHARS || payload.any { it.code > 0x7f }) {
            LOG.warn("Dropped invalid MilkJ navigation message: encoded payload is oversized or non-ASCII")
            return null
        }
        val target = try {
            strictPercentDecode(payload)
        } catch (_: IllegalArgumentException) {
            LOG.warn("Dropped invalid MilkJ navigation message: malformed percent encoding or UTF-8")
            return null
        }
        if (target.isBlank() || target.length > MAX_NAVIGATION_TARGET_CHARS || target.hasIsoControlCharacters()) {
            LOG.warn("Dropped invalid MilkJ navigation message: decoded target is empty, oversized, or contains controls")
            return null
        }
        return target
    }

    private fun handleImageUpload(payload: String) {
        val requestId = payload.substringBefore(':').takeIf(ImageUploads::isValidRequestId)
        fun refuse(reason: String) {
            LOG.warn("Refused MilkJ image upload: $reason")
            requestId?.let { replyImageUploaded(it, null) }
            notifyImageUploadFailed(reason)
        }

        if (!file.isWritable || syncBlocked) {
            refuse("The Markdown file is read-only in MilkJ right now.")
            return
        }
        val request = ImageUploads.parse(payload).getOrElse { error ->
            refuse(error.message ?: "The upload message was malformed.")
            return
        }
        val relativePath = try {
            WriteAction.compute<String, IOException> {
                ImageUploads.save(file, settings.state.imageUploadDirectory, request, requestor = this)
            }
        } catch (error: IOException) {
            refuse(error.message ?: "The image could not be written.")
            return
        }
        replyImageUploaded(request.requestId, relativePath)
    }

    private fun replyImageUploaded(requestId: String, relativePath: String?) {
        val pathJson = relativePath?.toJsonString() ?: "null"
        executeJavaScript("window.milkjImageUploaded?.(${requestId.toJsonString()}, $pathJson);")
    }

    private fun notifyImageUploadFailed(reason: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("MilkJ")
            .createNotification(
                "MilkJ could not save the pasted image",
                StringUtil.escapeXmlEntities(reason),
                NotificationType.WARNING,
            )
            .notify(project)
    }

    private fun notifyRoundTripFailure(encodedReason: String) {
        if (roundTripFailureNotified) return
        val reason = runCatching {
            URLDecoder.decode(encodedReason.take(MAX_ROUNDTRIP_ERROR_CHARS), StandardCharsets.UTF_8)
        }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: "The edit could not be mapped safely onto the original Markdown."
        roundTripFailureNotified = true
        NotificationGroupManager.getInstance()
            .getNotificationGroup("MilkJ")
            .createNotification(
                "MilkJ kept the Markdown source unchanged",
                "$reason The rich-text edit was reverted; use the built-in source editor for this change.",
                NotificationType.WARNING,
            )
            .notify(project)
    }

    private fun scheduleDocumentWrite(pageEdit: PageEdit) {
        if (pageEdit.revision != pageRevision) {
            // The page emitted an update created from content that the IDE has since replaced.
            pushMarkdown(currentMarkdown())
            return
        }
        if (syncBlocked || !diskMatchesTrustedBaseline()) {
            enterSyncConflict()
            return
        }

        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        val baseline = WriteBaseline(
            documentModificationStamp = document.modificationStamp,
            fileModificationStamp = file.modificationStamp,
            diskFingerprint = trustedDiskFingerprint ?: return,
            pageRevision = pageEdit.revision,
        )

        writeDebounce.cancelAllRequests()
        writeDebounce.addRequest(
            {
                writeMarkdownToDocument(pageEdit.markdown, baseline)
            },
            EDITOR_TO_IDE_DEBOUNCE_MS,
        )
    }

    private fun writeMarkdownToDocument(markdown: String, baseline: WriteBaseline) {
        if (project.isDisposed || !file.isValid || !file.isWritable) {
            return
        }

        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        if (document.modificationStamp != baseline.documentModificationStamp ||
            file.modificationStamp != baseline.fileModificationStamp ||
            pageRevision != baseline.pageRevision ||
            diskFingerprint() != baseline.diskFingerprint ||
            syncBlocked
        ) {
            enterSyncConflict()
            return
        }
        lastPageWriteMarkdown = markdown
        if (document.text == markdown) {
            return
        }

        WriteCommandAction.writeCommandAction(project)
            .withName("Edit Markdown in MilkJ")
            .withGroupId("MilkJ.DocumentSync")
            .shouldRecordActionForActiveDocument(true)
            .run<RuntimeException> {
                applyingFromPage = true
                try {
                    replaceChangedRange(document, markdown)
                } finally {
                    applyingFromPage = false
                }
            }
    }

    /**
     * Replaces only the changed region (common prefix/suffix trimmed) instead of the whole file:
     * whole-file setText made every WYSIWYG edit a full replacement — coarse undo, caret jumps in
     * the native tab, and needlessly large modified ranges.
     */
    private fun replaceChangedRange(document: Document, markdown: String) {
        val oldText = document.charsSequence
        val oldLength = oldText.length
        val newLength = markdown.length

        var prefix = 0
        val maxPrefix = minOf(oldLength, newLength)
        while (prefix < maxPrefix && oldText[prefix] == markdown[prefix]) {
            prefix++
        }

        var suffix = 0
        val maxSuffix = minOf(oldLength, newLength) - prefix
        while (suffix < maxSuffix && oldText[oldLength - 1 - suffix] == markdown[newLength - 1 - suffix]) {
            suffix++
        }

        document.replaceString(prefix, oldLength - suffix, markdown.substring(prefix, newLength - suffix))
    }

    private fun pushMarkdown(markdown: String) {
        pageRevision++
        executeJavaScript("window.milkjSetMarkdown?.(${markdown.toJsonString()}, $pageRevision);")
    }

    private fun pushViewState(state: MilkJEditorState) {
        executeJavaScript("window.milkjSetViewState?.(${state.anchor}, ${state.scrollTop});")
    }

    private fun pushConfig() {
        val configJson = frontendConfigJson(
            settings.state,
            readonly = !file.isWritable || syncBlocked,
            localImageBaseUrl = localImageBaseUrl,
        )
        executeJavaScript("window.milkjApplyConfig?.($configJson);")
    }

    private fun enterSyncConflict() {
        writeDebounce.cancelAllRequests()
        if (!syncBlocked) {
            syncBlocked = true
            if (pageReady) {
                pushConfig()
            }
        }
        file.refresh(false, false)
        notifySyncConflict()
    }

    private fun notifySyncConflict() {
        if (conflictNotified) {
            return
        }
        conflictNotified = true
        NotificationGroupManager.getInstance()
            .getNotificationGroup("MilkJ")
            .createNotification(
                "MilkJ paused to protect newer file content",
                "\"${file.name}\" differs between IntelliJ and disk. MilkJ is read-only until you save or reload the file in IntelliJ, so it cannot overwrite the disk version.",
                NotificationType.WARNING,
            )
            .notify(project)
    }

    private fun currentMarkdown(): String {
        val document = FileDocumentManager.getInstance().getDocument(file)
        if (document != null) {
            return document.text
        }
        return VfsUtilCore.loadText(file)
    }

    /**
     * Establishes a trusted physical-file baseline only when IntelliJ's Document contains exactly
     * the text loaded from that file. A mismatch is deliberately not resolved here: it may be a
     * legitimate unsaved edit, so IntelliJ remains responsible for asking the user whether to save
     * or reload it. MilkJ simply becomes read-only until the two sides agree again.
     */
    private fun reconcileDiskAndDocument(pushResolvedContent: Boolean) {
        file.refresh(false, false)
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        val disk = diskSnapshot()
        if (disk == null || document.text != disk.text) {
            enterSyncConflict()
            return
        }

        trustedDiskFingerprint = disk.fingerprint
        val wasBlocked = syncBlocked
        syncBlocked = false
        conflictNotified = false
        if (pageReady && wasBlocked) {
            pushConfig()
        }
        if (pageReady && pushResolvedContent && document.text != lastPageWriteMarkdown) {
            pushMarkdown(document.text)
        }
    }

    private fun executeJavaScript(script: String) {
        connection.executeJavaScript(script)
    }

    private fun diskMatchesTrustedBaseline(): Boolean {
        val trusted = trustedDiskFingerprint ?: return false
        return diskFingerprint() == trusted
    }

    private fun diskFingerprint(): DiskFingerprint? = diskSnapshot()?.fingerprint

    private fun diskSnapshot(): DiskSnapshot? {
        testDiskSnapshot?.let { return it }

        if (file.fileSystem.protocol == StandardFileSystems.FILE_PROTOCOL) {
            // A failed physical read is a conflict, not permission to fall back to possibly stale
            // VFS bytes. The page must never write while the authoritative file is unreadable.
            return runCatching {
                val path = VfsUtilCore.virtualToIoFile(file).toPath()
                val bytes = Files.readAllBytes(path)
                DiskSnapshot(
                    LoadTextUtil.getTextByBinaryPresentation(bytes, file).toString(),
                    fingerprint(bytes, Files.getLastModifiedTime(path).toMillis()),
                )
            }.getOrNull()
        }

        // IntelliJ's platform tests and some non-local VirtualFile implementations have no NIO
        // path. Their VFS bytes are still the authoritative backing content.
        return runCatching {
            val bytes = file.contentsToByteArray()
            DiskSnapshot(
                LoadTextUtil.getTextByBinaryPresentation(bytes, file).toString(),
                fingerprint(bytes, file.timeStamp),
            )
        }.getOrNull()
    }

    private fun fingerprint(bytes: ByteArray, lastModified: Long): DiskFingerprint =
        DiskFingerprint(
            lastModified = lastModified,
            size = bytes.size.toLong(),
            sha256 = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(bytes),
            ),
        )

    private fun parsePageMarkdown(payload: String): PageEdit? {
        val separator = payload.indexOf('\n')
        if (separator < 0) {
            return null
        }
        val revision = payload.substring(0, separator).toLongOrNull() ?: return null
        return PageEdit(revision, payload.substring(separator + 1))
    }

    companion object {
        private val LOG = Logger.getInstance(MilkJBridge::class.java)
        private const val EDITOR_TO_IDE_DEBOUNCE_MS = 250
        private const val IDE_TO_EDITOR_DEBOUNCE_MS = 150
        private const val NAVIGATION_PREFIX = "navigate:file:"
        private const val EXTERNAL_URL_PREFIX = "navigate:url:"
        private const val IMAGE_UPLOAD_PREFIX = "image:upload:"
        private const val ROUNDTRIP_ERROR_PREFIX = "roundtrip:error:"
        private const val VIEW_STATE_PREFIX = "viewstate:"
        private const val MAX_ROUNDTRIP_ERROR_CHARS = 1_024
        private const val MAX_NAVIGATION_PAYLOAD_CHARS = 8 * 1024
        private const val MAX_NAVIGATION_TARGET_CHARS = 4 * 1024

        internal fun frontendConfigJson(
            state: MilkJSettings.State,
            readonly: Boolean,
            localImageBaseUrl: String? = null,
        ): String {
            val effectiveTheme = when (state.theme) {
                MilkJSettings.ThemeMode.LIGHT -> "light"
                MilkJSettings.ThemeMode.DARK -> "dark"
                MilkJSettings.ThemeMode.FOLLOW_IDE -> if (!JBColor.isBright()) "dark" else "light"
            }

            return buildString {
                append("{")
                append("\"theme\":").append(effectiveTheme.toJsonString()).append(",")
                append("\"configuredTheme\":").append(state.theme.name.toJsonString()).append(",")
                append("\"editorTheme\":").append(state.editorTheme.name.toJsonString()).append(",")
                append("\"mermaidTheme\":").append(state.mermaidTheme.name.toJsonString()).append(",")
                append("\"defaultEditor\":").append(state.defaultEditor.name.toJsonString()).append(",")
                append("\"placeholder\":").append(state.placeholderText.toJsonString()).append(",")
                append("\"proofingEnabled\":").append(state.spellcheckEnabled).append(",")
                append("\"proofingDialect\":").append(state.proofingDialect.name.toJsonString()).append(",")
                append("\"customDictionary\":[")
                normalizeDictionary(state.customDictionary).forEachIndexed { index, word ->
                    if (index > 0) append(",")
                    append(word.toJsonString())
                }
                append("],")
                append("\"weirpacks\":[")
                enabledWeirpacks(state).forEachIndexed { index, data ->
                    if (index > 0) append(",")
                    append(data.toJsonString())
                }
                append("],")
                if (localImageBaseUrl != null) {
                    append("\"localImageBaseUrl\":").append(localImageBaseUrl.toJsonString()).append(",")
                }
                append("\"readonly\":").append(readonly)
                append("}")
            }
        }

        private fun String.toJsonString(): String =
            "\"" + StringUtil.escapeStringCharacters(this) + "\""
    }

    private data class WriteBaseline(
        val documentModificationStamp: Long,
        val fileModificationStamp: Long,
        val diskFingerprint: DiskFingerprint,
        val pageRevision: Long,
    )

    private data class DiskFingerprint(
        val lastModified: Long,
        val size: Long,
        val sha256: String,
    )

    private data class DiskSnapshot(val text: String, val fingerprint: DiskFingerprint)

    private data class PageEdit(val revision: Long, val markdown: String)
}
