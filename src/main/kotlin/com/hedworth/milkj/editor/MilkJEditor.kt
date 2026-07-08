package com.hedworth.milkj.editor

import com.hedworth.milkj.bridge.JcefBrowserConnection
import com.hedworth.milkj.bridge.MilkJBridge
import com.hedworth.milkj.web.MilkJWebResources
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBuilder
import java.awt.BorderLayout
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * A WYSIWYG Markdown [FileEditor] backed by Milkdown running inside an embedded JCEF browser.
 *
 * The browser is created eagerly in the constructor, even though IntelliJ instantiates every
 * accepted provider's editor when a file is opened (not when its tab is first selected), so this
 * spawns a JCEF process per opened Markdown file. A lazy show-triggered variant (0.1.5/0.1.6) made
 * editor creation so fast that the Marketplace IDE-run verifier deterministically hit a platform
 * threading bug on 2026.2 EAP: the daemon's first highlighting pass over the file races Gradle
 * sync's background write action, and DaemonFusReporter then reads the editor model without a read
 * action. JetBrains declined to treat it as a false positive, so we keep eager creation until the
 * platform bug is fixed before re-attempting lazy init. Document dirtying from Crepe's markdown
 * normalization is prevented by the frontend's echo suppression plus [MilkJBridge]'s write
 * baseline, not by laziness.
 */
class MilkJEditor(
    private val project: Project,
    private val file: VirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val panel = JPanel(BorderLayout())
    private var browser: JBCefBrowser? = null

    init {
        if (JcefSupport.isAvailable()) {
            initializeBrowser()
        } else {
            // Fallback if this editor is ever constructed without JCEF (the provider normally
            // refuses such files up front).
            panel.add(JLabel("MilkJ requires JCEF, which isn't available in this IDE."), BorderLayout.CENTER)
        }
    }

    private fun initializeBrowser() {
        val newBrowser = JBCefBrowserBuilder().build()
        Disposer.register(this, newBrowser)
        browser = newBrowser

        MilkJWebResources.registerSchemeHandler()

        val connection = JcefBrowserConnection(newBrowser)
        Disposer.register(this, connection)
        val bridge = MilkJBridge(project, file, connection)
        Disposer.register(this, bridge)
        bridge.install()

        newBrowser.loadURL(MilkJWebResources.indexUrl)
        panel.add(newBrowser.component, BorderLayout.CENTER)
        panel.revalidate()
        panel.repaint()
    }

    override fun getComponent(): JComponent = panel

    override fun getPreferredFocusedComponent(): JComponent? = browser?.component

    override fun getName(): String = "MilkJ"

    override fun getFile(): VirtualFile = file

    override fun setState(state: FileEditorState) { /* TODO: restore caret/scroll if we model state */ }

    override fun isModified(): Boolean = false // backed by the shared Document; platform tracks mod/save

    override fun isValid(): Boolean = file.isValid

    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun dispose() { /* browser, connection and bridge are registered with Disposer */ }
}
