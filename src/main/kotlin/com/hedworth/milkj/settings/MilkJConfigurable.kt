package com.hedworth.milkj.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.Messages
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.ItemListener
import java.awt.event.ActionListener
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.ComboBoxModel
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.event.ListSelectionListener

class MilkJConfigurable : Configurable {
    private val settings: MilkJSettings = MilkJSettings.getInstance()
    private var panel: JPanel? = null
    private var themeCombo: JComboBox<MilkJSettings.ThemeMode>? = null
    private var editorThemeCombo: JComboBox<MilkJSettings.EditorTheme>? = null
    private var mermaidThemeCombo: JComboBox<MilkJSettings.MermaidTheme>? = null
    private var defaultEditorCombo: JComboBox<MilkJSettings.DefaultEditorMode>? = null
    private var placeholderField: JBTextField? = null
    private var showShortcutsTabCheckBox: JBCheckBox? = null
    private var spellcheckCheckBox: JBCheckBox? = null
    private var proofingDialectCombo: JComboBox<MilkJSettings.ProofingDialect>? = null
    private var spellcheckListener: ItemListener? = null
    private var dictionaryModel: DefaultListModel<String>? = null
    private var dictionaryList: JBList<String>? = null
    private var dictionaryField: JBTextField? = null
    private var dictionaryAddButton: JButton? = null
    private var dictionaryRemoveButton: JButton? = null
    private var dictionaryClearButton: JButton? = null
    private var dictionaryValidationLabel: JBLabel? = null
    private var dictionaryAddListener: ActionListener? = null
    private var dictionaryRemoveListener: ActionListener? = null
    private var dictionaryClearListener: ActionListener? = null
    private var dictionarySelectionListener: ListSelectionListener? = null
    private var dictionaryBaseline: List<String> = emptyList()

    override fun getDisplayName(): String = "MilkJ"

    override fun createComponent(): JComponent {
        val createdPanel = JPanel(GridBagLayout())
        panel = createdPanel

        themeCombo = JComboBox(MilkJSettings.ThemeMode.entries.toTypedArray())
        editorThemeCombo = JComboBox(MilkJSettings.EditorTheme.entries.toTypedArray())
        mermaidThemeCombo = JComboBox(MilkJSettings.MermaidTheme.entries.toTypedArray())
        defaultEditorCombo = JComboBox(MilkJSettings.DefaultEditorMode.entries.toTypedArray())
        placeholderField = JBTextField()
        showShortcutsTabCheckBox = JBCheckBox("Show the Shortcuts reference tab for Markdown files")
        spellcheckCheckBox = JBCheckBox("Enable Harper spell checking")
        proofingDialectCombo = JComboBox(MilkJSettings.ProofingDialect.entries.toTypedArray())
        spellcheckListener = ItemListener {
            proofingDialectCombo?.isEnabled = spellcheckCheckBox?.isSelected == true
        }.also { spellcheckCheckBox!!.addItemListener(it) }

        val dictionaryPanel = createDictionaryPanel()

        createdPanel.addRow(0, "Theme mode:", themeCombo!!)
        createdPanel.addRow(1, "Editor theme:", editorThemeCombo!!)
        createdPanel.addRow(2, "Mermaid theme:", mermaidThemeCombo!!)
        createdPanel.addRow(3, "Default editor for Markdown:", defaultEditorCombo!!)
        createdPanel.addRow(4, "Placeholder text:", placeholderField!!)
        createdPanel.addRow(5, "", showShortcutsTabCheckBox!!)
        createdPanel.addRow(6, "", spellcheckCheckBox!!)
        createdPanel.addRow(7, "Proofreading dialect:", proofingDialectCombo!!)
        createdPanel.addRow(8, "Custom dictionary:", dictionaryPanel)
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
            showShortcutsTabCheckBox?.isSelected != state.showShortcutsTab ||
            spellcheckCheckBox?.isSelected != state.spellcheckEnabled ||
            proofingDialectCombo?.selectedItem != state.proofingDialect ||
            dictionaryWords() != dictionaryBaseline
    }

