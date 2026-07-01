package com.hedworth.milkj.bridge

import com.hedworth.milkj.settings.MilkJSettings
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.util.Alarm
import com.intellij.util.messages.MessageBusConnection
import com.intellij.ui.JBColor

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
    private var knownDiskLastModified = diskLastModified()

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
                            { pushMarkdown(currentMarkdown()) },
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
                        knownDiskLastModified = diskLastModified()
                        writeDebounce.cancelAllRequests()
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
                    pushMarkdown(currentMarkdown())
                    pushConfig()
                }
                message.startsWith("markdown:") && pageReady -> {
                    scheduleDocumentWrite(message.removePrefix("markdown:"))
                }
            }
        }
    }

    private fun scheduleDocumentWrite(markdown: String) {
        if (hasUnseenDiskChange()) {
            file.refresh(false, false)
            return
        }

        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        val baseline = WriteBaseline(
            documentModificationStamp = document.modificationStamp,
            fileModificationStamp = file.modificationStamp,
            diskLastModified = diskLastModified(),
        )

        writeDebounce.cancelAllRequests()
        writeDebounce.addRequest(
            {
                writeMarkdownToDocument(markdown, baseline)
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
            diskLastModified() != baseline.diskLastModified ||
            hasUnseenDiskChange()
        ) {
            file.refresh(false, false)
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
                    document.setText(markdown)
                } finally {
                    applyingFromPage = false
                }
            }
    }

    private fun pushMarkdown(markdown: String) {
        executeJavaScript("window.milkjSetMarkdown?.(${markdown.toJsonString()});")
    }

    private fun pushConfig() {
        executeJavaScript("window.milkjApplyConfig?.(${settings.toFrontendConfigJson()});")
    }

    private fun currentMarkdown(): String {
        val document = FileDocumentManager.getInstance().getDocument(file)
        if (document != null) {
            return document.text
        }
        return VfsUtilCore.loadText(file)
    }

    private fun executeJavaScript(script: String) {
        connection.executeJavaScript(script)
    }

    private fun hasUnseenDiskChange(): Boolean =
        diskLastModified() != knownDiskLastModified

    private fun diskLastModified(): Long =
        runCatching { VfsUtilCore.virtualToIoFile(file).lastModified() }.getOrDefault(0L)

    private fun MilkJSettings.toFrontendConfigJson(): String {
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
            append("\"placeholder\":").append(state.placeholderText.toJsonString())
            append("}")
        }
    }

    private fun String.toJsonString(): String =
        "\"" + StringUtil.escapeStringCharacters(this) + "\""

    companion object {
        private const val EDITOR_TO_IDE_DEBOUNCE_MS = 250
        private const val IDE_TO_EDITOR_DEBOUNCE_MS = 150
    }

    private data class WriteBaseline(
        val documentModificationStamp: Long,
        val fileModificationStamp: Long,
        val diskLastModified: Long,
    )
}
