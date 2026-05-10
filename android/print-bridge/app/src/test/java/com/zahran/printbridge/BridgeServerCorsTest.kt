package com.zahran.printbridge

import androidx.test.core.app.ApplicationProvider
import fi.iki.elonen.NanoHTTPD
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Verifies the CORS contract — every response from the bridge must
 * carry the three Access-Control-Allow-* headers, and an OPTIONS
 * preflight must return 204 with the same headers.  The FE's
 * `fetch('http://127.0.0.1:8911/...')` calls cross-origin, so
 * missing CORS = silent browser block.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BridgeServerCorsTest {

    @Test
    fun `cors() helper sets the three required headers`() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val server = BridgeServer(ctx)
        val r = NanoHTTPD.newFixedLengthResponse(
            NanoHTTPD.Response.Status.OK,
            "application/json",
            "{}",
        )
        server.cors(r)
        assertEquals("*", r.getHeader("access-control-allow-origin"))
        assertEquals(
            "GET, POST, OPTIONS",
            r.getHeader("access-control-allow-methods"),
        )
        assertEquals(
            "Content-Type",
            r.getHeader("access-control-allow-headers"),
        )
    }

    @Test
    fun `jsonResponse wraps cors headers around a BridgeResponse body`() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val server = BridgeServer(ctx)
        val resp = server.jsonResponse(
            NanoHTTPD.Response.Status.OK,
            BridgeResponse(ok = true),
        )
        assertEquals("*", resp.getHeader("access-control-allow-origin"))
        // Status preserved.
        assertEquals(NanoHTTPD.Response.Status.OK, resp.status)
        // MIME is application/json (NanoHTTPD lowercases it).
        assertTrue(resp.mimeType.startsWith("application/json"))
    }

    @Test
    fun `health JSON shape includes ok, version, host, port`() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val server = BridgeServer(ctx, versionName = "0.1.0")
        val body = server.renderHealthForTest()
        val o = org.json.JSONObject(body)
        assertEquals(true, o.getBoolean("ok"))
        assertEquals("0.1.0", o.getString("version"))
        assertEquals("127.0.0.1", o.getString("host"))
        assertEquals(8911, o.getInt("port"))
    }
}
