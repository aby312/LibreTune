import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../components/tables/TableEditor3D', () => ({ default: () => null }));

import { LoadingProvider } from '../contexts/LoadingContext';
import { ToastProvider } from '../contexts/ToastContext';
import { UnitPreferencesProvider } from '../contexts/useUnitPreferences';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const backendTable = (zValues: number[][]) => ({
  name: 'sparkTbl',
  title: 'Spark',
  x_bins: [1000, 2000, 3000],
  y_bins: [30, 60, 90],
  z_values: zValues,
});
const OLD_TUNE = [[10, 12, 14], [20, 22, 24], [30, 32, 34]];
const NEW_TUNE = [[50, 52, 54], [60, 62, 64], [70, 72, 74]];

const cell = (row: number, col: number) =>
  document.querySelectorAll('tbody tr')[row].querySelectorAll('td.table-cell')[col] as HTMLElement;
const updateCalls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'update_table_data')
    .map(([, args]) => args as { tableName: string; zValues: number[][] });

describe('App: table editor across a tune load', () => {
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  let tune = OLD_TUNE;

  beforeEach(() => {
    // jsdom has no scrollIntoView (TabBar scrolls the active tab into view).
    Element.prototype.scrollIntoView = vi.fn();
    tune = OLD_TUNE;
    for (const k of Object.keys(handlers)) delete handlers[k];
    listenMock.mockImplementation((async (name: string, handler: (e: unknown) => void) => {
      (handlers[name] ??= []).push(handler);
      return () => {};
    }) as unknown as typeof listen);
    invokeMock.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'list_repository_inis':
        case 'list_projects':
        case 'get_serial_ports':
        case 'get_status_bar_defaults':
        case 'get_available_channels':
        case 'get_menu_tree':
          return Promise.resolve([]);
        case 'get_settings':
          return Promise.resolve({ runtime_packet_mode: 'Auto', units_system: 'metric', last_active_tab: 'sparkTbl' });
        case 'get_current_project':
          return Promise.resolve({
            name: 'p', path: '/p', signature: 's', has_tune: true, tune_modified: false,
            connection: { port: null, baud_rate: 115200, auto_connect: false },
          });
        case 'is_onboarding_completed':
          return Promise.resolve(true);
        case 'get_connection_status':
          return Promise.resolve({ state: 'Disconnected', has_definition: false });
        case 'get_protocol_defaults':
          return Promise.resolve({ default_baud_rate: 115200, timeout_ms: 2000 });
        case 'get_searchable_index':
        case 'get_all_constant_values':
          return Promise.resolve({});
        case 'get_table_data':
          return Promise.resolve(backendTable(tune));
        default:
          return Promise.resolve();
      }
    }) as unknown as typeof invoke);
  });

  it('Escape and Ctrl+Z after tune:loaded do not write the previous tune\'s values', async () => {
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
    await waitFor(() => expect(cell(1, 1).textContent).toBe('22.0'), { timeout: 10_000 });
    await waitFor(() => expect(handlers['tune:loaded']?.length).toBeGreaterThan(0));

    // Edit under the old tune so the editor holds history and a snapshot of it.
    fireEvent.mouseDown(cell(1, 1));
    fireEvent.keyDown(document.querySelector('div.table-editor')!, { key: '+' });
    await waitFor(() => expect(updateCalls().length).toBe(1));

    // A different tune is loaded: the backend emits tune:loaded and App re-fetches the tab.
    tune = NEW_TUNE;
    await act(async () => {
      for (const h of handlers['tune:loaded']) h({ payload: 'new.msq' });
    });
    await waitFor(() => expect(cell(1, 1).textContent).toBe('62.0'));
    // Let the second refresher (the useTableCurveRefresh listener) finish too.
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    invokeMock.mockClear();

    fireEvent.mouseDown(cell(1, 1));
    const ed = () => document.querySelector('div.table-editor')!;
    fireEvent.keyDown(ed(), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(ed(), { key: 'Escape' });

    for (const c of updateCalls()) {
      expect(c.zValues).toEqual(NEW_TUNE);
    }
    expect(cell(1, 1).textContent).toBe('62.0');
  }, 30_000);
});
