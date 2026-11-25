# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

import os

datas = [
    ('frontend-mobile-preview/dist', 'frontend-mobile-preview/dist'),
    ('assets', 'assets')
]

# Default connectors are untracked; ship them read-only inside the executable so a fresh
# install works without any user-provided file. Builds must provide this file.
_DEFAULT_CONNECTORS = os.path.join('config', 'connectors.local.json')
if not os.path.isfile(_DEFAULT_CONNECTORS):
    raise SystemExit(f'Missing {_DEFAULT_CONNECTORS}: refusing to build an executable without default connectors.')
datas.append((_DEFAULT_CONNECTORS, 'config'))
binaries = []
hiddenimports = ['uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.lifespan.on']
tmp_ret = collect_all('src')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('webview')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('playwright')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('selectolax')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['src/main.py'],
    pathex=['.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['torch', 'torchvision', 'torchaudio', 'scipy', 'matplotlib', 'sympy', 'numba', 'llvmlite', 'tensorboard'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='IMAGEX',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='assets/app-icon.ico',
)
