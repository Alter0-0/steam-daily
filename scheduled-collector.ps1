param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $project
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$OutputEncoding = [Console]::OutputEncoding
$log = Join-Path $project 'data\collector.log'
try {
    "`r`nScheduled run: $([DateTimeOffset]::Now.ToString('o'))" | Out-File -FilePath $log -Append -Encoding utf8
    # Native stderr describes network failures; it must not suppress Node's exit code.
    $ErrorActionPreference = 'Continue'
    & $NodePath (Join-Path $project 'collector.mjs') 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
    exit $LASTEXITCODE
} catch {
    $_.ToString() | Out-File -FilePath $log -Append -Encoding utf8
    exit 1
}
