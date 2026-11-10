# Native (no Docker) run on Windows: watcher + dbt cycle + frontend.
#   .\start.ps1            start, Ctrl+C stops both
#   .\start.ps1 -Rebuild   force `npm run build` and `pip install -e watcher`
#   .\start.ps1 -Stop      stop a running instance (reads data/<user>/state/native.pids)
# A stop is a hard kill (taskkill /T /F): the unflushed <= 30 s buffer is
# re-read on the next start (at-least-once, no loss).
param([switch]$Rebuild, [switch]$Stop)
$ErrorActionPreference = 'Stop'

$Repo = $PSScriptRoot -replace '\\', '/'
# One data folder per OS user (data/<user>/); AURA_USER overrides.
$User = if ($env:AURA_USER) { $env:AURA_USER } else { $env:USERNAME }
$Data = "$Repo/data/$User"
$PidFile = "$Data/state/native.pids"

function Stop-Aura {
    if (-not (Test-Path $PidFile)) { return }
    foreach ($p in Get-Content $PidFile) {
        # /T also kills dbt.exe / node children, so no orphan dbt keeps the work-DB lock.
        if ($p) { & taskkill /T /F /PID $p 2>$null | Out-Null }
    }
    Remove-Item $PidFile -Force
    Write-Host 'Aura stopped.'
}

if ($Stop) { Stop-Aura; exit 0 }

# 1. The watcher's own mode guard is the real enforcement; this is an early, clearer error.
if (Get-Command docker -ErrorAction SilentlyContinue) {
    # Docker installed but not running writes to stderr, which 'Stop' would turn into a fatal error.
    $ErrorActionPreference = 'Continue'
    $running = & docker ps -q --filter name=aura-watcher 2>$null
    $ErrorActionPreference = 'Stop'
    if ($running) { throw 'The compose watcher is running. Run `docker compose down` first (never run both modes at once).' }
}

# 2. Python 3.12 venv (watcher + dbt) and Node >= 20.
$Py = "$Repo/.venv/Scripts/python.exe"
$fresh = -not (Test-Path $Py)
if ($fresh) { & py -3.12 -m venv "$Repo/.venv"; if ($LASTEXITCODE) { throw 'Python 3.12 is required (py -3.12).' } }
$pyver = & $Py -c "import sys; print('%d.%d' % sys.version_info[:2])"
if ($pyver -ne '3.12') { throw ".venv uses Python $pyver; delete .venv and rerun with Python 3.12 installed." }
if ($fresh -or $Rebuild) { & $Py -m pip install -e "$Repo/watcher"; if ($LASTEXITCODE) { throw 'pip install failed' } }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node >= 20 is required.' }
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { throw "Node >= 20 is required (found $nodeMajor)." }

# 3. Frontend standalone build and its static copies; verify script deps.
$Fe = "$Repo/frontend"
Push-Location $Fe
try {
    if (-not (Test-Path "$Fe/node_modules")) { & npm ci --legacy-peer-deps; if ($LASTEXITCODE) { throw 'npm ci failed' } }
    if ($Rebuild -or -not (Test-Path "$Fe/.next/BUILD_ID")) { & npm run build; if ($LASTEXITCODE) { throw 'npm run build failed' } }
} finally { Pop-Location }
$Sa = "$Fe/.next/standalone"
Remove-Item "$Sa/.next/static", "$Sa/public" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$Fe/.next/static" "$Sa/.next/static" -Recurse
Copy-Item "$Fe/public" "$Sa/public" -Recurse
if (-not (Test-Path "$Repo/scripts/verify/node_modules")) {
    Push-Location "$Repo/scripts/verify"
    try { & npm install --omit=dev; if ($LASTEXITCODE) { throw 'npm install (scripts/verify) failed' } } finally { Pop-Location }
}

# 4. Env (inherited by both processes). .env is not read.
$env:AURA_RUN_MODE = 'native'
$env:AURA_DATA_DIR = $Data
$env:AURA_DB_PATH = "$Data/work/aura.duckdb"
$env:AURA_LOGS_DIR = ("$HOME/.claude/projects" -replace '\\', '/')
$env:AURA_OBSERVER = 'native'
# The native observer can drop events on bursts; sweep every minute.
$env:AURA_SWEEP_INTERVAL_SECONDS = '60'
$env:AURA_DBT_DIR = "$Repo/dbt"
$env:AURA_VERIFY_SCRIPT = "$Repo/scripts/verify/run_all.mjs"
# 4 threads x 4 GB OOMs on catch-up cycles (stg_tool_results, dim_turn_messages); one model at a time with more memory does not.
if (-not $env:AURA_DBT_THREADS) { $env:AURA_DBT_THREADS = '1' }
if (-not $env:AURA_DBT_MEMORY_LIMIT) { $env:AURA_DBT_MEMORY_LIMIT = '6GB' }
$env:TZ = 'UTC'
# The default console codepage is cp1252.
$env:PYTHONUTF8 = '1'
$env:HOSTNAME = '127.0.0.1'
$env:PORT = '3000'

# 5. Start both, logging under data/logs/.
$Logs = "$Data/logs"
New-Item -ItemType Directory -Force $Logs, "$Data/state" | Out-Null
$w = Start-Process -FilePath $Py -ArgumentList '-m', 'aura_watcher.main' -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$Logs/watcher.log" -RedirectStandardError "$Logs/watcher.err.log"
$f = Start-Process -FilePath node -ArgumentList "$Sa/server.js" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$Logs/frontend.log" -RedirectStandardError "$Logs/frontend.err.log"
Set-Content -Path $PidFile -Value $w.Id, $f.Id -Encoding ascii

# 7. Where to look.
Write-Host 'Aura running at http://127.0.0.1:3000 (Ctrl+C to stop)'
Write-Host "Logs: $Logs/watcher.log, $Logs/frontend.log (stderr in *.err.log)"

# 6. Wait until Ctrl+C or either process exits, then stop both.
try {
    while (-not $w.HasExited -and -not $f.HasExited) { Start-Sleep -Seconds 2 }
    Write-Host 'A process exited; see the logs. Stopping the other.'
} finally {
    Stop-Aura
}
