package com.hedworth.milkj.navigation

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.StandardFileSystems
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicLong

fun interface FileLinkNavigator {
    fun navigate(rawHref: String)
}

/** Resolves links off the EDT, then performs only editor/document work on the EDT. */
class ProjectFileLinkNavigator(
    private val project: Project,
    private val sourceFile: VirtualFile,
    private val resolver: ProjectFileLinkResolver = ProjectFileLinkResolver(),
    private val submit: (Runnable) -> Future<*> = { task ->
        ApplicationManager.getApplication().executeOnPooledThread(task)
    },
    private val openEditor: (VirtualFile, Int) -> Unit = { file, zeroBasedLine ->
        FileEditorManager.getInstance(project).openTextEditor(
            OpenFileDescriptor(project, file, zeroBasedLine, 0),
            true,
        )
    },
    private val notifyWarning: (String, String) -> Unit = { target, reason ->
        NotificationGroupManager.getInstance()
            .getNotificationGroup("MilkJ")
            .createNotification(
                "Unable to open project file link",
                "<code>${escapeTarget(target)}</code>: ${StringUtil.escapeXmlEntities(reason)}",
                NotificationType.WARNING,
            )
            .notify(project)
    },
) : FileLinkNavigator, Disposable {
    private val generation = AtomicLong()

    @Volatile
    private var disposed = false

    @Volatile
    private var pending: Future<*>? = null

    override fun navigate(rawHref: String) {
        if (disposed || project.isDisposed || !sourceFile.isValid) return

        val requestGeneration = generation.incrementAndGet()
        pending?.cancel(true)
        val snapshot = captureSnapshot(rawHref)
        pending = submit(Runnable {
            if (!isCurrent(requestGeneration)) return@Runnable
            val result = resolver.resolve(snapshot)
            if (!isCurrent(requestGeneration)) return@Runnable
            when (result) {
                is LinkResolutionResult.ResolvedPath -> {
                    val virtualFile = LocalFileSystem.getInstance()
                        .refreshAndFindFileByNioFile(result.canonicalPath)
                    finalizeLater(requestGeneration) {
                        if (virtualFile == null || !virtualFile.isValid) {
                            warn(rawHref, "File not found")
                        } else {
                            finalizeFile(rawHref, virtualFile, result.oneBasedStartLine, result.oneBasedEndLine, true)
                        }
                    }
                }
                is LinkResolutionResult.CurrentFile -> finalizeLater(requestGeneration) {
                    finalizeFile(
                        rawHref,
                        sourceFile,
                        result.oneBasedStartLine,
                        result.oneBasedEndLine,
                        false,
                    )
                }
                is LinkResolutionResult.Invalid -> finalizeLater(requestGeneration) {
                    warn(rawHref, result.reason)
                }
                is LinkResolutionResult.NotFound -> finalizeLater(requestGeneration) {
                    warn(rawHref, result.reason)
                }
                LinkResolutionResult.Unsupported -> Unit
            }
        })
    }

    override fun dispose() {
        disposed = true
        generation.incrementAndGet()
        pending?.cancel(true)
        pending = null
    }

    private fun captureSnapshot(rawHref: String): LinkResolutionSnapshot {
        val sourceParent = sourceFile.takeIf {
            it.fileSystem.protocol == StandardFileSystems.FILE_PROTOCOL
        }?.path?.let(::pathOrNull)?.parent
        val projectBase = project.basePath?.let(::pathOrNull)
        val contentRoots = ProjectRootManager.getInstance(project).contentRoots.mapNotNull { root ->
            if (root.fileSystem.protocol == StandardFileSystems.FILE_PROTOCOL) pathOrNull(root.path) else null
        }
        return LinkResolutionSnapshot(rawHref, sourceParent, projectBase, contentRoots)
    }

    private fun finalizeLater(requestGeneration: Long, action: () -> Unit) {
        ApplicationManager.getApplication().invokeLater {
            if (isCurrent(requestGeneration) && sourceFile.isValid) action()
        }
    }

    private fun finalizeFile(
        rawHref: String,
        targetFile: VirtualFile,
        oneBasedStartLine: Int,
        oneBasedEndLine: Int,
        requireProjectContent: Boolean,
    ) {
        if (!targetFile.isValid) {
            warn(rawHref, "File not found")
            return
        }
        if (requireProjectContent && !ProjectFileIndex.getInstance(project).isInContent(targetFile)) {
            warn(rawHref, "The target is outside project content")
            return
        }
        val document = FileDocumentManager.getInstance().getDocument(targetFile)
        if (document == null) {
            warn(rawHref, "The target is not a text file")
            return
        }
        if (oneBasedStartLine > document.lineCount || oneBasedEndLine > document.lineCount) {
            warn(rawHref, "The requested line is outside the file")
            return
        }
        openEditor(targetFile, oneBasedStartLine - 1)
    }

    private fun warn(rawHref: String, reason: String) {
        if (!disposed && !project.isDisposed) notifyWarning(rawHref, reason)
    }

    private fun isCurrent(requestGeneration: Long): Boolean =
        !disposed && !project.isDisposed && generation.get() == requestGeneration

    private fun pathOrNull(value: String): Path? = try {
        Paths.get(value)
    } catch (_: Exception) {
        null
    }

    companion object {
        private fun escapeTarget(rawTarget: String): String {
            val safe = buildString {
                rawTarget.forEach { character -> append(if (character.isISOControl()) '\uFFFD' else character) }
            }
            val codePoints = safe.codePointCount(0, safe.length)
            val truncated = if (codePoints <= MAX_NOTIFICATION_TARGET_CODE_POINTS) {
                safe
            } else {
                safe.substring(0, safe.offsetByCodePoints(0, MAX_NOTIFICATION_TARGET_CODE_POINTS)) + "…"
            }
            return StringUtil.escapeXmlEntities(truncated)
        }

        private const val MAX_NOTIFICATION_TARGET_CODE_POINTS = 240
    }
}
