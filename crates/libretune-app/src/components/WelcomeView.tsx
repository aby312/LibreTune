import { useState } from "react";
import { Check, FolderPlus, Download, X } from "lucide-react";
import "./WelcomeView.css";

interface ProjectInfo {
  name: string;
  path: string;
  signature: string;
  modified: string;
}

interface WelcomeViewProps {
  projects: ProjectInfo[];
  onOpenProject: (path: string) => void;
  onNewProject: () => void;
  onImportTsProject: () => void;
  onDeleteProject: (path: string, name: string) => void;
}

export default function WelcomeView({
  projects,
  onOpenProject,
  onNewProject,
  onImportTsProject,
  onDeleteProject,
}: WelcomeViewProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Keyed by path: two projects can share a display name.
  function handleDelete(e: React.MouseEvent, project: ProjectInfo) {
    e.stopPropagation();
    if (confirmDelete === project.path) {
      onDeleteProject(project.path, project.name);
      setConfirmDelete(null);
    } else {
      setConfirmDelete(project.path);
    }
  }

  return (
    <div className="welcome-view">
      <div className="welcome-header">
        <h1 className="welcome-title">LibreTune</h1>
        <p className="welcome-subtitle">Open-source ECU tuning software</p>
      </div>

      <div className="welcome-actions">
        <button className="welcome-action-btn primary" onClick={onNewProject}>
          <span className="action-icon"><FolderPlus size={32} /></span>
          <span className="action-label">Connect ECU / New Project</span>
          <span className="action-desc">Detect a connected ECU or start offline</span>
        </button>
        <button className="welcome-action-btn" onClick={onImportTsProject}>
          <span className="action-icon"><Download size={32} /></span>
          <span className="action-label">Import TS Project</span>
          <span className="action-desc">Import from TunerStudio</span>
        </button>
      </div>

      {projects.length > 0 && (
        <div className="welcome-recent">
          <h3 className="recent-title">Recent Projects</h3>
          <div className="recent-list">
            {projects.slice(0, 8).map((project) => (
              <div
                key={project.path}
                className="recent-item"
                onClick={() => onOpenProject(project.path)}
              >
                <div className="recent-info">
                  <div className="recent-name">{project.name}</div>
                  <div className="recent-sig">{project.signature}</div>
                  <div className="recent-date">
                    Last modified: {new Date(project.modified).toLocaleDateString()}
                  </div>
                </div>
                <button
                  className={`recent-delete ${confirmDelete === project.path ? "confirm" : ""}`}
                  onClick={(e) => handleDelete(e, project)}
                  title={confirmDelete === project.path ? "Click again to confirm" : "Delete project"}
                >
                  {confirmDelete === project.path ? (
                    <><Check size={14} /> Confirm</>
                  ) : (
                    <X size={14} />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
