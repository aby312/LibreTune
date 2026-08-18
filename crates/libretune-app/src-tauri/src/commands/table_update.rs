//! Table z-values update command.

use crate::AppState;

/// One cell for [`update_table_cells`].
#[derive(serde::Deserialize)]
pub struct TableCellWrite {
    pub x: usize,
    pub y: usize,
    pub value: f64,
}

/// Write individual table cells as single-value ECU writes (one count=1 `M`
/// frame per cell), mirroring the cache/tune bookkeeping of
/// [`update_table_data`].
///
/// The bulk path sends the whole z-block as a single chunked write. The bench
/// simulator accepts that, but real Speeduino 2025.01 firmware appears to
/// silently ignore multi-value `M` frames: a chunked +10% VE step produced no
/// AFR response on a running engine, while single-value writes verifiably land
/// (RAM readback and autotune autosend both prove that form). Until chunked
/// writes are settled against real firmware, this is the form proven to reach
/// a running engine.
#[tauri::command]
pub async fn update_table_cells(
    state: tauri::State<'_, AppState>,
    table_name: String,
    cells: Vec<TableCellWrite>,
) -> Result<u32, String> {
    let (constant, endianness, default_page_bytes, x_size, y_size) = {
        let def_guard = state.definition.lock().await;
        let def = def_guard.as_ref().ok_or("Definition not loaded")?;

        let table = def
            .get_table_by_name_or_map(&table_name)
            .ok_or_else(|| format!("Table {} not found", table_name))?;

        let constant = def
            .constants
            .get(&table.map)
            .ok_or_else(|| format!("Constant {} not found for table {}", table.map, table_name))?
            .clone();

        let default_page_bytes = def
            .page_sizes
            .get(constant.page as usize)
            .copied()
            .unwrap_or(256) as usize;

        (
            constant,
            def.endianness,
            default_page_bytes,
            table.x_size,
            table.y_size,
        )
    };

    let element_size = constant.data_type.size_bytes();
    let mut conn_guard = state.connection.lock().await;
    let mut cache_guard = state.tune_cache.lock().await;
    let mut tune_guard = state.current_tune.lock().await;
    let mut written = 0u32;

    for cell in &cells {
        if cell.x >= x_size || cell.y >= y_size {
            return Err(format!(
                "Cell ({}, {}) outside {}x{} table",
                cell.x, cell.y, x_size, y_size
            ));
        }
        let idx = cell.y * x_size + cell.x;
        let mut raw = vec![0u8; element_size];
        let raw_val = constant.display_to_raw(cell.value);
        constant
            .data_type
            .write_to_bytes(&mut raw, 0, raw_val, endianness);
        let offset = constant.offset + (idx * element_size) as u16;

        if let Some(cache) = cache_guard.as_mut() {
            cache.write_bytes(constant.page, offset, &raw);
        }
        if let Some(tune) = tune_guard.as_mut() {
            let page_data = tune
                .pages
                .entry(constant.page)
                .or_insert_with(|| vec![0u8; default_page_bytes]);
            let start = offset as usize;
            if start + raw.len() <= page_data.len() {
                page_data[start..start + raw.len()].copy_from_slice(&raw);
            }
            if let Some(libretune_core::tune::TuneValue::Array(values)) =
                tune.constants.get_mut(&constant.name)
            {
                if idx < values.len() {
                    values[idx] = cell.value;
                }
            }
        }
        if let Some(conn) = conn_guard.as_mut() {
            let params = libretune_core::protocol::commands::WriteMemoryParams {
                can_id: 0,
                page: constant.page,
                offset,
                data: raw,
            };
            if let Err(e) = conn.write_memory(params) {
                eprintln!("[WARN] update_table_cells: ECU write failed: {}", e);
            } else {
                written += 1;
            }
        }
    }

    *state.tune_modified.lock().await = true;
    Ok(written)
}

