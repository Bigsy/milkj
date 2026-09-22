package com.hedworth.milkj.bridge

import com.hedworth.milkj.navigation.hasIsoControlCharacters
import com.hedworth.milkj.settings.MilkJSettings
import com.hedworth.milkj.settings.enabledWeirpacks
import com.hedworth.milkj.settings.normalizeDictionary
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.add

/*
 * The wire protocol between the page (frontend/src/protocol.ts) and [MilkJBridge]. Every message in
 * either direction is one JSON object discriminated by its `type`:
 *  - page -> IDE: a JSON string through `window.milkjSendToIde`, decoded and validated by
 *    [PageMessage.decode] before the bridge acts on it;
 *  - IDE -> page: a JSON object literal handed to `window.milkjReceive`, built by [IdeMessage.toScript].
 *
 * Both sides ship in the same plugin build, so the protocol is not versioned. protocol/fixtures.json
 * holds one example of every message; the tests on each side check their own types against it, which
 * is what keeps the Kotlin and TypeScript definitions from drifting apart.
 *
 * JSON goes through the kotlinx.serialization element API the platform bundles, not the compiler
 * plugin: generated serializers would have to match the runtime of every supported IDE build.
 */

/** A message from the page. The page renders untrusted Markdown and HTML, so nothing here is trusted. */
internal sealed interface PageMessage {
    object Ready : PageMessage

    /** A user edit, based on the content the IDE pushed as [revision]. */
    data class Markdown(val revision: Long, val markdown: String) : PageMessage

    /** An edit that could not be merged onto the source safely was reverted on the page. */
    data class RoundTripError(val reason: String) : PageMessage

    data class DictionaryAdd(val word: String) : PageMessage

    /** Cmd/Ctrl-click on a project file link; [href] is exactly as written in the Markdown. */
    data class NavigateFile(val href: String) : PageMessage

    /** Cmd/Ctrl-click on a web link; the bridge still decides whether the scheme may be opened. */
    data class NavigateUrl(val href: String) : PageMessage

    /** A pasted or dropped image; [com.hedworth.milkj.images.ImageUploads.validate] checks the fields. */
    data class ImageUpload(
        val requestId: String,
        val fileName: String,
        val mimeType: String,
        val base64: String,
    ) : PageMessage

    data class ViewState(val anchor: Int, val scrollTop: Int) : PageMessage

    /** `in`, `out` or `reset`; the IDE owns the zoom level. */
    data class Zoom(val command: String) : PageMessage

    companion object {
        private val LOG = Logger.getInstance(PageMessage::class.java)

        /**
         * Checked before parsing. The largest legitimate message is an image upload (10 MB of image
         * as base64); Markdown documents are far smaller in practice.
         */
        const val MAX_MESSAGE_CHARS: Int = 32 * 1024 * 1024
        const val MAX_NAVIGATION_TARGET_CHARS: Int = 4 * 1024

        val TYPES: Set<String> = setOf(
            "ready",
            "markdown",
            "roundtripError",
            "dictionaryAdd",
            "navigateFile",
            "navigateUrl",
            "imageUpload",
            "viewState",
            "zoom",
        )

        /** Returns null (and logs why, never the content) for anything that is not a well-formed message. */
        fun decode(raw: String): PageMessage? {
            if (raw.length > MAX_MESSAGE_CHARS) {
                return drop("oversized message")
            }
            val message = runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonObject
                ?: return drop("not a JSON object")
            val type = message.string("type") ?: return drop("missing type")
            val decoded = when (type) {
                "ready" -> Ready
                "markdown" -> {
                    val revision = message.long("revision")
                    val markdown = message.string("markdown")
                    if (revision == null || markdown == null) null else Markdown(revision, markdown)
                }
                "roundtripError" -> message.string("reason")?.let(::RoundTripError)
                "dictionaryAdd" -> message.string("word")?.let(::DictionaryAdd)
                "navigateFile" -> message.navigationTarget("href")?.let(::NavigateFile)
                "navigateUrl" -> message.navigationTarget("href")?.let(::NavigateUrl)
                "imageUpload" -> {
                    val requestId = message.string("requestId")
                    val fileName = message.string("fileName")
                    val mimeType = message.string("mimeType")
                    val base64 = message.string("base64")
                    if (requestId == null || fileName == null || mimeType == null || base64 == null) {
                        null
                    } else {
                        ImageUpload(requestId, fileName, mimeType, base64)
                    }
                }
                "viewState" -> {
                    val anchor = message.nonNegativeInt("anchor")
                    val scrollTop = message.nonNegativeInt("scrollTop")
                    if (anchor == null || scrollTop == null) null else ViewState(anchor, scrollTop)
                }
                "zoom" -> message.string("command")?.let(::Zoom)
                else -> return drop("unknown type")
            }
            return decoded ?: drop("malformed $type message")
        }

        private fun drop(reason: String): PageMessage? {
            LOG.warn("Dropped MilkJ page message: $reason")
            return null
        }

        private fun JsonObject.primitive(key: String): JsonPrimitive? = this[key] as? JsonPrimitive

        private fun JsonObject.string(key: String): String? =
            primitive(key)?.takeIf { it.isString }?.content

        private fun JsonObject.long(key: String): Long? =
            primitive(key)?.takeUnless { it.isString }?.longOrNull

        private fun JsonObject.nonNegativeInt(key: String): Int? =
            primitive(key)?.takeUnless { it.isString }?.intOrNull?.takeIf { it >= 0 }

        private fun JsonObject.navigationTarget(key: String): String? =
            string(key)?.takeIf {
                it.isNotBlank() && it.length <= MAX_NAVIGATION_TARGET_CHARS && !it.hasIsoControlCharacters()
            }
    }
}

