#Requires -Version 5.1
<#
  Inicializador de DESENVOLVIMENTO do Gerpro Studio no Windows.

  Executa `npm run dev` na pasta do projeto, sem janela de terminal, e espera
  a janela do app aparecer. Usado pelos atalhos criados por
  install-shortcuts.ps1; não substitui nem altera `npm run dev`.

  - Não depende do diretório atual: a pasta do projeto vem da localização
    deste arquivo.
  - Uma segunda chamada não abre outro ambiente: traz a janela existente para
    a frente.
  - Logs ficam fora do repositório, em %LOCALAPPDATA%\Gerpro Studio\logs
    (inicializador-*.log e dev-*.log, os 10 mais recentes de cada).
  - Qualquer falha mostra uma mensagem com o caminho do log.
#>

$ErrorActionPreference = 'Stop'

$AppTitle = 'Gerpro Studio'
$StartTimeoutSeconds = 180
$KeepLogs = 10
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$LogDir = Join-Path $env:LOCALAPPDATA 'Gerpro Studio\logs'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $LogDir "inicializador-$Stamp.log"
$DevLog = Join-Path $LogDir "dev-$Stamp.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Show-Failure([string]$Message) {
  Write-Log "ERRO: $Message"
  Add-Type -AssemblyName PresentationFramework
  $text = "$Message`n`nRegistro do inicializador:`n$LogFile`n`nSaída do ambiente de desenvolvimento:`n$DevLog"
  [System.Windows.MessageBox]::Show($text, "${AppTitle}: não foi possível iniciar", 'OK', 'Error') | Out-Null
  Write-Log 'Mensagem de erro exibida e fechada pelo usuário.'
}

function Remove-OldLogs {
  foreach ($pattern in 'inicializador-*.log', 'dev-*.log') {
    Get-ChildItem -LiteralPath $LogDir -Filter $pattern -File |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $KeepLogs |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

# Janela principal do app aberto a partir DESTE projeto (não de outro Electron).
function Get-AppWindowProcess {
  $electronDir = Join-Path $ProjectRoot 'node_modules\electron\dist'
  Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -eq $AppTitle -and
    $_.Path -and $_.Path.StartsWith($electronDir, [StringComparison]::OrdinalIgnoreCase)
  } | Select-Object -First 1
}

function Show-AppWindow($Process) {
  Add-Type -Namespace Gerpro -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
'@
  $hwnd = $Process.MainWindowHandle
  if ([Gerpro.Win32]::IsIconic($hwnd)) { [void][Gerpro.Win32]::ShowWindowAsync($hwnd, 9) } # SW_RESTORE
  [void][Gerpro.Win32]::SetForegroundWindow($hwnd)
}

try {
  Remove-OldLogs
  Write-Log "Inicializador do $AppTitle (desenvolvimento). Projeto: $ProjectRoot"

  # Uma inicialização por vez. O mutex fica com este processo até o app fechar.
  $mutex = New-Object System.Threading.Mutex($false, 'Local\GerproStudioDevLauncher')
  $owned = $false
  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) {
    $existing = Get-AppWindowProcess
    if ($existing) {
      Write-Log "Já aberto (PID $($existing.Id)): trazendo a janela para a frente."
      Show-AppWindow $existing
    } else {
      Write-Log 'Outra inicialização já está em andamento; nada a fazer.'
    }
    exit 0
  }

  # Aberto por fora do inicializador (ex.: `npm run dev` no terminal): só foca.
  $existing = Get-AppWindowProcess
  if ($existing) {
    Write-Log "Já aberto fora do inicializador (PID $($existing.Id)): trazendo a janela para a frente."
    Show-AppWindow $existing
    exit 0
  }

  # Pré-requisitos, com mensagens compreensíveis.
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json'))) {
    Show-Failure "A pasta do projeto não foi encontrada em:`n$ProjectRoot"
    exit 1
  }
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $npm -or -not $node) {
    Show-Failure 'O Node.js não foi encontrado. Instale o Node.js (que inclui o npm) e tente de novo.'
    exit 1
  }
  Write-Log ("Node {0} em {1}" -f (& $node.Source -v), $node.Source)
  foreach ($required in 'node_modules\electron\dist\electron.exe', 'node_modules\.bin\electron-vite.cmd') {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $required))) {
      Show-Failure "As dependências do projeto não estão instaladas ($required ausente).`nAbra a pasta do projeto e execute: npm install"
      exit 1
    }
  }

  # `npm run dev` sem janela; saída (inclusive erros) no log da sessão.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/d /s /c `"npm run dev 1>`"$DevLog`" 2>&1`""
  $psi.WorkingDirectory = $ProjectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['NO_COLOR'] = '1'
  $psi.EnvironmentVariables['FORCE_COLOR'] = '0'
  $dev = [System.Diagnostics.Process]::Start($psi)
  Write-Log "npm run dev iniciado (PID $($dev.Id)). Log: $DevLog"

  # Espera a janela aparecer; se o ambiente terminar antes, é falha.
  $deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
  $window = $null
  while (-not $window) {
    if ($dev.HasExited) {
      Show-Failure "O ambiente de desenvolvimento terminou antes de abrir a janela (código $($dev.ExitCode))."
      exit 1
    }
    if ((Get-Date) -gt $deadline) {
      Show-Failure "A janela não apareceu em $StartTimeoutSeconds segundos. O ambiente continua em execução (PID $($dev.Id))."
      exit 1
    }
    Start-Sleep -Milliseconds 500
    $window = Get-AppWindowProcess
  }
  Write-Log "Janela aberta (PID $($window.Id))."

  # O electron-vite encerra quando a janela do app fecha.
  $dev.WaitForExit()
  Write-Log "Ambiente encerrado (código $($dev.ExitCode))."
  $mutex.ReleaseMutex()
} catch {
  Show-Failure "Erro inesperado no inicializador: $($_.Exception.Message)"
  exit 1
}
