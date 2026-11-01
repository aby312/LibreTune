//! save_tune, save_tune_as and save_tune_copy commands (extracted from lib.rs).
//!
//! # AppState lock order
//!
//! `definition` -> `tune_cache` -> `current_tune` -> `current_tune_path` ->
//! `current_project`
//!
//! This is the canonical order for the tune-save/tune-load pair. It extends the
//! `definition` -> `current_project` rule `project_mgmt.rs` documents, and it is
//! what `use_project_tune` (`tune_misc.rs`) and `load_tune` must respect too:
//! `save_tune` used to hold `current_tune_path` while waiting for
//! `current_project` while `load_tune` held `current_project` and then waited on
//! `current_tune_path`, closing an AB-BA cycle across a blocking disk write.
//! `tokio::Mutex` is FIFO-fair, so neither side would have yielded.
//!
//! Belt and braces on this side: `save_tune` now clones out of
//! `current_tune_path` and releases it immediately, so it never holds that lock
//! while waiting for anything, and it drops every guard before the blocking
//! `TuneFile::save` runs on a `spawn_blocking` worker.

use std::path::PathBuf;

use crate::AppState;

#[tauri::command]
pub async fn save_tune(
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<String, String> {
    save_tune_inner(&state, path, true).await
}

/// Writes a copy of the current tune to `path` (e.g. a backup taken before an
/// INI switch) without making it the tune's save target: later saves still go
/// to the tune's own file, and the unsaved-changes flag is left alone.
#[tauri::command]
pub async fn save_tune_copy(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    save_tune_inner(&state, Some(path), false).await
}

/// The body of [`save_tune`], reachable without a `tauri::State` so the lock
/// order above is unit-testable. `make_current` re-points the tune at the file
/// just written (Save / Save As); a plain copy leaves it where it was.
pub(crate) async fn save_tune_inner(
    state: &AppState,
    path: Option<String>,
    make_current: bool,
) -> Result<String, String> {
    // Lock order: see the module comment.
    let def_guard = state.definition.lock().await;
    let cache_guard = state.tune_cache.lock().await;
    let mut tune_guard = state.current_tune.lock().await;
    // Cloned and released rather than held: nothing below reads it again, and
    // holding it across the `current_project` acquire is half of the AB-BA
    // cycle against `load_tune`.
    let existing_path = state.current_tune_path.lock().await.as_ref().cloned();

    let tune = tune_guard.as_mut().ok_or("No tune loaded")?;
    let def = def_guard.as_ref().ok_or("Definition not loaded")?;

    // Write TuneCache data to TuneFile before saving (ensures offline changes are saved)
    if let Some(cache) = cache_guard.as_ref() {
        // Copy all pages from cache to tune file
        for page_num in 0..def.n_pages {
            if let Some(page_data) = cache.get_page(page_num) {
                tune.pages.insert(page_num, page_data.to_vec());
            }
        }

        // Read constants from cache and add to tune file
        use libretune_core::tune::TuneValue;
        let mut constants_saved = 0;

        for (name, constant) in &def.constants {
            // Skip PC variables - they're stored separately
            if constant.is_pc_variable {
                // Get PC variable from local_values
                if let Some(value) = cache.local_values.get(name) {
                    tune.set_constant_with_page(
                        name.clone(),
                        TuneValue::Scalar(*value),
                        constant.page,
                    );
                    constants_saved += 1;
                }
                continue;
            }

            // Handle bits constants specially - they have zero size_bytes() but we need to read them
            if constant.data_type == libretune_core::ini::DataType::Bits {
                // Read the byte(s) containing the bits
                let byte_offset = (constant.bit_position.unwrap_or(0) / 8) as u16;
                let bit_in_byte = constant.bit_position.unwrap_or(0) % 8;
                let bit_size = constant.bit_size.unwrap_or(0);
                let bytes_needed = (bit_in_byte + bit_size).div_ceil(8).max(1) as u16;

                if let Some(bytes) =
                    cache.read_bytes(constant.page, constant.offset + byte_offset, bytes_needed)
                {
                    // Extract the bit value
                    let mut bit_val: u32 = 0;
                    let mut bits_remaining = bit_size;
                    let mut current_bit = bit_in_byte;

                    for byte in bytes.iter().take(bytes_needed as usize) {
                        let bits_in_this_byte = bits_remaining.min(8 - current_bit);
                        // Safe shift: ensure we don't shift by 8 or more
                        let mask = if bits_in_this_byte == 0 {
                            0
                        } else if bits_in_this_byte == 8 && current_bit == 0 {
                            // All bits in this byte
                            0xFFu8
                        } else {
                            // bits_in_this_byte is guaranteed to be < 8 here
                            let base_mask = (1u8 << bits_in_this_byte.min(7)) - 1;
                            base_mask << current_bit
                        };
                        let extracted = ((*byte & mask) >> current_bit) as u32;
                        bit_val |= extracted << (bit_size - bits_remaining);

                        bits_remaining = bits_remaining.saturating_sub(bits_in_this_byte);
                        if bits_remaining == 0 {
                            break;
                        }
                        current_bit = 0;
                    }

                    // Convert bit index to string from bit_options
                    let bit_index = bit_val as usize;
                    if bit_index < constant.bit_options.len() {
                        let option_string = constant.bit_options[bit_index].clone();
                        tune.set_constant_with_page(
                            name.clone(),
                            TuneValue::String(option_string),
                            constant.page,
                        );
                        constants_saved += 1;
                    } else {
                        // Out of range - save as numeric index (fallback)
                        tune.set_constant_with_page(
                            name.clone(),
                            TuneValue::Scalar(bit_val as f64),
                            constant.page,
                        );
                        constants_saved += 1;
                    }
                }
                continue;
            }

            // Skip constants with zero size
            let length = constant.size_bytes() as u16;
            if length == 0 {
                continue;
            }

            // Read constant from cache
            let page_state = cache.page_state(constant.page);
            let page_size = cache.page_size(constant.page);
            let page_data_opt = cache.get_page(constant.page);
            let page_data_len = page_data_opt.map(|p| p.len()).unwrap_or(0);

            if name == "veTable" || name == "veRpmBins" || name == "veLoadBins" {
                eprintln!("[DEBUG] save_tune: Attempting to save '{}' - page={}, offset={}, len={}, page_state={:?}, page_size={:?}, page_data_len={}", 
                    name, constant.page, constant.offset, length, page_state, page_size, page_data_len);
            }

            if let Some(raw_data) = cache.read_bytes(constant.page, constant.offset, length) {
                let element_count = constant.shape.element_count();
                let element_size = constant.data_type.size_bytes();

                // Strings are bytes, not numbers, and must not go through the
                // numeric loop below: DataType::String reports a size of 0 and
                // read_from_bytes returns None for it, so every element read
                // failed and was padded to 0.0 - overwriting the string in the
                // tune with an array of zeros, on every save. The Speeduino
                // 202501 INI declares 24 of these (the CAN AUX input aliases).
                // Decoded the same way constants_read and csv_io already do.
                if constant.data_type == libretune_core::ini::DataType::String {
                    let text = String::from_utf8_lossy(raw_data)
                        .trim_end_matches('\0')
                        .to_string();
                    tune.set_constant_with_page(
                        name.clone(),
                        TuneValue::String(text),
                        constant.page,
                    );
                    constants_saved += 1;
                    continue;
                }

                // A numeric element cannot fail to decode here - `length` is
                // `size_bytes()`, which is `element_size * element_count` for
                // every numeric type - so this refuses rather than padding to
                // 0.0. Padding was how the string case above went unnoticed.
                let mut values = Vec::with_capacity(element_count);
                let mut undecodable = None;
                for i in 0..element_count {
                    let offset = i * element_size;
                    match constant
                        .data_type
                        .read_from_bytes(raw_data, offset, def.endianness)
                    {
                        Some(raw_val) => values.push(constant.raw_to_display(raw_val)),
                        None => {
                            undecodable = Some(i);
                            break;
                        }
                    }
                }
                if let Some(i) = undecodable {
                    eprintln!(
                        "[WARN] save_tune: element {i} of {element_count} in '{name}' would                          not decode; leaving the tune's existing value rather than writing                          zeros over it"
                    );
                    continue;
                }

                // Convert to TuneValue format
                let tune_value = if element_count == 1 {
                    TuneValue::Scalar(values[0])
                } else {
                    TuneValue::Array(values)
                };

                tune.set_constant_with_page(name.clone(), tune_value, constant.page);
                constants_saved += 1;

                if name == "veTable" || name == "veRpmBins" || name == "veLoadBins" {
                    eprintln!(
                        "[DEBUG] save_tune: ✓ Saved '{}' - {} elements",
                        name, element_count
                    );
                }
            } else if name == "veTable" || name == "veRpmBins" || name == "veLoadBins" {
                eprintln!("[DEBUG] save_tune: ✗ Failed to read '{}' from cache - page_state={:?}, page_size={:?}, page_data_len={}, required_offset={}", 
                    name, page_state, page_size, page_data_len, constant.offset as usize + length as usize);
            }
        }

        eprintln!(
            "[DEBUG] save_tune: Saved {} constants from cache to tune file",
            constants_saved
        );
    }

    // Update modified timestamp
    tune.touch();

    // Populate INI metadata for version tracking (LibreTune 1.1+)
    // This allows detecting when a tune was created with a different INI version
    let ini_name = state
        .current_project
        .lock()
        .await
        .as_ref()
        .map(|p| p.config.ecu_definition.clone())
        .unwrap_or_else(|| "unknown.ini".to_string());
    tune.ini_metadata = Some(def.generate_ini_metadata(&ini_name));
    tune.constant_manifest = Some(def.generate_constant_manifest());

    // Use provided path, or current path, or generate default
    let save_path = if let Some(p) = path {
        PathBuf::from(p)
    } else if let Some(p) = existing_path {
        p
    } else {
        // Generate default path in projects directory
        let filename = format!("{}.msq", tune.signature.replace(' ', "_"));
        libretune_core::project::Project::projects_dir()
            .map_err(|e| format!("Failed to get projects directory: {}", e))?
            .join(filename)
    };

    // Everything the write needs is now decided. Hand the finished tune to a
    // blocking worker and release every AppState guard first: `create_dir_all`
    // plus `TuneFile::save` is real disk I/O, and the realtime stream takes
    // `current_tune` (and the whole string context takes `definition`,
    // `current_tune` and `current_project`) on a 50 ms deadline.
    let tune_to_write = tune.clone();
    drop(tune_guard);
    drop(cache_guard);
    drop(def_guard);

    let write_path = save_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if let Some(parent) = write_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        tune_to_write
            .save(&write_path)
            .map_err(|e| format!("Failed to save tune: {}", e))
    })
    .await
    .map_err(|e| format!("Tune save task failed: {}", e))??;

    if make_current {
        *state.current_tune_path.lock().await = Some(save_path.clone());
        *state.tune_modified.lock().await = false;
    }

    Ok(save_path.to_string_lossy().to_string())
}

