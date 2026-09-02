package com.hedworth.milkj.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.Cell
import com.intellij.ui.dsl.builder.Row
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.selected
import javax.swing.JComponent

/** Settings | Tools | MilkJ. */
class MilkJConfigurable : Configurable {
    private val settings: MilkJSettings = MilkJSettings.getInstance()

    /**
     * Edits land here first and [apply] is what pushes them into [MilkJSettings]. The bindings read
     * and write it through lambdas rather than property references, so [reset] can swap in a fresh
     * copy of the persisted state without leaving the components bound to the old one.
     */
    private var workingState: MilkJSettings.State = settings.state.copy()
    private var dialogPanel: DialogPanel? = null
    private var dictionaryEditor: DictionaryEditor? = null
    private var dictionaryBaseline: List<String> = emptyList()
    private var weirpackEditor: WeirpackEditor? = null
    private var weirpackBaseline: List<WeirpackSnapshot> = emptyList()

    override fun getDisplayName(): String = "MilkJ"

    override fun createComponent(): JComponent {
        val dictionary = DictionaryEditor().also { dictionaryEditor = it }
        val weirpacks = WeirpackEditor().also { weirpackEditor = it }
        val created = panel {
            row("Theme mode:") {
                enumComboBox(
                    MilkJSettings.ThemeMode.entries,
                    { workingState.theme },
                    { workingState.theme = it },
                )
            }
            row("Editor theme:") {
                enumComboBox(
                    MilkJSettings.EditorTheme.entries,
                    { workingState.editorTheme },
                    { workingState.editorTheme = it },
                )
            }
            row("Mermaid theme:") {
                enumComboBox(
                    MilkJSettings.MermaidTheme.entries,
                    { workingState.mermaidTheme },
                    { workingState.mermaidTheme = it },
                )
            }
            row("Default editor for Markdown:") {
                enumComboBox(
                    MilkJSettings.DefaultEditorMode.entries,
                    { workingState.defaultEditor },
                    { workingState.defaultEditor = it },
                )
            }
            row("Placeholder text:") {
                textField()
                    .bindText({ workingState.placeholderText }, { workingState.placeholderText = it })
                    .align(AlignX.FILL)
                    .resizableColumn()
            }
            row("Pasted image folder:") {
                textField()
                    .bindText(
                        { workingState.imageUploadDirectory },
                        { workingState.imageUploadDirectory = it.trim() },
                    )
                    .align(AlignX.FILL)
                    .resizableColumn()
                    .comment(
                        "Where pasted and dropped images are saved, relative to the Markdown " +
                            "file. Leave blank to use the file's own folder.",
                    )
            }
            row {
                checkBox("Show the Shortcuts reference tab for Markdown files")
                    .bindSelected({ workingState.showShortcutsTab }, { workingState.showShortcutsTab = it })
            }
            lateinit var spellcheck: Cell<JBCheckBox>
            row {
                spellcheck = checkBox("Enable Harper spell checking")
                    .bindSelected({ workingState.spellcheckEnabled }, { workingState.spellcheckEnabled = it })
            }
            row("Proofreading dialect:") {
                enumComboBox(
                    MilkJSettings.ProofingDialect.entries,
                    { workingState.proofingDialect },
                    { workingState.proofingDialect = it },
                ).enabledIf(spellcheck.selected)
            }
            row("Custom dictionary:") {
                cell(dictionary).align(AlignX.FILL).resizableColumn()
            }
            row("Weirpacks:") {
                cell(weirpacks).align(AlignX.FILL).resizableColumn()
            }
        }
        dialogPanel = created
        reset()
        return created
    }

    override fun isModified(): Boolean =
        dialogPanel?.isModified() == true ||
            dictionaryEditor?.words.orEmpty() != dictionaryBaseline ||
            weirpackEditor?.snapshots().orEmpty() != weirpackBaseline

    override fun apply() {
        dialogPanel?.apply()
        val localWords = dictionaryEditor?.words.orEmpty()
        val additions = localWords.toSet() - dictionaryBaseline.toSet()
        val removals = dictionaryBaseline.toSet() - localWords.toSet()
        // Only the words this page added or removed are merged, so a word the editor's own
        // "Add to dictionary" action stored while Settings was open is not thrown away.
        workingState.customDictionary = normalizeDictionary(
            settings.state.customDictionary.filterNot { it in removals } + additions,
        )
        workingState.weirpacks = weirpackEditor?.packs() ?: mutableListOf()
        settings.update(workingState)
        adoptPersistedState()
    }

    override fun reset() {
        adoptPersistedState()
        // Only a real reset throws away what the user was in the middle of; Apply leaves the
        // "Imported ..." line and a half-typed dictionary word where they are.
        dictionaryEditor?.clearInput()
        weirpackEditor?.clearStatus()
    }

    /**
     * Reloads the panel from what [MilkJSettings] actually holds, which is not always what was
     * handed to it: `update` normalizes the dictionary and the Weirpack list, and re-reading also
     * puts the trimmed image folder back in the text field and clears the panel's modified flag.
     */
    private fun adoptPersistedState() {
        workingState = settings.state.copy()
        dialogPanel?.reset()
        dictionaryEditor?.replaceWords(workingState.customDictionary)
        dictionaryBaseline = dictionaryEditor?.words.orEmpty()
        weirpackEditor?.replacePacks(workingState.weirpacks)
        weirpackBaseline = weirpackEditor?.snapshots().orEmpty()
    }

    override fun disposeUIResources() {
        // Dropping the working copy matters for the Weirpacks: it holds the base64 of any pack the
        // user removed, which nothing else references once the dialog is gone.
        workingState = MilkJSettings.State()
        dialogPanel = null
        dictionaryEditor = null
        dictionaryBaseline = emptyList()
        weirpackEditor = null
        weirpackBaseline = emptyList()
    }
}

/**
 * A combo box over an enum whose `toString` is already the display label. A null selection is
 * impossible for these models, so it is treated as "leave the value alone".
 */
private fun <T : Any> Row.enumComboBox(
    values: List<T>,
    get: () -> T,
    set: (T) -> Unit,
): Cell<ComboBox<T>> =
    comboBox(values).bindItem(get, { set(it ?: get()) })
