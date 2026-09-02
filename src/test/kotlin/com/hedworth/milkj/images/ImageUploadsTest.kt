package com.hedworth.milkj.images

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.util.Base64

class ImageUploadsTest {
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
    private val pngBase64 = Base64.getEncoder().encodeToString(png)
    private val noon = LocalDateTime.of(2026, 9, 2, 12, 30, 45)

    @Test
    fun parsesAValidUpload() {
        val request = ImageUploads.parse("req-1:my%20shot.png:image/png:$pngBase64").getOrThrow()

        assertEquals("req-1", request.requestId)
        assertEquals("my shot.png", request.fileName)
        assertEquals("image/png", request.mimeType)
        assertArrayEquals(png, request.bytes)
    }

    @Test
    fun rejectsMalformedAndUnsupportedUploads() {
        val failures = mapOf(
            "missing fields" to "req:shot.png:image/png",
            "bad request id" to "bad id:shot.png:image/png:$pngBase64",
            "unsupported mime" to "req:doc.pdf:application/pdf:$pngBase64",
            "bad percent escape" to "req:%ZZ.png:image/png:$pngBase64",
            "bad base64" to "req:shot.png:image/png:@@@",
            "empty image" to "req:shot.png:image/png:",
            "non-ascii" to "req:shot.png:image/png:${pngBase64}é",
            "oversized" to "req:shot.png:image/png:${"A".repeat(ImageUploads.MAX_PAYLOAD_CHARS + 1)}",
        )
        failures.forEach { (label, payload) ->
            val result = ImageUploads.parse(payload)
            assertTrue("$label must be rejected", result.isFailure)
            assertTrue("$label needs a user-facing reason", !result.exceptionOrNull()?.message.isNullOrBlank())
        }
    }

    @Test
    fun keepsMeaningfulDroppedFileNamesAndSanitizesThem() {
        val request = request(fileName = "Screenshot 2026-09-02 at 16.02.08.png")
        assertEquals(
            "Screenshot-2026-09-02-at-16.02.08.png",
            ImageUploads.targetFileName(request, exists = { false }, now = noon),
        )
    }

    @Test
    fun replacesGenericClipboardNamesWithATimestamp() {
        listOf("image.png", "blob", "", "../../", "Image.PNG").forEach { name ->
            assertEquals(
                name,
                "image-20260902-123045.png",
                ImageUploads.targetFileName(request(fileName = name), exists = { false }, now = noon),
            )
        }
    }

    @Test
    fun derivesTheExtensionFromTheMimeTypeWhenTheNameHasNone() {
        assertEquals(
            "diagram.jpg",
            ImageUploads.targetFileName(request("diagram", "image/jpeg"), exists = { false }, now = noon),
        )
        // A non-image extension is treated as noise: the mime type decides.
        assertEquals(
            "diagram.jpg",
            ImageUploads.targetFileName(request("diagram.txt", "image/jpeg"), exists = { false }, now = noon),
        )
    }

    @Test
    fun addsANumericSuffixUntilTheNameIsFree() {
        val taken = setOf("diagram.png", "diagram-2.png")
        assertEquals(
            "diagram-3.png",
            ImageUploads.targetFileName(request("diagram.png"), exists = taken::contains, now = noon),
        )
    }

    private fun request(fileName: String, mimeType: String = "image/png") =
        ImageUploadRequest("req", fileName, mimeType, png)
}
