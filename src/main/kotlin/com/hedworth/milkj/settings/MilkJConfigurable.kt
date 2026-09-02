package com.hedworth.milkj.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.ItemListener
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
    private var imageUploadDirectoryField: JBTextField? = null
    private var showShortcutsTabCheckBox: JBCheckBox? = null
    private var spellcheckCheckBox: JBCheckBox? = null
    private var proofingDialectCombo: JComboBox<MilkJSettings.ProofingDialect>? = null
    private var spellcheckListener: ItemListener? = null
    private var dictionaryEditor: DictionaryEditor? = null
    private var dictionaryBaseline: List<String> = emptyList()
    private var weirpackEditor: WeirpackEditor? = null
    private var weirpackBaseline: List<WeirpackSnapshot> = emptyList()

    override fun getDisplayName(): String = "MilkJ"

    override fun createComponent(): JComponent {
        val createdPanel = JPanel(GridBagLayout())
        panel = createdPanel

        themeCombo = JComboBox(MilkJSettings.ThemeMode.entries.toTypedArray())
        editorThemeCombo = JComboBox(MilkJSettings.EditorTheme.entries.toTypedArray())
        mermaidThemeCombo = JComboBox(MilkJSettings.MermaidTheme.entries.toTypedArray())
        defaultEditorCombo = JComboBox(MilkJSettings.DefaultEditorMode.entries.toTypedArray())
        placeholderField = JBTextField()
        imageUploadDirectoryField = JBTextField().apply {
            toolTipText = "Folder for pasted and dropped images, relative to the Markdown file. Leave blank to use the file's own folder."
        }
        showShortcutsTabCheckBox = JBCheckBox("Show the Shortcuts reference tab for Markdown files")
        spellcheckCheckBox = JBCheckBox("Enable Harper spell checking")
        proofingDialectCombo = JComboBox(MilkJSettings.ProofingDialect.entries.toTypedArray())
        spellcheckListener = ItemListener {
            proofingDialectCombo?.isEnabled = spellcheckCheckBox?.isSelected == true
        }.also { spellcheckCheckBox!!.addItemListener(it) }

        val dictionaryPanel = DictionaryEditor().also { dictionaryEditor = it }
        val weirpackPanel = WeirpackEditor().also { weirpackEditor = it }

        createdPanel.addRow(0, "Theme mode:", themeCombo!!)
        createdPanel.addRow(1, "Editor theme:", editorThemeCombo!!)
        createdPanel.addRow(2, "Mermaid theme:", mermaidThemeCombo!!)
        createdPanel.addRow(3, "Default editor for Markdown:", defaultEditorCombo!!)
        createdPanel.addRow(4, "Placeholder text:", placeholderField!!)
        createdPanel.addRow(5, "Pasted image folder:", imageUploadDirectoryField!!)
        createdPanel.addRow(6, "", showShortcutsTabCheckBox!!)
        createdPanel.addRow(7, "", spellcheckCheckBox!!)
        createdPanel.addRow(8, "Proofreading dialect:", proofingDialectCombo!!)
        createdPanel.addRow(9, "Custom dictionary:", dictionaryPanel)
        createdPanel.addRow(10, "Weirpacks:", weirpackPanel)
        reset()
        return createdPanel
    }

    override fun isModified(): Boolean {
        val state = settings.state
        return themeCombo?.selectedItem != state.theme ||
            editorThemeCombo?.selectedItem != state.editorTheme ||
            mermaidThemeCombo?.selectedItem != state.mermaidTheme ||
            defaultEditorCombo?.selectedItem != state.defaultEditor ||
            placeholderField?.text != state.placeholderText ||
            imageUploadDirectoryField?.text?.trim() != state.imageUploadDirectory ||
            showShortcutsTabCheckBox?.isSelected != state.showShortcutsTab ||
            spellcheckCheckBox?.isSelected != state.spellcheckEnabled ||
            proofingDialectCombo?.selectedItem != state.proofingDialect ||
            dictionaryEditor?.words.orEmpty() != dictionaryBaseline ||
            weirpackEditor?.snapshots().orEmpty() != weirpackBaseline
    }

    override fun apply() {
        val localWords = dictionaryEditor?.words.orEmpty()
        val additions = localWords.toSet() - dictionaryBaseline.toSet()
        val removals = dictionaryBaseline.toSet() - localWords.toSet()
        val mergedDictionary = normalizeDictionary(
            settings.state.customDictionary.filterNot { it in removals } + additions,
        )
        settings.update(
            settings.state.copy().also {
                it.theme = themeCombo?.selectedItem as MilkJSettings.ThemeMode
                it.editorTheme =
                    editorThemeCombo?.selectedItem as MilkJSettings.EditorTheme
                it.mermaidTheme =
                    mermaidThemeCombo?.selectedItem as MilkJSettings.MermaidTheme
                it.defaultEditor =
                    defaultEditorCombo?.selectedItem as MilkJSettings.DefaultEditorMode
                it.placeholderText = placeholderField?.text.orEmpty()
                it.imageUploadDirectory = imageUploadDirectoryField?.text.orEmpty().trim()
                it.showShortcutsTab = showShortcutsTabCheckBox?.isSelected ?: true
                it.spellcheckEnabled = spellcheckCheckBox?.isSelected ?: true
                it.proofingDialect =
                    proofingDialectCombo?.selectedItem as MilkJSettings.ProofingDialect
                it.customDictionary = mergedDictionary
                it.weirpacks = weirpackEditor?.packs() ?: mutableListOf()
            },
        )
        dictionaryEditor?.replaceWords(mergedDictionary)
        dictionaryBaseline = mergedDictionary.toList()
        weirpackEditor?.replacePacks(settings.state.weirpacks)
        weirpackBaseline = weirpackEditor?.snapshots().orEmpty()
    }

    override fun reset() {
        val state = settings.state
        themeCombo?.selectedItem = state.theme
        editorThemeCombo?.selectedItem = state.editorTheme
        mermaidThemeCombo?.selectedItem = state.mermaidTheme
        defaultEditorCombo?.selectedItem = state.defaultEditor
        placeholderField?.text = state.placeholderText
        imageUploadDirectoryField?.text = state.imageUploadDirectory
        showShortcutsTabCheckBox?.isSelected = state.showShortcutsTab
        spellcheckCheckBox?.isSelected = state.spellcheckEnabled
        proofingDialectCombo?.selectedItem = state.proofingDialect
        proofingDialectCombo?.isEnabled = state.spellcheckEnabled
        dictionaryBaseline = dictionaryEditor?.reset(state.customDictionary).orEmpty()
        weirpackBaseline = weirpackEditor?.reset(state.weirpacks).orEmpty()
    }

    override fun disposeUIResources() {
        spellcheckListener?.let { spellcheckCheckBox?.removeItemListener(it) }
        panel = null
        themeCombo = null
        editorThemeCombo = null
        mermaidThemeCombo = null
        defaultEditorCombo = null
        placeholderField = null
        imageUploadDirectoryField = null
        showShortcutsTabCheckBox = null
        spellcheckCheckBox = null
        proofingDialectCombo = null
        spellcheckListener = null
        dictionaryEditor = null
        dictionaryBaseline = emptyList()
        weirpackEditor = null
        weirpackBaseline = emptyList()
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
