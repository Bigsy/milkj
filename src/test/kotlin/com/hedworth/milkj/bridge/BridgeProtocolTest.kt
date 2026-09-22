package com.hedworth.milkj.bridge

import com.hedworth.milkj.settings.MilkJSettings
import com.hedworth.milkj.settings.WeirpackSetting
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Checks BridgeProtocol.kt against protocol/fixtures.json, the contract the frontend's
 * protocol.test.ts checks protocol.ts against as well.
 */
class BridgeProtocolTest {
    private val fixtures: JsonObject =
        Json.parseToJsonElement(Files.readString(Path.of("protocol", "fixtures.json"))).jsonObject
    private val pageFixtures = fixtures.getValue("page").jsonObject
    private val ideFixtures = fixtures.getValue("ide").jsonObject

    /** Exhaustive, so a new message type does not compile until it has a fixture. */
    private fun fixtureKey(message: PageMessage): String = when (message) {
        PageMessage.Ready -> "ready"
        is PageMessage.Markdown -> "markdown"
        is PageMessage.RoundTripError -> "roundtripError"
        is PageMessage.DictionaryAdd -> "dictionaryAdd"
        is PageMessage.NavigateFile -> "navigateFile"
        is PageMessage.NavigateUrl -> "navigateUrl"
        is PageMessage.ImageUpload -> "imageUpload"
        is PageMessage.ViewState -> "viewState"
        is PageMessage.Zoom -> "zoom"
    }

    private fun fixtureKey(message: IdeMessage): String = when (message) {
        is IdeMessage.SetMarkdown -> "setMarkdown"
        is IdeMessage.ApplyConfig -> "applyConfig"
        is IdeMessage.SetViewState -> "setViewState"
        is IdeMessage.ImageUploaded -> "imageUploaded"
    }

    private val expectedPageMessages = listOf(
        PageMessage.Ready,
        PageMessage.Markdown(7, "# Title\r\n\r\nQuote \" backslash \\ tab \t and Ångström 🎉\n"),
        PageMessage.RoundTripError("The merged Markdown was not equivalent to the rich-text document."),
        PageMessage.DictionaryAdd("C++"),
        PageMessage.NavigateFile("src/main/kotlin/Foo.kt#L2-L5"),
        PageMessage.NavigateUrl("https://example.com/docs?q=a+b#top"),
        PageMessage.ImageUpload("req-1", "my shot.png", "image/png", "iVBORw=="),
        PageMessage.ViewState(42, 1200),
        PageMessage.Zoom("in"),
    )

    private val ideMessages = listOf(
        IdeMessage.SetMarkdown("# Title\r\n\r\nQuote \" backslash \\ and </script> 🎉\n", 8),
        IdeMessage.ApplyConfig(
            FrontendConfig.from(
                MilkJSettings.State().apply {
                    theme = MilkJSettings.ThemeMode.FOLLOW_IDE
                    editorTheme = MilkJSettings.EditorTheme.FRAME
                    mermaidTheme = MilkJSettings.MermaidTheme.FOREST
                    defaultEditor = MilkJSettings.DefaultEditorMode.MILKJ
                    placeholderText = "Say \"hi\"\nthen \\ write"
                    textFontFamily = "Fira Sans"
                    codeFontFamily = "JetBrains Mono"
                    proofingDialect = MilkJSettings.ProofingDialect.AMERICAN
                    customDictionary = mutableListOf("Ångström", "C++", "two words")
                    weirpacks = mutableListOf(
                        WeirpackSetting().apply { data = "YWJj" },
                        WeirpackSetting().apply {
                            enabled = false
                            data = "ZGVm"
                        },
                    )
                },
                readonly = false,
                localImageBaseUrl = "http://milkj.localhost/local-image/token/",
                ideIsDark = true,
            ),
        ),
        IdeMessage.SetViewState(42, 1200),
        IdeMessage.ImageUploaded("req-1", "images/my-shot.png"),
    )

    @Test
    fun everyPageMessageTypeHasAFixtureOfThatType() {
        assertEquals(PageMessage.TYPES, pageFixtures.keys)
        assertEquals(PageMessage.TYPES, expectedPageMessages.map(::fixtureKey).toSet())
        pageFixtures.forEach { (key, fixture) ->
            assertEquals(key, fixture.jsonObject.getValue("type").jsonPrimitive.content)
        }
    }

    @Test
    fun pageFixturesDecodeToTheExpectedMessages() {
        expectedPageMessages.forEach { expected ->
            val fixture = pageFixtures.getValue(fixtureKey(expected))
            assertEquals(expected, PageMessage.decode(fixture.toString()))
        }
    }

    @Test
    fun ideMessagesEncodeExactlyToTheirFixtures() {
        assertEquals(ideFixtures.keys, ideMessages.map(::fixtureKey).toSet())
        ideMessages.forEach { message ->
            assertEquals(fixtureKey(message), ideFixtures.getValue(fixtureKey(message)), message.toJson())
        }
    }

    @Test
    fun ideMessagesAreDeliveredThroughTheSingleReceiveEntryPoint() {
        val message = IdeMessage.ImageUploaded("r", null)
        assertEquals(
            """window.milkjReceive?.({"type":"imageUploaded","requestId":"r","path":null});""",
            message.toScript(),
        )
    }

    @Test
    fun configOmitsTheLocalImageEndpointWhenThereIsNone() {
        val config = FrontendConfig.from(MilkJSettings.State(), readonly = true, ideIsDark = false)
        val json = config.toJson()
        assertNull(json["localImageBaseUrl"])
        assertEquals("light", json.getValue("theme").jsonPrimitive.content)
        assertEquals("true", json.getValue("readonly").jsonPrimitive.content)
    }

    @Test
    fun malformedPageMessagesAreDropped() {
        listOf(
            "",
            "ready",
            "[]",
            "\"ready\"",
            "{}",
            """{"type":7}""",
            """{"type":"unknown"}""",
            """{"type":"markdown","revision":"7","markdown":"x"}""",
            """{"type":"markdown","revision":1.5,"markdown":"x"}""",
            """{"type":"markdown","revision":7}""",
            """{"type":"markdown","revision":7,"markdown":null}""",
            """{"type":"viewState","anchor":-1,"scrollTop":0}""",
            """{"type":"viewState","anchor":1,"scrollTop":2.5}""",
            """{"type":"viewState","anchor":"1","scrollTop":2}""",
            """{"type":"viewState","anchor":1}""",
            """{"type":"navigateFile","href":""}""",
            """{"type":"navigateFile","href":"   "}""",
            """{"type":"navigateFile","href":"a\u0000b.kt"}""",
            """{"type":"navigateUrl","href":"${"a".repeat(PageMessage.MAX_NAVIGATION_TARGET_CHARS + 1)}"}""",
            """{"type":"imageUpload","requestId":"r","fileName":"a.png","mimeType":"image/png"}""",
            """{"type":"zoom","command":3}""",
            """{"type":"dictionaryAdd"}""",
        ).forEach { raw ->
            assertNull(raw, PageMessage.decode(raw))
        }
    }

    @Test
    fun oversizedMessagesAreDroppedBeforeParsing() {
        val raw = """{"type":"markdown","revision":1,"markdown":"${"a".repeat(PageMessage.MAX_MESSAGE_CHARS)}"}"""
        assertNull(PageMessage.decode(raw))
    }
}
