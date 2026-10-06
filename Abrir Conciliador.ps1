$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'http://localhost:4173/'

function Show-LauncherError([string]$message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'Conciliador Financeiro', 'OK', 'Error') | Out-Null
  } catch {
    $message | Set-Content -LiteralPath (Join-Path $env:TEMP 'Conciliador-Financeiro-erro.txt') -Encoding UTF8
  }
}

function Get-AppResponse {
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:4173/' -UseBasicParsing -TimeoutSec 2
  } catch {
    $null
  }
}

try {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeCandidates = @(@(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    $(if ($nodeCommand) { $nodeCommand.Source })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
  if (-not $nodeCandidates) { throw 'Node.js não foi encontrado neste computador.' }
  $node = $nodeCandidates | Select-Object -First 1
  $vite = Join-Path $root 'node_modules\vite\bin\vite.js'
  if (-not (Test-Path -LiteralPath $vite)) { throw 'Não encontrei as dependências do app nesta pasta.' }

  # Atualiza os arquivos servidos para que o atalho abra a versão mais recente.
  $build = Start-Process -FilePath $node -ArgumentList ('"{0}" build --configLoader native' -f $vite) -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait
  if ($build.ExitCode -ne 0) { throw 'Não foi possível preparar a versão atual do app.' }

  $response = Get-AppResponse
  if ($response -and $response.Content -notmatch 'Conciliador') {
    throw 'A porta 4173 está sendo usada por outro aplicativo. Feche-o e tente novamente.'
  }
  if (-not $response) {
    $arguments = '"{0}" preview --configLoader native --host 127.0.0.1 --port 4173 --strictPort' -f $vite
    Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    $response = Get-AppResponse
    if ($response -and $response.Content -match 'Conciliador') { $ready = $true; break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $ready) { throw 'O app não respondeu na porta 4173. Verifique se outro programa está usando essa porta e tente novamente.' }

  $edgeCandidates = @(@(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ })
  if (-not $edgeCandidates) { throw 'Não encontrei o Microsoft Edge instalado neste computador.' }
  $edge = $edgeCandidates | Select-Object -First 1
  Start-Process -FilePath $edge -ArgumentList $url | Out-Null
} catch {
  Show-LauncherError $_.Exception.Message
}
