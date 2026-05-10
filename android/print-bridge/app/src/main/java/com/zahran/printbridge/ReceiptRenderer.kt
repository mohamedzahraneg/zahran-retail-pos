package com.zahran.printbridge

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.TextUtils
import android.text.format.DateFormat
import java.util.Date
import java.util.Locale

/**
 * Renders Arabic + Latin receipt content into an Android [Bitmap]
 * suitable for [EscposBitmapEncoder].  Uses [StaticLayout] with
 * [TextDirectionHeuristics.RTL] so Arabic glyph shaping (joining +
 * BiDi reordering) is handled by the platform — we don't reinvent
 * the algorithm.
 *
 * Phase-2 MVP: only the test receipt is rendered natively.  Invoice
 * jobs arrive as `escpos_html` payloads from the FE; they're rendered
 * via the simple line-by-line path below until a future phase swaps
 * in a WebView-backed renderer.
 */
object ReceiptRenderer {

    /** Body text size, in pixels at 203dpi.  ~24px reads cleanly on 80mm. */
    private const val BODY_PX = 24f
    private const val TITLE_PX = 36f
    private const val SMALL_PX = 18f
    private const val LINE_SPACING = 1.2f
    private const val PADDING_PX = 16

    /**
     * Build the MVP test-print bitmap for the given paper width and
     * printer name.  The output is intentionally small (~280–320 px
     * tall on 80mm) so the print finishes in well under a second.
     */
    fun renderTestReceipt(
        widthDots: Int,
        shopName: String,
        printerName: String,
    ): Bitmap {
        val lines = buildList {
            add(Line(shopName, TITLE_PX, isBold = true))
            add(Divider)
            add(Line("اختبار طباعة", BODY_PX, isBold = true))
            add(Line("Printer: $printerName", SMALL_PX))
            add(
                Line(
                    "Time: ${DateFormat.format("yyyy-MM-dd HH:mm:ss", Date())}",
                    SMALL_PX,
                ),
            )
            add(Divider)
            add(Line("جسر الطباعة يعمل ✓", BODY_PX))
            add(Line("Print Bridge OK", SMALL_PX))
        }
        return renderLines(widthDots, lines)
    }

    /**
     * Render an [escpos_html] payload.  The MVP path strips tags and
     * lays out the resulting plain text — good enough for the receipt
     * text the FE currently emits (mostly inline spans + line breaks).
     * A richer renderer will follow in a later phase.
     */
    fun renderEscposHtml(widthDots: Int, html: String): Bitmap {
        // Naive HTML → text: collapse <br>/<p>/<div> to newlines, drop
        // every other tag.  HTML entities (`&amp;`, `&lt;`, `&gt;`,
        // `&nbsp;`, `&quot;`) decoded to keep the output readable.
        val text = html
            .replace(Regex("<\\s*br\\s*/?\\s*>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("</\\s*(p|div|tr|h[1-6])\\s*>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("<[^>]+>"), "")
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        val lines = text.map { Line(it, BODY_PX) }
        return renderLines(widthDots, lines)
    }

    // ─── Internals ────────────────────────────────────────────────

    private sealed interface Item
    private data class Line(
        val text: String,
        val sizePx: Float,
        val isBold: Boolean = false,
    ) : Item
    private data object Divider : Item

    private fun renderLines(widthDots: Int, items: List<Item>): Bitmap {
        val contentWidth = widthDots - PADDING_PX * 2

        // Build StaticLayouts up-front to measure heights.
        val layouts: List<Pair<Item, StaticLayout?>> = items.map { item ->
            when (item) {
                is Line -> item to staticLayout(item, contentWidth)
                is Divider -> item to null
            }
        }
        val totalHeight = PADDING_PX * 2 + layouts.sumOf { (item, layout) ->
            when (item) {
                is Line -> layout!!.height
                is Divider -> 12 // px between sections
            }
        }

        val bmp = Bitmap.createBitmap(widthDots, totalHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawColor(Color.WHITE)

        var y = PADDING_PX.toFloat()
        for ((item, layout) in layouts) {
            when (item) {
                is Line -> {
                    canvas.save()
                    canvas.translate(PADDING_PX.toFloat(), y)
                    layout!!.draw(canvas)
                    canvas.restore()
                    y += layout.height
                }
                is Divider -> {
                    val dashPaint = Paint().apply {
                        color = Color.BLACK
                        strokeWidth = 1f
                        style = Paint.Style.STROKE
                    }
                    val dashY = y + 6f
                    val startX = PADDING_PX.toFloat()
                    val endX = (widthDots - PADDING_PX).toFloat()
                    var x = startX
                    val dash = 6f
                    while (x < endX) {
                        canvas.drawLine(x, dashY, (x + dash).coerceAtMost(endX), dashY, dashPaint)
                        x += dash * 2
                    }
                    y += 12f
                }
            }
        }
        return bmp
    }

    private fun staticLayout(line: Line, widthPx: Int): StaticLayout {
        val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = line.sizePx
            color = Color.BLACK
            typeface = if (line.isBold) Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                       else Typeface.DEFAULT
            // Locale + textLocale → enables Arabic glyph shaping in the platform layout pass.
            textLocale = Locale("ar")
            isSubpixelText = true
        }
        // Detect direction from content; explicit RTL when the string
        // starts with Arabic characters.  Mixed-script lines (e.g.
        // "Printer: 3dea") fall through to LTR which is correct.
        val isArabic = line.text.any { it in '؀'..'ۿ' }
        val dir = if (isArabic) TextDirectionHeuristics.RTL
                  else TextDirectionHeuristics.LTR
        // Use the API 23+ Builder; min SDK is 24 so this is safe.
        return StaticLayout.Builder
            .obtain(line.text, 0, line.text.length, tp, widthPx)
            .setAlignment(
                if (isArabic) Layout.Alignment.ALIGN_OPPOSITE
                else Layout.Alignment.ALIGN_NORMAL,
            )
            .setLineSpacing(0f, LINE_SPACING)
            .setIncludePad(false)
            .setEllipsize(TextUtils.TruncateAt.END)
            .setMaxLines(8)
            .setTextDirection(dir)
            .build()
    }
}
