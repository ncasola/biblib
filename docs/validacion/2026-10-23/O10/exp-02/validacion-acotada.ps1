$ErrorActionPreference = 'Stop'
$expWorkspace = 'C:\Users\ncaso\orca\workspaces\biblib\u-inf-03'
if ((Get-Location).Path -ne $expWorkspace) { throw 'Este ensayo solo corresponde al worktree asignado.' }
$expLogDir = Join-Path $expWorkspace '.biblib/integration'
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:BIBLIB_CATALOGUE_MODE = 'fixture'
$env:SUPABASE_DB_URL = ''
$env:SUPABASE_SERVICE_ROLE_KEY = ''
$env:NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:55341'
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = 'build-placeholder'
Remove-Item Env:BIBLIB_TARGET -ErrorAction SilentlyContinue
$expResults = @()
$expScripts = @('lint', 'typecheck', 'test', 'test:scripts --test-concurrency=1', 'build', 'test:smoke')
foreach ($expScript in $expScripts) {
  $expSlug = $expScript.Split(' ')[0].Replace(':', '-')
  if ($expScript.StartsWith('test:scripts')) {
    $env:BIBLIB_SKIP_STACK_TESTS = '1'
    $env:BIBLIB_SKIP_BUILD_TESTS = '1'
  } else {
    Remove-Item Env:BIBLIB_SKIP_STACK_TESTS -ErrorAction SilentlyContinue
    Remove-Item Env:BIBLIB_SKIP_BUILD_TESTS -ErrorAction SilentlyContinue
  }
  $expStarted = Get-Date
  $expJob = Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c pnpm $expScript" -WorkingDirectory $expWorkspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $expLogDir "bounded-$expSlug.log") -RedirectStandardError (Join-Path $expLogDir "bounded-$expSlug.err")
  $expFinished = $expJob.WaitForExit(120000)
  if (-not $expFinished -and -not $expJob.HasExited) {
    # Solo el árbol del proceso que acaba de crear este ensayo, nunca procesos por nombre/puerto.
    taskkill /PID $expJob.Id /T /F | Out-Null
    $null = $expJob.WaitForExit(10000)
  }
  $expJob.Refresh()
  $expCode = if ($expFinished) { $expJob.ExitCode } else { $null }
  $expResults += [pscustomobject]@{ command = "pnpm $expScript"; status = $(if (-not $expFinished) { 'timeout' } elseif ($expCode -eq 0) { 'passed' } else { 'failed' }); exitCode = $expCode; durationSeconds = [math]::Round(((Get-Date) - $expStarted).TotalSeconds, 1); stackAndBuildSkipped = $expScript.StartsWith('test:scripts') }
  $expResults | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $expLogDir 'bounded-results.json') -Encoding utf8
  Write-Output ($expResults[-1] | ConvertTo-Json -Compress)
}
