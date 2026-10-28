param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'ops\log-retention.ps1')
New-Item -ItemType Directory -Path $Root | Out-Null
for ($index = 1; $index -le 9; $index++) {
    $prefix = 'server-202601{0:D2}-010101-001' -f $index
    foreach ($name in @('stdout.log', 'stderr.log')) {
        [IO.File]::WriteAllText((Join-Path $Root "$prefix-$name"), 'fixture ' + $index)
    }
}
[IO.File]::WriteAllText((Join-Path $Root 'unrelated.log'), 'preserved')
[IO.File]::WriteAllText((Join-Path $Root 'server.log'), 'current output')
Remove-OldBackendLogs -Directory $Root
$old = @(Get-ChildItem -LiteralPath $Root -File -Filter 'server-*-std*.log')
if ($old.Count -ne 14) { throw 'Expected exactly seven retained process generations.' }
if (Test-Path -LiteralPath (Join-Path $Root 'server-20260101-010101-001-stdout.log')) { throw 'Oldest generation was not removed.' }
if ([IO.File]::ReadAllText((Join-Path $Root 'server.log')) -ne 'current output') { throw 'Existing evidence must be preserved.' }
if ([IO.File]::ReadAllText((Join-Path $Root 'unrelated.log')) -ne 'preserved') { throw 'Unrelated file changed.' }
$supervisor = Join-Path $Root 'supervisor.log'
[IO.File]::WriteAllBytes($supervisor, (New-Object byte[] 1MB))
Write-BoundedSupervisorLog -Path $supervisor -Message 'recovery record'
if ((Get-Item -LiteralPath "$supervisor.1").Length -ne 1MB) { throw 'Previous supervisor generation not preserved.' }
if ([IO.File]::ReadAllText($supervisor).Trim() -ne 'recovery record') { throw 'New supervisor generation is incorrect.' }
Write-BoundedSupervisorLog -Path $Root -Message 'injected directory error'
Write-Output 'PASS: retention preserves existing evidence; failed log writes preserve supervisor execution.'
