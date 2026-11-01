//! Phase 0 USB-serial spike (Android only): thin Rust wrappers over the Kotlin
//! `UsbPlugin`. Read-only: the plugin itself refuses anything but `Q`/`S`.

use serde_json::{json, Value};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime, State};

pub struct UsbHandle<R: Runtime>(PluginHandle<R>);
pub struct BtHandle<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("usb")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.libretune.app", "UsbPlugin")?;
                app.manage(UsbHandle(handle));
                let bt = api.register_android_plugin("com.libretune.app", "BtPlugin")?;
                app.manage(BtHandle(bt));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

fn call<R: Runtime>(h: &UsbHandle<R>, cmd: &str, args: Value) -> Result<Value, String> {
    h.0.run_mobile_plugin::<Value>(cmd, args)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn usb_ping(h: State<'_, UsbHandle<tauri::Wry>>) -> Result<Value, String> {
    call(&h, "ping", json!({}))
}

#[tauri::command]
pub fn usb_list(h: State<'_, UsbHandle<tauri::Wry>>) -> Result<Value, String> {
    call(&h, "listDevices", json!({}))
}

#[tauri::command]
pub async fn usb_request_permission(
    h: State<'_, UsbHandle<tauri::Wry>>,
    device_name: String,
) -> Result<Value, String> {
    call(&h, "requestPermission", json!({ "deviceName": device_name }))
}

#[tauri::command]
pub async fn usb_open(
    h: State<'_, UsbHandle<tauri::Wry>>,
    device_name: String,
    baud: u32,
    delay_after_open_ms: u64,
) -> Result<Value, String> {
    call(
        &h,
        "open",
        json!({ "deviceName": device_name, "baud": baud, "delayAfterOpenMs": delay_after_open_ms }),
    )
}

/// `command` must be "Q" (signature) or "S" (version); the Kotlin side enforces it.
#[tauri::command]
pub async fn usb_query(
    h: State<'_, UsbHandle<tauri::Wry>>,
    command: String,
    count: u32,
) -> Result<Value, String> {
    call(&h, "query", json!({ "command": command, "count": count }))
}

#[tauri::command]
pub fn usb_close(h: State<'_, UsbHandle<tauri::Wry>>) -> Result<Value, String> {
    call(&h, "close", json!({}))
}

fn bt_call(h: &BtHandle<tauri::Wry>, cmd: &str, args: Value) -> Result<Value, String> {
    h.0.run_mobile_plugin::<Value>(cmd, args)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bt_request(h: State<'_, BtHandle<tauri::Wry>>) -> Result<Value, String> {
    bt_call(&h, "requestBt", json!({}))
}

#[tauri::command]
pub async fn bt_list(h: State<'_, BtHandle<tauri::Wry>>) -> Result<Value, String> {
    bt_call(&h, "listPaired", json!({}))
}

#[tauri::command]
pub async fn bt_connect(
    h: State<'_, BtHandle<tauri::Wry>>,
    address: String,
) -> Result<Value, String> {
    bt_call(&h, "connect", json!({ "address": address }))
}

/// `command` must be "Q" or "S"; the Kotlin side enforces it.
#[tauri::command]
pub async fn bt_query(
    h: State<'_, BtHandle<tauri::Wry>>,
    command: String,
    count: u32,
) -> Result<Value, String> {
    bt_call(&h, "query", json!({ "command": command, "count": count }))
}

#[tauri::command]
pub async fn bt_close(h: State<'_, BtHandle<tauri::Wry>>) -> Result<Value, String> {
    bt_call(&h, "close", json!({}))
}
