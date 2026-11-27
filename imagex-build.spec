# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, get_package_paths

import os
from pathlib import Path

datas = [
    ('frontend-mobile-preview/dist', 'frontend-mobile-preview/dist'),
    ('assets', 'assets')
]

# Only explicitly staged distributable defaults can go into the executable.
# The editable workstation configuration must never be picked up by a build.
_DEFAULT_CONNECTORS = os.path.join('config', 'connectors.defaults.json')
if os.path.isfile(_DEFAULT_CONNECTORS):
    datas.append((_DEFAULT_CONNECTORS, 'config'))
binaries = []
hiddenimports = ['uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.lifespan.on']
tmp_ret = collect_all('src')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('webview')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('playwright')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# Playwright's hermetic installer downloads both modes into its driver package.
# Keep Chromium files at exactly that layout inside the one-file executable.
_driver = Path(get_package_paths('playwright')[1]) / 'driver' / 'package'
_browser_dir = _driver / '.local-browsers'
for _pattern in (
    'chromium-*/chrome-win*/chrome.exe',
    'chromium_headless_shell-*/chrome-headless-shell-win*/chrome-headless-shell.exe',
):
    if not any(_browser_dir.glob(_pattern)):
        raise SystemExit('Chromium bundle incomplete. Run python scripts/install_dependencies.py --build first.')
# Keep this path short: the one-file archive may unpack under a deep Windows TEMP.
_bundle_prefix = 'b'
datas = [(src, dst) for src, dst in datas if '.local-browsers' not in Path(src).parts]
# Do not pass browser binaries through PyInstaller/UPX processing.
binaries = [(src, dst) for src, dst in binaries if '.local-browsers' not in Path(src).parts]
for _component in _browser_dir.iterdir():
    if _component.is_dir() and _component.name.startswith(('chromium-', 'chromium_headless_shell-', 'ffmpeg-', 'winldd-')):
        datas.append((str(_component), f'{_bundle_prefix}/{_component.name}'))
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
# Playwright's hook can add the default hermetic layout a second time.
# Keep only the explicit short-path copy of the browser payload.
_auto_browser_prefix = 'playwright/driver/package/.local-browsers/'
a.datas = [entry for entry in a.datas if not entry[0].replace(chr(92), '/').startswith(_auto_browser_prefix)]
a.binaries = [entry for entry in a.binaries if not entry[0].replace(chr(92), '/').startswith(_auto_browser_prefix)]
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
