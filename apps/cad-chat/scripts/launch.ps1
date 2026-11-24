param([Parameter(Mandatory=$true)][ValidateSet('codex','claude')][string]$Provider)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sha = [Security.Cryptography.SHA256]::Create()
$identity = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($appRoot.ToLowerInvariant()))).Replace('-','').Substring(0,16)
$statePath = Join-Path $env:TEMP "cadchat-$identity.json"
$mutex = New-Object Threading.Mutex($false, "Local\CadChatLauncher-$identity")
$locked = $false
function Get-Control($state, $method) {
  Invoke-RestMethod -Method $method -UseBasicParsing -TimeoutSec 3 -Uri ($state.url + '__cadchat/launcher') -Headers @{Authorization=('Bearer ' + $state.token)}
}
try {
  try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { return }
  $nodePath = (Get-Command node.exe).Source
  Push-Location $appRoot
  try { $port = & $nodePath --input-type=module -e "import {loadDotEnvLocal,resolvePort} from './src/server/config.mjs';loadDotEnvLocal();console.log(resolvePort())" } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0 -or $port -notmatch '^\d+$') { throw 'Unable to resolve the CAD server port.' }
  $url = "http://127.0.0.1:$port/"
  $old = $null
  if (Test-Path -LiteralPath $statePath) {
    $old = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($old.url -ne $url) { throw 'Restore the previous CADCHAT_PORT before switching this instance.' }
    try { $status = Get-Control $old 'GET' } catch { $status = $null }
    if ($status.provider -eq $Provider) { Start-Process $url; return }
    if ($status.provider) {
      $waitChosen = $false
      while ($true) {
        try { $null = Get-Control $old 'POST'; break } catch {
          if ([int]$_.Exception.Response.StatusCode -ne 409) { throw }
          if (!$waitChosen) {
            $choice = [Windows.Forms.MessageBox]::Show('目前有工作進行中。要等工作完成後切換代理嗎？','cad-chat','YesNo','Question')
            if ($choice -ne 'Yes') { return }
            $waitChosen = $true
          }
          Start-Sleep -Seconds 1
        }
      }
      for ($i=0;$i -lt 60;$i++) {
        try { $null = Get-Control $old 'GET' } catch { break }
        Start-Sleep -Milliseconds 200
      }
    }
  }
  $state = @{ url=$url; token=[Guid]::NewGuid().ToString('N') }
  $env:CADCHAT_PROVIDER = $Provider
  $env:CADCHAT_PORT = "$port"
  $env:CADCHAT_LAUNCH_TOKEN = $state.token
  $errLog = Join-Path $env:TEMP "cadchat-$identity.stderr.log"
  $child = Start-Process -FilePath $nodePath -ArgumentList 'src/server/server.mjs','--dev' -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardError $errLog -RedirectStandardOutput (Join-Path $env:TEMP "cadchat-$identity.stdout.log") -PassThru
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding ASCII
  for ($i=0;$i -lt 90;$i++) {
    if ($child.HasExited) { throw "啟動失敗，請檢查連接埠及記錄檔 $errLog" }
    try { $status = Get-Control $state 'GET' } catch { $status = $null }
    if ($status.provider -eq $Provider) { Start-Process $url; return }
    Start-Sleep -Milliseconds 500
  }
  throw "伺服器尚未就緒，請檢查 $errLog"
} catch {
  [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'cad-chat')
  exit 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
