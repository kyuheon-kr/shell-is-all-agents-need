param([int]$ServerPid, [string]$Started, [string]$SourcePipe, [string]$ControlPipe, [switch]$Worker)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'WindowsPipes.cs')
if (-not $Worker) {
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
        '-Worker', '-ServerPid', "$ServerPid", '-Started', $Started, '-SourcePipe', $SourcePipe, '-ControlPipe', $ControlPipe)
    $workerPid = [ShellAgents.WindowsPipes]::StartWorker((Join-Path $PSHOME 'powershell.exe'), $arguments)
    [Console]::WriteLine("STARTED $workerPid")
    exit 0
}
[ShellAgents.WindowsPipes]::Run($ServerPid, $Started, $SourcePipe, $ControlPipe)
