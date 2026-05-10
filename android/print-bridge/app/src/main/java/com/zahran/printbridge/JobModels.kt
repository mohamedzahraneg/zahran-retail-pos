package com.zahran.printbridge

import org.json.JSONException
import org.json.JSONObject

/**
 * Shared models that mirror the FE Phase-1 PrintJob shape exactly.
 *
 *   FE: frontend/src/lib/printers/types.ts
 *
 * We accept JSON, parse it defensively, and surface a typed
 * [ParseResult] so the caller can return a structured error response
 * to the FE instead of crashing the bridge.  Anything we don't
 * recognise becomes [PayloadKind.UNSUPPORTED] — the bridge then
 * responds with `error_code = "unsupported_payload_kind"` and the FE
 * falls back to its browser-print path.
 */

/** Document categories the FE may send.  Matches `DocumentType` in types.ts. */
enum class DocumentType(val wire: String) {
    INVOICE("invoice"),
    RETURN("return"),
    EXCHANGE("exchange"),
    EXPENSE("expense"),
    SHIFT_CLOSE("shift_close"),
    GENERAL_REPORT("general_report"),
    VOUCHER("voucher"),
    RESERVATION("reservation"),
    BARCODE_LABEL("barcode_label"),
    UNKNOWN("unknown");

    companion object {
        fun from(s: String?): DocumentType =
            entries.firstOrNull { it.wire == s } ?: UNKNOWN
    }
}

/** Payload kinds the FE may send.  Phase-2 MVP supports `escpos_html`. */
enum class PayloadKind(val wire: String) {
    ESCPOS_HTML("escpos_html"),
    ESCPOS_RAW("escpos_raw"),
    PDF("pdf"),
    HTML("html"),
    UNSUPPORTED("unsupported");

    companion object {
        fun from(s: String?): PayloadKind =
            entries.firstOrNull { it.wire == s } ?: UNSUPPORTED
    }
}

/**
 * A parsed print job ready for the printer module.  Fields not
 * needed by the printer (template_id, copies above 1, etc.) are
 * preserved so future phases can light them up without re-parsing.
 */
data class PrintJob(
    val jobId: String,
    val documentType: DocumentType,
    val documentId: String,
    val templateId: String?,
    val printerId: String?,
    /** Always >= 1 even if the FE sent 0 / negative / missing. */
    val copies: Int,
    val payloadKind: PayloadKind,
    /** HTML body for `escpos_html` and `html` kinds; null otherwise. */
    val payloadHtml: String?,
    /** Width in mm for `escpos_html`; 80 / 58.  Null for non-thermal. */
    val payloadWidthMm: Int?,
    /** Paper for `html` / `pdf`; "A4" / "A5".  Null for thermal. */
    val payloadPaper: String?,
    /** Optional explicit MAC the FE wants us to use (test-print path). */
    val printerMac: String?,
    /** Optional human-readable name (display only). */
    val printerName: String?,
    val emittedAt: String?,
)

/** Parse outcome — the bridge should always respond, never throw. */
sealed class ParseResult {
    data class Ok(val job: PrintJob) : ParseResult()
    data class Err(val errorCode: String, val message: String) : ParseResult()
}

object PrintJobParser {

    /**
     * Parse a JSON string into a [PrintJob].  Forgiving on every
     * optional field (returns sensible defaults) but strict on the
     * fields the printer module actually needs to print:
     *
     *   · `payload.kind` must be one of the recognised kinds.
     *   · For `escpos_html`: `payload.html` is a non-null string
     *     and `payload.width_mm` ∈ {80, 58}.
     *   · For `html`: `payload.html` and `payload.paper` ∈ {"A4","A5"}.
     */
    fun parse(raw: String): ParseResult {
        val root: JSONObject = try {
            JSONObject(raw)
        } catch (e: JSONException) {
            return ParseResult.Err(
                "malformed_json",
                "Request body is not valid JSON: ${e.message ?: "?"}",
            )
        }

        val payload = root.optJSONObject("payload")
            ?: return ParseResult.Err(
                "missing_payload",
                "Field `payload` is required.",
            )

        val kind = PayloadKind.from(payload.optString("kind").ifBlank { null })

        // Payload-kind-specific validation.
        var html: String? = null
        var widthMm: Int? = null
        var paper: String? = null
        when (kind) {
            PayloadKind.ESCPOS_HTML -> {
                html = payload.optString("html").ifBlank { null }
                widthMm = payload.optInt("width_mm", -1).takeIf { it == 80 || it == 58 }
                if (html == null || widthMm == null) {
                    return ParseResult.Err(
                        "invalid_escpos_html_payload",
                        "escpos_html payload requires non-empty html + width_mm in {80, 58}.",
                    )
                }
            }
            PayloadKind.HTML -> {
                html = payload.optString("html").ifBlank { null }
                paper = payload.optString("paper").ifBlank { null }
                if (html == null || (paper != "A4" && paper != "A5")) {
                    return ParseResult.Err(
                        "invalid_html_payload",
                        "html payload requires non-empty html + paper in {A4, A5}.",
                    )
                }
            }
            PayloadKind.ESCPOS_RAW, PayloadKind.PDF -> {
                // Recognised but not implemented in the MVP — the
                // bridge will respond with `unsupported_payload_kind`
                // so the FE falls back to its browser-print path.
                // Parsing succeeds; the printer module decides.
            }
            PayloadKind.UNSUPPORTED -> {
                return ParseResult.Err(
                    "unsupported_payload_kind",
                    "Unknown payload.kind. Supported: escpos_html, html (MVP).",
                )
            }
        }

        // Top-level fields.  All defensively defaulted so a
        // partial-but-valid request still parses.
        val printer = root.optJSONObject("printer")
        val printerMac = printer?.optString("mac")?.ifBlank { null }
        val printerName = printer?.optString("name")?.ifBlank { null }

        val job = PrintJob(
            jobId = root.optString("job_id").ifBlank {
                "j_" + System.currentTimeMillis().toString(36)
            },
            documentType = DocumentType.from(
                root.optString("document_type").ifBlank { null },
            ),
            documentId = root.optString("document_id"),
            templateId = root.optString("template_id").ifBlank { null },
            printerId = root.optString("printer_id").ifBlank { null },
            copies = root.optInt("copies", 1).coerceAtLeast(1),
            payloadKind = kind,
            payloadHtml = html,
            payloadWidthMm = widthMm,
            payloadPaper = paper,
            printerMac = printerMac,
            printerName = printerName,
            emittedAt = root.optString("emitted_at").ifBlank { null },
        )
        return ParseResult.Ok(job)
    }
}

/**
 * Standard structured response the bridge emits on every endpoint.
 * Mirrors the FE expectation:
 *
 *   {
 *     ok: true|false,
 *     job_id?: string,
 *     printer_name?: string,
 *     error_code?: string,
 *     message?: string
 *   }
 */
data class BridgeResponse(
    val ok: Boolean,
    val jobId: String? = null,
    val printerName: String? = null,
    val errorCode: String? = null,
    val message: String? = null,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJson(): JSONObject {
        val o = JSONObject()
        o.put("ok", ok)
        if (jobId != null) o.put("job_id", jobId)
        if (printerName != null) o.put("printer_name", printerName)
        if (errorCode != null) o.put("error_code", errorCode)
        if (message != null) o.put("message", message)
        for ((k, v) in extra) o.put(k, v)
        return o
    }

    fun toJsonString(): String = toJson().toString()
}
