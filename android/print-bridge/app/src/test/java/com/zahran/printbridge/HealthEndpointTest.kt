package com.zahran.printbridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the bridge's response shapes.  We don't bind
 * the HTTP socket here — that's covered by manual on-device testing.
 * These tests pin the JSON contract the FE
 * (`frontend/src/lib/printers/bridge.ts`) parses.
 */
class HealthEndpointTest {

    @Test
    fun `BridgeResponse default ok=true serializes as ok-only object`() {
        val r = BridgeResponse(ok = true)
        val o = JSONObject(r.toJsonString())
        assertEquals(true, o.getBoolean("ok"))
        assertTrue(!o.has("error_code"))
        assertTrue(!o.has("message"))
    }

    @Test
    fun `BridgeResponse error response carries error_code and message`() {
        val r = BridgeResponse(
            ok = false,
            jobId = "j-7",
            errorCode = "no_printer",
            message = "No printer selected.",
        )
        val o = JSONObject(r.toJsonString())
        assertEquals(false, o.getBoolean("ok"))
        assertEquals("j-7", o.getString("job_id"))
        assertEquals("no_printer", o.getString("error_code"))
        assertEquals("No printer selected.", o.getString("message"))
    }

    @Test
    fun `BridgeResponse extras are merged into the JSON object`() {
        val r = BridgeResponse(
            ok = true,
            extra = mapOf(
                "version" to "0.1.0",
                "host" to "127.0.0.1",
                "port" to 8911,
            ),
        )
        val o = JSONObject(r.toJsonString())
        assertEquals("0.1.0", o.getString("version"))
        assertEquals("127.0.0.1", o.getString("host"))
        assertEquals(8911, o.getInt("port"))
    }

    @Test
    fun `health URL constants match FE Phase-1 expectations`() {
        // The FE in frontend/src/lib/printers/store.ts hardcodes
        // http://127.0.0.1:8911 as the default; we must too.
        assertEquals("127.0.0.1", BridgeServer.LOOPBACK_HOST)
        assertEquals(8911, BridgeServer.BRIDGE_PORT)
    }
}
