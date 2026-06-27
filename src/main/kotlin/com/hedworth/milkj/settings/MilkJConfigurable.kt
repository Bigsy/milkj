package com.hedworth.milkj.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import javax.swing.ComboBoxModel
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel

class MilkJConfigurable : Configurable {
    private val settings: MilkJSettings = MilkJSettings.getInstance()
    private var panel: JPanel? = null
    private var themeCombo: JComboBox<MilkJSettings.ThemeMode>? = null
    private var editorThemeCombo: JComboBox<MilkJSettings.EditorTheme>? = null
    private var mermaidThemeCombo: JComboBox<MilkJSettings.MermaidTheme>? = null
    private var defaultEditorCombo: JComboBox<MilkJSettings.DefaultEditorMode>? = null
    private var placeholderField: JBTextField? = null

    override fun getDisplayName(): String = "MilkJ"

    override fun createComponent(): JComponent {
        val createdPanel = JPanel(GridBagLayout())
        panel = createdPanel

        themeCombo = JComboBox(MilkJSettings.ThemeMode.entries.toTypedArray())
        editorThemeCombo = JComboBox(MilkJSettings.EditorTheme.entries.toTypedArray())
        mermaidThemeCombo = JComboBox(MilkJSettings.MermaidTheme.entries.toTypedArray())
        defaultEditorCombo = JComboBox(MilkJSettings.DefaultEditorMode.entries.toTypedArray())
        placeholderField = JBTextField()

        createdPanel.addRow(0, "Theme mode:", themeCombo!!)
        createdPanel.addRow(1, "Editor theme:", editorThemeCombo!!)
        createdPanel.addRow(2, "Mermaid theme:", mermaidThemeCombo!!)
        createdPanel.addRow(3, "Default editor for Markdown:", defaultEditorCombo!!)
        createdPanel.addRow(4, "Placeholder text:", placeholderField!!)
        reset()
        return createdPanel
    }

    override fun isModified(): Boolean {
        val state = settings.state
        return themeCombo?.selectedItem != state.theme ||
            editorThemeCombo?.selectedItem != state.editorTheme ||
            mermaidThemeCombo?.selectedItem != state.mermaidTheme ||
            defaultEditorCombo?.selectedItem != state.defaultEditor ||
            placeholderField?.text != state.placeholderText
    }

    override fun apply() {
        settings.update(
            MilkJSettings.State().also {
                it.theme = themeCombo?.selectedItem as MilkJSettings.ThemeMode
                it.editorTheme =
                    editorThemeCombo?.selectedItem as MilkJSettings.EditorTheme
                it.mermaidTheme =
                    mermaidThemeCombo?.selectedItem as MilkJSettings.MermaidTheme
                it.defaultEditor =
                    defaultEditorCombo?.selectedItem as MilkJSettings.DefaultEditorMode
                it.placeholderText = placeholderField?.text.orEmpty()
            },
        )
    }

    override fun reset() {
        val state = settings.state
        themeCombo?.selectedItem = state.theme
        editorThemeCombo?.selectedItem = state.editorTheme
        mermaidThemeCombo?.selectedItem = state.mermaidTheme
        defaultEditorCombo?.selectedItem = state.defaultEditor
        placeholderField?.text = state.placeholderText
    }

    override fun disposeUIResources() {
        panel = null
        themeCombo = null
        editorThemeCombo = null
        mermaidThemeCombo = null
        defaultEditorCombo = null
        placeholderField = null
    }

    private fun JPanel.addRow(row: Int, label: String, component: JComponent) {
        val labelConstraints = GridBagConstraints().apply {
            gridx = 0
            gridy = row
            anchor = GridBagConstraints.WEST
            insets.set(4, 0, 4, 8)
        }
        add(JBLabel(label), labelConstraints)

        val fieldConstraints = GridBagConstraints().apply {
            gridx = 1
            gridy = row
            weightx = 1.0
            fill = GridBagConstraints.HORIZONTAL
            insets.set(4, 0, 4, 0)
        }
        add(component, fieldConstraints)
    }
}
