//! Tune info & new tune commands.

use crate::state::AppState;
use libretune_core::tune::TuneFile;
use serde::Serialize;

#[derive(Serialize)]
pub struct TuneInfo {
    pub path: Option<String>,
    pub signature: String,
    pub modified: bool,
    pub has_tune: bool,
}

/// Gets information about the currently loaded tune.
///
/// Returns: TuneInfo with path, signature, and modification status
#[tauri::command]
pub async fn get_tune_info(state: tauri::State<'_, AppState>) -> Result<TuneInfo, String> {
    let tune_guard = crate::commands::w2_probe::hold(&state.current_tune, "current_tune", "commands/tune_info.rs").await;
    let path_guard = state.current_tune_path.lock().await;
    let modified = *crate::commands::w2_probe::hold(&state.tune_modified, "tune_modified", "commands/tune_info.rs").await;

    match &*tune_guard {
        Some(tune) => Ok(TuneInfo {
            path: path_guard.as_ref().map(|p| p.to_string_lossy().to_string()),
            signature: tune.signature.clone(),
            modified,
            has_tune: true,
        }),
        None => Ok(TuneInfo {
            path: None,
            signature: String::new(),
            modified: false,
            has_tune: false,
        }),
    }
}

#[tauri::command]
pub async fn new_tune(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let def_guard = state.definition.lock().await;
    let signature = def_guard
        .as_ref()
        .map(|d| d.signature.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let tune = TuneFile::new(&signature);

    *crate::commands::w2_probe::hold(&state.current_tune, "current_tune", "commands/tune_info.rs").await = Some(tune);
    *state.current_tune_path.lock().await = None;
    *crate::commands::w2_probe::hold(&state.tune_modified, "tune_modified", "commands/tune_info.rs").await = false;

    Ok(())
}
