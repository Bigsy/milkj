package com.hedworth.milkj.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.xmlb.XmlSerializer
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

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
        val state = MilkJSettings.State().apply {
            customDictionary = mutableListOf("MilkJ")
            weirpacks = mutableListOf(WeirpackSetting().apply {
                name = "House style"
                data = "YWJj"
            })
        }
        val copy = state.copy()
        state.customDictionary += "Proofly"
        state.weirpacks.single().name = "Changed"
        assertEquals(listOf("MilkJ"), copy.customDictionary)
        assertEquals("House style", copy.weirpacks.single().name)
    }

    fun testZoomPercentDefaultsCopiesAndClampsOnLoad() {
        assertEquals(100, settings.state.zoomPercent)
        assertEquals(175, MilkJSettings.State().apply { zoomPercent = 175 }.copy().zoomPercent)

        settings.loadState(MilkJSettings.State().apply { zoomPercent = 7 })
        assertEquals(50, settings.state.zoomPercent)
        settings.update(settings.state.copy().apply { zoomPercent = 9000 })
        assertEquals(300, settings.state.zoomPercent)
    }

    fun testZoomLadderStepsFromInBetweenValues() {
        assertEquals(100, ZoomLevels.zoomIn(95))
        assertEquals(90, ZoomLevels.zoomOut(95))
        assertEquals(67, ZoomLevels.zoomIn(50))
        assertEquals(300, ZoomLevels.zoomIn(300))
        assertEquals(50, ZoomLevels.zoomOut(50))
        assertEquals(100, ZoomLevels.apply("reset", 250))
        assertNull(ZoomLevels.apply("bigger", 100))
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

    fun testWeirpacksAreNormalizedAndOnlyEnabledDataIsExposed() {
        settings.loadState(MilkJSettings.State().apply {
            weirpacks = mutableListOf(
                WeirpackSetting().apply {
                    name = " House style "
                    data = " YWJj "
                },
                WeirpackSetting().apply {
                    name = "Disabled"
                    enabled = false
                    data = "ZGVm"
                },
                WeirpackSetting().apply {
                    name = "Empty"
                    data = "  "
                },
            )
        })

        assertEquals(listOf("House style", "Disabled"), settings.state.weirpacks.map(WeirpackSetting::name))
        assertEquals(listOf("YWJj"), enabledWeirpacks(settings.state))
    }

    fun testWeirpackSettingsRoundTripThroughIntellijXmlSerialization() {
        val state = MilkJSettings.State().apply {
            weirpacks = mutableListOf(WeirpackSetting().apply {
                name = "House style"
                enabled = false
                data = "UEsDBAoAAAAA"
            })
        }

        val restored = XmlSerializer.deserialize(
            XmlSerializer.serialize(state),
            MilkJSettings.State::class.java,
        )

        assertEquals("House style", restored.weirpacks.single().name)
        assertFalse(restored.weirpacks.single().enabled)
        assertEquals("UEsDBAoAAAAA", restored.weirpacks.single().data)
    }

    fun testValidWeirpackRequiresManifestAndPayload() {
        val manifest = """{"author":"MilkJ","version":"1","description":"Test","license":"MIT"}"""
        assertNull(validateWeirpack(zip(
            "manifest.json" to manifest,
            "HouseStyle.weir" to "expr main teh",
        )))
        // harper-core accepts rules nested in subdirectories.
        assertNull(validateWeirpack(zip(
            "manifest.json" to manifest,
            "rules/HouseStyle.weir" to "expr main teh",
        )))
        // Dictionary-only packs (e.g. from weirsmith) are valid without any rules.
        assertNull(validateWeirpack(zip(
            "manifest.json" to manifest,
            "annotations.json" to """{"affixes":{},"properties":{}}""",
            "dictionary.dict" to "1\nmilkj\n",
        )))
        assertEquals(
            "The Weirpack is missing manifest.json at its root.",
            validateWeirpack(zip("HouseStyle.weir" to "expr main teh")),
        )
        assertEquals(
            "The Weirpack contains no .weir rules and no dictionary.dict.",
            validateWeirpack(zip("manifest.json" to "{}")),
        )
    }

    fun testInvalidWeirpackArchiveIsRejected() {
        assertEquals(
            "The file is not a valid ZIP-based Weirpack.",
            validateWeirpack("not a zip".toByteArray()),
        )
    }

    private fun zip(vararg entries: Pair<String, String>): ByteArray {
        val bytes = ByteArrayOutputStream()
        ZipOutputStream(bytes).use { archive ->
            entries.forEach { (name, contents) ->
                archive.putNextEntry(ZipEntry(name))
                archive.write(contents.toByteArray())
                archive.closeEntry()
            }
        }
        return bytes.toByteArray()
    }
}
