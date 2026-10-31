#Requires -Version 7.4
# Native Windows equivalent of bench.sh. Run from any directory; data stays in this checkout.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Name,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$WebPort,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$MockPort,
    [ValidateSet('start', 'stop', 'reset', 'status')][string]$Action = 'start',
    [string]$Patch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Use dev/bench.sh on non-Windows systems.' }
if ($WebPort -eq 3080 -or $MockPort -eq 3080) { throw 'Port 3080 belongs to the real service.' }
if ($WebPort -eq $MockPort) { throw 'WebPort and MockPort must be different.' }

$Plugin = Split-Path -Parent $PSScriptRoot
$Root = Split-Path -Parent $Plugin
$BenchHome = Join-Path $Root ".dsh-test-$Name"
$Overlay = Join-Path $BenchHome 'bench.patch.yml'

function Assert-BenchPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith("$BenchHome\", [StringComparison]::OrdinalIgnoreCase) -and $full -ne $BenchHome) {
        throw "Path is outside this bench: $full"
    }
    for ($current = $full; $current -ne $Root; $current = Split-Path -Parent $current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a linked bench path: $current"
            }
        }
    }
}

function Remove-BenchData([string]$Path, [switch]$Recurse) {
    Assert-BenchPath $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if ($Recurse) {
        foreach ($entry in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
            Assert-BenchPath $entry.FullName
        }
    }
    Remove-Item -LiteralPath $Path -Recurse:$Recurse -Force
}

function Get-BenchProcess([string]$Label) {
    $file = Join-Path $BenchHome "$Label.pid"
    if (-not (Test-Path -LiteralPath $file)) { return }
    Assert-BenchPath $file
    $recorded = (Get-Content -LiteralPath $file -Raw).Trim()
    if ($recorded -notmatch '^[1-9][0-9]*$') { throw "Invalid PID file: $file" }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $recorded"
    if (-not $process) { return }
    # A stale PID can be reused by an unrelated process; never stop that process.
    $marker = if ($Label -eq 'mock') { $BenchHome } else { $Overlay }
    if ($process.Name -ne 'node.exe' -or -not $process.CommandLine -or
        -not $process.CommandLine.Contains(('"{0}"' -f $marker), [StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "PID $recorded no longer identifies this bench's $Label process; leaving it alone."
        return
    }
    return $process
}

function Get-PortListeners([int]$Port) {
    Get-NetTCPConnection -State Listen | Where-Object LocalPort -EQ $Port
}

function Show-BenchStatus {
    foreach ($label in 'mock', 'web') {
        $process = Get-BenchProcess $label
        $file = Join-Path $BenchHome "$label.pid"
        $recorded = if (Test-Path -LiteralPath $file) { (Get-Content -LiteralPath $file -Raw).Trim() } else { 'none' }
        $state = if ($process) { 'alive' } else { 'dead' }
        Write-Output "${label}: $state (pid $recorded)"
    }
    foreach ($port in $WebPort, $MockPort) {
        $listeners = @(Get-PortListeners $port)
        if ($listeners.Count -eq 0) { Write-Output "port ${port}: free"; continue }
        foreach ($listener in $listeners) {
            $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            $ownerName = if ($owner) { $owner.ProcessName } else { 'exited' }
            Write-Output "port ${port}: listening (pid $($listener.OwningProcess), $ownerName)"
        }
    }
    Write-Output "home: $BenchHome  web: http://127.0.0.1:$WebPort  mock: $MockPort"
}

function Stop-BenchProcess([string]$Label) {
    $process = Get-BenchProcess $Label
    if ($process) {
        $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
        $tree = [Collections.Generic.List[object]]::new()
        $tree.Add($process)
        for ($index = 0; $index -lt $tree.Count; $index++) {
            foreach ($child in $all) {
                if ($child.ParentProcessId -eq $tree[$index].ProcessId -and
                    $child.CreationDate -ge $tree[$index].CreationDate) {
                    $tree.Add($child)
                }
            }
        }
        for ($index = $tree.Count - 1; $index -ge 0; $index--) {
            $entry = $tree[$index]
            $live = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.ProcessId)"
            if ($live -and $live.CreationDate -eq $entry.CreationDate) {
                try { Stop-Process -Id $live.ProcessId -Force } catch {
                    $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.ProcessId)"
                    if ($remaining -and $remaining.CreationDate -eq $entry.CreationDate) { throw }
                }
            }
        }
    }
    Remove-BenchData (Join-Path $BenchHome "$Label.pid")
}

