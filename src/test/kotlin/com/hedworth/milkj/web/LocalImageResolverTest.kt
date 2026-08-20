package com.hedworth.milkj.web

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assume.assumeNoException
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class LocalImageResolverTest {
    private lateinit var temporaryDirectory: Path
    private lateinit var projectRoot: Path
    private lateinit var markdownDirectory: Path
    private lateinit var resolver: LocalImageResolver

    @Before
    fun setUp() {
        temporaryDirectory = Files.createTempDirectory("milkj-local-images")
        projectRoot = Files.createDirectories(temporaryDirectory.resolve("project"))
        markdownDirectory = Files.createDirectories(projectRoot.resolve("docs/nested"))
        resolver = LocalImageResolver(markdownDirectory, projectRoot)
    }

    @After
    fun tearDown() {
        temporaryDirectory.toFile().deleteRecursively()
    }

    @Test
    fun `reads relative and project-root-relative images`() {
        val relativeBytes = byteArrayOf(1, 2, 3)
        val rootBytes = byteArrayOf(4, 5, 6)
        write(markdownDirectory.resolve("diagram one.png"), relativeBytes)
        write(projectRoot.resolve("assets/icon.svg"), rootBytes)

        val relative = resolver.read("./diagram%20one.png")
        val projectRelative = resolver.read("/assets/icon.svg")

        assertArrayEquals(relativeBytes, relative!!.bytes)
        assertEquals("image/png", relative.mimeType)
        assertArrayEquals(rootBytes, projectRelative!!.bytes)
        assertEquals("image/svg+xml", projectRelative.mimeType)
    }

    @Test
    fun `rejects remote URLs missing files and traversal outside the project`() {
        write(temporaryDirectory.resolve("outside.png"), byteArrayOf(9))

        assertNull(resolver.read("https://example.test/image.png"))
        assertNull(resolver.read("missing.png"))
        assertNull(resolver.read("../../../outside.png"))
    }

    @Test
    fun `rejects a symlink that leaves the project`() {
        val outside = write(temporaryDirectory.resolve("outside.png"), byteArrayOf(7))
        val link = markdownDirectory.resolve("outside-link.png")
        try {
            Files.createSymbolicLink(link, outside)
        } catch (error: Exception) {
            assumeNoException(error)
        }

        assertNull(resolver.read("outside-link.png"))
    }

    private fun write(path: Path, bytes: ByteArray): Path {
        Files.createDirectories(path.parent)
        Files.write(path, bytes)
        return path.toRealPath()
    }
}
