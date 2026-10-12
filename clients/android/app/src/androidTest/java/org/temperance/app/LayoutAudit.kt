package org.temperance.app

import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Finds the layout problems a person would notice: text cut off or ellipsized,
 * content running off the side of the screen, siblings drawn over each other,
 * content hidden under the status/navigation bars or display cutout, and tap
 * targets smaller than 48dp.
 */
object LayoutAudit {
    private val decorIds = setOf(android.R.id.statusBarBackground, android.R.id.navigationBarBackground)

    fun problems(root: View, label: String): List<String> {
        val out = mutableListOf<String>()
        val density = root.resources.displayMetrics.density
        val insets = root.rootWindowInsets?.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
        val origin = IntArray(2).also(root::getLocationOnScreen)
        val window = Rect().also { root.getGlobalVisibleRect(it); it.offset(origin[0], origin[1]) }
        val screen = root.resources.displayMetrics.let { Rect(0, 0, it.widthPixels, it.heightPixels) }
        val bars = insets?.let {
            listOf(
                Rect(screen.left, screen.top, screen.right, screen.top + it.top),
                Rect(screen.left, screen.bottom - it.bottom, screen.right, screen.bottom),
                Rect(screen.left, screen.top, screen.left + it.left, screen.bottom),
                Rect(screen.right - it.right, screen.top, screen.right, screen.bottom),
            ).filter { r -> !r.isEmpty }
        }.orEmpty()
        val content = root.findViewById<View>(android.R.id.content)
        val actionBar = root.findViewById<View>(root.resources.getIdentifier("action_bar_container", "id", "android"))
            ?.takeIf { it.isShown }?.let { bar -> IntArray(2).also(bar::getLocationOnScreen).let { Rect(it[0], it[1], it[0] + bar.width, it[1] + bar.height) } }
        fun inContent(v: View): Boolean {
            var p: Any? = v
            while (p is View) { if (p === content) return true; p = p.parent }
            return false
        }

        fun name(v: View): String {
            val id = if (v.id != View.NO_ID) runCatching { v.resources.getResourceEntryName(v.id) }.getOrNull() else null
            val text = (v as? TextView)?.text?.toString()?.take(40)?.let { "\"$it\"" }
            return "$label: ${v.javaClass.simpleName}${id?.let { "#$it" } ?: ""}${text?.let { " $it" } ?: ""}"
        }

        fun visit(v: View) {
            if (!v.isShown || v.width == 0 || v.height == 0 || v.id in decorIds) return
            val visible = Rect()
            val onScreen = v.getGlobalVisibleRect(visible).also { visible.offset(origin[0], origin[1]) }
            val loc = IntArray(2).also(v::getLocationOnScreen)
            val full = Rect(loc[0], loc[1], loc[0] + v.width, loc[1] + v.height)

            if (full.left < window.left - 1 || full.right > window.right + 1) out += "${name(v)} runs off the side of the window ($full vs $window)"

            if (v is TextView && v !is EditText && v.layout != null) {
                val layout = v.layout
                for (line in 0 until layout.lineCount) if (layout.getEllipsisCount(line) > 0) { out += "${name(v)} is ellipsized"; break }
                val available = v.height - v.compoundPaddingTop - v.compoundPaddingBottom
                if (layout.height > available + 1) out += "${name(v)} is clipped vertically (${layout.height}px text in ${available}px)"
                val width = v.width - v.compoundPaddingLeft - v.compoundPaddingRight
                val widest = (0 until layout.lineCount).maxOfOrNull { layout.getLineMax(it) } ?: 0f
                if (widest > width + 1) out += "${name(v)} is clipped horizontally"
            }

            if (v is EditText && v.text.isEmpty() && !v.hint.isNullOrEmpty() && v.maxLines == 1) {
                val width = v.width - v.compoundPaddingLeft - v.compoundPaddingRight
                if (v.paint.measureText(v.hint.toString()) > width + 1) out += "${name(v)} hint \"${v.hint}\" is cut off"
            }

            if (onScreen && v !is ViewGroup) {
                bars.firstOrNull { Rect.intersects(it, visible) }?.let { out += "${name(v)} is drawn under a system bar ($visible vs $it)" }
                if (actionBar != null && inContent(v) && Rect.intersects(actionBar, visible)) {
                    val scroll = generateSequence(v.parent) { it.parent }.filterIsInstance<android.widget.ScrollView>().firstOrNull()
                    out += "${name(v)} is hidden under the action bar ($visible vs $actionBar, scrollY=${scroll?.scrollY})"
                }
            }

            if (v.isClickable && v.isEnabled && v !is ViewGroup && onScreen) {
                val min = (48 * density * 0.95).toInt()
                if (v.height < min) out += "${name(v)} tap target is ${(v.height / density).toInt()}dp tall"
            }

            if (v is LinearLayout) {
                val kids = (0 until v.childCount).map(v::getChildAt).filter { it.isShown && it.width > 0 && it.height > 0 }
                val rects = kids.map { k -> Rect().also(k::getHitRect) }
                for (i in rects.indices) for (j in i + 1 until rects.size) {
                    if (Rect.intersects(rects[i], rects[j])) out += "${name(kids[i])} overlaps ${name(kids[j])}"
                }
            }
            if (v is ViewGroup) for (i in 0 until v.childCount) visit(v.getChildAt(i))
        }
        visit(root)
        return out
    }
}