    override fun apply() {
        val localWords = dictionaryWords()
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
                it.showShortcutsTab = showShortcutsTabCheckBox?.isSelected ?: true
                it.spellcheckEnabled = spellcheckCheckBox?.isSelected ?: true
                it.proofingDialect =
                    proofingDialectCombo?.selectedItem as MilkJSettings.ProofingDialect
                it.customDictionary = mergedDictionary
            },
        )
        replaceDictionaryWords(mergedDictionary)
        dictionaryBaseline = mergedDictionary.toList()
    }

    override fun reset() {
        val state = settings.state
        themeCombo?.selectedItem = state.theme
        editorThemeCombo?.selectedItem = state.editorTheme
        mermaidThemeCombo?.selectedItem = state.mermaidTheme
        defaultEditorCombo?.selectedItem = state.defaultEditor
        placeholderField?.text = state.placeholderText
        showShortcutsTabCheckBox?.isSelected = state.showShortcutsTab
        spellcheckCheckBox?.isSelected = state.spellcheckEnabled
        proofingDialectCombo?.selectedItem = state.proofingDialect
        proofingDialectCombo?.isEnabled = state.spellcheckEnabled
        dictionaryBaseline = normalizeDictionary(state.customDictionary).toList()
        replaceDictionaryWords(dictionaryBaseline)
        dictionaryField?.text = ""
        showDictionaryValidation(null)
    }

    override fun disposeUIResources() {
        spellcheckListener?.let { spellcheckCheckBox?.removeItemListener(it) }
        dictionaryAddListener?.let { listener ->
            dictionaryAddButton?.removeActionListener(listener)
            dictionaryField?.removeActionListener(listener)
        }
        dictionaryRemoveListener?.let { dictionaryRemoveButton?.removeActionListener(it) }
        dictionaryClearListener?.let { dictionaryClearButton?.removeActionListener(it) }
        dictionarySelectionListener?.let { dictionaryList?.removeListSelectionListener(it) }
        panel = null
        themeCombo = null
        editorThemeCombo = null
        mermaidThemeCombo = null
        defaultEditorCombo = null
        placeholderField = null
        showShortcutsTabCheckBox = null
        spellcheckCheckBox = null
        proofingDialectCombo = null
        spellcheckListener = null
        dictionaryModel = null
        dictionaryList = null
        dictionaryField = null
        dictionaryAddButton = null
        dictionaryRemoveButton = null
        dictionaryClearButton = null
        dictionaryValidationLabel = null
        dictionaryAddListener = null
        dictionaryRemoveListener = null
        dictionaryClearListener = null
        dictionarySelectionListener = null
        dictionaryBaseline = emptyList()
    }

    private fun createDictionaryPanel(): JPanel {
        val model = DefaultListModel<String>().also { dictionaryModel = it }
        val list = JBList(model).also {
            dictionaryList = it
            it.selectionMode = ListSelectionModel.MULTIPLE_INTERVAL_SELECTION
            it.visibleRowCount = 5
        }
        val scrollPane = JBScrollPane(list).apply { preferredSize = Dimension(360, 110) }
        val field = JBTextField().also { dictionaryField = it }
        val addButton = JButton("Add").also { dictionaryAddButton = it }
        val removeButton = JButton("Remove Selected").also {
            dictionaryRemoveButton = it
            it.isEnabled = false
        }
        val clearButton = JButton("Clear").also {
            dictionaryClearButton = it
            it.isEnabled = false
        }
        val validation = JBLabel().also {
            dictionaryValidationLabel = it
            it.foreground = JBColor.RED
        }

        dictionaryAddListener = ActionListener { addDictionaryWordFromField() }.also {
            addButton.addActionListener(it)
            field.addActionListener(it)
        }
        dictionaryRemoveListener = ActionListener {
            list.selectedIndices.sortedDescending().forEach(model::remove)
            updateDictionaryButtons()
            showDictionaryValidation(null)
        }.also(removeButton::addActionListener)
        dictionaryClearListener = ActionListener {
            val parent = panel
            if (parent != null && !model.isEmpty && Messages.showYesNoDialog(
                    parent,
                    "Remove every word from the MilkJ custom dictionary?",
                    "Clear Custom Dictionary",
                    Messages.getQuestionIcon(),
                ) == Messages.YES
            ) {
                model.clear()
                updateDictionaryButtons()
                showDictionaryValidation(null)
            }
        }.also(clearButton::addActionListener)
        dictionarySelectionListener = ListSelectionListener { updateDictionaryButtons() }
            .also(list::addListSelectionListener)

        val inputPanel = JPanel(BorderLayout(6, 0)).apply {
            add(field, BorderLayout.CENTER)
            add(addButton, BorderLayout.EAST)
        }
        val buttons = JPanel().apply {
            layout = java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)
            add(removeButton)
            add(javax.swing.Box.createHorizontalStrut(6))
            add(clearButton)
        }
        return JPanel(BorderLayout(0, 6)).apply {
            add(scrollPane, BorderLayout.CENTER)
            add(JPanel(BorderLayout(0, 4)).apply {
                add(inputPanel, BorderLayout.NORTH)
                add(buttons, BorderLayout.CENTER)
                add(validation, BorderLayout.SOUTH)
            }, BorderLayout.SOUTH)
        }
    }

    private fun addDictionaryWordFromField() {
        val raw = dictionaryField?.text.orEmpty()
        val word = raw.trim { it.isWhitespace() || it == '\uFEFF' }
        val message = when {
            word.isEmpty() -> "Enter a word."
            word.length > MilkJSettings.MAX_DICTIONARY_WORD_LENGTH -> "Words must be 64 characters or fewer."
            word.any { it.isWhitespace() || it == '\uFEFF' } -> "Dictionary words cannot contain whitespace."
            !word.codePoints().anyMatch(Character::isLetterOrDigit) -> "Include at least one letter or number."
            else -> null
        }
        if (message != null) {
            showDictionaryValidation(message)
            return
        }
        val words = normalizeDictionary(dictionaryWords() + word)
        replaceDictionaryWords(words)
        dictionaryList?.setSelectedValue(word, true)
        dictionaryField?.text = ""
        showDictionaryValidation(null)
    }

    private fun dictionaryWords(): List<String> {
        val model = dictionaryModel ?: return emptyList()
        return (0 until model.size()).map(model::getElementAt)
    }

    private fun replaceDictionaryWords(words: Iterable<String>) {
        val model = dictionaryModel ?: return
        model.clear()
        normalizeDictionary(words).forEach(model::addElement)
        updateDictionaryButtons()
    }

    private fun updateDictionaryButtons() {
        dictionaryRemoveButton?.isEnabled = dictionaryList?.isSelectionEmpty == false
        dictionaryClearButton?.isEnabled = dictionaryModel?.isEmpty == false
    }

    private fun showDictionaryValidation(message: String?) {
        dictionaryValidationLabel?.text = message.orEmpty()
        dictionaryValidationLabel?.isVisible = message != null
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
