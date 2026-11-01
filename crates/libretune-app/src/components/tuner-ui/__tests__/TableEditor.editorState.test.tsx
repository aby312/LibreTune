import { useState, type ComponentProps } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TableEditor, type TableData } from '../TableEditor';
import { TabContentRouter } from '../../TabContentRouter';
import { useGlobalShortcuts } from '../../../hooks/useGlobalShortcuts';
import { ToastProvider } from '../../../contexts/ToastContext';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('../../tables/TableEditor3D', () => ({ default: () => null }));

const invokeMock = vi.mocked(invoke);

// Two tables of the same shape: ignition-like (degrees) and AFR-like.
const SPARK: TableData = {
  name: 'sparkTbl',
  xAxis: [1000, 2000, 3000],
  yAxis: [30, 60, 90],
  zValues: [
    [10, 12, 14],
    [20, 22, 24],
    [30, 32, 34],
  ],
};
const AFR: TableData = {
  name: 'afrTable1Tbl',
  xAxis: [1000, 2000, 3000],
  yAxis: [30, 60, 90],
  zValues: [
    [14.7, 14.7, 14.7],
    [13.5, 13.5, 13.5],
    [12.0, 12.0, 12.0],
  ],
};

const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const editor = () => document.querySelector('div.table-editor') as HTMLElement;
const cell = (row: number, col: number) =>
  document.querySelectorAll('tbody tr')[row].querySelectorAll('td.table-cell')[col] as HTMLElement;
const updateCalls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'update_table_data')
    .map(([, args]) => args as { tableName: string; zValues: number[][] });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  try { localStorage.clear(); } catch { /* ignore */ }
});

type Contents = ComponentProps<typeof TabContentRouter>['tabContents'];

/** Mirrors App: tabContents + activeTabId state around the real TabContentRouter. */
function renderRouter() {
  const h: {
    switchTo: (id: string) => void;
    contents: Contents;
    /** What App does when a tune load refreshes the open tabs. */
    loadTune: (next: Contents) => void;
  } = { switchTo: () => {}, contents: {}, loadTune: () => {} };
  function Harness() {
    const [active, setActive] = useState('A');
    const [contents, setContents] = useState<Contents>({
      A: { type: 'table', data: copy(SPARK) },
      B: { type: 'table', data: copy(AFR) },
    });
    const [tuneLoadCount, setTuneLoadCount] = useState(0);
    h.switchTo = setActive;
    h.contents = contents;
    h.loadTune = (next) => {
      setContents(next);
      setTuneLoadCount((n) => n + 1);
    };
    return (
      <TabContentRouter
        currentProject={{ name: 'p' } as unknown as ComponentProps<typeof TabContentRouter>['currentProject']}
        availableProjects={[]}
        status={{ state: 'Disconnected' } as unknown as ComponentProps<typeof TabContentRouter>['status']}
        ecuType="Speeduino"
        iniCapabilities={null}
        activeTabId={active}
        tabs={[{ id: 'A', title: 'Spark' }, { id: 'B', title: 'AFR' }]}
        tabContents={contents}
        setTabContents={setContents}
        tuneLoadCount={tuneLoadCount}
        openProject={() => {}}
        setConnectEcuWizardOpen={() => {}}
        setImportProjectOpen={() => {}}
        handleDeleteProject={() => {}}
        setBurnDialogOpen={() => {}}
        handleTabClose={() => {}}
        openTarget={() => {}}
        fetchConstants={async () => ({})}
        fetchMenuTree={async () => {}}
        setConstantValues={() => {}}
        constantValues={{}}
        portEditorAssignments={{}}
        setPortEditorAssignments={() => {}}
        showToast={() => {}}
      />
    );
  }
  render(<ToastProvider><Harness /></ToastProvider>);
  return h;
}

