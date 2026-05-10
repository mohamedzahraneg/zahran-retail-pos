package com.zahran.printbridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM unit tests for [PrintJobParser].  No Android framework
 * classes used here, so these run instantly without Robolectric.
 *
 * Coverage:
 *   1. Happy-path escpos_html job parses fully.
 *   2. Missing payload → ParseResult.Err("missing_payload").
 *   3. Bad JSON → ParseResult.Err("malformed_json").
 *   4. Unknown payload kind → "unsupported_payload_kind".
 *   5. Invalid escpos_html (missing html / bad width_mm) → specific error code.
 *   6. Invalid html paper (not A4/A5) → specific error code.
 *   7. Default copies clamped to 1 when missing or zero.
 *   8. printer.mac / printer.name optional.
 */
class JobParsingTest {

    @Test
    fun `escpos_html happy path parses every field`() {
        val raw = """
            {
              "job_id": "j-1",
              "document_type": "invoice",
              "document_id": "INV-1",
              "template_id": "compact-80",
              "printer_id": "p-1",
              "copies": 2,
              "payload": {
                "kind": "escpos_html",
                "html": "<div>hello</div>",
                "width_mm": 80
              },
              "printer": {
                "mac": "AA:BB:CC:DD:EE:FF",
                "name": "3dea"
              },
              "emitted_at": "2026-05-10T20:00:00Z"
            }
        """.trimIndent()

        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Ok)
        val job = (r as ParseResult.Ok).job
        assertEquals("j-1", job.jobId)
        assertEquals(DocumentType.INVOICE, job.documentType)
        assertEquals("INV-1", job.documentId)
        assertEquals("compact-80", job.templateId)
        assertEquals("p-1", job.printerId)
        assertEquals(2, job.copies)
        assertEquals(PayloadKind.ESCPOS_HTML, job.payloadKind)
        assertEquals("<div>hello</div>", job.payloadHtml)
        assertEquals(80, job.payloadWidthMm)
        assertEquals("AA:BB:CC:DD:EE:FF", job.printerMac)
        assertEquals("3dea", job.printerName)
    }

    @Test
    fun `missing payload returns missing_payload error`() {
        val raw = """{"job_id":"x","document_id":"y"}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Err)
        assertEquals("missing_payload", (r as ParseResult.Err).errorCode)
    }

    @Test
    fun `malformed JSON returns malformed_json error`() {
        val r = PrintJobParser.parse("not json {{{")
        assertTrue(r is ParseResult.Err)
        assertEquals("malformed_json", (r as ParseResult.Err).errorCode)
    }

    @Test
    fun `unknown payload kind returns unsupported_payload_kind`() {
        val raw = """{"payload":{"kind":"banana"}}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Err)
        assertEquals("unsupported_payload_kind", (r as ParseResult.Err).errorCode)
    }

    @Test
    fun `escpos_html missing html returns invalid_escpos_html_payload`() {
        val raw = """{"payload":{"kind":"escpos_html","width_mm":80}}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Err)
        assertEquals("invalid_escpos_html_payload", (r as ParseResult.Err).errorCode)
    }

    @Test
    fun `escpos_html with bad width returns invalid_escpos_html_payload`() {
        val raw = """{"payload":{"kind":"escpos_html","html":"x","width_mm":42}}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Err)
        assertEquals("invalid_escpos_html_payload", (r as ParseResult.Err).errorCode)
    }

    @Test
    fun `html with bad paper returns invalid_html_payload`() {
        val raw = """{"payload":{"kind":"html","html":"x","paper":"A0"}}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Err)
        assertEquals("invalid_html_payload", (r as ParseResult.Err).errorCode)
    }

    @Test
    fun `escpos_raw and pdf parse without error but mark unsupported in router-side check`() {
        // Parser succeeds — the bridge handler decides whether the
        // MVP supports the kind.  This is intentional: parser =
        // shape; handler = capability.
        for (raw in listOf(
            """{"payload":{"kind":"escpos_raw","bytes_base64":"AA=="}}""",
            """{"payload":{"kind":"pdf","pdf_base64":"AA==","paper":"A4"}}""",
        )) {
            val r = PrintJobParser.parse(raw)
            assertTrue(r is ParseResult.Ok)
        }
    }

    @Test
    fun `copies clamps to 1 for missing or non-positive values`() {
        val r1 = PrintJobParser.parse("""{"payload":{"kind":"escpos_html","html":"x","width_mm":80}}""")
        val r2 = PrintJobParser.parse("""{"copies":0,"payload":{"kind":"escpos_html","html":"x","width_mm":80}}""")
        val r3 = PrintJobParser.parse("""{"copies":-5,"payload":{"kind":"escpos_html","html":"x","width_mm":80}}""")
        for (r in listOf(r1, r2, r3)) {
            assertTrue(r is ParseResult.Ok)
            assertEquals(1, (r as ParseResult.Ok).job.copies)
        }
    }

    @Test
    fun `printer object optional`() {
        val raw = """{"payload":{"kind":"escpos_html","html":"x","width_mm":80}}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Ok)
        val job = (r as ParseResult.Ok).job
        assertNull(job.printerMac)
        assertNull(job.printerName)
    }

    @Test
    fun `unknown document_type maps to UNKNOWN enum`() {
        val raw = """{"document_type":"future_unknown","payload":{"kind":"escpos_html","html":"x","width_mm":80}}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Ok)
        assertEquals(DocumentType.UNKNOWN, (r as ParseResult.Ok).job.documentType)
    }

    @Test
    fun `auto-generated job_id when missing`() {
        val raw = """{"payload":{"kind":"escpos_html","html":"x","width_mm":80}}"""
        val r = PrintJobParser.parse(raw)
        assertTrue(r is ParseResult.Ok)
        val id = (r as ParseResult.Ok).job.jobId
        assertNotNull(id)
        assertTrue(id.isNotBlank())
    }
}
