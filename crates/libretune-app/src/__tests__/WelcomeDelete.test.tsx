/**
 * Welcome-screen "Delete project" must identify the project by its folder path,
 * not its display name: two projects can share a name (e.g. a folder copied as
 * a backup), and the backend would otherwise delete the first match.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn().mockResolvedValue(undefined) }),
}));

import { invoke } from '@tauri-apps/api/core';
import WelcomeView from '../components/WelcomeView';
import { LoadingProvider } from '../contexts/LoadingContext';
import { ToastProvider } from '../contexts/ToastContext';
import { UnitPreferencesProvider } from '../contexts/useUnitPreferences';
import { setupTauriMocks, tearDownTauriMocks } from '../test-utils/tauriMocks';

// Two projects with the SAME display name but different folders.
const PROJECTS = [
  { name: 'NA6', path: 'C:/Users/t/LibreTuneProjects/NA6', signature: 'speeduino 202501', modified: '2026-10-01T10:00:00Z' },
  { name: 'NA6', path: 'C:/Users/t/LibreTuneProjects/NA6_backup', signature: 'speeduino 202501', modified: '2026-09-01T10:00:00Z' },
];
const SECOND = PROJECTS[1];

describe('Welcome delete identifies the project by path', () => {
  it('passes the clicked project\'s path to onDeleteProject', () => {
    const onDelete = vi.fn();
    render(
      <WelcomeView
        projects={PROJECTS}
        onOpenProject={() => {}}
        onNewProject={() => {}}
        onImportTsProject={() => {}}
        onDeleteProject={onDelete}
      />,
    );
    const buttons = screen.getAllByTitle('Delete project');
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[1]); // arm the second row
    fireEvent.click(screen.getAllByTitle('Click again to confirm').slice(-1)[0]);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(SECOND.path, SECOND.name);
  });

  it('arms only the clicked row when two projects share a name', () => {
    render(
      <WelcomeView
        projects={PROJECTS}
        onOpenProject={() => {}}
        onNewProject={() => {}}
        onImportTsProject={() => {}}
        onDeleteProject={() => {}}
      />,
    );
    fireEvent.click(screen.getAllByTitle('Delete project')[1]);
    expect(document.querySelectorAll('.recent-delete.confirm')).toHaveLength(1);
  });

  describe('through the real App', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      setupTauriMocks({});
    });
    afterEach(() => {
      tearDownTauriMocks();
    });

    it('invokes delete_project with the second project\'s path', async () => {
      const calls: Array<[string, unknown]> = [];
      (invoke as unknown as any).mockImplementation((cmd: string, args: unknown) => {
        calls.push([cmd, args]);
        switch (cmd) {
          case 'list_projects':
            return Promise.resolve(PROJECTS);
          case 'get_settings':
            return Promise.resolve({ runtime_packet_mode: 'Auto', units_system: 'metric' });
          case 'get_current_project':
            return Promise.resolve(null);
          case 'get_serial_ports':
            return Promise.resolve([]);
          case 'get_connection_status':
            return Promise.resolve({ state: 'Disconnected', has_definition: false });
          case 'get_protocol_defaults':
            return Promise.resolve({ default_baud_rate: 115200, timeout_ms: 2000 });
          case 'list_repository_inis':
          case 'get_status_bar_defaults':
          case 'get_available_channels':
          case 'get_menu_tree':
            return Promise.resolve([]);
          case 'get_searchable_index':
            return Promise.resolve({});
          default:
            return Promise.resolve();
        }
      });

      const { default: App } = await import('../App');
      render(
        <LoadingProvider>
          <ToastProvider>
            <UnitPreferencesProvider>
              <App />
            </UnitPreferencesProvider>
          </ToastProvider>
        </LoadingProvider>,
      );

      const buttons = await waitFor(
        () => {
          const b = screen.getAllByTitle('Delete project');
          expect(b).toHaveLength(2);
          return b;
        },
        { timeout: 10_000 },
      );

      fireEvent.click(buttons[1]);
      fireEvent.click(screen.getAllByTitle('Click again to confirm').slice(-1)[0]);

      await waitFor(() => expect(calls.some(([c]) => c === 'delete_project')).toBe(true), { timeout: 5000 });
      const [, args] = calls.find(([c]) => c === 'delete_project')!;
      expect(args).toEqual({ path: SECOND.path });
    }, 20000);
  });
});
