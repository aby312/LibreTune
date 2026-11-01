package com.libretune.app

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

@InvokeArg
class BtConnectArgs {
    var address: String = ""
}

@InvokeArg
class BtQueryArgs {
    var command: String = "Q"
    var count: Int = 1
    var timeoutMs: Long = 1000
}

/**
 * Phase 0 Bluetooth SPP spike (HC-05/HC-06). Read-only by construction: only
 * the signature ('Q') and version ('S') queries can be written to the ECU.
 * Pair the HC-06 in Android settings first (PIN usually 1234 or 0000).
 */
@TauriPlugin(
    permissions = [Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = "btConnect")]
)
class BtPlugin(private val activity: Activity) : Plugin(activity) {
    private val adapter: BluetoothAdapter? get() =
        (activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private var socket: BluetoothSocket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null
    private val spp: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    private fun needsRuntimePerm() =
        Build.VERSION.SDK_INT >= 31 && getPermissionState("btConnect") != PermissionState.GRANTED

    @Command
    fun requestBt(invoke: Invoke) {
        if (needsRuntimePerm()) requestPermissionForAlias("btConnect", invoke, "btPermCallback")
        else invoke.resolve(JSObject().put("granted", true))
    }

    @PermissionCallback
    fun btPermCallback(invoke: Invoke) {
        invoke.resolve(JSObject().put("granted", !needsRuntimePerm()))
    }

    @Command
    fun listPaired(invoke: Invoke) {
        val a = adapter ?: return invoke.reject("no Bluetooth adapter")
        if (needsRuntimePerm()) return invoke.reject("BLUETOOTH_CONNECT not granted")
        val arr = JSArray()
        try {
            for (d in a.bondedDevices) {
                arr.put(JSObject().put("name", d.name ?: "").put("address", d.address))
            }
        } catch (e: SecurityException) {
            return invoke.reject("permission: ${e.message}")
        }
        invoke.resolve(JSObject().put("devices", arr).put("enabled", a.isEnabled))
    }

    @Command
    fun connect(invoke: Invoke) {
        val args = invoke.parseArgs(BtConnectArgs::class.java)
        val a = adapter ?: return invoke.reject("no Bluetooth adapter")
        try {
            close0()
            a.cancelDiscovery()
            val s = a.getRemoteDevice(args.address).createRfcommSocketToServiceRecord(spp)
            val t0 = System.nanoTime()
            s.connect()
            socket = s
            input = s.inputStream
            output = s.outputStream
            invoke.resolve(JSObject().put("connectMs", (System.nanoTime() - t0) / 1e6))
        } catch (e: Exception) {
            invoke.reject("connect failed: ${e.message}")
        }
    }

    private fun roundTrip(cmd: Byte, timeoutMs: Long, out: java.io.ByteArrayOutputStream): Pair<Double, Double> {
        val i = input!!
        val o = output!!
        val buf = ByteArray(256)
        while (i.available() > 0) i.read(buf) // drop stale bytes
        val t0 = System.nanoTime()
        o.write(cmd.toInt())
        o.flush()
        var first = -1.0
        var last = t0
        while (true) {
            val now = System.nanoTime()
            val n = i.available()
            if (n > 0) {
                val r = i.read(buf, 0, minOf(n, buf.size))
                if (first < 0) first = (now - t0) / 1e6
                out.write(buf, 0, r)
                last = System.nanoTime()
            } else if (first >= 0 && (now - last) > 40_000_000L) break
            else if ((now - t0) > timeoutMs * 1_000_000L) break
            else Thread.sleep(0, 500_000)
        }
        return Pair(first, (last - t0) / 1e6)
    }

    @Command
    fun query(invoke: Invoke) {
        val args = invoke.parseArgs(BtQueryArgs::class.java)
        if (args.command != "Q" && args.command != "S") return invoke.reject("only Q (signature) and S (version) are allowed")
        if (socket == null) return invoke.reject("not connected")
        try {
            val firsts = JSArray()
            val totals = JSArray()
            var reply = ""
            for (n in 0 until args.count.coerceIn(1, 500)) {
                val out = java.io.ByteArrayOutputStream()
                val (f, t) = roundTrip(args.command[0].code.toByte(), args.timeoutMs, out)
                firsts.put(f)
                totals.put(t)
                reply = String(out.toByteArray(), Charsets.ISO_8859_1)
            }
            invoke.resolve(JSObject().put("reply", reply).put("firstByteMs", firsts).put("totalMs", totals))
        } catch (e: Exception) {
            invoke.reject("query failed: ${e.message}")
        }
    }

    private fun close0() {
        try { socket?.close() } catch (_: Exception) {}
        socket = null
        input = null
        output = null
    }

    @Command
    fun close(invoke: Invoke) {
        close0()
        invoke.resolve()
    }
}
