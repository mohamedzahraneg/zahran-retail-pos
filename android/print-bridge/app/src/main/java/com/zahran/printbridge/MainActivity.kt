package com.zahran.printbridge

import android.bluetooth.BluetoothAdapter
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.zahran.printbridge.databinding.ActivityMainBinding
import java.io.IOException
import kotlin.concurrent.thread

/**
 * Main activity for the Print Bridge app.  Five UI sections (see
 * activity_main.xml):
 *
 *   1. Bridge running status + URL
 *   2. Permissions panel (BT + Notifications)
 *   3. Paired-printers list
 *   4. Selected printer + Test Print button
 *
 * Most logic lives in [BridgeService]; the activity just reads /
 * writes the bound service's `selectedMac`/`selectedName` and
 * triggers Bluetooth I/O on a background thread for the test print.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var service: BridgeService? = null
    private val printer by lazy { BluetoothPrinter(applicationContext) }

    private var selectedMac: String? = null
    private var selectedName: String? = null

    private val serviceConn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, ib: IBinder?) {
            val s = (ib as? BridgeService.LocalBinder)?.service()
            service = s
            // Restore the previously selected printer (survives
            // configuration changes; lost on full app kill).
            s?.selectedMac?.let { selectedMac = it }
            s?.selectedName?.let { selectedName = it }
            refreshAll()
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
        }
    }

    private val permsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { _ ->
        // Whatever the user picked, refresh — the labels need to
        // reflect the new state.
        refreshAll()
        if (PermissionsHelper.allGranted(this)) {
            startBridgeService()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnGrant.setOnClickListener { requestPermissions() }
        binding.btnScan.setOnClickListener { refreshPrinterList() }
        binding.btnOpenBtSettings.setOnClickListener {
            try {
                startActivity(Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS))
            } catch (_: Exception) {
                Toast.makeText(this, "Bluetooth settings unavailable", Toast.LENGTH_SHORT).show()
            }
        }
        binding.btnTestPrint.setOnClickListener { onTestPrintClicked() }
    }

    override fun onStart() {
        super.onStart()
        // Kick the service if we already have permissions — don't
        // wait until the user taps "Grant".
        if (PermissionsHelper.allGranted(this)) {
            startBridgeService()
        }
        bindService(
            Intent(this, BridgeService::class.java),
            serviceConn,
            Context.BIND_AUTO_CREATE,
        )
    }

    override fun onResume() {
        super.onResume()
        refreshAll()
    }

    override fun onStop() {
        super.onStop()
        try {
            unbindService(serviceConn)
        } catch (_: IllegalArgumentException) {
            // Service already unbound (e.g. process tear-down).
        }
    }

    // ─── Bridge service control ───────────────────────────────────

    private fun startBridgeService() {
        val intent = Intent(this, BridgeService::class.java).apply {
            action = BridgeService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun requestPermissions() {
        val needed = PermissionsHelper.requiredPermissions().filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isEmpty()) {
            startBridgeService()
            return
        }
        permsLauncher.launch(needed.toTypedArray())
    }

    // ─── UI refresh ───────────────────────────────────────────────

    private fun refreshAll() {
        refreshStatus()
        refreshPermissions()
        refreshPrinterList()
        refreshSelectedPrinter()
    }

    private fun refreshStatus() {
        val running = PermissionsHelper.allGranted(this) &&
            BluetoothAdapter.getDefaultAdapter()?.isEnabled == true
        binding.textStatus.text =
            getString(if (running) R.string.status_running else R.string.status_stopped)
        binding.textStatus.setBackgroundColor(
            if (running) getColor(R.color.status_running_bg)
            else getColor(R.color.status_stopped_bg),
        )
        binding.textStatus.setTextColor(
            if (running) getColor(R.color.status_running_fg)
            else getColor(R.color.status_stopped_fg),
        )
        binding.textStatusUrl.text =
            "http://${BridgeServer.LOOPBACK_HOST}:${BridgeServer.BRIDGE_PORT}"
    }

    private fun refreshPermissions() {
        binding.textPermBt.text = getString(
            if (PermissionsHelper.bluetoothGranted(this)) R.string.permission_bt_granted
            else R.string.permission_bt_denied,
        )
        binding.textPermNotif.text = getString(
            if (PermissionsHelper.notificationsGranted(this)) R.string.permission_notif_granted
            else R.string.permission_notif_denied,
        )
        binding.btnGrant.visibility =
            if (PermissionsHelper.allGranted(this)) View.GONE else View.VISIBLE
    }

    private fun refreshPrinterList() {
        binding.listPrinters.removeAllViews()
        if (!PermissionsHelper.bluetoothGranted(this)) {
            binding.textNoPrinters.visibility = View.GONE
            return
        }
        val printers = printer.listBonded()
        if (printers.isEmpty()) {
            binding.textNoPrinters.visibility = View.VISIBLE
            return
        }
        binding.textNoPrinters.visibility = View.GONE
        for (p in printers) {
            binding.listPrinters.addView(buildPrinterRow(p))
        }
    }

    private fun refreshSelectedPrinter() {
        binding.textSelectedPrinter.text =
            selectedName ?: selectedMac ?: getString(R.string.printer_none_selected)
        binding.btnTestPrint.isEnabled = selectedMac != null
    }

    private fun buildPrinterRow(p: BluetoothPrinter.PairedDevice): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(8, 12, 8, 12)
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            isClickable = true
            isFocusable = true
            setOnClickListener {
                selectedMac = p.mac
                selectedName = p.name
                service?.selectedMac = p.mac
                service?.selectedName = p.name
                refreshSelectedPrinter()
                Toast.makeText(
                    this@MainActivity,
                    "${p.name}",
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }

        val info = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f,
            )
        }
        info.addView(TextView(this).apply {
            text = p.name
            setTextColor(Color.parseColor("#0f172a"))
            textSize = 16f
        })
        info.addView(TextView(this).apply {
            text = p.mac
            setTextColor(Color.parseColor("#475569"))
            textSize = 12f
        })

        val state = TextView(this).apply {
            text = if (p.bonded) "✓" else "—"
            textSize = 16f
            setTextColor(
                if (p.bonded) Color.parseColor("#15803d")
                else Color.parseColor("#94a3b8"),
            )
        }

        row.addView(info)
        row.addView(state)

        // Highlight selection.
        if (p.mac == selectedMac) {
            row.setBackgroundColor(Color.parseColor("#ede9fe"))
        }
        return row
    }

    // ─── Test print ───────────────────────────────────────────────

    private fun onTestPrintClicked() {
        val mac = selectedMac
        val name = selectedName
        if (mac == null) {
            Toast.makeText(this, R.string.toast_no_printer, Toast.LENGTH_SHORT).show()
            return
        }
        binding.btnTestPrint.isEnabled = false
        Toast.makeText(this, R.string.toast_test_started, Toast.LENGTH_SHORT).show()

        thread(name = "test-print", isDaemon = true) {
            try {
                val widthDots = EscposBitmapEncoder.widthDotsFor(80)
                val bitmap = ReceiptRenderer.renderTestReceipt(
                    widthDots = widthDots,
                    shopName = "Zahran POS",
                    printerName = name ?: "(unnamed)",
                )
                val bytes = EscposBitmapEncoder.encode(bitmap, widthDots)
                printer.printBytes(mac, bytes)
                runOnUiThread {
                    binding.btnTestPrint.isEnabled = true
                    Toast.makeText(this, R.string.toast_test_ok, Toast.LENGTH_LONG).show()
                }
            } catch (e: IOException) {
                runOnUiThread {
                    binding.btnTestPrint.isEnabled = true
                    Toast.makeText(
                        this,
                        getString(R.string.toast_test_error, e.message ?: "?"),
                        Toast.LENGTH_LONG,
                    ).show()
                }
            } catch (e: SecurityException) {
                runOnUiThread {
                    binding.btnTestPrint.isEnabled = true
                    Toast.makeText(
                        this,
                        getString(R.string.toast_test_error, "permission missing"),
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }
}
