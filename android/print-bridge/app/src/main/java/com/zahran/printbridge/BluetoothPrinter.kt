package com.zahran.printbridge

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.IOException
import java.util.UUID

/**
 * Thin wrapper around [BluetoothSocket] for ESC/POS thermal printers.
 *
 * Connection model: connect → write → flush → close on every job.
 * Persistent sockets are tempting but BT-Classic RFCOMM tends to drop
 * on Android after a few minutes of idle, so we avoid the bookkeeping.
 *
 * Permission model: every call site must verify [Manifest.permission
 * .BLUETOOTH_CONNECT] (Android 12+) was granted.  The methods below
 * return null / throw if the runtime permission is missing — the UI
 * layer catches and surfaces.
 */
class BluetoothPrinter(private val ctx: Context) {

    companion object {
        private const val TAG = "BluetoothPrinter"
        /** Standard SPP profile UUID — matches Xprinter, Epson clones. */
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val CONNECT_RETRIES = 1
        private const val WRITE_CHUNK = 1024
    }

    /** Lightweight DTO used by the bridge `/printers/scan` endpoint. */
    data class PairedDevice(
        val name: String,
        val mac: String,
        val bonded: Boolean,
    )

    private val adapter: BluetoothAdapter? by lazy {
        val mgr = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        mgr?.adapter
    }

    /** True iff BT is enabled AND we hold the runtime permissions. */
    fun isReady(): Boolean {
        val a = adapter ?: return false
        if (!a.isEnabled) return false
        return hasConnectPermission()
    }

    private fun hasConnectPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // Pre-Android-12: legacy normal-permission BLUETOOTH; auto-granted.
            return true
        }
        return ContextCompat.checkSelfPermission(
            ctx,
            Manifest.permission.BLUETOOTH_CONNECT,
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * List bonded (already-paired) BT devices the user could send a
     * print job to.  We do NOT scan for new devices — the user pairs
     * the printer in Android Settings, then the bridge picks it up
     * here.  Returns an empty list when permission is missing or BT
     * is off, never throws.
     */
    @SuppressLint("MissingPermission")  // checked at runtime above
    fun listBonded(): List<PairedDevice> {
        if (!isReady()) return emptyList()
        return try {
            adapter!!.bondedDevices
                .map { d ->
                    PairedDevice(
                        name = d.name ?: "(unnamed)",
                        mac = d.address,
                        bonded = d.bondState == BluetoothDevice.BOND_BONDED,
                    )
                }
                .sortedBy { it.name }
        } catch (e: SecurityException) {
            Log.w(TAG, "listBonded: permission lost mid-call", e)
            emptyList()
        }
    }

    /**
     * Connect to the printer at [mac], write [bytes], flush, close.
     * Retries once on transient [IOException].  Throws on
     * unrecoverable failure with a clear message — the caller wraps
     * that in a [BridgeResponse] for the FE.
     *
     * Time budget: connect ~1–3s, write a few KB ~200ms.  Total
     * within the FE's 8000ms submit timeout with plenty of headroom.
     */
    @SuppressLint("MissingPermission")
    @Throws(IOException::class)
    fun printBytes(mac: String, bytes: ByteArray) {
        if (!isReady()) {
            throw IOException("Bluetooth is not ready (off or permission denied).")
        }
        val device = adapter!!.getRemoteDevice(mac)
        var lastError: IOException? = null
        for (attempt in 0..CONNECT_RETRIES) {
            try {
                writeOnce(device, bytes)
                return
            } catch (e: IOException) {
                Log.w(TAG, "printBytes attempt ${attempt + 1} failed", e)
                lastError = e
                // Sleep briefly before the retry — some printers need
                // a moment after a failed connect before they accept
                // a new socket.
                try {
                    Thread.sleep(250)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw IOException("Interrupted while retrying Bluetooth print.", e)
                }
            }
        }
        throw lastError ?: IOException("Unknown Bluetooth print failure.")
    }

    @SuppressLint("MissingPermission")
    @Throws(IOException::class)
    private fun writeOnce(device: BluetoothDevice, bytes: ByteArray) {
        var socket: BluetoothSocket? = null
        try {
            socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
            // Cancel any in-progress discovery — connect() gets
            // dramatically slower otherwise.  Discovery may not be
            // running, but cancelDiscovery is a no-op if not.
            adapter?.cancelDiscovery()
            socket.connect()                            // blocking
            val out = socket.outputStream
            // Write in chunks so a stalled printer surfaces sooner.
            var off = 0
            while (off < bytes.size) {
                val n = minOf(WRITE_CHUNK, bytes.size - off)
                out.write(bytes, off, n)
                off += n
            }
            out.flush()
        } finally {
            try {
                socket?.close()
            } catch (e: IOException) {
                Log.w(TAG, "Socket close failed (ignored)", e)
            }
        }
    }
}
