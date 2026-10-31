import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UsbDevice {
  deviceName: string;
  vendorId: number;
  productId: number;
  product: string;
  manufacturer: string;
  hasPermission: boolean;
  supported: boolean;
}

const stats = (xs: number[]) => {
  const s = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  if (!s.length) return "n/a";
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  return `min ${s[0].toFixed(1)} / p50 ${q(0.5)} / p95 ${q(0.95)} / max ${s[s.length - 1].toFixed(1)} ms (n=${s.length})`;
};

/**
 * Android Phase 0 spike: list USB devices, ask permission, open the ECU and
 * send the signature (Q) / version (S) query. Read-only; the native side
 * rejects any other command. Shown only on Android.
 */
export default function UsbProbe() {
  const [open, setOpen] = useState(true);
  const [devices, setDevices] = useState<UsbDevice[]>([]);
  const [baud, setBaud] = useState(115200);
  const [log, setLog] = useState<string[]>([]);
  const add = (m: string) => setLog((l) => [...l.slice(-30), m]);
  const run = async (label: string, f: () => Promise<unknown>) => {
    try {
      const r = await f();
      add(`${label}: ${typeof r === "string" ? r : JSON.stringify(r)}`);
      return r;
    } catch (e) {
      add(`${label} ERROR: ${String(e)}`);
    }
  };
  const first = devices[0];

  const bench = async () => {
    const n = 100;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await invoke("usb_ping");
    add(`plugin-call overhead (ping x${n}): ${((performance.now() - t0) / n).toFixed(2)} ms avg`);
    const r = (await invoke("usb_query", { command: "Q", count: 100 })) as {
      firstByteMs: number[];
      totalMs: number[];
    };
    add(`native Q x100 first byte: ${stats(r.firstByteMs)}`);
    add(`native Q x100 complete:   ${stats(r.totalMs)}`);
    const t1 = performance.now();
    const js: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      await invoke("usb_query", { command: "Q", count: 1 });
      js.push(performance.now() - s);
    }
    add(`JS->Rust->Kotlin Q x20 (per-call): ${stats(js)} total ${(performance.now() - t1).toFixed(0)} ms`);
  };

  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 99999, background: "#111e", color: "#eee", font: "12px monospace", padding: 6, maxHeight: open ? "55vh" : undefined, overflow: "auto" }}>
      <div onClick={() => setOpen(!open)}><b>USB probe (Phase 0)</b> {open ? "▾" : "▸"}</div>
      {open && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "4px 0" }}>
            <button onClick={() => run("list", async () => { const r = (await invoke("usb_list")) as { devices: UsbDevice[] }; setDevices(r.devices); return r.devices; })}>List</button>
            <button disabled={!first} onClick={() => run("permission", () => invoke("usb_request_permission", { deviceName: first.deviceName }))}>Permission</button>
            <input type="number" value={baud} onChange={(e) => setBaud(Number(e.target.value))} style={{ width: 90 }} />
            <button disabled={!first} onClick={() => run("open", () => invoke("usb_open", { deviceName: first.deviceName, baud, delayAfterOpenMs: 1500 }))}>Open</button>
            <button onClick={() => run("Q signature", async () => ((await invoke("usb_query", { command: "Q", count: 1 })) as { reply: string }).reply)}>Q</button>
            <button onClick={() => run("S version", async () => ((await invoke("usb_query", { command: "S", count: 1 })) as { reply: string }).reply)}>S</button>
            <button onClick={() => run("bench", bench)}>Bench</button>
            <button onClick={() => run("close", () => invoke("usb_close"))}>Close</button>
          </div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
        </>
      )}
    </div>
  );
}
