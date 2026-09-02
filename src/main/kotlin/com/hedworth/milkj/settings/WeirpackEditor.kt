package com.hedworth.milkj.settings

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.ui.HyperlinkLabel
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.table.JBTable
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.util.Base64
import javax.swing.Box
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.table.AbstractTableModel

/**
 * The Weirpack table, import button and status line from the MilkJ settings page.
 *
 * Like [DictionaryEditor], it owns its widgets and listeners so the settings page does not have to
 * track or unsubscribe them.
 */
internal class WeirpackEditor : JPanel(BorderLayout(0, 4)) {
    private val model = WeirpackTableModel()
    private val table = JBTable(model).apply {
        selectionModel.selectionMode = ListSelectionModel.SINGLE_SELECTION
        setShowGrid(false)
        emptyText.text = "No Weirpacks imported"
        columnModel.getColumn(0).apply {
            minWidth = 64
            maxWidth = 64
        }
        columnModel.getColumn(2).apply {
            minWidth = 70
            maxWidth = 70
        }
    }
    private val importButton = JButton("Import…")
    private val removeButton = JButton("Remove Selected").apply { isEnabled = false }
    private val statusLabel = JBLabel()

    init {
        importButton.addActionListener { importPack() }
        removeButton.addActionListener {
            val selected = table.selectedRow
            if (selected >= 0) {
                model.removePack(table.convertRowIndexToModel(selected))
                updateButtons()
                showStatus(null, error = false)
            }
        }
        table.selectionModel.addListSelectionListener { updateButtons() }

        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            add(importButton)
            add(Box.createHorizontalStrut(6))
            add(removeButton)
        }
        val help = JPanel(BorderLayout(0, 2)).apply {
            add(
                JBLabel("Import ZIP-based .weirpack archives containing custom Harper rules or dictionaries."),
                BorderLayout.NORTH,
            )
            add(
                HyperlinkLabel("Create your own with Weirsmith").apply {
                    setHyperlinkTarget(WEIRSMITH_URL)
                },
                BorderLayout.WEST,
            )
        }
        add(JBScrollPane(table).apply { preferredSize = Dimension(360, 90) }, BorderLayout.CENTER)
        add(
            JPanel(BorderLayout(0, 4)).apply {
                add(buttons, BorderLayout.NORTH)
                add(help, BorderLayout.CENTER)
                add(statusLabel, BorderLayout.SOUTH)
            },
            BorderLayout.SOUTH,
        )
    }

    /** The packs currently listed, normalized the same way the persisted state is. */
    fun packs(): MutableList<WeirpackSetting> = normalizeWeirpacks(model.packs)

    fun snapshots(): List<WeirpackSnapshot> =
        packs().map { WeirpackSnapshot(it.name, it.enabled, it.data) }

    /** Hides whatever the last import or failure left on the status line. */
    fun clearStatus() {
        showStatus(null, error = false)
    }

    fun replacePacks(packs: Iterable<WeirpackSetting>) {
        model.replacePacks(normalizeWeirpacks(packs))
        updateButtons()
    }

    private fun importPack() {
        val descriptor = FileChooserDescriptor(true, false, false, false, false, false)
            .withTitle("Import Harper Weirpack")
            .withDescription("Choose a .weirpack archive containing custom Weir rules")
            .withFileFilter { file ->
                file.isDirectory || file.extension.equals("weirpack", ignoreCase = true)
            }
        val file = FileChooser.chooseFile(descriptor, null, null) ?: return
        if (file.length > MAX_WEIRPACK_FILE_BYTES) {
            showStatus("Weirpacks must be smaller than 10 MB.", error = true)
            return
        }

        val bytes = try {
            file.contentsToByteArray()
        } catch (exception: Exception) {
            showStatus(
                "Could not read ${file.name}: ${exception.message ?: "unknown error"}.",
                error = true,
            )
            return
        }
        if (bytes.size > MAX_WEIRPACK_FILE_BYTES) {
            showStatus("Weirpacks must be smaller than 10 MB.", error = true)
            return
        }
        val validationError = validateWeirpack(bytes)
        if (validationError != null) {
            showStatus(validationError, error = true)
            return
        }

        val name = uniqueName(file.nameWithoutExtension.ifBlank { file.name })
        model.addPack(
            WeirpackSetting().also {
                it.name = name
                it.data = Base64.getEncoder().encodeToString(bytes)
            },
        )
        val lastRow = model.rowCount - 1
        if (lastRow >= 0) {
            table.selectionModel.setSelectionInterval(lastRow, lastRow)
        }
        showStatus("Imported “$name” (${formatByteSize(bytes.size)}).", error = false)
    }

    private fun uniqueName(baseName: String): String {
        val names = packs().mapTo(mutableSetOf(), WeirpackSetting::name)
        if (baseName !in names) return baseName
        var suffix = 2
        while ("$baseName ($suffix)" in names) suffix++
        return "$baseName ($suffix)"
    }

    private fun updateButtons() {
        removeButton.isEnabled = table.selectedRow >= 0
    }

    private fun showStatus(message: String?, error: Boolean) {
        statusLabel.text = message.orEmpty()
        statusLabel.foreground = if (error) JBColor.RED else JBColor.foreground()
        statusLabel.isVisible = message != null
    }

    private companion object {
        const val MAX_WEIRPACK_FILE_BYTES = 10L * 1024L * 1024L
        const val WEIRSMITH_URL = "https://weirsmith.bigsy.uk"
    }
}

internal data class WeirpackSnapshot(
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
            .fold(onSuccess = ::formatByteSize, onFailure = { "Invalid" })
}

private fun formatByteSize(bytes: Int): String =
    if (bytes < 1024) "$bytes B" else String.format("%.1f KB", bytes / 1024.0)
