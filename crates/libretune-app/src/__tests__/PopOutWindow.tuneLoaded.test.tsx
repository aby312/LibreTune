import { render, waitFor, fireEvent, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import PopOutWindow from '../PopOutWindow';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
  emit: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('../components/tables/TableEditor3D', () => ({ default: () => null }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const X_BINS = [500, 1000, 1500];
const Y_BINS = [20, 40, 60];
const Z_OLD = [
  [10, 11, 12],
  [20, 21, 22],
  [30, 31, 32],
];
// What the backend holds after a tune load (file, project, ECU sync, restore point).
const Z_NEW = [
  [90, 91, 92],
  [93, 94, 95],
  [96, 97, 98],
];

let backendZ: number[][] = Z_OLD;
let failTableFetch = false;
let handlers: Record<string, Array<(e: { payload: unknown }) => void>> = {};

/** Deliver a Tauri event to every listener the window registered for it. */
function fire(name: string, payload: unknown = 'project') {
  expect(handlers[name]?.length, `pop-out never listened for ${name}`).toBe(1);
  act(() => {
    for (const h of handlers[name] ?? []) h({ payload });
  });
}

function setHash(hash: string) {
  window.location.hash = hash;
}

beforeEach(() => {
  backendZ = Z_OLD;
  failTableFetch = false;
  handlers = {};
  setHash('#/popout?tabId=veTable1Tbl&type=table&title=VE%20Table');
  localStorage.clear();

  listenMock.mockReset();
  listenMock.mockImplementation((async (name: string, handler: (e: { payload: unknown }) => void) => {
    (handlers[name] ??= []).push(handler);
    return () => {
      handlers[name] = (handlers[name] ?? []).filter((h) => h !== handler);
    };
  }) as never);

  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string) => {
    switch (cmd) {
      case 'get_table_data':
        if (failTableFetch) throw new Error('backend busy');
        return {
          name: 'veTable1Tbl',
          x_bins: X_BINS,
          y_bins: Y_BINS,
          z_values: backendZ.map((r) => [...r]),
          x_axis_name: 'RPM',
          y_axis_name: 'MAP',
        };
      case 'get_curve_data':
        return {
          name: 'warmup',
          title: 'Warmup',
          x_bins: [0, 50, 100],
          y_bins: [180, 140, 100],
          x_label: 'CLT',
          y_label: '%',
        };
      case 'get_connection_status':
        return { state: 'Disconnected' };
      case 'get_settings':
        return {};
      default:
        return undefined;
    }
  }) as never);
});

const cellTexts = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('td.table-cell')).map((e) => e.textContent);

const OLD_TEXTS = Z_OLD.flat().map((v) => v.toFixed(1));
const NEW_TEXTS = Z_NEW.flat().map((v) => v.toFixed(1));

const fetchCount = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd).length;

/** Double-click cell (row, col), type a value, commit with blur. */
function editCell(c: HTMLElement, row: number, col: number, value: string) {
  const td = c.querySelectorAll('tbody tr')[row].querySelectorAll('td.table-cell')[col];
  fireEvent.doubleClick(td);
  const input = c.querySelector('input.table-cell-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function lastUpdateTableData() {
  const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'update_table_data');
  return calls[calls.length - 1]?.[1] as { tableName: string; zValues: number[][] } | undefined;
}

/** Render the table pop-out and wait until it shows the grid. */
async function renderTablePopOut() {
  const view = render(<PopOutWindow />);
  await waitFor(() => expect(cellTexts(view.container)).toEqual(OLD_TEXTS));
  return view;
}

describe('PopOutWindow reloads on tune:loaded', () => {
  it('shows the new backend values after a tune load', async () => {
    const { container } = await renderTablePopOut();

    backendZ = Z_NEW;
    fire('tune:loaded');

    await waitFor(() => expect(cellTexts(container)).toEqual(NEW_TEXTS));
    expect(fetchCount('get_table_data')).toBe(2);
  });

  it('does not write the pre-load grid back when a cell is edited after a tune load', async () => {
    const { container } = await renderTablePopOut();

    backendZ = Z_NEW;
    fire('tune:loaded');
    await waitFor(() => expect(cellTexts(container)).toEqual(NEW_TEXTS));

    editCell(container, 0, 0, '55');

    await waitFor(() => expect(lastUpdateTableData()).toBeTruthy());
    const expected = Z_NEW.map((r) => [...r]);
    expected[0][0] = 55;
    expect(lastUpdateTableData()!.zValues).toEqual(expected);
  });

  it('shows an error rather than the old grid when the reload fails', async () => {
    const { container } = await renderTablePopOut();

    failTableFetch = true;
    fire('tune:loaded');

    await waitFor(() => expect(container.querySelector('.popout-error')).toBeTruthy());
    expect(cellTexts(container)).toEqual([]);
  });

  it('reloads a curve pop-out too', async () => {
    setHash('#/popout?tabId=warmup&type=curve&title=Warmup');
    render(<PopOutWindow />);
    await waitFor(() => expect(fetchCount('get_curve_data')).toBe(1));

    fire('tune:loaded');

    await waitFor(() => expect(fetchCount('get_curve_data')).toBe(2));
  });

  it('removes the listener when the window unmounts', async () => {
    const { unmount } = await renderTablePopOut();
    expect(handlers['tune:loaded']?.length, 'pop-out never listened for tune:loaded').toBe(1);

    unmount();

    expect(handlers['tune:loaded'] ?? []).toHaveLength(0);
  });
});
