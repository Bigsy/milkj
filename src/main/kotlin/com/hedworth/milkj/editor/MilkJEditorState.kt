package com.hedworth.milkj.editor

import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.FileEditorStateLevel
import org.jdom.Element
import kotlin.math.abs

/**
 * What the platform remembers about a MilkJ tab between openings: the ProseMirror selection anchor
 * and the page's scroll offset. The page reports it in `viewState` messages and takes it back in
 * `setViewState` ones (see BridgeProtocol.kt).
 */
data class MilkJEditorState(
    val anchor: Int,
    val scrollTop: Int,
) : FileEditorState {

    /**
     * Navigation history (Back / Forward) only records a new place when the caret moved a fair
     * distance, like the text editor does with its line-based threshold; every other level merges.
     */
    override fun canBeMergedWith(otherState: FileEditorState, level: FileEditorStateLevel): Boolean =
        otherState is MilkJEditorState &&
            (level != FileEditorStateLevel.NAVIGATION || abs(anchor - otherState.anchor) < NAVIGATION_MERGE_DISTANCE)

    fun write(element: Element) {
        element.setAttribute(ANCHOR_ATTRIBUTE, anchor.toString())
        element.setAttribute(SCROLL_TOP_ATTRIBUTE, scrollTop.toString())
    }

    companion object {
        private const val NAVIGATION_MERGE_DISTANCE = 500
        private const val ANCHOR_ATTRIBUTE = "anchor"
        private const val SCROLL_TOP_ATTRIBUTE = "scroll-top"

        fun read(element: Element): MilkJEditorState? {
            val anchor = element.getAttributeValue(ANCHOR_ATTRIBUTE)?.toIntOrNull()?.takeIf { it >= 0 } ?: return null
            val scrollTop = element.getAttributeValue(SCROLL_TOP_ATTRIBUTE)?.toIntOrNull()?.takeIf { it >= 0 } ?: return null
            return MilkJEditorState(anchor, scrollTop)
        }
    }
}
