param(
    [string]$DesktopBinPath = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'),
    [string]$RuntimePath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime\cli')
)
$ErrorActionPreference = 'Stop'
# Desktop may remove old helper executables while a long-lived Web app-server
# still uses that directory. Give each Web process its own immutable bundle.
$required = @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')
$cli = Get-ChildItem -Path (Join-Path $DesktopBinPath '*\codex.exe') -File |
    Where-Object {
        $directory = $_.DirectoryName
        @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $directory $_) -PathType Leaf) }).Count -eq 0
    } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $cli) { throw 'No complete installed Codex runtime bundle found.' }
$hashes = @($required | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $cli.DirectoryName $_) -Algorithm SHA256).Hash })
$sha = [Security.Cryptography.SHA256]::Create()
try { $version = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($hashes -join ':'))))).Replace('-', '').Substring(0,24).ToLowerInvariant() }
finally { $sha.Dispose() }
$destination = Join-Path $RuntimePath $version
New-Item -ItemType Directory -Path $RuntimePath -Force | Out-Null
if (-not (Test-Path -LiteralPath $destination)) {
    $staging = Join-Path $RuntimePath ('staging-' + [Guid]::NewGuid().ToString('N'))
    try {
        Copy-Item -LiteralPath $cli.DirectoryName -Destination $staging -Recurse
        for ($i=0; $i -lt $required.Count; $i++) {
            if ((Get-FileHash -LiteralPath (Join-Path $staging $required[$i])).Hash -ne $hashes[$i]) { throw 'Desktop bundle changed during copy; start again after its update finishes.' }
        }
        Move-Item -LiteralPath $staging -Destination $destination
    } finally {
        if (Test-Path -LiteralPath $staging) {
            if (-not [IO.Path]::GetFullPath($staging).StartsWith([IO.Path]::GetFullPath($RuntimePath).TrimEnd('\')+'\')) { throw 'Unsafe staging cleanup path' }
            Remove-Item -LiteralPath $staging -Recurse -ErrorAction Stop
        }
    }
}
for ($i=0; $i -lt $required.Count; $i++) {
    if ((Get-FileHash -LiteralPath (Join-Path $destination $required[$i])).Hash -ne $hashes[$i]) { throw 'Managed Codex runtime integrity check failed.' }
}
Join-Path $destination 'codex.exe'
