package com.hedworth.milkj.bridge

import com.hedworth.milkj.settings.MilkJSettings
import com.hedworth.milkj.web.MilkJWebResources
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
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter

/**
 * Two-way bridge between the Milkdown editor (JS, in JCEF) and the IntelliJ document model.
 *
 * Skeleton only. Intended responsibilities:
 *  - JS -> IDE: a [JBCefJSQuery] the page calls on every Milkdown change; the handler writes the new
 *    Markdown into the file's `Document` (inside a write command), so undo/redo/save flow normally.
 *  - IDE -> JS: a `DocumentListener` that, on external edits (e.g. edits made in the native Markdown
 *    tab), pushes the updated Markdown back into Milkdown via `browser.cefBrowser.executeJavaScript`.
 *  - Debounce + loop-guard so the two directions don't fight each other.
 */
class MilkJBridge(
    private val project: Project,
    private val file: VirtualFile,
    private val browser: JBCefBrowser,
) : Disposable {
    // JBCefBrowser is a JBCefBrowserBase, which is what JBCefJSQuery.create expects.
    private val jsToIde: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val settings: MilkJSettings = MilkJSettings.getInstance()
    private val messageBusConnection: MessageBusConnection =
        ApplicationManager.getApplication().messageBus.connect()
    private val writeDebounce = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var pageReady = false
    private var applyingFromPage = false
    private var knownDiskLastModified = diskLastModified()

    fun install() {
        jsToIde.addHandler { message ->
            handlePageMessage(message)
            null
        }

        FileDocumentManager.getInstance().getDocument(file)?.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    if (!applyingFromPage && pageReady) {
                        writeDebounce.cancelAllRequests()
                        pushMarkdown(event.document.text)
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

        browser.jbCefClient.addLoadHandler(
            object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                    if (frame?.isMain == true) {
                        installJavaScriptBridge()
                    }
                }
            },
            browser.cefBrowser,
        )
    }

    override fun dispose() {
        writeDebounce.cancelAllRequests()
        messageBusConnection.disconnect()
        jsToIde.dispose()
    }

    private fun installJavaScriptBridge() {
        val script = """
            window.milkjSendToIde = function (payload) {
              ${jsToIde.inject("payload")}
            };
            window.milkjBridgeInstalled?.();
        """.trimIndent()
        executeJavaScript(script)
    }

    private fun handlePageMessage(message: String) {
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
        browser.cefBrowser.executeJavaScript(script, MilkJWebResources.indexUrl, 0)
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
    }

    private data class WriteBaseline(
        val documentModificationStamp: Long,
        val fileModificationStamp: Long,
        val diskLastModified: Long,
    )
}
