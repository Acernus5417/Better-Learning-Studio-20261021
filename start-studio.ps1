param([switch]$SkipBuild, [switch]$ShowErrorDialog)
$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$studioLogs = Join-Path $studioRoot '.desktop-cache'
New-Item -ItemType Directory -Path $studioLogs -Force | Out-Null
$studioLog = Join-Path $studioLogs ("startup-{0}-{1}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
$studioEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-StudioLog([string]$Message) {
    $safeMessage = $Message -replace 'https?://\S+', '[URL REDACTED]'
    $safeMessage = $safeMessage -replace '(?i)(bearer\s+)\S+', '$1[REDACTED]'
    $safeMessage = $safeMessage -replace '(?i)((?:token|api[_-]?key|authorization|password)["'':=\s]+)[^\s"'']+', '$1[REDACTED]'
    [IO.File]::AppendAllText($studioLog, "$safeMessage`r`n", $studioEncoding)
    Write-Host $safeMessage
}

function Invoke-StudioCommand([string]$Executable, [string[]]$CommandArguments) {
    $previousPreference = $ErrorActionPreference
    try {
        # Native stderr can contain ordinary Electron diagnostics in Windows PowerShell 5.
        $ErrorActionPreference = 'Continue'
        & $Executable @CommandArguments 2>&1 | ForEach-Object { Write-StudioLog $_.ToString() }
        $commandExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($commandExit -ne 0) { throw "Startup command exited with code $commandExit. See $studioLog" }
}

try {
    Write-StudioLog 'Starting Better Learning Studio...'
    $studioNodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $studioNode = if ($null -ne $studioNodeCommand) { $studioNodeCommand.Source } else {
        Join-Path $studioRoot 'apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime/dependencies/node/bin/node.exe'
    }
    if (-not (Test-Path -LiteralPath $studioNode -PathType Leaf)) { throw 'Node.js is unavailable. Restore the development dependencies before starting.' }
    $studioData = Join-Path $env:APPDATA 'BetterLearningStudio-DSH'
    $env:DSH_HOME = Join-Path $studioData 'dsh'
    $env:BLS_STUDIO = '1'
    $env:BLS_WORKFLOW_ROOT = Join-Path $studioRoot 'apps/desktop/resources/workflows/better-learning'
    $env:DSH_CLIENT_BUILD_PROFILE = 'better-learning'
    $env:DSH_CLIENT_TITLE = 'Better Learning Studio'
    $env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
    $env:electron_config_cache = Join-Path $studioLogs 'electron'
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'safe.directory'
    $env:GIT_CONFIG_VALUE_0 = ($studioRoot -replace '\\', '/')
    & $studioNode -e "try { require('node:os').userInfo(); process.exit(0) } catch { process.exit(1) }"
    if ($LASTEXITCODE -ne 0) {
        $studioShim = (Join-Path $studioRoot 'scripts/user-info-fallback.cjs') -replace '\\', '/'
        $env:NODE_OPTIONS = "--require=`"$studioShim`" $env:NODE_OPTIONS".Trim()
    }
    Set-Location -LiteralPath $studioRoot
    Invoke-StudioCommand $studioNode @('scripts/ensure-electron.mjs')
    $studioScript = if ($SkipBuild) { 'start:desktop' } else { 'dev:desktop' }
    $studioLocalPnpm = Join-Path $studioRoot 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs'
    if (Test-Path -LiteralPath $studioLocalPnpm -PathType Leaf) {
        Invoke-StudioCommand $studioNode @($studioLocalPnpm, 'run', $studioScript)
    } else {
        $studioPnpm = (Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        Invoke-StudioCommand $studioPnpm @('run', $studioScript)
    }
    exit 0
} catch {
    $studioFailure = $_.Exception.Message
    Write-StudioLog "Could not start Better Learning Studio: $studioFailure"
    if ($ShowErrorDialog) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("Better Learning Studio could not start.`r`n`r`n$studioFailure`r`n`r`nStartup log: $studioLog", 'Better Learning Studio', 'OK', 'Error') | Out-Null
    }
    exit 1
}
