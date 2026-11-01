//! Miscellaneous project commands: MSQ info preview, project deletion.

use crate::state::AppState;
use libretune_core::project::Project;
use libretune_core::tune::TuneFile;
use std::path::Path;

/// Get info about an MSQ file without fully loading it (for the open dialog preview)
#[tauri::command]
pub async fn get_msq_info(path: String) -> Result<serde_json::Value, String> {
    let file_path = std::path::Path::new(&path);
    if !file_path.exists() {
        return Err("File not found".to_string());
    }

    let tune = TuneFile::load(file_path).map_err(|e| format!("Failed to read MSQ: {}", e))?;

    let mut info = serde_json::Map::new();
    info.insert(
        "signature".to_string(),
        serde_json::Value::String(tune.signature.clone()),
    );
    info.insert(
        "version".to_string(),
        serde_json::Value::String(tune.version.clone()),
    );
    info.insert(
        "file_name".to_string(),
        serde_json::Value::String(
            file_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        ),
    );
    info.insert(
        "file_size".to_string(),
        serde_json::Value::Number(serde_json::Number::from(
            std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0),
        )),
    );

    // Count constants
    let constant_count = tune.constants.len();
    info.insert(
        "constant_count".to_string(),
        serde_json::Value::Number(serde_json::Number::from(constant_count)),
    );

    // INI metadata if present
    if let Some(ref meta) = tune.ini_metadata {
        info.insert(
            "ini_name".to_string(),
            serde_json::Value::String(meta.name.clone()),
        );
        info.insert(
            "saved_at".to_string(),
            serde_json::Value::String(meta.saved_at.clone()),
        );
    }

    // Author and description
    if let Some(ref author) = tune.author {
        info.insert(
            "author".to_string(),
            serde_json::Value::String(author.to_string()),
        );
    }
    if let Some(ref desc) = tune.description {
        info.insert(
            "description".to_string(),
            serde_json::Value::String(desc.to_string()),
        );
    }

    Ok(serde_json::Value::Object(info))
}

/// Delete the project folder at `path` and all its files.
///
/// `path` is the folder reported by `list_projects`. The display name cannot
/// identify a project: two folders (e.g. a copy kept as a backup) can share one.
#[tauri::command]
pub async fn delete_project(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let base = Project::projects_dir()
        .map_err(|e| format!("Could not locate the projects directory: {}", e))?;

    // Held across the delete so the project cannot be opened in between.
    let proj_guard = state.current_project.lock().await;
    delete_project_dir(
        &base,
        Path::new(&path),
        proj_guard.as_ref().map(|p| p.path.as_path()),
    )
}

/// Delete `path` if it is a project folder (has a `project.json`) sitting
/// directly inside `base`, and is not the `open` project.
///
/// `path` comes from the webview, so it is canonicalised (resolving `..` and
/// symlinks) and checked rather than trusted: nothing outside `base` is touched.
fn delete_project_dir(base: &Path, path: &Path, open: Option<&Path>) -> Result<(), String> {
    let base = base
        .canonicalize()
        .map_err(|_| "Projects directory not found".to_string())?;
    let target = path
        .canonicalize()
        .map_err(|_| format!("Project '{}' not found", path.display()))?;

    if target.parent() != Some(base.as_path()) || !target.join("project.json").is_file() {
        return Err(format!("'{}' is not a project folder", path.display()));
    }

    if open.and_then(|p| p.canonicalize().ok()).as_deref() == Some(target.as_path()) {
        return Err("Cannot delete the currently open project. Close it first.".to_string());
    }

    std::fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete project: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A project folder as `list_projects` sees it: a directory with a project.json.
    fn make_project(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("project.json"), br#"{"name":"NA6"}"#).unwrap();
        fs::write(dir.join("CurrentTune.msq"), b"<msq/>").unwrap();
    }

    #[test]
    fn deletes_only_the_project_at_the_given_path() {
        // Two projects sharing a display name (a folder copied as a backup).
        let base = tempfile::tempdir().unwrap();
        let first = base.path().join("NA6");
        let copy = base.path().join("NA6_backup");
        make_project(&first);
        make_project(&copy);

        delete_project_dir(base.path(), &copy, None).unwrap();

        assert!(!copy.exists());
        assert!(first.join("CurrentTune.msq").exists());
    }

    #[test]
    fn refuses_anything_but_a_project_directly_inside_base() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("LibreTuneProjects");
        let project = base.join("NA6");
        make_project(&project);
        let outside = root.path().join("Elsewhere");
        make_project(&outside);
        let not_a_project = base.join("notes");
        fs::create_dir_all(&not_a_project).unwrap();
        let nested = project.join("nested");
        make_project(&nested);

        for bad in [
            outside.clone(),
            base.clone(),
            not_a_project.clone(),
            nested.clone(),
            // `..` out of a real project lands on the outside project.
            project.join("..").join("..").join("Elsewhere"),
            base.join("missing"),
            PathBuf::new(),
        ] {
            assert!(
                delete_project_dir(&base, &bad, None).is_err(),
                "{bad:?} must be refused"
            );
        }
        for kept in [&outside, &base, &not_a_project, &nested, &project] {
            assert!(kept.exists(), "{kept:?} must not be deleted");
        }
    }

    #[test]
    fn refuses_the_open_project() {
        let base = tempfile::tempdir().unwrap();
        let open = base.path().join("NA6");
        let other = base.path().join("NA6_backup");
        make_project(&open);
        make_project(&other);

        // Same display name as the open project, so only the path tells them apart.
        assert!(delete_project_dir(base.path(), &open, Some(&open)).is_err());
        assert!(open.exists());
        delete_project_dir(base.path(), &other, Some(&open)).unwrap();
        assert!(!other.exists());
    }
}
