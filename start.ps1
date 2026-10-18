param([int]$Port = 8214)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port already has a listener."
}
if (-not $env:CODEX_CLI_PATH) {
    $env:CODEX_CLI_PATH = & (Join-Path $root 'ops/resolve-cli.ps1')
}
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$runtime = Join-Path $root 'runtime'
$temporary = Join-Path $runtime 'tmp'
New-Item -ItemType Directory -Path $temporary -Force | Out-Null
$env:TEMP = $temporary
$env:TMP = $temporary
$entry = Join-Path $root 'src/server/main.js'
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), '--host', '127.0.0.1', '--port', $Port) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'server.log') -RedirectStandardError (Join-Path $runtime 'server-error.log') -PassThru
@{pid = $process.Id; port = $Port; entry = $entry} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'server-process.json') -Encoding UTF8
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($process.HasExited) { throw "Codex Web exited; see runtime/server-error.log." }
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listener -and $listener.OwningProcess -eq $process.Id) {
        Write-Output "Codex Web: http://127.0.0.1:$Port (PID $($process.Id))"
        return
    }
    Start-Sleep -Milliseconds 500
}
throw 'Codex Web did not open its port within the startup deadline.'
