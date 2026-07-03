package com.hedworth.milkj.editor

import com.hedworth.milkj.settings.MilkJSettings
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.jcef.JBCefApp

/**
 * Contributes the Milkdown WYSIWYG editor as an additional editor tab for Markdown files.
 *
 * IntelliJ shows one tab per [FileEditorProvider] that [accept]s a file (the tabs at the bottom of
 * the editor). [FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR] keeps the platform's native Markdown
 * editor as the default and adds "MilkJ" beside it, so the user can switch between WYSIWYG and the
 * built-in source/preview editor.
 */
class MilkJEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean {
        // Without JCEF the editor would just be a dead tab with a fallback label — hide it entirely.
        return file.extension?.lowercase() in MARKDOWN_EXTENSIONS && JBCefApp.isSupported()
    }

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        MilkJEditor(project, file)

    override fun getEditorTypeId(): String = EDITOR_TYPE_ID

    override fun getPolicy(): FileEditorPolicy =
        when (MilkJSettings.getInstance().state.defaultEditor) {
            MilkJSettings.DefaultEditorMode.MILKJ -> FileEditorPolicy.PLACE_BEFORE_DEFAULT_EDITOR
            MilkJSettings.DefaultEditorMode.BUILT_IN -> FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR
        }

    companion object {
        const val EDITOR_TYPE_ID = "milkj-wysiwyg-editor"
        internal val MARKDOWN_EXTENSIONS = setOf("md", "markdown")
    }
}
