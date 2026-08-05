//! Serial port handling
//!
//! Provides low-level serial port access for ECU communication.

use serialport::{SerialPort, SerialPortInfo, SerialPortType};
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
use std::time::Duration;

use super::{ProtocolError, DEFAULT_BAUD_RATE};

/// Information about an available serial port
#[derive(Debug, Clone)]
pub struct PortInfo {
    /// Port name (e.g., "/dev/ttyUSB0" or "COM3")
    pub name: String,

    /// USB vendor ID (if USB device)
    pub vid: Option<u16>,

    /// USB product ID (if USB device)
    pub pid: Option<u16>,

    /// Manufacturer name (if available)
    pub manufacturer: Option<String>,

    /// Product name (if available)
    pub product: Option<String>,

    /// Serial number (if available)
    pub serial_number: Option<String>,
}

impl From<SerialPortInfo> for PortInfo {
    fn from(info: SerialPortInfo) -> Self {
        let (vid, pid, manufacturer, product, serial_number) = match info.port_type {
            SerialPortType::UsbPort(usb_info) => (
                Some(usb_info.vid),
                Some(usb_info.pid),
                usb_info.manufacturer,
                usb_info.product,
                usb_info.serial_number,
            ),
            _ => (None, None, None, None, None),
        };

        Self {
            name: info.port_name,
            vid,
            pid,
            manufacturer,
            product,
            serial_number,
        }
    }
}

/// Helper used to sort port names so that:
///  - ttyACM* ports come first (sorted numerically by suffix)
///  - then ttyUSB* ports (sorted numerically)
///  - then other ports (sorted by name)
fn port_sort_key(name: &str) -> (u8, usize, String) {
    let basename = name.rsplit('/').next().unwrap_or(name);
    if let Some(rest) = basename.strip_prefix("ttyACM") {
        let num = rest.parse::<usize>().unwrap_or(usize::MAX);
        return (0, num, basename.to_string());
    }
    if let Some(rest) = basename.strip_prefix("ttyUSB") {
        let num = rest.parse::<usize>().unwrap_or(usize::MAX);
        return (1, num, basename.to_string());
    }
    (2, 0, basename.to_string())
}

/// List all available serial ports, with /dev fallbacks and deterministic ordering
pub fn list_ports() -> Vec<PortInfo> {
    // Collect from serialport API
    let mut map: HashMap<String, PortInfo> = HashMap::new();
    for info in serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
    {
        let p = PortInfo::from(info);
        map.entry(p.name.clone()).or_insert(p);
    }

    // Linux-only: Add /dev/ttyACM* and /dev/ttyUSB* entries if present but not found by API
    #[cfg(target_os = "linux")]
    if let Ok(entries) = fs::read_dir("/dev") {
        for entry in entries.flatten() {
            if let Some(fname) = entry.file_name().to_str() {
                if fname.starts_with("ttyACM") || fname.starts_with("ttyUSB") {
                    let full = format!("/dev/{}", fname);
                    map.entry(full.clone()).or_insert_with(|| PortInfo {
                        name: full,
                        vid: None,
                        pid: None,
                        manufacturer: None,
                        product: None,
                        serial_number: None,
                    });
                }
            }
        }
    }

    // Collect and sort deterministically
    let mut v: Vec<PortInfo> = map.into_values().collect();
    v.sort_by_key(|p| port_sort_key(&p.name));
    v
}

/// Open a serial port with default settings
pub fn open_port(name: &str, baud_rate: Option<u32>) -> Result<Box<dyn SerialPort>, ProtocolError> {
    let baud = baud_rate.unwrap_or(DEFAULT_BAUD_RATE);

    // Use short timeout (100ms) for responsive non-blocking reads
    // This matches the behavior that works in standalone test
    serialport::new(name, baud)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| ProtocolError::SerialError(e.to_string()))
}

/// Configure a serial port for ECU communication
pub fn configure_port(port: &mut dyn SerialPort) -> Result<(), ProtocolError> {
    // Standard 8N1 configuration
    port.set_data_bits(serialport::DataBits::Eight)
        .map_err(|e| ProtocolError::SerialError(e.to_string()))?;
    port.set_parity(serialport::Parity::None)
        .map_err(|e| ProtocolError::SerialError(e.to_string()))?;
    port.set_stop_bits(serialport::StopBits::One)
        .map_err(|e| ProtocolError::SerialError(e.to_string()))?;
    port.set_flow_control(serialport::FlowControl::None)
        .map_err(|e| ProtocolError::SerialError(e.to_string()))?;

    // Deassert DTR so opening the port does not reset the ECU.
    //
    // On Arduino-derived boards — which covers most Speeduino hardware — the
    // DTR line is capacitor-coupled to RESET, so asserting it pulses the board
    // into reset. That is how the bootloader is normally entered.
    //
    // This previously asserted DTR, with a comment claiming that *prevented*
    // the reset. It does the opposite. Observed on a Speeduino 2025.01:
    // connecting reset the ECU every time, which is why a handshake sent
    // immediately after opening the port was lost, and — the reason this
    // matters beyond timing — **connecting while the engine was running
    // stopped the engine**. TunerStudio connects to the same board without
    // disturbing it.
    //
    // Deasserting also leaves the reset line alone for boards that do not use
    // the auto-reset circuit at all, so this is not Arduino-specific.
    if let Err(e) = port.write_data_terminal_ready(false) {
        tracing::debug!("configure_port: failed to clear DTR: {} (continuing)", e);
    } else {
        tracing::debug!("configure_port: DTR deasserted (no ECU reset)");
    }

    // Likewise for RTS: some USB-serial adaptors wire it to reset as well, and
    // flow control is disabled above, so nothing needs it asserted.
    if let Err(e) = port.write_request_to_send(false) {
        tracing::debug!("configure_port: failed to clear RTS: {} (continuing)", e);
    } else {
        tracing::debug!("configure_port: RTS deasserted");
    }

    Ok(())
}

/// Clear the serial port buffers
pub fn clear_buffers(port: &mut dyn SerialPort) -> Result<(), ProtocolError> {
    port.clear(serialport::ClearBuffer::All)
        .map_err(|e| ProtocolError::SerialError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_ports() {
        // This test just ensures the function doesn't panic
        let ports = list_ports();
        for port in &ports {
            println!("Found port: {} - {:?}", port.name, port.product);
        }
    }

    #[test]
    fn test_port_sorting() {
        let names = vec![
            "/dev/ttyUSB1",
            "/dev/ttyACM1",
            "/dev/ttyUSB0",
            "/dev/ttyACM0",
            "/dev/someport",
            "/dev/ttyACM10",
        ];
        let mut ports: Vec<PortInfo> = names
            .into_iter()
            .map(|n| PortInfo {
                name: n.to_string(),
                vid: None,
                pid: None,
                manufacturer: None,
                product: None,
                serial_number: None,
            })
            .collect();

        ports.sort_by_key(|p| port_sort_key(&p.name));
        let ordered: Vec<String> = ports.into_iter().map(|p| p.name).collect();

        assert_eq!(
            ordered,
            vec![
                "/dev/ttyACM0",
                "/dev/ttyACM1",
                "/dev/ttyACM10",
                "/dev/ttyUSB0",
                "/dev/ttyUSB1",
                "/dev/someport",
            ]
        );
    }
}
