package com.hedworth.milkj.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.messages.Topic

@State(
    name = "MilkJSettings",
    storages = [Storage("milkj.xml")],
)
class MilkJSettings : PersistentStateComponent<MilkJSettings.State> {
    private var settingsState = State()

    override fun getState(): State = settingsState

    override fun loadState(state: State) {
        settingsState = state.copy().also {
            it.customDictionary = normalizeDictionary(it.customDictionary)
        }
    }

    fun update(newState: State) {
        settingsState = newState.copy().also {
            it.customDictionary = normalizeDictionary(it.customDictionary)
        }
        notifyChanged()
    }

    fun addDictionaryWord(rawWord: String): Boolean {
        val word = rawWord.trimDictionaryWhitespace()
        if (!isValidDictionaryWord(word) || word in settingsState.customDictionary) return false
        val next = settingsState.copy()
        next.customDictionary = normalizeDictionary(next.customDictionary + word)
        settingsState = next
        notifyChanged()
        return true
    }

    private fun notifyChanged() {
        ApplicationManager.getApplication()
            .messageBus
            .syncPublisher(TOPIC)
            .settingsChanged()
    }

    class State {
        var theme: ThemeMode = ThemeMode.FOLLOW_IDE
        var editorTheme: EditorTheme = EditorTheme.NORD
        var mermaidTheme: MermaidTheme = MermaidTheme.AUTO
        var defaultEditor: DefaultEditorMode = DefaultEditorMode.BUILT_IN
        var placeholderText: String = "Start writing..."
        var showShortcutsTab: Boolean = true
        var spellcheckEnabled: Boolean = true
        var proofingDialect: ProofingDialect = ProofingDialect.AUTO
        var customDictionary: MutableList<String> = mutableListOf()

        fun copy(): State =
            State().also {
                it.theme = theme
                it.editorTheme = editorTheme
                it.mermaidTheme = mermaidTheme
                it.defaultEditor = defaultEditor
                it.placeholderText = placeholderText
                it.showShortcutsTab = showShortcutsTab
                it.spellcheckEnabled = spellcheckEnabled
                it.proofingDialect = proofingDialect
                it.customDictionary = customDictionary.toMutableList()
            }
    }

    enum class ThemeMode(private val label: String) {
        FOLLOW_IDE("Follow IDE"),
        LIGHT("Light"),
        DARK("Dark");

        override fun toString(): String = label
    }

    enum class EditorTheme(private val label: String) {
        NORD("Nord"),
        CLASSIC("Classic"),
        FRAME("Frame");

        override fun toString(): String = label
    }

    enum class MermaidTheme(private val label: String) {
        AUTO("Auto"),
        DEFAULT("Default"),
        DARK("Dark"),
        FOREST("Forest"),
        NEUTRAL("Neutral"),
        BASE("Base");

        override fun toString(): String = label
    }

    enum class DefaultEditorMode(private val label: String) {
        BUILT_IN("Built-in editor"),
        MILKJ("MilkJ");

        override fun toString(): String = label
    }

    enum class ProofingDialect(private val label: String) {
        AUTO("Auto"),
        AMERICAN("American English"),
        BRITISH("British English"),
        AUSTRALIAN("Australian English"),
        CANADIAN("Canadian English"),
        INDIAN("Indian English");

        override fun toString(): String = label
    }

    interface Listener {
        fun settingsChanged()
    }

    companion object {
        internal const val MAX_DICTIONARY_WORD_LENGTH = 64

        val TOPIC: Topic<Listener> = Topic.create("MilkJ settings", Listener::class.java)

        fun getInstance(): MilkJSettings =
            ApplicationManager.getApplication().getService(MilkJSettings::class.java)
    }
}

internal fun isValidDictionaryWord(word: String): Boolean =
    word.isNotEmpty() &&
        word.length <= MilkJSettings.MAX_DICTIONARY_WORD_LENGTH &&
        word.none { it.isWhitespace() || it == '\uFEFF' } &&
        word.codePoints().anyMatch(Character::isLetterOrDigit)

internal fun normalizeDictionary(values: Iterable<String>): MutableList<String> =
    values
        .map(String::trimDictionaryWhitespace)
        .filter(::isValidDictionaryWord)
        .distinct()
        .sorted()
        .toMutableList()

private fun String.trimDictionaryWhitespace(): String =
    trim { it.isWhitespace() || it == '\uFEFF' }