/** A message to the page. */
internal sealed interface IdeMessage {
    fun toJson(): JsonObject

    /** Script that delivers this message; a JSON object is also a valid JavaScript expression. */
    fun toScript(): String = "window.milkjReceive?.(${toJson()});"

    data class SetMarkdown(val markdown: String, val revision: Long) : IdeMessage {
        override fun toJson() = buildJsonObject {
            put("type", "setMarkdown")
            put("markdown", markdown)
            put("revision", revision)
        }
    }

    data class ApplyConfig(val config: FrontendConfig) : IdeMessage {
        override fun toJson() = buildJsonObject {
            put("type", "applyConfig")
            put("config", config.toJson())
        }
    }

    data class SetViewState(val anchor: Int, val scrollTop: Int) : IdeMessage {
        override fun toJson() = buildJsonObject {
            put("type", "setViewState")
            put("anchor", anchor)
            put("scrollTop", scrollTop)
        }
    }

    /** The reply to an [PageMessage.ImageUpload]: the Markdown-relative [path], or null when refused. */
    data class ImageUploaded(val requestId: String, val path: String?) : IdeMessage {
        override fun toJson() = buildJsonObject {
            put("type", "imageUploaded")
            put("requestId", requestId)
            put("path", path)
        }
    }
}

/** Everything the page needs to know about the settings and the file; `MilkJConfig` in protocol.ts. */
internal data class FrontendConfig(
    /** The resolved colour scheme: `light` or `dark`. */
    val theme: String,
    val configuredTheme: MilkJSettings.ThemeMode,
    val editorTheme: MilkJSettings.EditorTheme,
    val mermaidTheme: MilkJSettings.MermaidTheme,
    val defaultEditor: MilkJSettings.DefaultEditorMode,
    val placeholder: String,
    /** Font family overrides; blank keeps the editor theme's own fonts. */
    val textFontFamily: String,
    val headingFontFamily: String,
    val codeFontFamily: String,
    val proofingEnabled: Boolean,
    val proofingDialect: MilkJSettings.ProofingDialect,
    val customDictionary: List<String>,
    /** Base64 Weirpack archives, enabled ones only. */
    val weirpacks: List<String>,
    /** True when the page must not accept edits: the file is read-only or sync is paused. */
    val readonly: Boolean,
    val localImageBaseUrl: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("theme", theme)
        put("configuredTheme", configuredTheme.name)
        put("editorTheme", editorTheme.name)
        put("mermaidTheme", mermaidTheme.name)
        put("defaultEditor", defaultEditor.name)
        put("placeholder", placeholder)
        put("textFontFamily", textFontFamily)
        put("headingFontFamily", headingFontFamily)
        put("codeFontFamily", codeFontFamily)
        put("proofingEnabled", proofingEnabled)
        put("proofingDialect", proofingDialect.name)
        putJsonArray("customDictionary") { customDictionary.forEach { add(it) } }
        putJsonArray("weirpacks") { weirpacks.forEach { add(it) } }
        put("readonly", readonly)
        localImageBaseUrl?.let { put("localImageBaseUrl", it) }
    }

    companion object {
        /** [ideIsDark] resolves "Follow IDE"; it is the current look and feel unless a test pins it. */
        fun from(
            state: MilkJSettings.State,
            readonly: Boolean,
            localImageBaseUrl: String? = null,
            ideIsDark: Boolean,
        ): FrontendConfig = FrontendConfig(
            theme = when (state.theme) {
                MilkJSettings.ThemeMode.LIGHT -> "light"
                MilkJSettings.ThemeMode.DARK -> "dark"
                MilkJSettings.ThemeMode.FOLLOW_IDE -> if (ideIsDark) "dark" else "light"
            },
            configuredTheme = state.theme,
            editorTheme = state.editorTheme,
            mermaidTheme = state.mermaidTheme,
            defaultEditor = state.defaultEditor,
            placeholder = state.placeholderText,
            textFontFamily = state.textFontFamily,
            headingFontFamily = state.headingFontFamily,
            codeFontFamily = state.codeFontFamily,
            proofingEnabled = state.spellcheckEnabled,
            proofingDialect = state.proofingDialect,
            customDictionary = normalizeDictionary(state.customDictionary),
            weirpacks = enabledWeirpacks(state),
            readonly = readonly,
            localImageBaseUrl = localImageBaseUrl,
        )
    }
}
