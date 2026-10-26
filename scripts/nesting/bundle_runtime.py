"""Build a relocatable Windows runtime; no user venv or system Python is needed."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'src-tauri/src/imposition/local_nesting'
DESTINATION = ROOT / 'src-tauri/resources/imposition-runtime'
ADAPTER = Path('src-tauri/src/imposition/local_nesting/local_tools_engine.py')
MODULES = ['local_tools_engine.py', 'nesting_common.py', 'nest_uniform.py', 'nest_repeat_lots.py', 'nest_repeat_patterns.py', 'nest_order_search.py', 'nest_combined.py', 'nesting_rust.py', 'nest_replan.py']


def verify_runtime(runtime: Path):
    """Exercise all strategies and occupied-board replanning after relocation."""
    runtime = runtime.resolve()
    python = runtime / '.tools/nesting/python/python.exe'
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(('PYTHON', 'PRINTFLOW_NESTING_')):
            del env[key]
    # Neither PATH Python nor the checkout is available to the installed child.
    env['PATH'] = str(Path(env.get('SYSTEMROOT', 'C:/Windows')) / 'System32')
    env['PRINTFLOW_NESTING_CORE'] = 'rust'
    env['PRINTFLOW_NESTING_THREADS'] = '2'
    evidence = []
    with tempfile.TemporaryDirectory(prefix='printflow-installed-nesting-') as cwd:
        env['LOCALAPPDATA'] = str(Path(cwd) / 'user-data')
        for objective in ['least-material', 'least-cutting', 'combined', 'template-repack', 'template-repack-combined']:
            replan = objective.startswith('template-repack')
            request = dict(plateWidthMm=100, plateHeightMm=80, effectiveWidthMm=85,
                           effectiveHeightMm=60, effectiveRightMm=5, spacingMm=3,
                           objective=objective, irregularAlgorithm='local-tools',
                           items=[dict(id='安装验证', widthMm=10, heightMm=8, quantity=4,
                                       polygon=[[1, 1], [9, 1], [5, 7]])])
            if replan:
                request['objective'] = 'combined' if objective.endswith('-combined') else 'least-cutting'
                request['items'].append(dict(id='背景', widthMm=10, heightMm=8, quantity=2,
                                             polygon=[[0, 0], [10, 0], [10, 8], [0, 8]]))
                position = lambda ident, x: dict(sourceId=ident, xMm=x, yMm=10, rotationDeg=0)
                request['templateRepack'] = dict(
                    templates=[dict(id='source', repeatCount=4, placements=[position('安装验证', 10)]),
                               dict(id='target', repeatCount=2, placements=[position('背景', 10)])],
                    sourceTemplateId='source', targetTemplateId='target', sourceSlotIndex=0,
                    targetPlacement=position('安装验证', 25))
            child = subprocess.run([str(python), '-X', 'utf8', '-B', str(runtime / ADAPTER)],
                                   input=json.dumps(dict(engine='local-tools', request=request), ensure_ascii=False),
                                   encoding='utf-8', capture_output=True, cwd=cwd, env=env,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
            if child.returncode:
                raise RuntimeError(f'Installed {objective} failed: {child.stderr[-2000:]}')
            payload = json.loads(child.stdout)
            if payload.get('ok') is False:
                raise RuntimeError(f'Installed adapter failed: {payload}')
            result = payload.get('result', payload)
            expected = 6 if replan else 4
            assert len(result['placements']) == expected and not result['unplaced'], result
            assert result['searchCore']['backend'] == 'rust', result['searchCore']
            assert result['sheetsUsed'] == 1, result
            if replan:
                assert any(p['id'].split('#qt-')[0] == '安装验证' and p['xMm'] == 25 and p['yMm'] == 10
                           for p in result['placements']), result
            if objective == 'combined':
                assert result['algorithm'].startswith('tools/combined'), result['algorithm']
            evidence.append(dict(objective=objective, placements=expected, sheets=1,
                                 core=result['searchCore']['backend']))
    print('Installed runtime verified: ' + json.dumps(evidence), flush=True)


def bundle():
    if sys.platform != 'win32' or struct.calcsize('P') != 8 or sys.version_info[:2] != (3, 13):
        raise RuntimeError('Build the Windows x64 bundle with Python 3.13')
    base = Path(sys.base_prefix)
    version = f'{sys.version_info.major}{sys.version_info.minor}'
    inputs = [Path(__file__), ROOT / 'scripts/nesting/requirements-local-tools.txt']
    inputs += [SOURCE / name for name in MODULES]
    inputs += [SOURCE / f'rust_core/{name}' for name in ['Cargo.toml', 'Cargo.lock', 'src/lib.rs']]
    fingerprint = hashlib.sha256(sys.version.encode() + b''.join(p.read_bytes() for p in inputs)).hexdigest()
    stamp = DESTINATION / 'runtime.json'
    if stamp.is_file() and json.loads(stamp.read_text())['fingerprint'] == fingerprint:
        verify_runtime(DESTINATION)
        return
    subprocess.run(['cargo', 'build', '--release', '--locked', '--jobs', '1',
                    '--manifest-path', str(SOURCE / 'rust_core/Cargo.toml'),
                    '--target-dir', str(ROOT / '.tools/nesting/rust-core-target')], check=True)
    staging = DESTINATION.with_name('.imposition-runtime-' + uuid.uuid4().hex)
    staging.mkdir(parents=True)
    python = staging / '.tools/nesting/python'
    python.mkdir(parents=True)
    for name in ['python.exe', 'python3.dll', f'python{version}.dll',
                 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']:
        shutil.copy2(base / name, python / name)
    shutil.copytree(base / 'DLLs', python / 'DLLs', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    excluded = {'site-packages', 'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip'}
    with zipfile.ZipFile(python / f'python{version}.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in (base / 'Lib').rglob('*'):
            relative = file.relative_to(base / 'Lib')
            if file.is_file() and relative.parts[0] not in excluded and '__pycache__' not in relative.parts and file.suffix not in {'.pyc', '.pyo'}:
                archive.write(file, relative.as_posix())
    # Explicit paths isolate the interpreter from registry, PYTHONHOME and user sites.
    (python / f'python{version}._pth').write_text(f'python{version}.zip\n.\nDLLs\nLib/site-packages\n', encoding='utf-8')
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:', '--no-compile',
                    '--target', str(python / 'Lib/site-packages'), '-r',
                    str(ROOT / 'scripts/nesting/requirements-local-tools.txt')], check=True)
    module = staging / ADAPTER.parent
    module.mkdir(parents=True)
    for name in MODULES:
        shutil.copy2(SOURCE / name, module / name)
    native = staging / '.tools/nesting/native'
    native.mkdir(parents=True)
    shutil.copy2(ROOT / '.tools/nesting/rust-core-target/release/printflow_nesting_core.dll', native)
    # Test relocation before publishing build resources, including spaces and Unicode.
    with tempfile.TemporaryDirectory(prefix='PrintFlow 安装 验证 ') as relocated:
        shutil.copytree(staging, Path(relocated) / 'imposition-runtime')
        verify_runtime(Path(relocated) / 'imposition-runtime')
    (staging / '.gitkeep').touch()
    (staging / 'runtime.json').write_text(json.dumps(dict(fingerprint=fingerprint, python=sys.version,
                                                        layout='self-contained-windows-x64'), indent=2), encoding='utf-8')
    previous = DESTINATION.with_name('.imposition-runtime-' + uuid.uuid4().hex)
    if DESTINATION.exists():
        DESTINATION.rename(previous)
    staging.rename(DESTINATION)
    if previous.exists():
        # Only our explicitly checked generated-resource sibling is removed.
        assert previous.resolve().parent == (ROOT / 'src-tauri/resources').resolve()
        assert previous.name.startswith('.imposition-runtime-')
        shutil.rmtree(previous)
    print(f'Bundled nesting runtime: {DESTINATION}', flush=True)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--verify':
        verify_runtime(Path(sys.argv[2]))
    else:
        bundle()
