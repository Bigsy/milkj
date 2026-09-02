package com.hedworth.milkj.editor

import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.FileEditorStateLevel
import org.jdom.Element
import kotlin.math.abs

/**
 * What the platform remembers about a MilkJ tab between openings: the ProseMirror selection anchor
 * and the page's scroll offset. The page reports it as `viewstate:<anchor>:<scrollTop>` and takes it
 * back through `window.milkjSetViewState(anchor, scrollTop)`.
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

        /** Parses the page's `<anchor>:<scrollTop>` payload; anything but two non-negative ints is dropped. */
        fun parse(payload: String): MilkJEditorState? {
            val parts = payload.split(':')
            if (parts.size != 2) return null
            val anchor = parts[0].toIntOrNull()?.takeIf { it >= 0 } ?: return null
            val scrollTop = parts[1].toIntOrNull()?.takeIf { it >= 0 } ?: return null
            return MilkJEditorState(anchor, scrollTop)
        }

        fun read(element: Element): MilkJEditorState? {
            val anchor = element.getAttributeValue(ANCHOR_ATTRIBUTE) ?: return null
            val scrollTop = element.getAttributeValue(SCROLL_TOP_ATTRIBUTE) ?: return null
            return parse("$anchor:$scrollTop")
        }
    }
}
