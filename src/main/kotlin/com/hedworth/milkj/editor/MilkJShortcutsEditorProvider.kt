package com.hedworth.milkj.editor

import com.hedworth.milkj.settings.MilkJSettings
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Contributes the "Shortcuts" reference tab next to the MilkJ editor for Markdown files.
 *
 * On by default; Settings → Tools → MilkJ has a checkbox to hide it. The setting is checked in
 * [accept], so toggling it affects files opened afterwards — already-open tabs keep their editors
 * until reopened.
 */
class MilkJShortcutsEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean =
        file.extension?.lowercase() in MilkJEditorProvider.MARKDOWN_EXTENSIONS &&
            MilkJSettings.getInstance().state.showShortcutsTab

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        MilkJShortcutsEditor(file)

    override fun getEditorTypeId(): String = EDITOR_TYPE_ID

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR

    companion object {
        const val EDITOR_TYPE_ID = "milkj-shortcuts"
    }
}
