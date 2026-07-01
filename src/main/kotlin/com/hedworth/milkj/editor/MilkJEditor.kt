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
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBuilder
import java.awt.BorderLayout
import java.awt.event.HierarchyEvent
import java.awt.event.HierarchyListener
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * A WYSIWYG Markdown [FileEditor] backed by Milkdown running inside an embedded JCEF browser.
 *
 * The browser (and the [MilkJBridge] that can write into the file's Document) is created lazily,
 * the first time the MilkJ tab is actually shown: IntelliJ instantiates every accepted provider's
 * editor when a file is opened, not when its tab is first selected, so eager creation would spawn
 * a JCEF process — and let Crepe's markdown normalization dirty the Document — for every opened
 * Markdown file even if the user never selects the MilkJ tab.
 */
class MilkJEditor(
    private val project: Project,
    private val file: VirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val panel = JPanel(BorderLayout())
    private var browser: JBCefBrowser? = null

    init {
        if (JBCefApp.isSupported()) {
            panel.addHierarchyListener(object : HierarchyListener {
                override fun hierarchyChanged(event: HierarchyEvent) {
                    if (event.changeFlags and HierarchyEvent.SHOWING_CHANGED.toLong() != 0L && panel.isShowing) {
                        panel.removeHierarchyListener(this)
                        initializeBrowser()
                    }
                }
            })
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
