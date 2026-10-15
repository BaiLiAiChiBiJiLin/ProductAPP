param([switch]$PythonOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$venv = Join-Path $root '.tools/nesting/.venv'
$python = Join-Path $venv 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw '创建拼版 Python 环境失败' }
}
& $python -m pip install -r (Join-Path $PSScriptRoot 'requirements-local-tools.txt')
if ($LASTEXITCODE -ne 0) { throw '安装本地拼版依赖失败' }
& $python -c 'import cv2, numpy, shapely; print("Local tools nesting runtime ready")'
if ($LASTEXITCODE -ne 0) { throw '本地拼版运行时校验失败' }
if (-not $PythonOnly) {
  & (Join-Path $PSScriptRoot 'build_rust_core.ps1')
}
