package com.hedworth.milkj.editor

import com.hedworth.milkj.bridge.MilkJBridge
import com.hedworth.milkj.web.MilkJWebResources
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.JLabel

/**
 * A WYSIWYG Markdown [FileEditor] backed by Milkdown running inside an embedded JCEF browser.
 *
 * Skeleton only — the real implementation needs to:
 *  1. Load the bundled Milkdown app from resources (`/web/index.html`) into the JCEF browser.
 *  2. Push the file's current Markdown into Milkdown on load.
 *  3. Sync edits both ways via [MilkJBridge] (JS -> Document on change; Document -> JS on external edits).
 *  4. Handle disposal, theming (sync IDE theme/LAF into the page), and JCEF-unavailable fallback.
 */
class MilkJEditor(
    private val project: Project,
    private val file: VirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val browser: JBCefBrowser? =
        if (JBCefApp.isSupported()) JBCefBrowser() else null

    private val bridge: MilkJBridge? =
        browser?.let { MilkJBridge(project, file, it) }

    // Fallback shown when JCEF isn't available in the running IDE.
    private val fallback: JComponent =
        JLabel("MilkJ requires JCEF, which isn't available in this IDE.")

    init {
        browser?.let {
            MilkJWebResources.registerSchemeHandler()
            bridge?.install()
            it.loadURL(MilkJWebResources.indexUrl)
        }
    }

    override fun getComponent(): JComponent = browser?.component ?: fallback

    override fun getPreferredFocusedComponent(): JComponent? = browser?.component

    override fun getName(): String = "MilkJ"

    override fun getFile(): VirtualFile = file

    override fun setState(state: FileEditorState) { /* TODO: restore caret/scroll if we model state */ }

    override fun isModified(): Boolean = false // backed by the shared Document; platform tracks mod/save

    override fun isValid(): Boolean = file.isValid

    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun dispose() {
        bridge?.dispose()
        browser?.let { com.intellij.openapi.util.Disposer.dispose(it) }
    }
}
