package com.zahran.printbridge

import android.graphics.Bitmap
import android.graphics.Color
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Unit tests for [EscposBitmapEncoder].
 *
 * Robolectric is required because [Bitmap] is an Android framework
 * class — but the encoder itself never touches the network or
 * Bluetooth, so the tests run in a few hundred milliseconds on a
 * plain JVM.
 *
 * Coverage:
 *   1. Header bytes are exactly the `GS v 0` raster command shape.
 *   2. Width-dots padding rounds up to the next multiple of 8.
 *   3. A single black pixel produces the expected bit set MSB-first.
 *   4. `widthDotsFor(80) == 576`, `widthDotsFor(58) == 384`.
 *   5. The full encoder emits init + raster + cut.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])  // Robolectric stable target
class EscposBitmapEncoderTest {

    @Test
    fun `widthDotsFor maps 80mm and 58mm correctly`() {
        assertEquals(576, EscposBitmapEncoder.widthDotsFor(80))
        assertEquals(384, EscposBitmapEncoder.widthDotsFor(58))
    }

    @Test
    fun `widthDotsFor falls back to mm times 8`() {
        assertEquals(800, EscposBitmapEncoder.widthDotsFor(100))
    }

    @Test
    fun `encode emits init then raster then cut`() {
        val bmp = Bitmap.createBitmap(8, 1, Bitmap.Config.ARGB_8888).apply {
            setPixel(0, 0, Color.BLACK)
        }
        val bytes = EscposBitmapEncoder.encode(bmp, widthDots = 8, feedLines = 0, paperCut = true)
        // Init: ESC @ = 0x1B 0x40
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x40.toByte(), bytes[1])
        // GS L 0 0 = 0x1D 0x4C 0x00 0x00
        assertEquals(0x1D.toByte(), bytes[2])
        assertEquals(0x4C.toByte(), bytes[3])
        // GS v 0 header at offset 6: 0x1D 0x76 0x30
        assertEquals(0x1D.toByte(), bytes[6])
        assertEquals(0x76.toByte(), bytes[7])
        assertEquals(0x30.toByte(), bytes[8])
        // Cut command at the end: GS V 1 = 0x1D 0x56 0x01
        assertEquals(0x1D.toByte(), bytes[bytes.size - 3])
        assertEquals(0x56.toByte(), bytes[bytes.size - 2])
        assertEquals(0x01.toByte(), bytes[bytes.size - 1])
    }

    @Test
    fun `raster header carries correct xL_xH_yL_yH for 16-wide x 3-tall bitmap`() {
        val bmp = Bitmap.createBitmap(16, 3, Bitmap.Config.ARGB_8888)
        // Top-left and bottom-right black; rest white (default).
        bmp.setPixel(0, 0, Color.BLACK)
        bmp.setPixel(15, 2, Color.BLACK)

        val out = java.io.ByteArrayOutputStream()
        EscposBitmapEncoder.encodeRaster(bmp, widthDots = 16, out = out)
        val raster = out.toByteArray()

        // Header: 0x1D 0x76 0x30 m xL xH yL yH
        assertEquals(0x1D.toByte(), raster[0])
        assertEquals(0x76.toByte(), raster[1])
        assertEquals(0x30.toByte(), raster[2])
        assertEquals(0x00.toByte(), raster[3])     // m = 0
        assertEquals(2.toByte(), raster[4])        // xL = 16/8 = 2
        assertEquals(0.toByte(), raster[5])        // xH = 0
        assertEquals(3.toByte(), raster[6])        // yL = height
        assertEquals(0.toByte(), raster[7])        // yH = 0

        // Body: 3 rows × 2 bytes/row.  First row's first byte should
        // have its MSB (bit 7) set — that's pixel (0,0).
        val rowBytes = 2
        val body = raster.copyOfRange(8, 8 + rowBytes * 3)
        assertEquals(rowBytes * 3, body.size)
        // Row 0 byte 0: bit 7 set → 0x80
        assertEquals(0x80.toByte(), body[0])
        assertEquals(0x00.toByte(), body[1])
        // Row 1 all white
        assertEquals(0x00.toByte(), body[2])
        assertEquals(0x00.toByte(), body[3])
        // Row 2 byte 1: bit 0 set (pixel x=15) → 0x01
        assertEquals(0x00.toByte(), body[4])
        assertEquals(0x01.toByte(), body[5])
    }

    @Test
    fun `width padding rounds up to multiple of 8`() {
        // widthDots = 9 → padded to 16 → 2 bytes per row.
        val bmp = Bitmap.createBitmap(9, 1, Bitmap.Config.ARGB_8888)
        bmp.setPixel(0, 0, Color.BLACK)
        val out = java.io.ByteArrayOutputStream()
        EscposBitmapEncoder.encodeRaster(bmp, widthDots = 9, out = out)
        val raster = out.toByteArray()
        // xL = 16/8 = 2 (rounded up from 9 → next multiple of 8 = 16)
        assertEquals(2.toByte(), raster[4])
        // After header: 1 row × 2 bytes
        assertEquals(8 + 2, raster.size)
    }

    @Test
    fun `feedLines emits LF bytes between raster and cut`() {
        val bmp = Bitmap.createBitmap(8, 1, Bitmap.Config.ARGB_8888)
        val bytes = EscposBitmapEncoder.encode(bmp, widthDots = 8, feedLines = 4, paperCut = true)
        // Find the cut sequence at the end.  The four bytes before
        // it should be LF (0x0A) × 4.
        val cutStart = bytes.size - 3
        for (i in cutStart - 4 until cutStart) {
            assertEquals(0x0A.toByte(), bytes[i])
        }
    }

    @Test
    fun `paperCut=false omits the cut command`() {
        val bmp = Bitmap.createBitmap(8, 1, Bitmap.Config.ARGB_8888)
        val bytes = EscposBitmapEncoder.encode(bmp, widthDots = 8, feedLines = 0, paperCut = false)
        // Last byte must NOT be 0x01 (the cut command's payload).
        assertTrue(bytes.last() != 0x01.toByte() || bytes.size < 3)
    }

    @Test
    fun `mostly-white bitmap produces zero-filled body`() {
        val bmp = Bitmap.createBitmap(16, 2, Bitmap.Config.ARGB_8888)
        // bitmap is white by default (0,0,0,0) which under our
        // threshold counts as white — wait, transparent pixels
        // sum to 0 r+g+b, which is < THRESHOLD = 384, so they'd
        // be black.  Fill explicitly with white.
        for (y in 0 until 2) for (x in 0 until 16) bmp.setPixel(x, y, Color.WHITE)
        val out = java.io.ByteArrayOutputStream()
        EscposBitmapEncoder.encodeRaster(bmp, widthDots = 16, out = out)
        val body = out.toByteArray().copyOfRange(8, out.size())
        assertArrayEquals(ByteArray(4) { 0 }, body)
    }
}
