package com.hedworth.milkj.navigation

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNoException
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class ProjectFileLinkResolverTest {
    private lateinit var temporaryDirectory: Path
    private lateinit var projectRoot: Path
    private lateinit var sourceParent: Path
    private val resolver = ProjectFileLinkResolver()

    @Before
    fun setUp() {
        temporaryDirectory = Files.createTempDirectory("milkj-project-links")
        projectRoot = Files.createDirectories(temporaryDirectory.resolve("project"))
        sourceParent = Files.createDirectories(projectRoot.resolve("docs/nested"))
    }

    @After
    fun tearDown() {
        temporaryDirectory.toFile().deleteRecursively()
    }

    @Test
    fun `strict decoder preserves plus and validates utf8`() {
        assertEquals("C++.kt", strictPercentDecode("C++.kt"))
        assertEquals("café.kt", strictPercentDecode("caf%C3%A9.kt"))
        assertEquals("a b", strictPercentDecode("a%20b"))
        assertFailsDecode("%")
        assertFailsDecode("%GG")
        assertFailsDecode("%C3%28")
    }

    @Test
    fun `relative lookup prefers source directory then falls back to project root`() {
        val local = write(sourceParent.resolve("local.kt"))
        val root = write(projectRoot.resolve("root.kt"))

        assertResolved("local.kt", local, 1, 1)
        assertResolved("root.kt#L2-L4", root, 2, 4)
    }

    @Test
    fun `project paths normalize and remain inside content`() {
        val sibling = write(projectRoot.resolve("docs/sibling.kt"))
        val root = write(projectRoot.resolve("src/Foo.kt"))

        assertResolved("../sibling.kt", sibling, 1, 1)
        assertResolved("/src/Foo.kt#l3", root, 3, 3)
        assertTrue(resolve("../../../outside.kt") is LinkResolutionResult.NotFound)
    }

    @Test
    fun `file urls and encoded filenames resolve exactly once`() {
        val spaced = write(projectRoot.resolve("src/My File.kt"))
        val plus = write(projectRoot.resolve("src/C++.kt"))
        val hash = write(projectRoot.resolve("src/name#part.kt"))
        val percent = write(projectRoot.resolve("src/name%.kt"))

        assertResolved(spaced.toUri().toASCIIString(), spaced, 1, 1)
        assertResolved("/src/My%20File.kt", spaced, 1, 1)
        assertResolved("/src/C++.kt", plus, 1, 1)
        assertResolved("/src/name%23part.kt", hash, 1, 1)
        assertResolved("/src/name%25.kt", percent, 1, 1)
    }

    @Test
    fun `line-only links target the current virtual file without roots`() {
        val result = resolver.resolve(LinkResolutionSnapshot("#L20-L30", null, null, emptyList()))
        assertEquals(LinkResolutionResult.CurrentFile(20, 30), result)
    }

    @Test
    fun `invalid and unsupported syntax is rejected`() {
        listOf(
            "file.kt#installation",
            "file.kt#L0",
            "file.kt#L3-L2",
            "file.kt#L2147483648",
            "file.kt?raw=true",
            "file:/project/file.kt",
            "bad%escape.kt",
            "bad%C3%28.kt",
            "raw\\path.kt",
            "encoded%5Cpath.kt",
            "#L1#L2",
        ).forEach { target -> assertTrue("expected invalid: $target", resolve(target) is LinkResolutionResult.Invalid) }

        listOf(
            "https://example.com/file.kt",
            "mailto:test@example.com",
            "//example.com/file.kt",
            "C:/source/Foo.kt",
        ).forEach { target -> assertEquals(LinkResolutionResult.Unsupported, resolve(target)) }
    }

    @Test
    fun `directories and paths outside project content are rejected`() {
        Files.createDirectories(sourceParent.resolve("directory"))
        val outside = write(temporaryDirectory.resolve("outside.kt"))

        assertTrue(resolve("directory") is LinkResolutionResult.Invalid)
        assertTrue(resolve(outside.toUri().toASCIIString()) is LinkResolutionResult.Invalid)
        assertTrue(resolve("missing.kt") is LinkResolutionResult.NotFound)
    }

    @Test
    fun `existing invalid local candidate blocks root fallback`() {
        Files.createDirectories(sourceParent.resolve("same.kt"))
        write(projectRoot.resolve("same.kt"))
        assertTrue(resolve("same.kt") is LinkResolutionResult.Invalid)
    }

    @Test
    fun `symlinks are checked by canonical content containment`() {
        val inProject = write(projectRoot.resolve("src/real.kt"))
        val outside = write(temporaryDirectory.resolve("outside.kt"))
        val insideLink = sourceParent.resolve("inside.kt")
        val outsideLink = sourceParent.resolve("outside.kt")
        try {
            Files.createSymbolicLink(insideLink, inProject)
            Files.createSymbolicLink(outsideLink, outside)
        } catch (error: Exception) {
            assumeNoException(error)
        }

        assertResolved("inside.kt", inProject, 1, 1)
        assertTrue(resolve("outside.kt") is LinkResolutionResult.Invalid)
    }

    private fun write(path: Path): Path {
        Files.createDirectories(path.parent)
        Files.writeString(path, "one\ntwo\nthree\nfour\n")
        return path.toRealPath()
    }

    private fun resolve(target: String): LinkResolutionResult = resolver.resolve(
        LinkResolutionSnapshot(target, sourceParent, projectRoot, listOf(projectRoot)),
    )

    private fun assertResolved(target: String, expected: Path, start: Int, end: Int) {
        assertEquals(LinkResolutionResult.ResolvedPath(expected.toRealPath(), start, end), resolve(target))
    }

    private fun assertFailsDecode(value: String) {
        try {
            strictPercentDecode(value)
            throw AssertionError("Expected strictPercentDecode to fail for $value")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }
}
