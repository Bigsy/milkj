package com.hedworth.milkj.settings

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.Messages
import com.intellij.ui.HyperlinkLabel
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.ui.table.JBTable
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.ActionListener
import java.awt.event.ItemListener
import java.util.Base64
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.ComboBoxModel
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.table.AbstractTableModel
import javax.swing.event.ListSelectionListener

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
    private var weirpackModel: WeirpackTableModel? = null
    private var weirpackTable: JBTable? = null
    private var weirpackImportButton: JButton? = null
    private var weirpackRemoveButton: JButton? = null
    private var weirpackStatusLabel: JBLabel? = null
    private var weirpackImportListener: ActionListener? = null
    private var weirpackRemoveListener: ActionListener? = null
    private var weirpackSelectionListener: ListSelectionListener? = null
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

        val dictionaryPanel = createDictionaryPanel()
        val weirpackPanel = createWeirpackPanel()

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
            dictionaryWords() != dictionaryBaseline ||
            weirpackSnapshots() != weirpackBaseline
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
                it.imageUploadDirectory = imageUploadDirectoryField?.text.orEmpty().trim()
                it.showShortcutsTab = showShortcutsTabCheckBox?.isSelected ?: true
                it.spellcheckEnabled = spellcheckCheckBox?.isSelected ?: true
                it.proofingDialect =
                    proofingDialectCombo?.selectedItem as MilkJSettings.ProofingDialect
                it.customDictionary = mergedDictionary
                it.weirpacks = weirpacks()
            },
        )
        replaceDictionaryWords(mergedDictionary)
        dictionaryBaseline = mergedDictionary.toList()
        replaceWeirpacks(settings.state.weirpacks)
        weirpackBaseline = weirpackSnapshots()
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
        dictionaryBaseline = normalizeDictionary(state.customDictionary).toList()
        replaceDictionaryWords(dictionaryBaseline)
        dictionaryField?.text = ""
        showDictionaryValidation(null)
        replaceWeirpacks(state.weirpacks)
        weirpackBaseline = weirpackSnapshots()
        showWeirpackStatus(null, error = false)
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
        weirpackImportListener?.let { weirpackImportButton?.removeActionListener(it) }
        weirpackRemoveListener?.let { weirpackRemoveButton?.removeActionListener(it) }
        weirpackSelectionListener?.let { weirpackTable?.selectionModel?.removeListSelectionListener(it) }
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
        weirpackModel = null
        weirpackTable = null
        weirpackImportButton = null
        weirpackRemoveButton = null
        weirpackStatusLabel = null
        weirpackImportListener = null
        weirpackRemoveListener = null
        weirpackSelectionListener = null
        weirpackBaseline = emptyList()
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

    private fun createWeirpackPanel(): JPanel {
        val model = WeirpackTableModel().also { weirpackModel = it }
        val table = JBTable(model).also {
            weirpackTable = it
            it.selectionModel.selectionMode = ListSelectionModel.SINGLE_SELECTION
            it.setShowGrid(false)
            it.emptyText.text = "No Weirpacks imported"
            it.columnModel.getColumn(0).apply {
                minWidth = 64
                maxWidth = 64
            }
            it.columnModel.getColumn(2).apply {
                minWidth = 70
                maxWidth = 70
            }
        }
        val importButton = JButton("Import…").also { weirpackImportButton = it }
        val removeButton = JButton("Remove Selected").also {
            weirpackRemoveButton = it
            it.isEnabled = false
        }
        val status = JBLabel().also { weirpackStatusLabel = it }

        weirpackImportListener = ActionListener { importWeirpack() }
            .also(importButton::addActionListener)
        weirpackRemoveListener = ActionListener {
            val selected = table.selectedRow
            if (selected >= 0) {
                model.removePack(table.convertRowIndexToModel(selected))
                updateWeirpackButtons()
                showWeirpackStatus(null, error = false)
            }
        }.also(removeButton::addActionListener)
        weirpackSelectionListener = ListSelectionListener { updateWeirpackButtons() }
            .also(table.selectionModel::addListSelectionListener)

        val buttons = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
            add(importButton)
            add(javax.swing.Box.createHorizontalStrut(6))
            add(removeButton)
        }
        val help = JPanel(BorderLayout(0, 2)).apply {
            add(
                JBLabel("Import ZIP-based .weirpack archives containing custom Harper rules or dictionaries."),
                BorderLayout.NORTH,
            )
            add(HyperlinkLabel("Create your own with Weirsmith").apply {
                setHyperlinkTarget(WEIRSMITH_URL)
            }, BorderLayout.WEST)
        }
        return JPanel(BorderLayout(0, 4)).apply {
            add(JBScrollPane(table).apply {
                preferredSize = Dimension(360, 90)
            }, BorderLayout.CENTER)
            add(JPanel(BorderLayout(0, 4)).apply {
                add(buttons, BorderLayout.NORTH)
                add(help, BorderLayout.CENTER)
                add(status, BorderLayout.SOUTH)
            }, BorderLayout.SOUTH)
        }
    }

    private fun importWeirpack() {
        panel ?: return
        val descriptor = FileChooserDescriptor(true, false, false, false, false, false)
            .withTitle("Import Harper Weirpack")
            .withDescription("Choose a .weirpack archive containing custom Weir rules")
            .withFileFilter { file ->
                file.isDirectory || file.extension.equals("weirpack", ignoreCase = true)
            }
        val file = FileChooser.chooseFile(descriptor, null, null) ?: return
        if (file.length > MAX_WEIRPACK_FILE_BYTES) {
            showWeirpackStatus("Weirpacks must be smaller than 10 MB.", error = true)
            return
        }

        val bytes = try {
            file.contentsToByteArray()
        } catch (exception: Exception) {
            showWeirpackStatus(
                "Could not read ${file.name}: ${exception.message ?: "unknown error"}.",
                error = true,
            )
            return
        }
        if (bytes.size > MAX_WEIRPACK_FILE_BYTES) {
            showWeirpackStatus("Weirpacks must be smaller than 10 MB.", error = true)
            return
        }
        val validationError = validateWeirpack(bytes)
        if (validationError != null) {
            showWeirpackStatus(validationError, error = true)
            return
        }

        val name = uniqueWeirpackName(file.nameWithoutExtension.ifBlank { file.name })
        weirpackModel?.addPack(
            WeirpackSetting().also {
                it.name = name
                it.data = Base64.getEncoder().encodeToString(bytes)
            },
        )
        val lastRow = (weirpackModel?.rowCount ?: 0) - 1
        if (lastRow >= 0) {
            weirpackTable?.selectionModel?.setSelectionInterval(lastRow, lastRow)
        }
        showWeirpackStatus(
            "Imported “$name” (${formatByteSize(bytes.size)}).",
            error = false,
        )
    }

    private fun uniqueWeirpackName(baseName: String): String {
        val names = weirpacks().mapTo(mutableSetOf(), WeirpackSetting::name)
        if (baseName !in names) return baseName
        var suffix = 2
        while ("$baseName ($suffix)" in names) suffix++
        return "$baseName ($suffix)"
    }

    private fun weirpacks(): MutableList<WeirpackSetting> =
        normalizeWeirpacks(weirpackModel?.packs.orEmpty())

    private fun replaceWeirpacks(packs: Iterable<WeirpackSetting>) {
        weirpackModel?.replacePacks(normalizeWeirpacks(packs))
        updateWeirpackButtons()
    }

    private fun weirpackSnapshots(): List<WeirpackSnapshot> =
        weirpacks().map { WeirpackSnapshot(it.name, it.enabled, it.data) }

    private fun updateWeirpackButtons() {
        weirpackRemoveButton?.isEnabled = weirpackTable?.selectedRow?.let { it >= 0 } == true
    }

    private fun showWeirpackStatus(message: String?, error: Boolean) {
        weirpackStatusLabel?.apply {
            text = message.orEmpty()
            foreground = if (error) JBColor.RED else JBColor.foreground()
            isVisible = message != null
        }
    }

    private fun formatByteSize(bytes: Int): String =
        if (bytes < 1024) "$bytes B" else String.format("%.1f KB", bytes / 1024.0)

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

    private companion object {
        const val MAX_WEIRPACK_FILE_BYTES = 10L * 1024L * 1024L
        const val WEIRSMITH_URL = "https://weirsmith.bigsy.uk"
    }
}

