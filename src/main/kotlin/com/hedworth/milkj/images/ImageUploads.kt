package com.hedworth.milkj.images

import com.hedworth.milkj.navigation.strictPercentDecode
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import java.io.IOException
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64

/** A pasted or dropped image the page asked the IDE to store next to the Markdown file. */
internal data class ImageUploadRequest(
    val requestId: String,
    val fileName: String,
    val mimeType: String,
    val bytes: ByteArray,
)

/**
 * Parsing, naming, and writing for `image:upload:` bridge messages. Everything here operates on
 * the VFS only, so it works for any file system IntelliJ can write to (including the test one).
 */
internal object ImageUploads {
    const val MAX_IMAGE_BYTES: Int = 10 * 1024 * 1024

    /** Base64 of the largest accepted image, plus room for the id, name, and mime fields. */
    const val MAX_PAYLOAD_CHARS: Int = (MAX_IMAGE_BYTES / 3 + 1) * 4 + 4 * 1024

    private val REQUEST_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val TIMESTAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
    private val UNSAFE_NAME_CHARS = Regex("[^A-Za-z0-9._-]+")
    private val EXTENSION_BY_MIME = mapOf(
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/gif" to "gif",
        "image/webp" to "webp",
        "image/svg+xml" to "svg",
        "image/bmp" to "bmp",
        "image/avif" to "avif",
    )
    private val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif")

    /** Names browsers assign to clipboard images; they carry no information worth keeping. */
    private val GENERIC_BASE_NAMES = setOf("image", "blob", "pasted", "clipboard", "untitled")

    fun isValidRequestId(value: String): Boolean = REQUEST_ID.matches(value)

    /** Parses `<request id>:<urlencoded file name>:<mime>:<base64>`; failures carry a user-facing reason. */
    fun parse(payload: String): Result<ImageUploadRequest> = runCatching {
        require(payload.length <= MAX_PAYLOAD_CHARS) { "The image is larger than the 10 MB limit." }
        require(payload.all { it.code in 0x21..0x7e }) { "The upload message was malformed." }
        val parts = payload.split(':', limit = 4)
        require(parts.size == 4) { "The upload message was malformed." }
        val (requestId, encodedName, mimeType, base64) = parts
        require(isValidRequestId(requestId)) { "The upload message was malformed." }
        require(mimeType in EXTENSION_BY_MIME) { "Only PNG, JPEG, GIF, WebP, SVG, BMP, and AVIF images can be pasted." }
        val fileName = try {
            strictPercentDecode(encodedName)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("The upload message was malformed.")
        }
        require(fileName.none { it.isISOControl() } && fileName.length <= 1024) { "The upload message was malformed." }
        val bytes = try {
            Base64.getDecoder().decode(base64)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("The image data could not be decoded.")
        }
        require(bytes.isNotEmpty()) { "The image is empty." }
        require(bytes.size <= MAX_IMAGE_BYTES) { "The image is larger than the 10 MB limit." }
        ImageUploadRequest(requestId, fileName, mimeType, bytes)
    }

    /**
     * Picks a safe, unique file name: the pasted name when it is meaningful (dropped files), else
     * `image-<timestamp>`. Only `[A-Za-z0-9._-]` survive, so the Markdown never needs escaping.
     */
    fun targetFileName(
        request: ImageUploadRequest,
        exists: (String) -> Boolean,
        now: LocalDateTime = LocalDateTime.now(),
    ): String {
        val original = request.fileName.substringAfterLast('/').substringAfterLast('\\')
        val originalExtension = original.substringAfterLast('.', missingDelimiterValue = "").lowercase()
        val extension = originalExtension.takeIf { it in IMAGE_EXTENSIONS }
            ?: EXTENSION_BY_MIME.getValue(request.mimeType)
        val originalBase = if (originalExtension.isEmpty()) original else original.substringBeforeLast('.')
        val safeBase = originalBase
            .replace(UNSAFE_NAME_CHARS, "-")
            .trim('-', '.')
            .take(80)
        val base = if (safeBase.isEmpty() || safeBase.lowercase() in GENERIC_BASE_NAMES) {
            "image-${now.format(TIMESTAMP)}"
        } else {
            safeBase
        }
        var candidate = "$base.$extension"
        var suffix = 2
        while (exists(candidate)) {
            candidate = "$base-$suffix.$extension"
            suffix++
        }
        return candidate
    }

    /**
     * Writes the image under [directorySetting] (relative to the Markdown file; blank means the
     * file's own folder) and returns the Markdown-relative path to reference it. Must run inside a
     * write action.
     */
    @Throws(IOException::class)
    fun save(
        markdownFile: VirtualFile,
        directorySetting: String,
        request: ImageUploadRequest,
        requestor: Any,
        now: LocalDateTime = LocalDateTime.now(),
    ): String {
        val markdownDirectory = markdownFile.parent
            ?: throw IOException("The Markdown file has no parent folder.")
        val directory = resolveDirectory(markdownDirectory, directorySetting, requestor)
        val name = targetFileName(request, exists = { directory.findChild(it) != null }, now = now)
        val created = directory.createChildData(requestor, name)
        created.setBinaryContent(request.bytes)
        return VfsUtilCore.findRelativePath(markdownFile, created, '/')
            ?: throw IOException("The image was written to ${created.path} but cannot be referenced relatively.")
    }

    @Throws(IOException::class)
    private fun resolveDirectory(start: VirtualFile, setting: String, requestor: Any): VirtualFile {
        var directory = start
        setting.trim().replace('\\', '/').split('/').filter { it.isNotBlank() && it != "." }.forEach { segment ->
            directory = when (segment) {
                ".." -> directory.parent ?: throw IOException("The image folder is above the file system root.")
                else -> {
                    val child = directory.findChild(segment)
                    when {
                        child == null -> directory.createChildDirectory(requestor, segment)
                        child.isDirectory -> child
                        else -> throw IOException("\"${child.path}\" exists and is not a folder.")
                    }
                }
            }
        }
        return directory
    }
}
