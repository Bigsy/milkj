package com.hedworth.milkj.settings

import com.intellij.openapi.ui.Messages
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.Box
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.ListSelectionModel

/**
 * The custom dictionary list, add field and validation message from the MilkJ settings page.
 *
 * Owning its own widgets and listeners is the point: the component is discarded with the settings
 * panel, so nothing has to be unsubscribed by hand.
 */
internal class DictionaryEditor : JPanel(BorderLayout(0, 6)) {
    private val model = DefaultListModel<String>()
    private val list = JBList(model).apply {
        selectionMode = ListSelectionModel.MULTIPLE_INTERVAL_SELECTION
        visibleRowCount = 5
    }
    private val field = JBTextField()
    private val addButton = JButton("Add")
    private val removeButton = JButton("Remove Selected").apply { isEnabled = false }
    private val clearButton = JButton("Clear").apply { isEnabled = false }
    private val validationLabel = JBLabel().apply { foreground = JBColor.RED }

    /** The words currently listed, already normalized by [replaceWords]. */
    val words: List<String>
        get() = (0 until model.size()).map(model::getElementAt)

    init {
        addButton.addActionListener { addWordFromField() }
        field.addActionListener { addWordFromField() }
        removeButton.addActionListener {
            list.selectedIndices.sortedDescending().forEach(model::remove)
            updateButtons()
            showValidation(null)
        }
        clearButton.addActionListener { clearWithConfirmation() }
        list.addListSelectionListener { updateButtons() }

        val inputPanel = JPanel(BorderLayout(6, 0)).apply {
            add(field, BorderLayout.CENTER)
            add(addButton, BorderLayout.EAST)
        }
        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            add(removeButton)
            add(Box.createHorizontalStrut(6))
            add(clearButton)
        }
        add(JBScrollPane(list).apply { preferredSize = Dimension(360, 110) }, BorderLayout.CENTER)
        add(
            JPanel(BorderLayout(0, 4)).apply {
                add(inputPanel, BorderLayout.NORTH)
                add(buttons, BorderLayout.CENTER)
                add(validationLabel, BorderLayout.SOUTH)
            },
            BorderLayout.SOUTH,
        )
    }

    /** Discards a half-typed word and its validation message. */
    fun clearInput() {
        field.text = ""
        showValidation(null)
    }

    fun replaceWords(words: Iterable<String>) {
        model.clear()
        normalizeDictionary(words).forEach(model::addElement)
        updateButtons()
    }

    private fun addWordFromField() {
        val word = field.text.orEmpty().trim { it.isWhitespace() || it == '\uFEFF' }
        val message = when {
            word.isEmpty() -> "Enter a word."
            word.length > MilkJSettings.MAX_DICTIONARY_WORD_LENGTH -> "Words must be 64 characters or fewer."
            word.any { it.isWhitespace() || it == '\uFEFF' } -> "Dictionary words cannot contain whitespace."
            !word.codePoints().anyMatch(Character::isLetterOrDigit) -> "Include at least one letter or number."
            else -> null
        }
        if (message != null) {
            showValidation(message)
            return
        }
        replaceWords(words + word)
        list.setSelectedValue(word, true)
        field.text = ""
        showValidation(null)
    }

    private fun clearWithConfirmation() {
        if (model.isEmpty) return
        val confirmed = Messages.showYesNoDialog(
            this,
            "Remove every word from the MilkJ custom dictionary?",
            "Clear Custom Dictionary",
            Messages.getQuestionIcon(),
        ) == Messages.YES
        if (!confirmed) return
        model.clear()
        updateButtons()
        showValidation(null)
    }

    private fun updateButtons() {
        removeButton.isEnabled = !list.isSelectionEmpty
        clearButton.isEnabled = !model.isEmpty
    }

    private fun showValidation(message: String?) {
        validationLabel.text = message.orEmpty()
        validationLabel.isVisible = message != null
    }
}
