package com.hedworth.milkj.web

import com.hedworth.milkj.navigation.strictPercentDecode
import java.nio.file.Files
import java.nio.file.Path

internal data class LocalImageContent(
    val bytes: ByteArray,
    val mimeType: String,
)

/** Resolves Markdown image paths while preventing reads outside the open project. */
internal class LocalImageResolver(
    markdownDirectory: Path,
    projectDirectory: Path?,
) {
    private val markdownRoot = markdownDirectory.toRealPath()
    private val projectRoot = projectDirectory?.toRealPath()
    private val allowedRoot = projectRoot ?: markdownRoot

    fun read(rawSource: String): LocalImageContent? {
        val path = sourcePath(rawSource) ?: return null
        val unresolved = if (path.startsWith('/')) {
            allowedRoot.resolve(path.removePrefix("/"))
        } else {
            markdownRoot.resolve(path)
        }.normalize()

        if (!unresolved.startsWith(allowedRoot)) return null
        val resolved = runCatching { unresolved.toRealPath() }.getOrNull() ?: return null
        if (!resolved.startsWith(allowedRoot) || !Files.isRegularFile(resolved)) return null
        val size = runCatching { Files.size(resolved) }.getOrNull() ?: return null
        if (size > MAX_IMAGE_BYTES) return null

        val bytes = runCatching { Files.readAllBytes(resolved) }.getOrNull() ?: return null
        return LocalImageContent(bytes, imageMimeType(resolved.fileName.toString()))
    }

    private fun sourcePath(rawSource: String): String? {
        if (
            rawSource.isBlank() ||
            rawSource.length > MAX_SOURCE_CHARS ||
            rawSource.any { it.isISOControl() } ||
            URI_SCHEME.containsMatchIn(rawSource) ||
            rawSource.startsWith("//")
        ) {
            return null
        }

        val withoutSuffix = rawSource.substringBefore('#').substringBefore('?')
        if (withoutSuffix.isBlank()) return null
        // Markdown destinations commonly use URL escapes for spaces. A literal malformed percent
        // is still a valid filename, so only use the decoded form when decoding succeeds.
        return runCatching { strictPercentDecode(withoutSuffix) }.getOrDefault(withoutSuffix)
    }

    companion object {
        private const val MAX_SOURCE_CHARS = 8 * 1024
        private const val MAX_IMAGE_BYTES = 25L * 1024 * 1024
        private val URI_SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

        private fun imageMimeType(name: String): String =
            when (name.substringAfterLast('.', missingDelimiterValue = "").lowercase()) {
                "svg" -> "image/svg+xml"
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                "avif" -> "image/avif"
                "bmp" -> "image/bmp"
                "ico" -> "image/x-icon"
                else -> "application/octet-stream"
            }
    }
}
