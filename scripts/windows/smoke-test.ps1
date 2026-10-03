# Smoke test of the SUDS Windows server zip, run by CI (.github/workflows/ci.yml, windows-exe) on windows-latest,
# where the runner is an administrator. -Dir is the unzipped suds-<version>-windows-x64.zip. It runs what county IT
# runs (docs/WINDOWS-SERVER.md): suds version, suds try (signs in with a sample account), suds status --json, the
# Windows service (install, start, health, a clean stop, uninstall) and suds logs. Every failure is one ::error::
# annotation, readable on the run's page without opening the log. Not part of the zip.
param(
  [Parameter(Mandatory = $true)] [string] $Dir,
  [Parameter(Mandatory = $true)] [string] $Version
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $Dir 'suds.exe'
$work = Join-Path $env:RUNNER_TEMP 'suds-smoke'
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Fail([string] $m) { Write-Output "::error::$m"; exit 1 }
function Step([string] $m) { Write-Output ''; Write-Output "=== $m" }
function FreePort {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start()
  $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}
function WaitLive([string] $base, [int] $seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    try { $r = Invoke-RestMethod "$base/api/health/live" -TimeoutSec 5; if ($r.ok) { return $true } } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Suds([string[]] $a) {
  $ErrorActionPreference = 'Continue' # a native command's stderr is output here, not an error
  $out = & $exe @a 2>&1 | ForEach-Object { "$_" } | Out-String
  return @{ code = $LASTEXITCODE; out = $out }
}

Step 'suds version'
$r = Suds @('version'); Write-Output $r.out
if ($r.code -ne 0) { Fail "suds.exe version exited $($r.code): $($r.out)" }
if ($r.out -notmatch [regex]::Escape("SUDS $Version")) { Fail "suds.exe version printed '$($r.out.Trim())', not SUDS $Version" }
$v = (& $exe version --json) | ConvertFrom-Json
if ($v.node -notmatch '^22\.') { Fail "suds.exe runs Node $($v.node), not the pinned Node 22" }
$r = Suds @('help'); if ($r.code -ne 0 -or $r.out -notmatch 'Windows service') { Fail "suds help did not list the commands: $($r.out)" }
$r = Suds @('service', '--help'); if ($r.code -ne 0 -or $r.out -notmatch 'NT SERVICE\\SUDS') { Fail "suds service --help: $($r.out)" }
$r = Suds @('no-such-command'); if ($r.code -ne 2) { Fail "an unknown command exited $($r.code), not 2" }
$r = Suds @('compliance-check'); if ($r.code -ne 5 -or $r.out -notmatch 'Linux servers only') { Fail "suds compliance-check on Windows exited $($r.code): $($r.out)" }

Step 'suds try: sample data, sign in, list clients'
$port = FreePort
$tryDir = Join-Path $work 'data-try'
$tryOut = Join-Path $work 'try.out'; $tryErr = Join-Path $work 'try.err'
$p = Start-Process -FilePath $exe -ArgumentList @('try', '--port', "$port", '--data', $tryDir) -PassThru -NoNewWindow -RedirectStandardOutput $tryOut -RedirectStandardError $tryErr
try {
  $base = "http://127.0.0.1:$port"
  if (-not (WaitLive $base 180)) { Get-Content $tryOut, $tryErr -ErrorAction SilentlyContinue; Fail "suds try did not answer on port $port within 3 minutes" }
  $h = Invoke-RestMethod "$base/api/health"
  if (-not $h.ok) { Fail "suds try: /api/health is not ok: $($h | ConvertTo-Json -Compress)" }
  $hdr = @{ 'X-Requested-With' = 'suds' }
  $body = @{ username = 'mrivera'; password = 'Navigator2026!!' } | ConvertTo-Json
  $login = Invoke-RestMethod "$base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -Headers $hdr -SessionVariable s
  if ($login.user.role -ne 'navigator') { Fail "suds try: signing in as mrivera gave $($login | ConvertTo-Json -Compress)" }
  $clients = Invoke-RestMethod "$base/api/clients" -WebSession $s -Headers $hdr
  if ($clients.clients.Count -lt 1) { Fail 'suds try: the sample clients are missing' }
  Write-Output "Signed in as mrivera (navigator); $($clients.clients.Count) sample clients."
  if ((Get-Content $tryOut -Raw) -notmatch 'suds try --reset') { Fail 'suds try: the banner does not say how to start over with suds try --reset' }
} finally { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Get-Content $tryOut | Select-Object -First 30

Step 'suds status --json (nothing running yet)'
$r = Suds @('status', '--json')
$st = $r.out | ConvertFrom-Json
if ($r.code -ne 1) { Fail "suds status with no server exited $($r.code), not 1" }
foreach ($k in 'version', 'service', 'server', 'data_dir', 'logs', 'backup', 'disk', 'update') { if ($null -eq $st.$k) { Fail "suds status --json has no '$k'" } }
if ($st.service.installed -ne $false) { Fail "suds status says the service is installed before install: $($st.service | ConvertTo-Json -Compress)" }
if ($st.data_dir -ne (Join-Path $env:ProgramData 'SUDS')) { Fail "the default data folder is $($st.data_dir), not %ProgramData%\SUDS" }

Step 'suds service install'
$r = Suds @('service', 'install'); Write-Output $r.out
if ($r.code -ne 0) { Fail "suds service install exited $($r.code): $($r.out)" }
$qc = sc.exe qc SUDS | Out-String; Write-Output $qc
if ($qc -notmatch 'NT SERVICE\\SUDS') { Fail "the service does not run as NT SERVICE\SUDS: $qc" }
if ($qc -notmatch 'AUTO_START') { Fail "the service is not set to start automatically: $qc" }
$fail = sc.exe qfailure SUDS | Out-String; Write-Output $fail
if ($fail -notmatch 'RESTART') { Fail "the service is not restarted on failure: $fail" }
$acl = icacls (Join-Path $env:ProgramData 'SUDS') | Out-String; Write-Output $acl
if ($acl -notmatch 'NT SERVICE\\SUDS') { Fail "the data folder does not grant NT SERVICE\SUDS: $acl" }
if ($acl -match 'BUILTIN\\Users') { Fail "the data folder still lets every user in: $acl" }

Step 'suds service start, health'
$r = Suds @('service', 'start'); Write-Output $r.out
if ($r.code -ne 0) {
  & $exe logs --errors 2>&1 | Out-String | Write-Output
  Get-ChildItem (Join-Path $env:ProgramData 'SUDS\logs\service') -ErrorAction SilentlyContinue | ForEach-Object { Write-Output "--- $($_.Name)"; Get-Content $_.FullName -Tail 40 }
  Fail "suds service start exited $($r.code): $($r.out)"
}
if (-not (WaitLive 'http://127.0.0.1:8080' 60)) { Fail 'the service does not answer on http://127.0.0.1:8080' }
$setup = Invoke-RestMethod 'http://127.0.0.1:8080/api/setup/status'
if (-not $setup.needed) { Fail "a new service install does not offer the setup wizard: $($setup | ConvertTo-Json -Compress)" }
if ($setup.env -ne 'production') { Fail "the service runs in $($setup.env), not production" }
$r = Suds @('status', '--json'); Write-Output $r.out
$st = $r.out | ConvertFrom-Json
if ($st.service.state -ne 'running') { Fail "suds status says the service is $($st.service.state)" }
if ($st.service.account -notmatch 'NT SERVICE\\SUDS') { Fail "suds status gives the account as $($st.service.account)" }
if (-not $st.server.reachable) { Fail 'suds status cannot reach the server' }
$r = Suds @('status'); Write-Output $r.out
$r = Suds @('service', 'status'); if ($r.code -ne 0 -or $r.out -notmatch 'running') { Fail "suds service status: $($r.out)" }
if (-not (Test-Path (Join-Path $env:ProgramData 'SUDS\keys.json'))) { Fail 'the service did not create keys.json in the data folder' }

Step 'suds service stop: a clean shutdown'
$r = Suds @('service', 'stop'); Write-Output $r.out
if ($r.code -ne 0) { Fail "suds service stop exited $($r.code): $($r.out)" }
$data = Join-Path $env:ProgramData 'SUDS'
if (Test-Path (Join-Path $data '.suds.lock')) { Fail 'the instance lock is still there after the service stopped: the stop was not clean' }
$log = Get-ChildItem (Join-Path $data 'logs') -Filter 'suds-*.log' | Sort-Object Name | Select-Object -Last 1
if (-not $log -or (Get-Content $log.FullName -Raw) -notmatch 'shutting down') { Fail 'the server log does not show a clean shutdown (WinSW''s Ctrl+C did not reach the server)' }
if (Test-Path (Join-Path $data 'suds.db-wal')) { Fail 'the database was not closed (its write-ahead log is still there)' }

Step 'suds service restart (start, then restart)'
$r = Suds @('service', 'restart'); Write-Output $r.out
if ($r.code -ne 0) { Fail "suds service restart exited $($r.code): $($r.out)" }
if (-not (WaitLive 'http://127.0.0.1:8080' 60)) { Fail 'the service does not answer after a restart' }

Step 'suds logs'
$r = Suds @('logs', '--lines', '5'); Write-Output $r.out
if ($r.code -ne 0) { Fail "suds logs --lines 5 exited $($r.code): $($r.out)" }
if (($r.out.Trim() -split "`n").Count -lt 1) { Fail 'suds logs printed nothing' }
$r = Suds @('logs', '--errors', '--lines', '20'); Write-Output $r.out
if ($r.code -ne 0) { Fail "suds logs --errors exited $($r.code)" }
foreach ($f in Get-ChildItem (Join-Path $data 'logs') -Recurse -File) { if ((Get-Content $f.FullName -Raw) -match 'Temporary password:') { Fail "$($f.FullName) holds the first administrator's temporary password" } }

Step 'suds backup (elevated, while the service runs)'
$r = Suds @('backup'); Write-Output $r.out
if ($r.code -ne 0 -or $r.out -notmatch 'Encrypted backup written') { Fail "suds backup exited $($r.code): $($r.out)" }

Step 'The Event Log (Application, source SUDS)'
try { Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'SUDS' } -MaxEvents 10 | Format-Table -AutoSize TimeCreated, Id, LevelDisplayName, Message | Out-String -Width 200 | Write-Output }
catch { Write-Output "::warning::No Application log events from source SUDS: $($_.Exception.Message)" }

Step 'suds service uninstall'
$r = Suds @('service', 'uninstall'); Write-Output $r.out
if ($r.code -ne 0) { Fail "suds service uninstall exited $($r.code): $($r.out)" }
sc.exe query SUDS | Out-Null
if ($LASTEXITCODE -ne 1060) { Fail "the service is still installed after uninstall (sc.exe query exited $LASTEXITCODE)" }
if (-not (Test-Path (Join-Path $data 'suds.db'))) { Fail 'uninstall removed the data' }
Write-Output ''
Write-Output 'The Windows server zip passed its smoke test.'
exit 0
