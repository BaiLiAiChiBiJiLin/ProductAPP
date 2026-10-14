param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$manifest = Join-Path $Root 'src-tauri/src/imposition/local_nesting/rust_core/Cargo.toml'
$target = Join-Path $Root '.tools/nesting/rust-core-target'
$native = Join-Path $Root '.tools/nesting/native'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw 'Rust cargo is required to build the native nesting core. Install the Rust MSVC toolchain first.'
}
& cargo build --release --locked --jobs 1 --manifest-path $manifest --target-dir $target
if ($LASTEXITCODE -ne 0) { throw 'Building the Rust nesting core failed' }
$candidate = Join-Path $target 'release/printflow_nesting_core.dll'
if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
  throw "The native nesting DLL was not produced: $candidate"
}
if ($SkipDeploy) {
  Write-Host "Native nesting candidate: $candidate"
  Write-Host 'Use PRINTFLOW_NESTING_CORE_LIBRARY to test this candidate before deployment.'
} else {
  New-Item -ItemType Directory -Force -Path $native | Out-Null
  $destination = Join-Path $native 'printflow_nesting_core.dll'
  Copy-Item -LiteralPath $candidate -Destination $destination -Force
  Write-Host "Native nesting core ready: $destination"
}
