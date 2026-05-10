package com.zahran.printbridge

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress

/**
 * NanoHTTPD subclass that owns the four bridge endpoints + CORS.
 * Bound to `127.0.0.1:8911` only, so a malicious LAN device can't
 * reach the print queue.
 *
 * All endpoints respond with a JSON [BridgeResponse] body even on
 * failure — the FE in `frontend/src/lib/printers/bridge.ts` parses
 * the body and surfaces error messages.
 */
class BridgeServer(
    private val ctx: Context,
    /** Selected printer MAC; null until the user picks one in MainActivity. */
    @Volatile var defaultPrinterMac: String? = null,
    @Volatile var defaultPrinterName: String? = null,
    private val versionName: String = "0.1.0",
) : NanoHTTPD(LOOPBACK_HOST, BRIDGE_PORT) {

    companion object {
        const val BRIDGE_PORT = 8911
        const val LOOPBACK_HOST = "127.0.0.1"
        private const val TAG = "BridgeServer"
    }

    private val printer = BluetoothPrinter(ctx)

    @Throws(IOException::class)
    fun startBridge() {
        // Bind to the loopback interface only — never the LAN.
        // `start()` accepts (timeout, daemon) but we use the simpler
        // overload and rely on NanoHTTPD's default constructor which
        // picks the host we passed in.
        start(SOCKET_READ_TIMEOUT, /* daemon = */ true)
        Log.i(TAG, "Bridge listening on http://$LOOPBACK_HOST:$BRIDGE_PORT")
    }

    fun stopBridge() {
        stop()
        Log.i(TAG, "Bridge stopped")
    }

    override fun serve(session: IHTTPSession): Response {
        val method = session.method
        val uri = session.uri

        // CORS preflight — every browser hitting us cross-origin
        // sends this on the first call to /print/jobs.
        if (method == Method.OPTIONS) {
            return cors(newFixedLengthResponse(Response.Status.NO_CONTENT, "text/plain", ""))
        }

        return try {
            when {
                method == Method.GET && uri == "/health" -> handleHealth()
                method == Method.GET && uri == "/printers/scan" -> handleScan()
                method == Method.POST && uri == "/print/test" -> handleTest(session)
                method == Method.POST && uri == "/print/jobs" -> handleJob(session)
                else -> jsonResponse(
                    Response.Status.NOT_FOUND,
                    BridgeResponse(
                        ok = false,
                        errorCode = "not_found",
                        message = "Unknown endpoint: $method $uri",
                    ),
                )
            }
        } catch (t: Throwable) {
            // Last-ditch safety net — every endpoint catches its own
            // exceptions, but if one slips through we still respond
            // with a structured error rather than letting NanoHTTPD
            // emit a stack trace as plain text.
            Log.e(TAG, "Unhandled error in $method $uri", t)
            jsonResponse(
                Response.Status.INTERNAL_ERROR,
                BridgeResponse(
                    ok = false,
                    errorCode = "internal_error",
                    message = t.message ?: t.javaClass.simpleName,
                ),
            )
        }
    }

    // ─── Endpoints ────────────────────────────────────────────────

    private fun handleHealth(): Response {
        val printers = JSONArray()
        for (d in printer.listBonded()) {
            printers.put(
                JSONObject().apply {
                    put("name", d.name)
                    put("mac", d.mac)
                    put("bonded", d.bonded)
                    put("connection", "bluetooth")
                },
            )
        }
        val body = BridgeResponse(
            ok = true,
            extra = mapOf(
                "version" to versionName,
                "printers" to printers,
                "default_printer" to (defaultPrinterMac ?: JSONObject.NULL),
                "host" to LOOPBACK_HOST,
                "port" to BRIDGE_PORT,
            ),
        )
        return jsonResponse(Response.Status.OK, body)
    }

    private fun handleScan(): Response {
        val printers = JSONArray()
        for (d in printer.listBonded()) {
            printers.put(
                JSONObject().apply {
                    put("name", d.name)
                    put("mac", d.mac)
                    put("bonded", d.bonded)
                    put("connection", "bluetooth")
                },
            )
        }
        return jsonResponse(
            Response.Status.OK,
            BridgeResponse(ok = true, extra = mapOf("printers" to printers)),
        )
    }

    private fun handleTest(session: IHTTPSession): Response {
        val body = readBody(session)
        val mac: String?
        val name: String?
        val widthMm: Int
        try {
            val root = if (body.isBlank()) JSONObject() else JSONObject(body)
            val printerObj = root.optJSONObject("printer")
            mac = printerObj?.optString("mac")?.ifBlank { null } ?: defaultPrinterMac
            name = printerObj?.optString("name")?.ifBlank { null } ?: defaultPrinterName
            widthMm = root.optInt("width_mm", 80).takeIf { it == 80 || it == 58 } ?: 80
        } catch (e: Exception) {
            return jsonResponse(
                Response.Status.BAD_REQUEST,
                BridgeResponse(
                    ok = false,
                    errorCode = "malformed_json",
                    message = e.message ?: "Invalid JSON",
                ),
            )
        }

        if (mac == null) {
            return jsonResponse(
                Response.Status.BAD_REQUEST,
                BridgeResponse(
                    ok = false,
                    errorCode = "no_printer",
                    message = "No printer selected (set default in app or pass body.printer.mac).",
                ),
            )
        }

        val widthDots = EscposBitmapEncoder.widthDotsFor(widthMm)
        val bitmap = ReceiptRenderer.renderTestReceipt(
            widthDots = widthDots,
            shopName = "Zahran POS",
            printerName = name ?: "(unnamed)",
        )
        val bytes = EscposBitmapEncoder.encode(bitmap, widthDots)
        return runPrint(mac, name, "test_${System.currentTimeMillis()}", bytes)
    }

    private fun handleJob(session: IHTTPSession): Response {
        val body = readBody(session)
        val parsed = PrintJobParser.parse(body)
        if (parsed is ParseResult.Err) {
            return jsonResponse(
                Response.Status.BAD_REQUEST,
                BridgeResponse(
                    ok = false,
                    errorCode = parsed.errorCode,
                    message = parsed.message,
                ),
            )
        }
        val job = (parsed as ParseResult.Ok).job

        // Phase-2 MVP: only escpos_html is fully implemented.
        if (job.payloadKind != PayloadKind.ESCPOS_HTML) {
            return jsonResponse(
                Response.Status.BAD_REQUEST,
                BridgeResponse(
                    ok = false,
                    jobId = job.jobId,
                    errorCode = "unsupported_payload_kind",
                    message = "MVP supports payload.kind=escpos_html only. Received: ${job.payloadKind.wire}",
                ),
            )
        }

        val mac = job.printerMac ?: defaultPrinterMac
        val name = job.printerName ?: defaultPrinterName
        if (mac == null) {
            return jsonResponse(
                Response.Status.BAD_REQUEST,
                BridgeResponse(
                    ok = false,
                    jobId = job.jobId,
                    errorCode = "no_printer",
                    message = "No printer selected.",
                ),
            )
        }

        val widthDots = EscposBitmapEncoder.widthDotsFor(job.payloadWidthMm ?: 80)
        val bitmap = ReceiptRenderer.renderEscposHtml(widthDots, job.payloadHtml ?: "")
        val bytes = EscposBitmapEncoder.encode(bitmap, widthDots)
        return runPrint(mac, name, job.jobId, bytes, copies = job.copies)
    }

    // ─── Internals ────────────────────────────────────────────────

    private fun runPrint(
        mac: String,
        name: String?,
        jobId: String,
        bytes: ByteArray,
        copies: Int = 1,
    ): Response {
        return try {
            repeat(copies.coerceAtLeast(1)) {
                printer.printBytes(mac, bytes)
            }
            jsonResponse(
                Response.Status.OK,
                BridgeResponse(
                    ok = true,
                    jobId = jobId,
                    printerName = name,
                ),
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "BT permission missing", e)
            jsonResponse(
                Response.Status.FORBIDDEN,
                BridgeResponse(
                    ok = false,
                    jobId = jobId,
                    errorCode = "permission_denied",
                    message = "Grant BLUETOOTH_CONNECT in Android settings.",
                ),
            )
        } catch (e: IOException) {
            Log.e(TAG, "BT print failed", e)
            jsonResponse(
                Response.Status.INTERNAL_ERROR,
                BridgeResponse(
                    ok = false,
                    jobId = jobId,
                    printerName = name,
                    errorCode = "bluetooth_io_error",
                    message = e.message ?: "Bluetooth write failed.",
                ),
            )
        }
    }

    private fun readBody(session: IHTTPSession): String {
        // NanoHTTPD requires us to call parseBody to materialise POST
        // bodies; we discard its file map and read the raw text from
        // the in-memory `postData` it leaves behind.
        val files = HashMap<String, String>()
        return try {
            session.parseBody(files)
            files["postData"] ?: ""
        } catch (e: Exception) {
            Log.w(TAG, "readBody failed: ${e.message}")
            ""
        }
    }

    /**
     * Wrap any [Response] with the standard CORS headers.  The FE is
     * served from `https://pos.turathmasr.com` and will hit the
     * bridge cross-origin; without these headers the browser blocks
     * the response before it reaches `fetch()`.
     */
    internal fun cors(r: Response): Response {
        r.addHeader("Access-Control-Allow-Origin", "*")
        r.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        r.addHeader("Access-Control-Allow-Headers", "Content-Type")
        r.addHeader("Access-Control-Max-Age", "600")
        return r
    }

    internal fun jsonResponse(status: Response.Status, body: BridgeResponse): Response {
        val r = newFixedLengthResponse(status, "application/json", body.toJsonString())
        return cors(r)
    }

    /** Test-only smoke check: build a response without binding the socket. */
    internal fun renderHealthForTest(): String =
        BridgeResponse(
            ok = true,
            extra = mapOf(
                "version" to versionName,
                "host" to LOOPBACK_HOST,
                "port" to BRIDGE_PORT,
            ),
        ).toJsonString()
}

/** Read-timeout for serve-loop sockets, in ms.  Generous so a slow
 *  bridge POST (printer wake-up) doesn't drop. */
private const val SOCKET_READ_TIMEOUT = 10_000

@Suppress("unused") // belt-and-braces for tooling that scans for InetAddress refs.
private val LOOPBACK_INET: InetAddress = InetAddress.getByName(BridgeServer.LOOPBACK_HOST)
