package com.hedworth.milkj.settings

/**
 * The editor zoom is one application-wide percentage, applied through the embedded browser's own
 * page zoom (so pixel-sized Crepe styles, images and diagrams all scale together). Keyboard zooming
 * walks the same ladder as Chromium; the settings spinner can land in between.
 */
object ZoomLevels {
    const val MIN_PERCENT = 50
    const val MAX_PERCENT = 300
    const val DEFAULT_PERCENT = 100

    val STEPS: List<Int> = listOf(50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300)

    fun clamp(percent: Int): Int = percent.coerceIn(MIN_PERCENT, MAX_PERCENT)

    fun zoomIn(percent: Int): Int = STEPS.firstOrNull { it > percent } ?: MAX_PERCENT

    fun zoomOut(percent: Int): Int = STEPS.lastOrNull { it < percent } ?: MIN_PERCENT

    /** Maps a page `zoom:<command>` payload onto the next percentage, or null for an unknown command. */
    fun apply(command: String, percent: Int): Int? =
        when (command) {
            "in" -> zoomIn(clamp(percent))
            "out" -> zoomOut(clamp(percent))
            "reset" -> DEFAULT_PERCENT
            else -> null
        }
}
