package com.hedworth.milkj.navigation

import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths

data class LinkResolutionSnapshot(
    val rawTarget: String,
    val sourceParent: Path?,
    val projectBase: Path?,
    val contentRoots: List<Path>,
)

sealed class LinkResolutionResult {
    data class ResolvedPath(
        val canonicalPath: Path,
        val oneBasedStartLine: Int,
        val oneBasedEndLine: Int,
    ) : LinkResolutionResult()

    data class CurrentFile(
        val oneBasedStartLine: Int,
        val oneBasedEndLine: Int,
    ) : LinkResolutionResult()

    data object Unsupported : LinkResolutionResult()
    data class Invalid(val reason: String) : LinkResolutionResult()
    data class NotFound(val reason: String) : LinkResolutionResult()
}

/** Pure NIO resolver. Its caller is responsible for running it away from the EDT. */
class ProjectFileLinkResolver {
    fun resolve(snapshot: LinkResolutionSnapshot): LinkResolutionResult {
        val target = snapshot.rawTarget
        if (target.isBlank() || target.hasIsoControlCharacters()) {
            return LinkResolutionResult.Invalid("The target is empty or contains control characters")
        }

        val hash = target.indexOf('#')
        val rawPath = if (hash >= 0) target.substring(0, hash) else target
        val rawFragment = if (hash >= 0) target.substring(hash + 1) else null
        val lines = parseLines(rawFragment) ?: return LinkResolutionResult.Invalid("Invalid line fragment")

        if (rawPath.isEmpty()) {
            return if (rawFragment != null) {
                LinkResolutionResult.CurrentFile(lines.first, lines.second)
            } else {
                LinkResolutionResult.Invalid("The target is empty")
            }
        }
        if ('?' in rawPath) {
            return LinkResolutionResult.Invalid("Query strings are not supported")
        }
        if (rawPath.startsWith("//")) {
            return LinkResolutionResult.Unsupported
        }
        if ('\\' in rawPath) {
            return LinkResolutionResult.Invalid("Backslashes are not supported in project file links")
        }

        val scheme = SCHEME.find(rawPath)?.groupValues?.get(1)
        return when {
            scheme != null && !scheme.equals("file", ignoreCase = true) -> LinkResolutionResult.Unsupported
            scheme != null -> resolveFileUrl(snapshot, rawPath, lines)
            rawPath.startsWith('/') -> resolveProjectPath(snapshot, rawPath.drop(1), lines)
            else -> resolveRelativePath(snapshot, rawPath, lines)
        }
    }

    private fun resolveFileUrl(
        snapshot: LinkResolutionSnapshot,
        rawPath: String,
        lines: Pair<Int, Int>,
    ): LinkResolutionResult {
        if (!rawPath.startsWith("file://", ignoreCase = true)) {
            return LinkResolutionResult.Invalid("Malformed file URL")
        }
        val uri = try {
            URI(rawPath)
        } catch (_: Exception) {
            return LinkResolutionResult.Invalid("Malformed file URL")
        }
        if (!uri.scheme.equals("file", ignoreCase = true) ||
            uri.rawQuery != null || uri.rawFragment != null || uri.userInfo != null || uri.port != -1 ||
            (!uri.rawAuthority.isNullOrEmpty() && !uri.rawAuthority.equals("localhost", ignoreCase = true)) ||
            uri.rawPath.isNullOrEmpty()
        ) {
            return LinkResolutionResult.Invalid("Only local file URLs without queries are supported")
        }
        val decoded = decodePath(uri.rawPath) ?: return LinkResolutionResult.Invalid("Malformed encoded path")
        val path = try {
            Paths.get(decoded).normalize()
        } catch (_: Exception) {
            return LinkResolutionResult.Invalid("Invalid file path")
        }
        return resolveCandidate(path, snapshot.contentRoots, lines, missingIsFinal = true)
            ?: LinkResolutionResult.NotFound("File not found")
    }

    private fun resolveProjectPath(
        snapshot: LinkResolutionSnapshot,
        encodedPath: String,
        lines: Pair<Int, Int>,
    ): LinkResolutionResult {
        val base = snapshot.projectBase ?: return LinkResolutionResult.Unsupported
        val decoded = decodePath(encodedPath) ?: return LinkResolutionResult.Invalid("Malformed encoded path")
        val candidate = safeResolve(base, decoded) ?: return LinkResolutionResult.Invalid("Invalid file path")
        return resolveCandidate(candidate, snapshot.contentRoots, lines, missingIsFinal = true)
            ?: LinkResolutionResult.NotFound("File not found")
    }

    private fun resolveRelativePath(
        snapshot: LinkResolutionSnapshot,
        encodedPath: String,
        lines: Pair<Int, Int>,
    ): LinkResolutionResult {
        val parent = snapshot.sourceParent ?: return LinkResolutionResult.Unsupported
        val decoded = decodePath(encodedPath) ?: return LinkResolutionResult.Invalid("Malformed encoded path")
        val local = safeResolve(parent, decoded) ?: return LinkResolutionResult.Invalid("Invalid file path")
        val localResult = resolveCandidate(local, snapshot.contentRoots, lines, missingIsFinal = false)
        if (localResult != null) {
            return localResult
        }

        val base = snapshot.projectBase ?: return LinkResolutionResult.NotFound("File not found")
        val rootCandidate = safeResolve(base, decoded)
            ?: return LinkResolutionResult.Invalid("Invalid file path")
        if (rootCandidate == local) {
            return LinkResolutionResult.NotFound("File not found")
        }
        return resolveCandidate(rootCandidate, snapshot.contentRoots, lines, missingIsFinal = true)
            ?: LinkResolutionResult.NotFound("File not found")
    }

    private fun decodePath(rawPath: String): String? {
        val decoded = try {
            strictPercentDecode(rawPath)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (decoded.hasIsoControlCharacters() || '\\' in decoded || decoded.startsWith("//")) {
            return null
        }
        return decoded
    }

    private fun safeResolve(base: Path, decoded: String): Path? = try {
        base.resolve(decoded).normalize()
    } catch (_: Exception) {
        null
    }

    private fun resolveCandidate(
        candidate: Path,
        contentRoots: List<Path>,
        lines: Pair<Int, Int>,
        missingIsFinal: Boolean,
    ): LinkResolutionResult? {
        if (!Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) {
            return if (missingIsFinal) LinkResolutionResult.NotFound("File not found") else null
        }
        val canonical = try {
            candidate.toRealPath()
        } catch (_: Exception) {
            return LinkResolutionResult.Invalid("The target could not be resolved")
        }
        if (!Files.isRegularFile(canonical)) {
            return LinkResolutionResult.Invalid("The target is not a regular file")
        }
        val canonicalRoots = contentRoots.mapNotNull { root ->
            try {
                root.toRealPath()
            } catch (_: Exception) {
                null
            }
        }
        if (canonicalRoots.none(canonical::startsWith)) {
            return LinkResolutionResult.Invalid("The target is outside project content")
        }
        return LinkResolutionResult.ResolvedPath(canonical, lines.first, lines.second)
    }

    private fun parseLines(fragment: String?): Pair<Int, Int>? {
        if (fragment == null) return 1 to 1
        val match = LINE_FRAGMENT.matchEntire(fragment) ?: return null
        val start = match.groupValues[1].toIntOrNull() ?: return null
        val endText = match.groupValues[2]
        val end = if (endText.isEmpty()) start else endText.toIntOrNull() ?: return null
        return if (end >= start) start to end else null
    }

    companion object {
        private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*):")
        private val LINE_FRAGMENT = Regex("^L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$", RegexOption.IGNORE_CASE)
    }
}
