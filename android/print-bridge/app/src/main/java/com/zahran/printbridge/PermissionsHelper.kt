package com.zahran.printbridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Centralised runtime-permission decisions.  Two checks the UI cares
 * about:
 *   1. BLUETOOTH_CONNECT (+ BLUETOOTH_SCAN) on Android 12+ — without
 *      these the bridge can't list bonded devices or open RFCOMM.
 *   2. POST_NOTIFICATIONS on Android 13+ — without this the
 *      foreground-service notification is silently suppressed.
 *
 * Older OS versions return `true` because the underlying perms are
 * normal-protection (auto-granted).
 */
object PermissionsHelper {

    /** All runtime permissions we need to request together at startup. */
    fun requiredPermissions(): Array<String> {
        val list = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            list += Manifest.permission.BLUETOOTH_CONNECT
            list += Manifest.permission.BLUETOOTH_SCAN
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            list += Manifest.permission.POST_NOTIFICATIONS
        }
        return list.toTypedArray()
    }

    fun bluetoothGranted(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(
            ctx, Manifest.permission.BLUETOOTH_CONNECT,
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun notificationsGranted(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            ctx, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun allGranted(ctx: Context): Boolean =
        bluetoothGranted(ctx) && notificationsGranted(ctx)
}
