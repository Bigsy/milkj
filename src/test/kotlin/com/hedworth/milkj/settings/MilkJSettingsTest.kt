package com.hedworth.milkj.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class MilkJSettingsTest : BasePlatformTestCase() {
    private lateinit var settings: MilkJSettings
    private lateinit var original: MilkJSettings.State

    override fun setUp() {
        super.setUp()
        settings = MilkJSettings.getInstance()
        original = settings.state.copy()
        settings.loadState(MilkJSettings.State())
    }

    override fun tearDown() {
        try {
            settings.loadState(original)
        } finally {
            super.tearDown()
        }
    }

    fun testDictionaryDefaultsEmptyAndCopyIsDefensive() {
        assertEmpty(settings.state.customDictionary)
        val state = MilkJSettings.State().apply { customDictionary = mutableListOf("MilkJ") }
        val copy = state.copy()
        state.customDictionary += "Proofly"
        assertEquals(listOf("MilkJ"), copy.customDictionary)
    }

    fun testLoadAndUpdateNormalizeDictionary() {
        settings.loadState(MilkJSettings.State().apply {
            customDictionary = mutableListOf(" zebra ", "Apple", "Apple", "two\u00a0words", "two\uFEFFwords", "---")
        })
        assertEquals(listOf("Apple", "zebra"), settings.state.customDictionary)

        settings.update(settings.state.copy().apply {
            customDictionary = mutableListOf("C++", "C#", " C++ ", "𐐀")
        })
        assertEquals(listOf("C#", "C++", "𐐀"), settings.state.customDictionary)
    }

    fun testAddDictionaryWordValidatesAndDeduplicates() {
        var notifications = 0
        ApplicationManager.getApplication().messageBus.connect(testRootDisposable).subscribe(
            MilkJSettings.TOPIC,
            object : MilkJSettings.Listener {
                override fun settingsChanged() {
                    notifications++
                }
            },
        )
        assertTrue(settings.addDictionaryWord(" Proofly "))
        assertEquals(listOf("Proofly"), settings.state.customDictionary)
        assertFalse(settings.addDictionaryWord("Proofly"))
        assertFalse(settings.addDictionaryWord("two words"))
        assertFalse(settings.addDictionaryWord("x".repeat(65)))
        assertEquals(listOf("Proofly"), settings.state.customDictionary)
        assertEquals(1, notifications)
    }
}