private data class WeirpackSnapshot(
    val name: String,
    val enabled: Boolean,
    val data: String,
)

private class WeirpackTableModel : AbstractTableModel() {
    val packs: MutableList<WeirpackSetting> = mutableListOf()

    override fun getRowCount(): Int = packs.size

    override fun getColumnCount(): Int = 3

    override fun getColumnName(column: Int): String =
        when (column) {
            0 -> "Enabled"
            1 -> "Weirpack"
            else -> "Size"
        }

    override fun getColumnClass(columnIndex: Int): Class<*> =
        if (columnIndex == 0) java.lang.Boolean::class.java else super.getColumnClass(columnIndex)

    override fun isCellEditable(rowIndex: Int, columnIndex: Int): Boolean = columnIndex == 0

    override fun getValueAt(rowIndex: Int, columnIndex: Int): Any {
        val pack = packs[rowIndex]
        return when (columnIndex) {
            0 -> pack.enabled
            1 -> pack.name
            else -> decodedSize(pack.data)
        }
    }

    override fun setValueAt(value: Any?, rowIndex: Int, columnIndex: Int) {
        if (columnIndex == 0 && value is Boolean) {
            packs[rowIndex].enabled = value
            fireTableCellUpdated(rowIndex, columnIndex)
        }
    }

    fun addPack(pack: WeirpackSetting) {
        val index = packs.size
        packs += pack.copy()
        fireTableRowsInserted(index, index)
    }

    fun removePack(index: Int) {
        packs.removeAt(index)
        fireTableRowsDeleted(index, index)
    }

    fun replacePacks(replacement: Iterable<WeirpackSetting>) {
        packs.clear()
        packs += replacement.map(WeirpackSetting::copy)
        fireTableDataChanged()
    }

    private fun decodedSize(data: String): String =
        runCatching { Base64.getDecoder().decode(data).size }
            .fold(
                onSuccess = { bytes ->
                    if (bytes < 1024) "$bytes B" else String.format("%.1f KB", bytes / 1024.0)
                },
                onFailure = { "Invalid" },
            )
}
