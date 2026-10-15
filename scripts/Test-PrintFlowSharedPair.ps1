param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Setup', 'A', 'B', 'Inspect')]
    [string]$Role,
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$Exe,
    [ValidateRange(1, 1000)]
    [int]$Round = 1
)

# Each participant runs locally. The fixture directory is the only shared state.
$ErrorActionPreference = 'Stop'
$batch = "two-pc-$Round"
$exePath = (Resolve-Path -LiteralPath $Exe).Path

function Invoke-ProbeResult {
    param([string[]]$ProbeArguments)
    $output = @(& $exePath @ProbeArguments)
    $code = $LASTEXITCODE
    if ($output.Count -eq 0) { throw "Probe returned no output (exit $code)" }
    $result = $output[-1] | ConvertFrom-Json
    return $result
}

function Write-NewJson {
    param([string]$Path, $Value)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

if ($Role -eq 'Setup') {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.printflow-probe'))) {
        $initialized = Invoke-ProbeResult -ProbeArguments @('init', '--root', $Root)
        if (-not $initialized.success) { throw $initialized.error }
    }
    $seeded = Invoke-ProbeResult -ProbeArguments @('seed', '--root', $Root, '--batch', $batch, '--actor', 'user-a', '--mb', '8')
    if (-not $seeded.success) { throw $seeded.error }
    Write-Host "Ready: $Root, round $Round. Run Role A and B on DIFFERENT computers."
    exit 0
}

if ($Role -eq 'Inspect') {
    $one = Get-Content -LiteralPath (Join-Path $Root "signals\$batch-A-result.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $two = Get-Content -LiteralPath (Join-Path $Root "signals\$batch-B-result.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $head = Invoke-ProbeResult -ProbeArguments @('inspect', '--root', $Root, '--batch', $batch)
    if (-not $head.success) { throw $head.error }
    $successCount = @(@($one, $two) | Where-Object { $_.success }).Count
    $failure = @(@($one, $two) | Where-Object { -not $_.success })
    if ($successCount -ne 1 -or $failure.Count -ne 1 -or $failure[0].error -notmatch 'VERSION_CONFLICT' -or $head.data.state.version -ne 2) {
        throw "Unexpected concurrent results. Inspect the result JSON and logs."
    }
    if ($one.computer -eq $two.computer) {
        Write-Warning 'Results came from the SAME computer. This does NOT prove two-computer SMB behavior.'
    } else {
        Write-Host "PASS: two computers ($($one.computer), $($two.computer)), one commit, one version conflict."
    }
    $head | ConvertTo-Json -Depth 12
    exit 0
}

$inspected = Invoke-ProbeResult -ProbeArguments @('inspect', '--root', $Root, '--batch', $batch)
if (-not $inspected.success) { throw $inspected.error }
$version = $inspected.data.state.version
$readyPath = Join-Path $Root "signals\$batch-$Role-ready.json"
Write-NewJson -Path $readyPath -Value @{ computer = $env:COMPUTERNAME; version = $version; role = $Role }
Write-Host "Role $Role has read version $version. Waiting for the other computer..."
$other = if ($Role -eq 'A') { 'B' } else { 'A' }
$otherPath = Join-Path $Root "signals\$batch-$other-ready.json"
$deadline = [DateTime]::UtcNow.AddSeconds(120)
while (-not (Test-Path -LiteralPath $otherPath)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Other computer did not join within 120 seconds. Use a new Round.' }
    Start-Sleep -Milliseconds 200
}
$otherReady = $null
while ($null -eq $otherReady) {
    try { $otherReady = Get-Content -LiteralPath $otherPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Could not read peer readiness record.' }
        Start-Sleep -Milliseconds 100
    }
}
if ($otherReady.version -ne $version) { throw 'Participants read different versions. Use a new Round.' }
# Both devices intentionally edit the same owner's test batch from the same base.
$result = Invoke-ProbeResult -ProbeArguments @('save', '--root', $Root, '--batch', $batch, '--actor', 'user-a', '--expected', "$version", '--value', "changed-by-$Role")
Write-NewJson -Path (Join-Path $Root "signals\$batch-$Role-result.json") -Value $result
$result | ConvertTo-Json -Depth 12
Write-Host 'Run Role Inspect after both participants finish. Use a new Round to repeat.'
