param([int]$AncestorPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'WindowsProcesses.cs')
$rows = [ShellAgents.WindowsProcesses]::Snapshot($AncestorPid)
[Console]::Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 3))
