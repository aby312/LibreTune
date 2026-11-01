import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import TableEditor2D from '../TableEditor2D';
import { ToastProvider } from '../../../contexts/ToastContext';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('../TableEditor3D', () => ({ default: () => null }));

const invokeMock = vi.mocked(invoke);

const X_BINS = [500, 1000, 1500];
const Y_BINS = [20, 40, 60];
const Z_VALUES = [
  [10, 11, 12],
  [20, 21, 22],
  [30, 31, 32],
];

// Generator output: a new grid AND new axes (rebuildAxes defaults to on).
const GEN_X = [800, 2400, 4000];
const GEN_Y = [30, 65, 100];
const GEN_Z = [
  [71, 72, 73],
  [74, 75, 76],
  [77, 78, 79],
];

let failRebin = false;

function installBackend() {
  failRebin = false;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'get_table_data':
        return { name: 'veTable1Tbl', x_bins: X_BINS, y_bins: Y_BINS, z_values: Z_VALUES, size_info: null };
      case 'get_settings':
        return {};
      case 'generate_table_values':
        return { table_type: 've', z_values: GEN_Z, x_bins: GEN_X, y_bins: GEN_Y };
      case 'rebin_table':
        if (failRebin) throw new Error('axis write refused');
        return undefined;
      default:
        return undefined;
    }
  });
}

/** Mounted the way dialogs/PanelComponents.tsx mounts the VE table (embedded). */
function renderEmbedded() {
  return render(
    <ToastProvider>
      <TableEditor2D
        title="VE Table"
        table_name="veTable1Tbl"
        x_axis_name="RPM"
        y_axis_name="MAP"
        x_bins={X_BINS}
        y_bins={Y_BINS}
        z_values={Z_VALUES}
        embedded={true}
      />
    </ToastProvider>
  );
}

function callsOf(command: string) {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === command);
}

/** Global call-order numbers of every invocation of a command. */
function orderOf(command: string) {
  return invokeMock.mock.calls.flatMap(([cmd], i) => (cmd === command ? [invokeMock.mock.invocationCallOrder[i]] : []));
}

function axisLabels(container: HTMLElement, axis: 'x' | 'y') {
  return Array.from(container.querySelectorAll(`.axis-bin-label.${axis}-bin`)).map((e) => e.textContent);
}

/** Double-click a bin label, type a value, press Enter. */
function editBin(container: HTMLElement, axis: 'x' | 'y', index: number, value: string) {
  fireEvent.doubleClick(container.querySelectorAll(`.axis-bin-label.${axis}-bin`)[index]);
  const input = container.querySelector(`input.axis-bin-label.${axis}-bin.editing`) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** Right-click menu -> Generate VE Table... -> Generate (rebuild axes left on). */
async function generate(container: HTMLElement) {
  fireEvent.contextMenu(container.querySelector('.table-cell[data-x="1"][data-y="1"]')!);
  fireEvent.click(await screen.findByText(/Generate VE Table/));
  fireEvent.click(await screen.findByRole('button', { name: 'Generate VE Table' }));
}

describe('TableEditor2D persists axis bins', () => {
  beforeEach(installBackend);

  it('writes an edited x bin to the backend, leaving the grid in place', async () => {
    const { container } = renderEmbedded();
    editBin(container, 'x', 1, '1200');

    await waitFor(() => expect(callsOf('rebin_table')).toHaveLength(1));
    expect(callsOf('rebin_table')[0][1]).toEqual({
      tableName: 'veTable1Tbl',
      newXBins: [500, 1200, 1500],
      newYBins: Y_BINS,
      interpolateZ: false,
    });
    expect(axisLabels(container, 'x')).toEqual(['500', '1200', '1500']);
  });

  it('writes an edited y bin to the backend', async () => {
    const { container } = renderEmbedded();
    editBin(container, 'y', 1, '45');

    await waitFor(() => expect(callsOf('rebin_table')).toHaveLength(1));
    expect(callsOf('rebin_table')[0][1]).toMatchObject({ newXBins: X_BINS, newYBins: [20, 45, 60] });
  });

  it('does not write when a bin is left unchanged', async () => {
    const { container } = renderEmbedded();
    editBin(container, 'x', 1, '1000');

    await waitFor(() => expect(axisLabels(container, 'x')).toEqual(['500', '1000', '1500']));
    expect(callsOf('rebin_table')).toHaveLength(0);
  });

  it('shows the old bin again, with a toast, when the write fails', async () => {
    failRebin = true;
    const { container } = renderEmbedded();
    editBin(container, 'x', 1, '1200');

    expect(await screen.findByText(/Saving axis failed: axis write refused/)).toBeInTheDocument();
    expect(axisLabels(container, 'x')).toEqual(['500', '1000', '1500']);
  });

  it('writes generated axes before the generated grid', async () => {
    const { container } = renderEmbedded();
    await generate(container);

    await waitFor(() => expect(callsOf('update_table_data')).toHaveLength(1));
    expect(callsOf('rebin_table')).toHaveLength(1);
    expect(callsOf('rebin_table')[0][1]).toEqual({
      tableName: 'veTable1Tbl',
      newXBins: GEN_X,
      newYBins: GEN_Y,
      interpolateZ: false,
    });
    expect(callsOf('update_table_data')[0][1]).toEqual({ tableName: 'veTable1Tbl', zValues: GEN_Z });

    expect(orderOf('rebin_table')[0]).toBeLessThan(orderOf('update_table_data')[0]);
    expect(axisLabels(container, 'x')).toEqual(GEN_X.map(String));
  });

  it('does not write the generated grid, or show it, when the axis write fails', async () => {
    failRebin = true;
    const { container } = renderEmbedded();
    await generate(container);

    expect(await screen.findByText(/Saving axes failed: axis write refused/)).toBeInTheDocument();
    expect(callsOf('update_table_data')).toHaveLength(0);
    expect(axisLabels(container, 'x')).toEqual(['500', '1000', '1500']);
    expect(axisLabels(container, 'y')).toEqual(['20', '40', '60']);
  });

  it('puts the old axes back on the ECU, before the old grid, when a Generate is undone', async () => {
    const { container } = renderEmbedded();
    await generate(container);
    await waitFor(() => expect(axisLabels(container, 'x')).toEqual(GEN_X.map(String)));
    await waitFor(() => expect(callsOf('update_table_data')).toHaveLength(1));

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(callsOf('update_table_data')).toHaveLength(2));
    expect(callsOf('rebin_table')).toHaveLength(2);
    expect(callsOf('rebin_table')[1][1]).toMatchObject({ newXBins: X_BINS, newYBins: Y_BINS });
    expect(callsOf('update_table_data')[1][1]).toEqual({ tableName: 'veTable1Tbl', zValues: Z_VALUES });
    expect(orderOf('rebin_table')[1]).toBeLessThan(orderOf('update_table_data')[1]);
    expect(axisLabels(container, 'x')).toEqual(['500', '1000', '1500']);
  });
});
