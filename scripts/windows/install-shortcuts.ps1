#Requires -Version 5.1
<#
  Cria (ou remove, com -Remove) os atalhos "Gerpro Studio" do usuário atual:
  - Área de Trabalho;
  - Menu Iniciar (Programas), necessário para fixar na barra de tarefas.

  Os dois abrem start-gerpro-studio.ps1 e recebem System.AppUserModel.ID =
  br.com.gerpro.studio, o mesmo que o processo Main define com
  app.setAppUserModelId. Com isso, a janela do app e o item fixado na barra
  de tarefas são reconhecidos como o mesmo aplicativo, e o item fixado
  reabre pelo inicializador (não por um Electron genérico).

  Não exige administrador. Não fixa nada automaticamente.
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$AppUserModelId = 'br.com.gerpro.studio'
$Name = 'Gerpro Studio'
$Launcher = Join-Path $PSScriptRoot 'start-gerpro-studio.ps1'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
# Ícone provisório: o do Electron. O ícone próprio do Gerpro Studio aguarda aprovação.
$Icon = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$Targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk"),
  (Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk")
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Gerpro {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit, Size = 24)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointer;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }

  public static class ShortcutProperties {
    const ushort VT_LPWSTR = 31;
    const int GPS_READWRITE = 2;
    static PropertyKey AppUserModelId = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bindCtx, int flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    [DllImport("ole32.dll", PreserveSig = false)]
    static extern void PropVariantClear(ref PropVariant value);

    static IPropertyStore Open(string path, int flags) {
      Guid iid = typeof(IPropertyStore).GUID;
      IPropertyStore store;
      SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, flags, ref iid, out store);
      return store;
    }

    public static void SetAppUserModelId(string path, string id) {
      IPropertyStore store = Open(path, GPS_READWRITE);
      PropVariant value = new PropVariant { vt = VT_LPWSTR, pointer = Marshal.StringToCoTaskMemUni(id) };
      try {
        store.SetValue(ref AppUserModelId, ref value);
        store.Commit();
      } finally {
        PropVariantClear(ref value);
        Marshal.ReleaseComObject(store);
      }
    }

    public static string GetAppUserModelId(string path) {
      IPropertyStore store = Open(path, 0);
      PropVariant value;
      try {
        store.GetValue(ref AppUserModelId, out value);
        string id = value.vt == VT_LPWSTR ? Marshal.PtrToStringUni(value.pointer) : null;
        PropVariantClear(ref value);
        return id;
      } finally {
        Marshal.ReleaseComObject(store);
      }
    }
  }
}
'@

if ($Remove) {
  foreach ($path in $Targets) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path
      Write-Output "Removido: $path"
    }
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $Launcher)) { throw "Inicializador não encontrado: $Launcher" }

$shell = New-Object -ComObject WScript.Shell
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($path in $Targets) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $powershell
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
  $link.WorkingDirectory = $ProjectRoot
  $link.Description = 'Abre o Gerpro Studio (ambiente de desenvolvimento)'
  # 7 = minimizada: a janela do PowerShell não aparece na frente antes de se ocultar.
  $link.WindowStyle = 7
  if (Test-Path -LiteralPath $Icon) { $link.IconLocation = "$Icon,0" }
  $link.Save()
  [Gerpro.ShortcutProperties]::SetAppUserModelId($path, $AppUserModelId)
  $check = [Gerpro.ShortcutProperties]::GetAppUserModelId($path)
  if ($check -ne $AppUserModelId) { throw "AppUserModelID não gravado em $path" }
  Write-Output "Criado: $path (AppUserModelID $check)"
}
