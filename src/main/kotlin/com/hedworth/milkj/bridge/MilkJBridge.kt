package com.hedworth.milkj.bridge

import com.hedworth.milkj.settings.MilkJSettings
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.impl.LoadTextUtil
import com.intellij.openapi.project.Project
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
import java.nio.file.Files
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
) : Disposable {
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
    private var testDiskSnapshot: DiskSnapshot? = null
    private var testDiskVersion = 0L

    // One notification per conflict burst; reset only after disk and Document agree again.
    private var conflictNotified = false

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

    }

    override fun dispose() {
        writeDebounce.cancelAllRequests()
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
                }
                message.startsWith("markdown:") && pageReady -> {
                    parsePageMarkdown(message.removePrefix("markdown:"))?.let { pageEdit ->
                        scheduleDocumentWrite(pageEdit)
                    }
                }
            }
        }
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

    private fun pushConfig() {
        val configJson = frontendConfigJson(settings.state, readonly = !file.isWritable || syncBlocked)
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
        if (pageReady && pushResolvedContent) {
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
        private const val EDITOR_TO_IDE_DEBOUNCE_MS = 250
        private const val IDE_TO_EDITOR_DEBOUNCE_MS = 150

        internal fun frontendConfigJson(state: MilkJSettings.State, readonly: Boolean): String {
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
