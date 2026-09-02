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

    fun testParseAcceptsOnlyTwoNonNegativeIntegers() {
        assertEquals(MilkJEditorState(0, 0), MilkJEditorState.parse("0:0"))
        assertEquals(MilkJEditorState(7, 900), MilkJEditorState.parse("7:900"))
        listOf("", "7", "7:", ":9", "-1:0", "0:-1", "1:2:3", "1.0:2", "a:b", " 1:2").forEach {
            assertNull("'$it' must be rejected", MilkJEditorState.parse(it))
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
