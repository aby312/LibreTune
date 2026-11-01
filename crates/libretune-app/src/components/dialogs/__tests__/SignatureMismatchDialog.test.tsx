/**
 * "Save Current ECU Tune First" must write a real backup file next to the
 * project's tune and tell the user where it went. It used to invoke
 * `save_tune` with `{ filename, includeMetadata }`; the Rust command only
 * takes `path`, so the backup name was dropped, the project's own tune was
 * overwritten and the dialog still announced a backup.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import SignatureMismatchDialog from '../SignatureMismatchDialog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const PROJECT_PATH = 'C:/Users/t/LibreTuneProjects/NA6';

/** Parameter names of `pub async fn <name>(...)` in save_tune.rs, minus the injected `state`. */
function rustParams(name: string): string[] {
  const src = readFileSync(resolve(__dirname, '../../../../src-tauri/src/commands/save_tune.rs'), 'utf8');
  for (const m of src.matchAll(/pub async fn (\w+)\s*\(([\s\S]*?)\)\s*->/g)) {
    if (m[1] === name) {
      return [...m[2].matchAll(/(?:^|,)\s*(\w+)\s*:(?!:)/g)].map((x) => x[1]).filter((n) => n !== 'state');
    }
  }
  throw new Error(`could not find \`pub async fn ${name}(\` in save_tune.rs`);
}

function openDialogAndClickSave() {
  render(
    <SignatureMismatchDialog
      isOpen
      mismatchInfo={{
        ecu_signature: 'speeduino 202501-T41',
        ini_signature: 'speeduino 202305',
        match_type: 'mismatch',
        current_ini_path: 'x.ini',
        matching_inis: [],
      }}
      onClose={() => {}}
      onSelectIni={() => {}}
      onContinue={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Save current ECU tune to PC/i }));
}

describe('SignatureMismatchDialog: Save Current ECU Tune First', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;
  let project: { path: string } | null;

  beforeEach(() => {
    project = { path: PROJECT_PATH };
    invokeMock.mockReset();
    invokeMock.mockImplementation((async (cmd: string, args?: { path?: string }) => {
      if (cmd === 'check_internet_connectivity') return false; // keep the online-search path out of the picture
      if (cmd === 'search_online_inis') return { entries: [] };
      if (cmd === 'get_current_project') return project;
      if (cmd === 'save_tune_copy') return args?.path;
      return undefined;
    }) as typeof invoke);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  });
  afterEach(() => alertSpy.mockRestore());

  const calls = () => invokeMock.mock.calls.map(([cmd]) => cmd);

  it('writes a backup file inside the project folder and reports that file', async () => {
    openDialogAndClickSave();
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());

    // The ECU is read first, then the copy is written.
    expect(calls().indexOf('sync_ecu_data')).toBeGreaterThanOrEqual(0);
    expect(calls().indexOf('sync_ecu_data')).toBeLessThan(calls().indexOf('save_tune_copy'));

    const args = invokeMock.mock.calls.find(([c]) => c === 'save_tune_copy')![1] as { path: string };
    expect(args.path.startsWith(`${PROJECT_PATH}/ecu_backup_`)).toBe(true);
    expect(args.path.endsWith('.msq')).toBe(true);
    // Every key sent is a declared parameter of the Rust command (Tauri silently drops the rest).
    expect(Object.keys(args).every((k) => rustParams('save_tune_copy').includes(k))).toBe(true);

    // It is a copy: Save / Save As would make the backup the file later Saves write to.
    expect(calls()).not.toContain('save_tune');
    expect(calls()).not.toContain('save_tune_as');

    // The alert names the file that was actually written.
    const text = String(alertSpy.mock.calls[0][0]);
    expect(text).toContain('✓');
    expect(text).toContain(args.path);
  });

  it('writes nothing and says so when no project is open', async () => {
    project = null;
    openDialogAndClickSave();
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());

    expect(calls()).not.toContain('save_tune_copy');
    expect(String(alertSpy.mock.calls[0][0])).toContain('✗');
  });

  it('does not announce a backup when the write fails', async () => {
    invokeMock.mockImplementation((async (cmd: string) => {
      if (cmd === 'get_current_project') return project;
      if (cmd === 'save_tune_copy') throw 'disk full';
      return undefined;
    }) as typeof invoke);
    openDialogAndClickSave();
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());

    const text = String(alertSpy.mock.calls[0][0]);
    expect(text).toContain('✗');
    expect(text).toContain('disk full');
  });
});
