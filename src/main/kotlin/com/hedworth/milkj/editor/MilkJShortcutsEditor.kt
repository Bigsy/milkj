package com.hedworth.milkj.editor

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.HTMLEditorKitBuilder
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.JEditorPane

/**
 * A read-only "Shortcuts" reference tab shown next to the MilkJ editor. Plain Swing (no JCEF), so
 * it costs nothing per open file. The listed bindings mirror the Milkdown/Crepe defaults bundled
 * in the frontend plus MilkJ's own find bar — update this table when the frontend keymaps change.
 */
class MilkJShortcutsEditor(
    private val file: VirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val component: JComponent = JBScrollPane(
        JEditorPane().apply {
            isEditable = false
            editorKit = HTMLEditorKitBuilder.simple()
            text = buildShortcutsHtml()
            caretPosition = 0
            border = JBUI.Borders.empty(16, 24)
            background = UIUtil.getPanelBackground()
        },
    )

    override fun getComponent(): JComponent = component

    override fun getPreferredFocusedComponent(): JComponent = component

    override fun getName(): String = "Shortcuts"

    override fun getFile(): VirtualFile = file

    override fun setState(state: FileEditorState) {}

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = file.isValid

    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun dispose() {}

    private fun buildShortcutsHtml(): String {
        val mod = if (SystemInfo.isMac) "Cmd" else "Ctrl"
        val alt = if (SystemInfo.isMac) "Option" else "Alt"
        val redo = if (SystemInfo.isMac) "Shift+Cmd+Z" else "Ctrl+Y or Shift+Ctrl+Z"

        fun section(title: String, rows: List<Pair<String, String>>): String =
            "<h3>$title</h3><table cellpadding='3' cellspacing='0'>" +
                rows.joinToString("") { (keys, action) ->
                    "<tr><td width='220'><b>$keys</b></td><td>$action</td></tr>"
                } +
                "</table>"

        return "<html><body>" +
            "<h2>MilkJ editor shortcuts</h2>" +
            section(
                "Find and replace",
                listOf(
                    "$mod+F" to "Open find bar (prefilled from selection)",
                    "Enter / Shift+Enter" to "Next / previous match (in the find field)",
                    "$mod+G / Shift+$mod+G" to "Next / previous match",
                    "F3 / Shift+F3" to "Next / previous match",
                    "Escape" to "Close the find bar",
                ),
            ) +
            section(
                "Formatting",
                listOf(
                    "$mod+B" to "Bold",
                    "$mod+I" to "Italic",
                    "$mod+E" to "Inline code",
                    "$mod+$alt+X" to "Strikethrough",
                ),
            ) +
            section(
                "Blocks",
                listOf(
                    "$mod+$alt+1 … 6" to "Heading 1–6",
                    "$mod+$alt+0" to "Plain paragraph",
                    "$mod+Shift+B" to "Blockquote",
                    "$mod+$alt+C" to "Code block",
                    "$mod+$alt+7" to "Ordered list",
                    "$mod+$alt+8" to "Bullet list",
                    "Shift+Enter" to "Hard line break",
                ),
            ) +
            section(
                "Lists and tables",
                listOf(
                    "Tab / $mod+]" to "Indent list item; next table cell",
                    "Shift+Tab / $mod+[" to "Outdent list item; previous table cell",
                    "$mod+Enter" to "Exit the table",
                ),
            ) +
            section(
                "History",
                listOf(
                    "$mod+Z" to "Undo",
                    redo to "Redo",
                ),
            ) +
            section(
                "As-you-type",
                listOf(
                    "/" to "Open the insert menu (headings, lists, tables, images…)",
                    "# + space" to "Heading (## for level 2, …)",
                    "- + space" to "Bullet list",
                    "1. + space" to "Ordered list",
                    "&gt; + space" to "Blockquote",
                    "``` " to "Code fence",
                    "**text**" to "Bold",
                    "*text*" to "Italic",
                    "`text`" to "Inline code",
                    "---" to "Divider",
                ),
            ) +
            "<p>Select text to show the formatting toolbar. " +
            "This tab can be hidden in Settings → Tools → MilkJ.</p>" +
            "</body></html>"
    }
}
