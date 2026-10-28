function Remove-OldBackendLogs {
    param([Parameter(Mandatory = $true)][string]$Directory)
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $logs = @(Get-ChildItem -LiteralPath $root -File -ErrorAction Stop | Where-Object {
        $_.Name -match '^server-\d{8}-\d{6}-\d{3}-(?:stdout|stderr)\.log$'
    })
    $generations = @($logs | ForEach-Object { $_.Name.Substring(0, 26) } | Sort-Object -Descending -Unique)
    foreach ($generation in @($generations | Select-Object -Skip 7)) {
        foreach ($log in @($logs | Where-Object { $_.Name.StartsWith($generation + '-') })) {
            if ($log.DirectoryName -ne $root -or ($log.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Log retention target is outside the expected directory.'
            }
            Remove-Item -LiteralPath $log.FullName -ErrorAction Stop
        }
    }
}

function Write-BoundedSupervisorLog {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Message)
    try {
        if ($Message.Length -gt 16384) { $Message = $Message.Substring(0, 16384) }
        if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -ge 1MB) {
            $previous = "$Path.1"
            if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -ErrorAction Stop }
            Move-Item -LiteralPath $Path -Destination $previous -ErrorAction Stop
        }
        Add-Content -LiteralPath $Path -Value $Message -Encoding utf8 -ErrorAction Stop
    } catch {
        # Disk failure in diagnostics must not terminate the restart supervisor.
    }
}
