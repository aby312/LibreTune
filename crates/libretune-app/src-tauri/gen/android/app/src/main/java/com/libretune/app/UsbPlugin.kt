package com.libretune.app

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber

@InvokeArg
class DeviceArgs {
    var deviceName: String = ""
}

@InvokeArg
class OpenArgs {
    var deviceName: String = ""
    var baud: Int = 115200
    var delayAfterOpenMs: Long = 1000
}

@InvokeArg
class QueryArgs {
    var command: String = "Q"
    var count: Int = 1
    var timeoutMs: Long = 1000
}

/**
 * Phase 0 USB spike. Read-only by construction: the only bytes this plugin
 * will ever write to the ECU are the signature ('Q') and version ('S')
 * queries; anything else is rejected before it reaches the port.
 */
@TauriPlugin
class UsbPlugin(private val activity: Activity) : Plugin(activity) {
    private val manager get() = activity.getSystemService(Context.USB_SERVICE) as UsbManager
    private var port: UsbSerialPort? = null

    private fun find(name: String): UsbDevice? = manager.deviceList.values.firstOrNull { it.deviceName == name }

    @Command
    fun ping(invoke: Invoke) {
        invoke.resolve(JSObject().put("t", System.nanoTime() / 1000))
    }

    @Command
    fun listDevices(invoke: Invoke) {
        val arr = JSArray()
        for (d in manager.deviceList.values) {
            val o = JSObject()
            o.put("deviceName", d.deviceName)
            o.put("vendorId", d.vendorId)
            o.put("productId", d.productId)
            o.put("product", d.productName ?: "")
            o.put("manufacturer", d.manufacturerName ?: "")
            o.put("hasPermission", manager.hasPermission(d))
            o.put("supported", UsbSerialProber.getDefaultProber().probeDevice(d) != null)
            arr.put(o)
        }
        invoke.resolve(JSObject().put("devices", arr))
    }

    @Command
    fun requestPermission(invoke: Invoke) {
        val args = invoke.parseArgs(DeviceArgs::class.java)
        val dev = find(args.deviceName) ?: return invoke.reject("device not found")
        if (manager.hasPermission(dev)) return invoke.resolve(JSObject().put("granted", true))
        val action = "com.libretune.app.USB_PERMISSION"
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                activity.unregisterReceiver(this)
                invoke.resolve(JSObject().put("granted", i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)))
            }
        }
        ContextCompat.registerReceiver(activity, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(activity, 0, Intent(action).setPackage(activity.packageName), flags)
        manager.requestPermission(dev, pi)
    }

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        val dev = find(args.deviceName) ?: return invoke.reject("device not found")
        val driver = UsbSerialProber.getDefaultProber().probeDevice(dev) ?: return invoke.reject("no USB-serial driver for this device")
        val conn = manager.openDevice(dev) ?: return invoke.reject("openDevice failed (permission?)")
        try {
            port?.close()
            val p = driver.ports[0]
            p.open(conn)
            p.setParameters(args.baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            // Opening asserts DTR, which resets an Arduino Mega: wait it out.
            Thread.sleep(args.delayAfterOpenMs)
            try { p.purgeHwBuffers(true, true) } catch (_: Exception) {}
            port = p
            invoke.resolve(JSObject().put("driver", driver.javaClass.simpleName))
        } catch (e: Exception) {
            invoke.reject("open failed: ${e.message}")
        }
    }

    /** One round trip: write [cmd], collect bytes until 40 ms of silence. */
    private fun roundTrip(p: UsbSerialPort, cmd: Byte, timeoutMs: Long, out: java.io.ByteArrayOutputStream): Pair<Double, Double> {
        val buf = ByteArray(256)
        val t0 = System.nanoTime()
        p.write(byteArrayOf(cmd), 200)
        var first = -1.0
        var last = t0
        while (true) {
            val n = p.read(buf, 20)
            val now = System.nanoTime()
            if (n > 0) {
                if (first < 0) first = (now - t0) / 1e6
                out.write(buf, 0, n)
                last = now
            } else if (first >= 0 && (now - last) > 40_000_000L) break
            else if ((now - t0) > timeoutMs * 1_000_000L) break
        }
        return Pair(first, (last - t0) / 1e6)
    }

    @Command
    fun query(invoke: Invoke) {
        val args = invoke.parseArgs(QueryArgs::class.java)
        if (args.command != "Q" && args.command != "S") return invoke.reject("only Q (signature) and S (version) are allowed")
        val p = port ?: return invoke.reject("port not open")
        try {
            val firsts = JSArray()
            val totals = JSArray()
            var reply = ""
            for (i in 0 until args.count.coerceIn(1, 500)) {
                val out = java.io.ByteArrayOutputStream()
                val (f, t) = roundTrip(p, args.command[0].code.toByte(), args.timeoutMs, out)
                firsts.put(f)
                totals.put(t)
                reply = String(out.toByteArray(), Charsets.ISO_8859_1)
            }
            invoke.resolve(JSObject().put("reply", reply).put("firstByteMs", firsts).put("totalMs", totals))
        } catch (e: Exception) {
            invoke.reject("query failed: ${e.message}")
        }
    }

    @Command
    fun close(invoke: Invoke) {
        try { port?.close() } catch (_: Exception) {}
        port = null
        invoke.resolve()
    }
}
