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
        settingsState = state
    }

    fun setTheme(theme: ThemeMode) {
        if (settingsState.theme == theme) {
            return
        }
        settingsState.theme = theme
        notifyChanged()
    }

    fun update(newState: State) {
        settingsState = newState.copy()
        notifyChanged()
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

        fun copy(): State =
            State().also {
                it.theme = theme
                it.editorTheme = editorTheme
                it.mermaidTheme = mermaidTheme
                it.defaultEditor = defaultEditor
                it.placeholderText = placeholderText
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

    interface Listener {
        fun settingsChanged()
    }

    companion object {
        val TOPIC: Topic<Listener> = Topic.create("MilkJ settings", Listener::class.java)

        fun getInstance(): MilkJSettings =
            ApplicationManager.getApplication().getService(MilkJSettings::class.java)
    }
}