describe('TableEditor keeps its state per table (tab switching)', () => {
  it('Escape on another tab never writes the first table\'s values into it', async () => {
    const tabs = renderRouter();

    // Edit table A so its editor holds a snapshot/history of A.
    fireEvent.mouseDown(cell(1, 1));
    fireEvent.keyDown(editor(), { key: '.' }); // +0.1 on A[1][1]
    await waitFor(() => expect(updateCalls().some((c) => c.tableName === 'sparkTbl')).toBe(true));
    invokeMock.mockClear();

    act(() => tabs.switchTo('B'));
    expect(screen.getByText('afrTable1Tbl', { selector: '.table-status span' })).toBeInTheDocument();
    expect(cell(1, 1).textContent).toBe('13.5');

    fireEvent.mouseDown(cell(1, 1));
    fireEvent.keyDown(editor(), { key: 'Escape' });

    // Escape reverts to B's own original, so anything written for B must be B's values.
    for (const c of updateCalls().filter((u) => u.tableName === 'afrTable1Tbl')) {
      expect(c.zValues).toEqual(AFR.zValues);
    }
    expect(cell(1, 1).textContent).toBe('13.5');
  });

  it('Ctrl+Z on another tab does not undo (or rewrite) the first table', async () => {
    const tabs = renderRouter();

    fireEvent.mouseDown(cell(0, 0));
    fireEvent.keyDown(editor(), { key: '+' }); // +1 on A[0][0]
    await waitFor(() => expect(updateCalls().some((c) => c.tableName === 'sparkTbl')).toBe(true));
    expect(tabs.contents.A.data).toMatchObject({ name: 'sparkTbl' });
    invokeMock.mockClear();

    act(() => tabs.switchTo('B'));
    fireEvent.mouseDown(cell(0, 0));
    fireEvent.keyDown(editor(), { key: 'z', ctrlKey: true });

    expect(updateCalls().filter((c) => c.tableName === 'sparkTbl')).toEqual([]);
    expect(tabs.contents.B.data).toMatchObject({ name: 'afrTable1Tbl' });
  });

  it('after a tune load, Escape and Ctrl+Z do not bring back the old tune values', async () => {
    const tabs = renderRouter();

    fireEvent.mouseDown(cell(1, 1));
    fireEvent.keyDown(editor(), { key: '+' }); // edit under the old tune: history holds 22
    await waitFor(() => expect(updateCalls().length).toBe(1));
    invokeMock.mockClear();

    const loaded = { ...copy(SPARK), zValues: [[50, 52, 54], [60, 62, 64], [70, 72, 74]] };
    act(() => tabs.loadTune({ ...tabs.contents, A: { type: 'table', data: loaded } }));
    expect(cell(1, 1).textContent).toBe('62.0');

    fireEvent.mouseDown(cell(1, 1));
    fireEvent.keyDown(editor(), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(editor(), { key: 'Escape' });

    // Only the loaded tune's values may ever be written.
    for (const c of updateCalls()) {
      expect(c.zValues).toEqual(loaded.zValues);
    }
    expect(cell(1, 1).textContent).toBe('62.0');
  });
});

describe('TableEditor refused writes', () => {
  const backendError =
    'ECU did not store table sparkTbl as written - do not drive on this tune until it is re-sent and verified';

  function Parent({ initial }: { initial: TableData }) {
    const [data, setData] = useState(initial);
    return <TableEditor data={data} onChange={setData} />;
  }

  function editCell(value: string) {
    fireEvent.mouseDown(cell(1, 1));
    fireEvent.doubleClick(cell(1, 1));
    const input = document.querySelector('input.table-cell-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the backend error and keeps the edit, matching the tune cache', async () => {
    invokeMock.mockImplementation(((cmd: string) =>
      cmd === 'update_table_data' ? Promise.reject(backendError) : Promise.resolve({})) as typeof invoke);
    render(<ToastProvider><Parent initial={copy(SPARK)} /></ToastProvider>);
    expect(cell(1, 1).textContent).toBe('22.0');

    editCell('99');
    expect(updateCalls()[0].zValues[1][1]).toBe(99);

    // The backend has already mirrored the edit into the tune cache when it
    // refuses the ECU write, so the grid must keep showing it - plus the error.
    expect(await screen.findByText(/do not drive on this tune/)).toBeInTheDocument();
    expect(cell(1, 1).textContent).toBe('99.0');
    expect(screen.getByLabelText('Undo')).not.toBeDisabled();
  });

  it('keeps the edit and its undo entry when the write is accepted', async () => {
    render(<ToastProvider><Parent initial={copy(SPARK)} /></ToastProvider>);

    editCell('99');

    await waitFor(() => expect(screen.getByLabelText('Undo')).not.toBeDisabled());
    expect(cell(1, 1).textContent).toBe('99.0');
    expect(document.querySelector('.toast')).toBeNull();
  });
});

describe('TableEditor shortcuts leave window-level chords alone', () => {
  let windowKeydown: Mock<(e: KeyboardEvent) => void>;
  let setSaveDialogOpen: Mock<(open: boolean) => void>;

  function mount() {
    function Shell() {
      useGlobalShortcuts({
        isConnected: false,
        tuneModified: false,
        setConnectEcuWizardOpen: () => {},
        setLoadDialogOpen: () => {},
        setSaveDialogOpen,
        setBurnDialogOpen: () => {},
      });
      const [data, setData] = useState<TableData>(copy(SPARK));
      return <TableEditor data={data} onChange={setData} />;
    }
    render(<ToastProvider><Shell /></ToastProvider>);
    fireEvent.mouseDown(cell(0, 0)); // corner cell differs from its neighbours
    expect(cell(0, 0)).toHaveClass('selected');
    windowKeydown.mockClear();
  }

  beforeEach(() => {
    windowKeydown = vi.fn<(e: KeyboardEvent) => void>();
    setSaveDialogOpen = vi.fn<(open: boolean) => void>();
    window.addEventListener('keydown', windowKeydown);
  });
  afterEach(() => {
    window.removeEventListener('keydown', windowKeydown);
  });

  it('plain "s" still smooths the selection', async () => {
    mount();
    fireEvent.keyDown(editor(), { key: 's' });
    await waitFor(() => expect(updateCalls().length).toBe(1));
    expect(cell(0, 0).textContent).not.toBe('10.0');
    expect(setSaveDialogOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['Ctrl+S', { key: 's', ctrlKey: true }, 'Save'],
    ['Meta+S', { key: 's', metaKey: true }, 'Save'],
    ['Ctrl+H', { key: 'h', ctrlKey: true }, null],
    ['Alt+.', { key: '.', altKey: true }, null],
  ])('%s is not an editor shortcut and reaches the window', async (_name, init, save) => {
    mount();
    invokeMock.mockClear();

    fireEvent.keyDown(editor(), init);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(updateCalls()).toEqual([]);
    expect(cell(0, 0).textContent).toBe('10.0');
    expect(windowKeydown).toHaveBeenCalled();
    expect(setSaveDialogOpen).toHaveBeenCalledTimes(save ? 1 : 0);
  });
});