#[tauri::command]
pub async fn update_table_data(
    state: tauri::State<'_, AppState>,
    table_name: String,
    z_values: Vec<Vec<f64>>,
) -> Result<(), String> {
    // Snapshot only what we need from the definition, then drop the lock
    // before doing any ECU I/O below — holding it across a blocking
    // conn.write_memory() call starves every other command that needs the
    // definition. This is the primary table-cell-edit command (the main
    // table editor calls it on every cell edit), so it's likely the single
    // most frequently invoked path that had this bug.
    let (constant, endianness, default_page_bytes) = {
        let def_guard = state.definition.lock().await;
        let def = def_guard.as_ref().ok_or("Definition not loaded")?;

        let table = def
            .get_table_by_name_or_map(&table_name)
            .ok_or_else(|| format!("Table {} not found", table_name))?;

        let constant = def
            .constants
            .get(&table.map)
            .ok_or_else(|| format!("Constant {} not found for table {}", table.map, table_name))?
            .clone();

        let default_page_bytes = def
            .page_sizes
            .get(constant.page as usize)
            .copied()
            .unwrap_or(256) as usize;

        (constant, def.endianness, default_page_bytes)
    };

    // Flatten z_values
    let flat_values: Vec<f64> = z_values.into_iter().flatten().collect();

    if flat_values.len() != constant.shape.element_count() {
        return Err(format!(
            "Invalid data size: expected {}, got {}",
            constant.shape.element_count(),
            flat_values.len()
        ));
    }

    // Convert display values to raw bytes
    let element_size = constant.data_type.size_bytes();
    let mut raw_data = vec![0u8; constant.size_bytes()];

    for (i, val) in flat_values.iter().enumerate() {
        let raw_val = constant.display_to_raw(*val);
        let offset = i * element_size;
        constant
            .data_type
            .write_to_bytes(&mut raw_data, offset, raw_val, endianness);
    }

    let mut conn_guard = state.connection.lock().await;
    let mut cache_guard = state.tune_cache.lock().await;

    // Always write to TuneCache if available (enables offline editing)
    if let Some(cache) = cache_guard.as_mut() {
        if cache.write_bytes(constant.page, constant.offset, &raw_data) {
            // Also update TuneFile in memory
            let mut tune_guard = state.current_tune.lock().await;
            if let Some(tune) = tune_guard.as_mut() {
                // Get or create page data
                let page_data = tune
                    .pages
                    .entry(constant.page)
                    .or_insert_with(|| vec![0u8; default_page_bytes]);

                // Update the page data
                let start = constant.offset as usize;
                let end = start + raw_data.len();
                if end <= page_data.len() {
                    page_data[start..end].copy_from_slice(&raw_data);
                }

                // Offline reads prefer the parsed msq constants over page data,
                // so keep them in sync or edits revert on reload
                tune.constants.insert(
                    constant.name.clone(),
                    libretune_core::tune::TuneValue::Array(flat_values.clone()),
                );
            }

            // Mark tune as modified
            *state.tune_modified.lock().await = true;
        }
    }

    // Write to ECU if connected (optional - offline mode works without this)
    if let Some(conn) = conn_guard.as_mut() {
        let params = libretune_core::protocol::commands::WriteMemoryParams {
            can_id: 0,
            page: constant.page,
            offset: constant.offset,
            data: raw_data.clone(),
        };

        // Read the table straight back. A legacy-protocol write is
        // fire-and-forget, so "the write returned Ok" only ever meant "the
        // bytes left the host" — which is how a corrupted ignition table
        // reached a running engine on 18 Aug 2026 with both writes reported
        // successful. Chunking stops that particular overrun; the read-back is
        // what turns the next silent divergence into a visible error.
        match conn.write_memory_verified(params) {
            Ok(()) => {}
            // The ECU is holding something other than what was sent. This is
            // not a connectivity problem and must not be swallowed: the tune
            // on screen no longer matches the tune the engine is running.
            Err(e @ libretune_core::protocol::ProtocolError::WriteVerificationFailed { .. }) => {
                return Err(format!(
                    "ECU did not store table {table_name} as written — do not \
                     drive on this tune until it is re-sent and verified: {e}"
                ));
            }
            // Anything else (not connected, timeout, dropped adapter) keeps
            // the existing offline-tolerant behaviour: the edit is already in
            // the local tune cache above.
            Err(e) => {
                eprintln!("[WARN] Failed to write to ECU (offline mode?): {}", e);
            }
        }
    }

    Ok(())
}
