package com.hedworth.milkj.navigation

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/** Percent-decodes UTF-8 without applying HTML form semantics (`+` remains `+`). */
fun strictPercentDecode(value: String): String {
    val bytes = ByteArrayOutputStream(value.length)
    val encoder = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)

    var offset = 0
    while (offset < value.length) {
        if (value[offset] == '%') {
            if (offset + 2 >= value.length) {
                throw IllegalArgumentException("Incomplete percent escape")
            }
            val high = value[offset + 1].digitToIntOrNull(16)
                ?: throw IllegalArgumentException("Invalid percent escape")
            val low = value[offset + 2].digitToIntOrNull(16)
                ?: throw IllegalArgumentException("Invalid percent escape")
            bytes.write((high shl 4) or low)
            offset += 3
            continue
        }

        val codePoint = Character.codePointAt(value, offset)
        if (codePoint in Character.MIN_SURROGATE.code..Character.MAX_SURROGATE.code) {
            throw IllegalArgumentException("Malformed Unicode input")
        }
        val encoded = encoder.reset().encode(CharBuffer.wrap(Character.toChars(codePoint)))
        while (encoded.hasRemaining()) {
            bytes.write(encoded.get().toInt())
        }
        offset += Character.charCount(codePoint)
    }

    val decoder = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
        decoder.decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
    } catch (error: Exception) {
        throw IllegalArgumentException("Invalid UTF-8", error)
    }
}

internal fun String.hasIsoControlCharacters(): Boolean = any { it.isISOControl() }