/// Saves the current tune to a specified path.
///
/// Wrapper around save_tune with a required path argument.
///
/// # Arguments
/// * `path` - File path for saving the tune
///
/// Returns: The path where the tune was saved
#[tauri::command]
pub async fn save_tune_as(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    save_tune(state, Some(path)).await
}

#[cfg(test)]
mod string_constant_tests {
    use libretune_core::ini::{Constant, DataType, EcuDefinition, Endianness, Shape};
    use libretune_core::tune::{TuneCache, TuneValue};

    /// The decode save_tune performs for a string constant, isolated. The
    /// command itself needs AppState, so this pins the behaviour that was
    /// wrong: DataType::String reports size 0 and read_from_bytes returns None
    /// for it, so the numeric loop padded every element to 0.0 and overwrote
    /// the string with an array of zeros on every save.
    fn decode(raw: &[u8]) -> String {
        String::from_utf8_lossy(raw)
            .trim_end_matches('\0')
            .to_string()
    }

    #[test]
    fn a_string_constant_decodes_to_its_text_not_zeros() {
        let mut def = EcuDefinition {
            page_sizes: vec![64],
            n_pages: 1,
            ..Default::default()
        };
        let c = Constant {
            name: "AUXin00Alias".to_string(),
            page: 0,
            offset: 0,
            data_type: DataType::String,
            shape: Shape::Array1D(20),
            ..Default::default()
        };
        def.constants.insert(c.name.clone(), c.clone());

        // "Boost" null-padded to the declared 20 bytes, as the ECU stores it.
        let mut page = b"Boost".to_vec();
        page.resize(64, 0);
        let mut cache = TuneCache::from_definition(&def);
        cache.load_page(0, page);

        let length = c.size_bytes() as u16;
        assert_eq!(length, 20, "a string's footprint is one byte per character");
        assert_eq!(
            c.data_type.size_bytes(),
            0,
            "while its element size is 0 - which is what broke the numeric loop"
        );

        let raw = cache.read_bytes(0, 0, length).expect("read");
        assert_eq!(decode(raw), "Boost");

        // What the old code produced instead.
        let old: Vec<f64> = (0..c.shape.element_count())
            .map(|i| {
                c.data_type
                    .read_from_bytes(raw, i * c.data_type.size_bytes(), Endianness::Big)
                    .map(|v| c.raw_to_display(v))
                    .unwrap_or(0.0)
            })
            .collect();
        assert_eq!(
            old,
            vec![0.0; 20],
            "the old path really did turn every string into zeros"
        );
        assert!(matches!(TuneValue::String(decode(raw)), TuneValue::String(s) if s == "Boost"));
    }
}
