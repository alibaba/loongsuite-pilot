import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe.skipIf(process.platform !== 'linux')('RISC-V guest shutdown', () => {
  it('handles exit races without hiding ownership, permission or timeout failures', () => {
    const code = String.raw`
import contextlib, importlib.util, io, sys
from pathlib import Path
from unittest.mock import MagicMock, patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('qemu_test', 'scripts/riscv64/qemu-env.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def check(stat=None, stat_error=None, kill_error=None, expected_error=None):
    work = MagicMock()
    pidfile = work.__truediv__.return_value.__truediv__.return_value
    with patch.object(m, 'owned_pid', return_value=424242), patch.object(m.os, 'kill', side_effect=kill_error), \
         patch.object(m, 'Path') as proc, patch.object(m.time, 'sleep'):
        proc.return_value.read_text.return_value = stat
        proc.return_value.read_text.side_effect = stat_error
        try:
            with contextlib.redirect_stdout(io.StringIO()): m.stop(work)
        except Exception as error:
            assert expected_error and isinstance(error, expected_error), repr(error)
            pidfile.unlink.assert_not_called()
        else:
            assert expected_error is None
            pidfile.unlink.assert_called_once_with(missing_ok=True)

check(stat_error=FileNotFoundError())
check(kill_error=ProcessLookupError())
check(stat='424242 (qemu worker) Z 1 0')
check(stat='424242 (qemu worker) R 1 0', expected_error=RuntimeError)
check(stat_error=PermissionError(), expected_error=PermissionError)
check(kill_error=PermissionError(), expected_error=PermissionError)
with patch.object(m, 'owned_pid', return_value=None), patch.object(m.os, 'kill') as kill:
    with contextlib.redirect_stdout(io.StringIO()): m.stop(MagicMock())
    kill.assert_not_called()
with patch.object(m, 'owned_pid', side_effect=RuntimeError('not our guest')), patch.object(m.os, 'kill') as kill:
    try: m.stop(MagicMock())
    except RuntimeError: pass
    else: raise AssertionError('ownership rejection was swallowed')
    kill.assert_not_called()
work = MagicMock(); pidfile = work.__truediv__.return_value.__truediv__.return_value
pidfile.exists.return_value = True
pidfile.read_text.side_effect = FileNotFoundError()
assert m.owned_pid(work) is None
`;
    const result=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:15000});
    expect(result.status,result.stderr).toBe(0);
  });
});
