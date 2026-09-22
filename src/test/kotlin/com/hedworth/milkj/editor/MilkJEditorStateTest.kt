package com.hedworth.milkj.editor

import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.FileEditorStateLevel
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.jdom.Element

class MilkJEditorStateTest : BasePlatformTestCase() {

    private val provider = MilkJEditorProvider()

    fun testStateRoundTripsThroughTheProvidersWorkspaceSerialization() {
        val element = Element("state")
        val file = myFixture.configureByText("notes.md", "# Notes\n").virtualFile

        provider.writeState(MilkJEditorState(anchor = 128, scrollTop = 2048), project, element)

        assertEquals("128", element.getAttributeValue("anchor"))
        assertEquals("2048", element.getAttributeValue("scroll-top"))
        assertEquals(MilkJEditorState(128, 2048), provider.readState(element, project, file))
    }

    fun testMissingOrCorruptWorkspaceStateFallsBackToTheEmptyState() {
        val file = myFixture.configureByText("notes.md", "# Notes\n").virtualFile

        assertSame(FileEditorState.INSTANCE, provider.readState(Element("state"), project, file))
        val corrupt = Element("state").apply {
            setAttribute("anchor", "twelve")
            setAttribute("scroll-top", "0")
        }
        assertSame(FileEditorState.INSTANCE, provider.readState(corrupt, project, file))

        val untouched = Element("state")
        provider.writeState(FileEditorState.INSTANCE, project, untouched)
        assertTrue("a foreign state writes nothing", untouched.attributes.isEmpty())
    }

    fun testWorkspaceStateAcceptsOnlyTwoNonNegativeIntegers() {
        val file = myFixture.configureByText("notes.md", "# Notes\n").virtualFile
        fun read(anchor: String, scrollTop: String) = provider.readState(
            Element("state").apply {
                setAttribute("anchor", anchor)
                setAttribute("scroll-top", scrollTop)
            },
            project,
            file,
        )

        assertEquals(MilkJEditorState(0, 0), read("0", "0"))
        assertEquals(MilkJEditorState(7, 900), read("7", "900"))
        listOf("" to "0", "-1" to "0", "0" to "-1", "1.0" to "2", "a" to "b", " 1" to "2").forEach { (anchor, scrollTop) ->
            assertSame("'$anchor', '$scrollTop' must be rejected", FileEditorState.INSTANCE, read(anchor, scrollTop))
        }
    }

    fun testNavigationHistoryMergesNearbyPositionsOnly() {
        val here = MilkJEditorState(anchor = 1000, scrollTop = 0)
        assertTrue(here.canBeMergedWith(MilkJEditorState(1200, 5000), FileEditorStateLevel.NAVIGATION))
        assertFalse(here.canBeMergedWith(MilkJEditorState(2000, 0), FileEditorStateLevel.NAVIGATION))
        assertTrue(here.canBeMergedWith(MilkJEditorState(2000, 0), FileEditorStateLevel.FULL))
        assertTrue(here.canBeMergedWith(MilkJEditorState(2000, 0), FileEditorStateLevel.UNDO))
        assertFalse(here.canBeMergedWith(FileEditorState.INSTANCE, FileEditorStateLevel.FULL))
    }

    fun testMarkdownExtensionsCoverTheCommonVariants() {
        assertEquals(setOf("md", "markdown", "mdown", "mkd", "mkdn"), MilkJEditorProvider.MARKDOWN_EXTENSIONS)
    }
}