function Stop-Bench {
    Stop-BenchProcess 'web'
    Stop-BenchProcess 'mock'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $busy = @($WebPort, $MockPort | Where-Object { @(Get-PortListeners $_).Count -gt 0 })
        if ($busy.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    Show-BenchStatus
    throw "Ports still occupied after stop: $($busy -join ', '). No unrelated port owner was stopped."
}

function Get-HarnessPath {
    if ($env:DSH_HARNESS) { return (Resolve-Path -LiteralPath $env:DSH_HARNESS).ProviderPath }
    $candidates = @(
        (Join-Path (Split-Path -Parent $Root) 'deepseek-harness'),
        (Join-Path $Root 'deepseek-harness')
    )
    $common = & git -C $Root rev-parse --path-format=absolute --git-common-dir
    if ($LASTEXITCODE -eq 0) {
        $main = Split-Path -Parent $common
        $candidates += (Join-Path $main 'deepseek-harness')
        $candidates += (Join-Path (Split-Path -Parent $main) 'deepseek-harness')
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'apps/cli/src/bin.ts')) {
            return (Resolve-Path -LiteralPath $candidate).ProviderPath
        }
    }
    throw 'DeepSeek Harness checkout not found; set DSH_HARNESS to its path.'
}

function Initialize-BenchProfile {
    $profileDir = Join-Path $BenchHome 'profiles/web'
    $packageFile = Join-Path $profileDir 'package.json'
    $workspaceFile = Join-Path $profileDir 'pnpm-workspace.yaml'
    foreach ($path in $packageFile, $workspaceFile) { Assert-BenchPath $path }
    # Keep the drive letter: link:/d/... would become a broken D:\d\... junction.
    $link = "link:$($Plugin.Replace('\', '/'))"
    $profileMatches = $false
    if (Test-Path -LiteralPath $packageFile) {
        $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json -AsHashtable
        $profileMatches = $package.dependencies -and $package.dependencies['ds-bot'] -eq $link
    }
    $installed = Test-Path -LiteralPath (Join-Path $profileDir 'node_modules/ds-bot/package.json')
    if ($profileMatches -and $installed) { return }
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    @{
        name = 'dsh-profile-web'
        private = $true
        dependencies = @{ 'ds-bot' = $link }
        dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot') } }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $packageFile -Encoding utf8
    Set-Content -LiteralPath $workspaceFile -Value "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false" -Encoding utf8
    $previousHome = $env:DSH_HOME
    Push-Location -LiteralPath $profileDir
    try {
        $env:DSH_HOME = $BenchHome
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed in $profileDir (exit $LASTEXITCODE)." }
    } finally {
        $env:DSH_HOME = $previousHome
        Pop-Location
    }
}

function Write-BenchOverlay {
    $rows = @()
    if ($env:CHECK_RATIO) {
        $rows += "- id: bot`n  config:`n    checkRatio: $env:CHECK_RATIO"
    }
    if ($env:CONTEXT_WINDOW) {
        $rows += @"
- id: llm-deepseek
  config:
    models:
      - { id: deepseek-flash, contextWindow: $env:CONTEXT_WINDOW, maxTokens: 8000, inputModalities: [text, image] }
      - { id: deepseek-v4-pro, contextWindow: $env:CONTEXT_WINDOW, maxTokens: 8000 }
"@
    }
    Assert-BenchPath $Overlay
    Set-Content -LiteralPath $Overlay -Value $(if ($rows.Count) { $rows -join "`n" } else { '[]' }) -Encoding utf8
}

function Start-BenchProcess([string]$Label, [string]$Directory, [string[]]$Arguments, [hashtable]$Environment) {
    $stdout = Join-Path $BenchHome $(if ($Label -eq 'web') { 'web.log' } else { 'mock.out' })
    $stderr = Join-Path $BenchHome "$Label.err"
    $pidFile = Join-Path $BenchHome "$Label.pid"
    foreach ($path in $stdout, $stderr, $pidFile) { Assert-BenchPath $path }
    # Start-Process joins ArgumentList; quote paths explicitly so worktrees may contain spaces.
    $process = Start-Process -FilePath (Get-Command node.exe).Source -WorkingDirectory $Directory `
        -ArgumentList ($Arguments | ForEach-Object { '"{0}"' -f $_ }) -Environment $Environment `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
}

function Wait-Bench {
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        $mock = Get-BenchProcess 'mock'
        $web = Get-BenchProcess 'web'
        if (-not $mock -or -not $web) { throw 'A bench process exited before readiness.' }
        $log = Join-Path $BenchHome 'web.log'
        if ((Select-String -LiteralPath $log -SimpleMatch 'dsh web: http' -Quiet) -and
            @(Get-PortListeners $WebPort).Count -gt 0 -and @(Get-PortListeners $MockPort).Count -gt 0) {
            return
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Bench readiness timed out after 120 seconds (web log marker and listening ports required).'
}

function Start-Bench {
    $harness = Get-HarnessPath
    $picker = Join-Path $harness 'apps/web/tests/pin-browse-picker.overlay.yml'
    foreach ($path in (Join-Path $harness 'apps/cli/src/bin.ts'), $picker) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required harness file not found: $path" }
    }
    $extraPatch = if ($Patch) { (Resolve-Path -LiteralPath $Patch).ProviderPath } else { $null }
    if ($extraPatch -and -not (Test-Path -LiteralPath $extraPatch -PathType Leaf)) {
        throw "Extra patch is not a file: $extraPatch"
    }
    foreach ($entry in @(@('mock', $MockPort), @('web', $WebPort))) {
        if (-not (Get-BenchProcess $entry[0]) -and @(Get-PortListeners $entry[1]).Count -gt 0) {
            Show-BenchStatus
            throw "Port $($entry[1]) is already occupied; no process was started."
        }
    }
    New-Item -ItemType Directory -Path $BenchHome -Force | Out-Null
    Initialize-BenchProfile
    Write-BenchOverlay
    $started = @()
    try {
        if (-not (Get-BenchProcess 'mock')) {
            Assert-BenchPath (Join-Path $BenchHome 'mock.jsonl')
            Start-BenchProcess 'mock' $Plugin @('dev/mock-llm.mjs', $BenchHome) @{
                DSH_HOME = $BenchHome
                MOCK_PORT = "$MockPort"
                MOCK_DELAY_MS = $(if ($env:MOCK_DELAY_MS) { $env:MOCK_DELAY_MS } else { '300' })
                MOCK_LOG = (Join-Path $BenchHome 'mock.jsonl')
            }
            $started += 'mock'
        }
        if (-not (Get-BenchProcess 'web')) {
            $arguments = @('--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web',
                '--patch', $picker, '--patch', $Overlay)
            if ($extraPatch) { $arguments += @('--patch', $extraPatch) }
            $arguments += @('--no-open', '--port', "$WebPort")
            Start-BenchProcess 'web' $harness $arguments @{
                DSH_HOME = $BenchHome
                DEEPSEEK_BASE_URL = "http://127.0.0.1:$MockPort/v1"
                DEEPSEEK_API_KEY = 'mock-key'
            }
            $started += 'web'
        }
        Wait-Bench
    } catch {
        $failure = $_
        foreach ($file in 'web.log', 'web.err', 'mock.out', 'mock.err') {
            $path = Join-Path $BenchHome $file
            if (Test-Path -LiteralPath $path) {
                Write-Host "--- $file (last 20 lines, login tokens omitted) ---"
                Get-Content -LiteralPath $path -Tail 20 | Where-Object { $_ -notmatch 'token=' } | Write-Host
            }
        }
        [array]::Reverse($started)
        foreach ($label in $started) { Stop-BenchProcess $label }
        throw "Bench startup failed: $($failure.Exception.Message) See logs in $BenchHome."
    }
    Show-BenchStatus
}

Assert-BenchPath $BenchHome
switch ($Action) {
    'status' { Show-BenchStatus }
    'stop' { Stop-Bench; Show-BenchStatus }
    'start' { Start-Bench }
    'reset' {
        Stop-Bench
        foreach ($file in 'mock.jsonl', 'cookies.txt') { Remove-BenchData (Join-Path $BenchHome $file) }
        Remove-BenchData (Join-Path $BenchHome 'bot') -Recurse
        $sessions = Join-Path $BenchHome 'sessions'
        Assert-BenchPath $sessions
        if (Test-Path -LiteralPath $sessions) {
            foreach ($workspace in Get-ChildItem -LiteralPath $sessions -Directory -Filter '*workspace*') {
                Assert-BenchPath $workspace.FullName
                foreach ($session in Get-ChildItem -LiteralPath $workspace.FullName -Filter 'session-*') {
                    Remove-BenchData $session.FullName -Recurse
                }
            }
        }
        Start-Bench
    }
}
