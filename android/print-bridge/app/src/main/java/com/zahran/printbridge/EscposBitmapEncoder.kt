package com.zahran.printbridge

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream

/**
 * ESC/POS bitmap encoder — the most testable piece of the bridge.
 *
 * Pure function `Bitmap → ByteArray`.  No Bluetooth, no Context, no
 * Android framework I/O.  This makes it trivial to unit-test on a
 * plain JVM (Robolectric is needed only because [Bitmap] is an
 * Android class — see EscposBitmapEncoderTest).
 *
 * Strategy:
 *   1. Threshold the bitmap to 1-bit (black if r+g+b < THRESHOLD,
 *      else white).  No dithering — thermal printers don't need it
 *      and the bytes get smaller.
 *   2. Pad the width to a multiple of 8 dots so each printed row
 *      packs into a whole number of bytes.
 *   3. Emit `GS v 0  m  xL xH  yL yH  <data>` — the standard Epson /
 *      Xprinter raster command:
 *        m   = 0  (normal density)
 *        xL/xH = (paddedWidth / 8) split into low/high bytes
 *        yL/yH = bitmap height split into low/high bytes
 *        data  = (paddedWidth/8) * height bytes, MSB-first within byte,
 *                left-to-right pixels, top-to-bottom rows.
 *   4. Optional trailing line feeds + paper cut so the receipt
 *      detaches cleanly.
 *
 * The XP-P323B BT supports `GS v 0` and `GS V 1` (partial cut) per
 * the published Xprinter spec; both are emitted here.  If the cut
 * fails on a clone unit, callers can switch [paperCut] off and feed
 * a few extra lines instead.
 */
object EscposBitmapEncoder {

    /** Threshold for r+g+b sum (0..765); pixels darker than this print black. */
    private const val THRESHOLD = 384

    /**
     * Top-level entry: encode [bitmap] for [widthDots]-wide thermal
     * paper.  Most callers should let [bitmap] be exactly [widthDots]
     * wide (e.g. 576 for 80mm); if it's narrower we right-pad with
     * white, if it's wider we centre-crop.
     *
     * @param bitmap         the receipt bitmap (Argb8888 expected;
     *                       other configs work but are slower)
     * @param widthDots      target paper width in dots — 576 for 80mm
     *                       at 203dpi, 384 for 58mm
     * @param feedLines      lines of paper to feed after the raster
     *                       (default 4: ~5 mm of breathing room)
     * @param paperCut       emit `GS V 1` partial cut at the end
     */
    fun encode(
        bitmap: Bitmap,
        widthDots: Int,
        feedLines: Int = 4,
        paperCut: Boolean = true,
    ): ByteArray {
        require(widthDots > 0) { "widthDots must be > 0" }
        val out = ByteArrayOutputStream()

        // Reset the printer to a clean state — clears any leftover
        // formatting (alignment, double-width, etc.) from the last job.
        out.write(byteArrayOf(0x1B, 0x40))               // ESC @  (init)

        // Set left margin to zero in case the printer was configured
        // otherwise.
        out.write(byteArrayOf(0x1D, 0x4C, 0x00, 0x00))   // GS L 0 0

        encodeRaster(bitmap, widthDots, out)

        // Feed a few lines so the cut happens BELOW the content.
        repeat(feedLines.coerceAtLeast(0)) { out.write(0x0A) } // LF

        if (paperCut) {
            // GS V 1 — partial cut.  The 0x42 / 0x66 variants do a feed-
            // and-cut at once, but `1` is the most widely supported.
            out.write(byteArrayOf(0x1D, 0x56, 0x01))
        }
        return out.toByteArray()
    }

    /**
     * Internal raster encoder — exposed `internal` so the unit test
     * can verify the byte stream without re-implementing the header.
     */
    internal fun encodeRaster(
        bitmap: Bitmap,
        widthDots: Int,
        out: ByteArrayOutputStream,
    ) {
        val srcW = bitmap.width
        val srcH = bitmap.height

        // Effective render width = min(srcW, widthDots) so we don't
        // print past the paper edge.  Pad widthDots to a multiple of 8.
        val effectiveW = minOf(srcW, widthDots)
        val paddedW = ((widthDots + 7) / 8) * 8
        val rowBytes = paddedW / 8

        // ── Header ──
        out.write(0x1D); out.write(0x76); out.write(0x30)            // GS v 0
        out.write(0x00)                                              // m = 0 (normal)
        out.write(rowBytes and 0xFF)                                 // xL
        out.write((rowBytes ushr 8) and 0xFF)                        // xH
        out.write(srcH and 0xFF)                                     // yL
        out.write((srcH ushr 8) and 0xFF)                            // yH

        // ── Raster bytes ──
        // Allocate one row's worth of pixel argbs at a time so we
        // don't pull the entire bitmap into memory if it's large.
        val rowPixels = IntArray(srcW)
        val rowOut = ByteArray(rowBytes)
        for (y in 0 until srcH) {
            bitmap.getPixels(rowPixels, 0, srcW, 0, y, srcW, 1)
            // Reset the row buffer (white = 0).
            for (i in rowOut.indices) rowOut[i] = 0
            for (x in 0 until effectiveW) {
                val argb = rowPixels[x]
                val r = (argb ushr 16) and 0xFF
                val g = (argb ushr 8) and 0xFF
                val b = argb and 0xFF
                if (r + g + b < THRESHOLD) {
                    val byteIdx = x ushr 3              // x / 8
                    val bitIdx = 7 - (x and 7)          // MSB-first
                    rowOut[byteIdx] = (rowOut[byteIdx].toInt() or (1 shl bitIdx)).toByte()
                }
            }
            out.write(rowOut)
        }
    }

    /**
     * Compute the right [widthDots] for a paper width in millimetres,
     * assuming the standard 203dpi (8 dots / mm) thermal head.
     */
    fun widthDotsFor(paperWidthMm: Int): Int = when (paperWidthMm) {
        80 -> 576
        58 -> 384
        else -> paperWidthMm * 8
    }
}
