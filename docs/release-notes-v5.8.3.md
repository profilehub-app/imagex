# ImageX v5.8.3: Windows Chromium setup

The standard Windows download is smaller. On first launch, ImageX downloads the matching Chromium Headless Shell in the background. You can use the local library while the download runs. Browser-dependent features become available when setup completes.

## Which download should I choose?

- **IMAGEX.exe** or **IMAGEX-Windows.zip**: The standard Windows build. Internet access is required for the first Chromium download. If it fails, select Retry in ImageX. Subsequent launches reuse the installed browser.
- **IMAGEX-Windows-Offline.zip**: The larger package includes Chromium and does not require a first-run browser download. Features that retrieve online media still need internet access.
- **Source code**: Run `python scripts/install_dependencies.py` to install the Python dependencies and matching Playwright Chromium. See the README for the remaining setup steps.

This release fixes missing Chromium on clean Windows installs without relying on an existing Chrome or Playwright installation.
