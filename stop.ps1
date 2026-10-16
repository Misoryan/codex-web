$ErrorActionPreference = 'Stop'
$record = Join-Path $PSScriptRoot 'runtime/server-process.json'
if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { return }
$state = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = Join-Path $PSScriptRoot 'src/server/main.js'
if ($state.entry -ne $entry) { throw 'Process record belongs to another checkout.' }
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
if ($process) {
    if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains($entry)) {
        throw 'PID belongs to another process; refusing to stop it.'
    }
    taskkill.exe /PID $state.pid /T /F
    if ($LASTEXITCODE -ne 0) { throw 'Failed to stop Codex Web.' }
}
Remove-Item -LiteralPath $record -ErrorAction Stop
