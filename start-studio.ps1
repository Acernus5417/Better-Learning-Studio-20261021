param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$studioData = Join-Path $env:APPDATA 'BetterLearningStudio-DSH'
$env:DSH_HOME = Join-Path $studioData 'dsh'
$env:BLS_STUDIO = '1'
$env:BLS_WORKFLOW_ROOT = Join-Path $studioRoot 'apps\desktop\resources\workflows\better-learning'
$env:DSH_CLIENT_BUILD_PROFILE = 'better-learning'
$env:DSH_CLIENT_TITLE = 'Better Learning Studio'
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
$env:electron_config_cache = Join-Path $studioRoot '.desktop-cache\electron'
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = ($studioRoot -replace '\\', '/')
& node -e "try { require('node:os').userInfo(); process.exit(0) } catch { process.exit(1) }"
if ($LASTEXITCODE -ne 0) {
    $studioShim = (Join-Path $studioRoot 'scripts\user-info-fallback.cjs') -replace '\\', '/'
    $env:NODE_OPTIONS = "--require=`"$studioShim`" $env:NODE_OPTIONS".Trim()
}
Set-Location -LiteralPath $studioRoot
& node scripts/ensure-electron.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($SkipBuild) { & node --import=tsx apps/desktop/scripts/dev.ts --skip-build }
else { & pnpm run dev:desktop }
exit $LASTEXITCODE
