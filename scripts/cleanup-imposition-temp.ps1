param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPackage = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
if ($taskPackage.name -ne 'productionapp') { throw 'This script must remain in productionAPP/scripts.' }

# Exact reviewed targets only. Production data, tools sources, the active app
# build, and .tools/nesting/{.venv,native,rust-core-target} are not targets.
$taskRelativePaths = @(
    '.cargo-target-complexity', '.cargo-target-debugraw', '.cargo-target-quantity',
    '.cargo-target-real', '.cargo-target-real-complexity', '.test-output',
    '.tmp-complexity-repro', '.tmp-real-complexity-final', '.tmp-real-complexity-one',
    '.tmp-real-complexity-single', '.tmp-real-nesting', '.tmp-real-nesting-final',
    '.tmp_bal.py', '.tmp-deep-test.json', '.tmp-packingsolver-ds84-simplified.json',
    '.tmp-packingsolver-ds84.json', '.tmp-packingsolver-smoke.json', '.tmp-payload.json',
    '.tmp-real-nesting-final.log', '.tmp-real-nesting-ironnest-real.log',
    '.tmp-real-nesting-irregular.log', '.tmp-real-nesting-qt1-after.log',
    '.tmp-real-nesting-qt1.log', '.tmp-real-nesting-sheetnest-84.log',
    '.tmp-u-ds.err', '.tmp-u-ds.json', '.tmp-u-multi.json', '.tmp-u-test.json',
    'tmp_inspect_styles.py', 'tmp_inspect.py', 'tmp_pathattrs.py',
    'tmp_polycheck.py', 'tmp_repair.py', '.tools\nesting\repos',
    '.tools\nesting\python-libs', '.tools\nesting\target', '.tools\nesting\bin'
)

function Assert-NotLinked([System.IO.FileSystemInfo]$Item) {
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a linked path: $($Item.FullName)"
    }
}

# Validate the whole batch before deleting anything; never traverse a junction.
$taskVerified = @()
foreach ($taskRelative in $taskRelativePaths) {
    $taskCandidate = Join-Path $taskRoot $taskRelative
    if (-not (Test-Path -LiteralPath $taskCandidate)) { continue }
    $taskResolved = (Resolve-Path -LiteralPath $taskCandidate).Path
    if (-not $taskResolved.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a path outside the workspace: $taskResolved"
    }
    $taskItem = Get-Item -LiteralPath $taskResolved -Force
    $taskAncestor = $taskItem
    while ($null -ne $taskAncestor) {
        Assert-NotLinked $taskAncestor
        if ($taskAncestor.FullName -eq $taskRoot) { break }
        $taskAncestor = if ($taskAncestor.PSIsContainer) { $taskAncestor.Parent } else { $taskAncestor.Directory }
    }
    # Explicit stack: inspect a child before walking into it.
    $taskStack = [Collections.Generic.Stack[string]]::new()
    if ($taskItem.PSIsContainer) { $taskStack.Push($taskResolved) }
    while ($taskStack.Count -gt 0) {
        foreach ($taskChild in Get-ChildItem -LiteralPath $taskStack.Pop() -Force) {
            Assert-NotLinked $taskChild
            if ($taskChild.PSIsContainer) { $taskStack.Push($taskChild.FullName) }
        }
    }
    $taskVerified += $taskResolved
}

foreach ($taskProcess in Get-CimInstance Win32_Process) {
    if (-not $taskProcess.ExecutablePath) { continue }
    foreach ($taskTarget in $taskVerified) {
        if ($taskProcess.ExecutablePath.Equals($taskTarget, [StringComparison]::OrdinalIgnoreCase) -or
            $taskProcess.ExecutablePath.StartsWith($taskTarget + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Target is in use by process $($taskProcess.ProcessId): $taskTarget"
        }
    }
}

if (-not $Apply) {
    $taskVerified
    Write-Output "Preview only: $($taskVerified.Count) targets. Run with -Apply to delete."
    exit 0
}

$taskFailures = @()
foreach ($taskTarget in $taskVerified) {
    try {
        Remove-Item -LiteralPath $taskTarget -Recurse -Force -ErrorAction Stop
        Write-Output "Deleted: $taskTarget"
    } catch {
        $taskFailures += "$taskTarget : $($_.Exception.Message)"
    }
}
if ($taskFailures.Count -gt 0) { throw ($taskFailures -join [Environment]::NewLine) }
Write-Output "Completed: $($taskVerified.Count) targets removed."
