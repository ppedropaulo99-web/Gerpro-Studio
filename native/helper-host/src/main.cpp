// gerpro-helper-host.exe: cria o auxiliar DXCore (gerpro-dxcore-helper.exe)
// SUSPENSO e já associado a um Job Object próprio, confere a contenção e a
// integridade, e só então o deixa rodar (docs/10-ativacao-dxcore.md, seções
// 9–16; D61).
//
// Garantias e limites:
// - Falha fechada: qualquer erro de contenção ou integridade sai com 20–26
//   SEM retomar o auxiliar. Não existe caminho que execute o auxiliar fora do
//   job (sem AssignProcessToJobObject, sem fallback).
// - A política de processos filhos é só defesa adicional, não fronteira de
//   segurança (docs/10, 9.2): um auxiliar comprometido do mesmo usuário pode
//   contorná-la, e também o job.
// - O TOCTOU é reduzido, não eliminado (docs/10, seção 13).
// - O launcher não escreve nada na saída padrão nem na de erro: a única saída
//   é a do auxiliar, pelo pipe herdado.
// - Limite de memória do job: PENDENTE (T-M1). Nenhum valor arbitrário foi
//   fixado; a execução em produção continua bloqueada (hashes nulos e
//   dxcoreHostBlockers no app).
// - Variante de testes (GERPRO_HOST_TEST_BUILD, 6C.6C.1): MESMA sequência;
//   muda só a identidade (nomes e pasta, protocol.h), a linha de comando do
//   alvo e exige que o resumo seja de um auxiliar sintético fixado no build.
// - Variante diagnóstica (GERPRO_HOST_DIAG_BUILD, só junto com a de testes;
//   6C.6C.2C): a MESMA sequência, com pontos de registro entre os passos
//   (blocos #if abaixo) e uma linha ASCII no fim (test-artifacts/host_diag.*).
//   Fora dela, os blocos não existem.
// - Criação do auxiliar com DETACHED_PROCESS (6C.6C.2E; D67): o auxiliar
//   não ganha console nenhum. Com CREATE_NO_WINDOW, o auxiliar ganhava um
//   console novo e morria na inicialização (0xC0000142; docs/11, seções 11
//   e 12). A saída continua sendo só o pipe passado em STARTUPINFO.

#include <windows.h>

#include <cstdint>
#include <cstring>
#include <cwchar>

#include "exit_codes.h"
#include "integrity.h"
#include "protocol.h"
#if defined(GERPRO_HOST_TEST_BUILD)
// Gerado pelo build da variante de testes (resumos dos auxiliares sintéticos);
// define GERPRO_SYNTHETIC_DIGESTS. Fora desse build, o header não existe.
#include "synthetic_digests.h"
#if !defined(GERPRO_SYNTHETIC_DIGESTS)
#error "variante de testes sem os resumos fixados dos auxiliares sintéticos"
#endif
#endif
#if defined(GERPRO_HOST_DIAG_BUILD)
// Exige também GERPRO_HOST_TEST_BUILD (conferido no próprio header).
#include "host_diag.h"
#endif

namespace {

using namespace gerpro::host;

// Prazos (iguais a DXCORE_HOST_TIMEOUTS).
constexpr DWORD kHelperWaitMs = 2000;
constexpr DWORD kTerminateConfirmMs = 500;

// Tamanho aceito do auxiliar (igual a DXCORE_HELPER.minFileBytes/maxFileBytes).
constexpr ULONGLONG kMinHelperBytes = 1024;
constexpr ULONGLONG kMaxHelperBytes = 8ull * 1024 * 1024;

// Limites do job. Só os de comportamento documentado e verificável.
constexpr DWORD kJobLimitFlags =
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
constexpr DWORD kActiveProcessLimit = 1;

#if !defined(GERPRO_HOST_TEST_BUILD)
// Linha de comando do auxiliar (DXCORE_HELPER_ARGS), sem espaços no nome.
constexpr wchar_t kHelperCommandLine[] = L"gerpro-dxcore-helper.exe --protocol 1";
#else
// Variante de testes: mesmo formato, alvo sintético.
constexpr wchar_t kHelperCommandLine[] = L"gerpro-synthetic-helper.exe --protocol 1";
#endif

// Fecha o identificador ao sair do escopo (o launcher não usa exceções).
class Handle {
 public:
  Handle() = default;
  explicit Handle(HANDLE h) : h_(h) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { Close(); }
  HANDLE get() const { return h_; }
  bool valid() const { return h_ != nullptr && h_ != INVALID_HANDLE_VALUE; }
  void reset(HANDLE h) {
    Close();
    h_ = h;
  }
  void Close() {
    if (valid()) ::CloseHandle(h_);
    h_ = nullptr;
  }

 private:
  HANDLE h_ = nullptr;
};

// Buffers estáticos: nenhuma alocação dinâmica.
wchar_t g_hostPath[kMaxPathChars];
wchar_t g_finalPath[kMaxPathChars];
wchar_t g_archDir[kMaxPathChars];
wchar_t g_helpersDir[kMaxPathChars];
wchar_t g_helperPath[kMaxPathChars];
wchar_t g_imagePath[kMaxPathChars];
wchar_t g_systemDir[MAX_PATH + 1];
wchar_t g_windowsDir[MAX_PATH + 1];
wchar_t g_environment[2 * (MAX_PATH + 16) + 2];
wchar_t g_commandLine[64];
alignas(16) unsigned char g_attributeBuffer[512];

bool HardenProcess() {
  if (!::SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)) return false;
  PROCESS_MITIGATION_IMAGE_LOAD_POLICY image = {};
  image.NoRemoteImages = 1;
  image.NoLowMandatoryLabelImages = 1;
  image.PreferSystem32Images = 1;
  if (!::SetProcessMitigationPolicy(ProcessImageLoadPolicy, &image, sizeof(image))) return false;
  PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY extensions = {};
  extensions.DisableExtensionPoints = 1;
  if (!::SetProcessMitigationPolicy(ProcessExtensionPointDisablePolicy, &extensions, sizeof(extensions))) return false;
  PROCESS_MITIGATION_STRICT_HANDLE_CHECK_POLICY handles = {};
  handles.RaiseExceptionOnInvalidHandleReference = 1;
  handles.HandleExceptionsPermanentlyEnabled = 1;
  return ::SetProcessMitigationPolicy(ProcessStrictHandleCheckPolicy, &handles, sizeof(handles)) != FALSE;
}

// Imagem nativa da arquitetura do build, sem emulação.
bool RunningNatively() {
  USHORT processMachine = IMAGE_FILE_MACHINE_UNKNOWN;
  USHORT nativeMachine = IMAGE_FILE_MACHINE_UNKNOWN;
  if (!::IsWow64Process2(::GetCurrentProcess(), &processMachine, &nativeMachine)) return false;
#if defined(_M_X64)
  constexpr USHORT kBuildMachine = IMAGE_FILE_MACHINE_AMD64;
#elif defined(_M_ARM64)
  constexpr USHORT kBuildMachine = IMAGE_FILE_MACHINE_ARM64;
#endif
  return processMachine == IMAGE_FILE_MACHINE_UNKNOWN && nativeMachine == kBuildMachine;
}

// Caminho final do identificador, no formato "X:\..." (sem link, junção,
// rede ou dispositivo). Falso se não couber ou se o formato for outro.
const wchar_t* FinalPath(HANDLE handle) {
  const DWORD length = ::GetFinalPathNameByHandleW(handle, g_finalPath, static_cast<DWORD>(kMaxPathChars), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0 || length >= kMaxPathChars) return nullptr;
  return StripFinalPathPrefix(g_finalPath);
}

bool IsReparsePoint(HANDLE handle, bool expectDirectory) {
  FILE_ATTRIBUTE_TAG_INFO tag = {};
  if (!::GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) return true;
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return true;
  const bool directory = (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return directory != expectDirectory;
}

// O próprio executável: o caminho conhecido pelo carregador tem de ser o
// caminho final (sem junção, link, nome curto ou unidade substituta).
bool ResolveOwnPath() {
  const DWORD length = ::GetModuleFileNameW(nullptr, g_hostPath, static_cast<DWORD>(kMaxPathChars));
  if (length == 0 || length >= kMaxPathChars) return false;
  Handle self(::CreateFileW(g_hostPath, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!self.valid() || IsReparsePoint(self.get(), false)) return false;
  const wchar_t* resolved = FinalPath(self.get());
  return resolved != nullptr && PathsEqual(resolved, g_hostPath);
}

// Pasta aberta sem FILE_SHARE_DELETE (H-F4): não pode ser renomeada nem
// apagada enquanto o identificador existir. FILE_LIST_DIRECTORY faz o
// identificador participar da conferência de compartilhamento.
bool LockDirectory(const wchar_t* path, Handle& out) {
  out.reset(::CreateFileW(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                          FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!out.valid() || IsReparsePoint(out.get(), true)) return false;
  const wchar_t* resolved = FinalPath(out.get());
  return resolved != nullptr && PathsEqual(resolved, path);
}

// Arquivo do auxiliar aberto só para leitura, sem FILE_SHARE_WRITE nem
// FILE_SHARE_DELETE (H-F1). Confere tipo, tamanho e caminho final; devolve a
// identidade (volume + FileId) e o tamanho.
bool LockHelperFile(Handle& out, FILE_ID_INFO& identity, ULONGLONG& size) {
  out.reset(::CreateFileW(g_helperPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
                          nullptr));
  if (!out.valid() || ::GetFileType(out.get()) != FILE_TYPE_DISK || IsReparsePoint(out.get(), false)) return false;
  LARGE_INTEGER length = {};
  if (!::GetFileSizeEx(out.get(), &length) || length.QuadPart < 0) return false;
  size = static_cast<ULONGLONG>(length.QuadPart);
  if (size < kMinHelperBytes || size > kMaxHelperBytes) return false;
  const wchar_t* resolved = FinalPath(out.get());
  if (resolved == nullptr || !PathsEqual(resolved, g_helperPath)) return false;
  return ::GetFileInformationByHandleEx(out.get(), FileIdInfo, &identity, sizeof(identity)) != FALSE;
}

bool SameIdentity(const FILE_ID_INFO& a, const FILE_ID_INFO& b) {
  return a.VolumeSerialNumber == b.VolumeSerialNumber && std::memcmp(a.FileId.Identifier, b.FileId.Identifier, sizeof(a.FileId.Identifier)) == 0;
}

// Job sem nome e não herdável, com os limites relidos e conferidos.
bool CreateContainmentJob(Handle& out) {
  out.reset(::CreateJobObjectW(nullptr, nullptr));
  if (!out.valid()) return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = kJobLimitFlags;
  limits.BasicLimitInformation.ActiveProcessLimit = kActiveProcessLimit;
  if (!::SetInformationJobObject(out.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION applied = {};
  if (!::QueryInformationJobObject(out.get(), JobObjectExtendedLimitInformation, &applied, sizeof(applied), nullptr)) return false;
  return applied.BasicLimitInformation.LimitFlags == kJobLimitFlags && applied.BasicLimitInformation.ActiveProcessLimit == kActiveProcessLimit;
}

// Contabilidade do job: exatamente o auxiliar, nenhum processo encerrado por limite.
bool JobAccountingIs(HANDLE job, DWORD active) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
  if (!::QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return false;
  return accounting.ActiveProcesses == active && accounting.TotalProcesses == 1 && accounting.TotalTerminatedProcesses == 0;
}

// Saída padrão: pipe, herdável (duplicada se preciso). Nada mais é herdado.
bool InheritableOutput(Handle& duplicate, HANDLE& out) {
  HANDLE output = ::GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE || ::GetFileType(output) != FILE_TYPE_PIPE) return false;
  DWORD flags = 0;
  if (!::GetHandleInformation(output, &flags)) return false;
  if ((flags & HANDLE_FLAG_INHERIT) != 0) {
    out = output;
    return true;
  }
  HANDLE copy = nullptr;
  if (!::DuplicateHandle(::GetCurrentProcess(), output, ::GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return false;
  duplicate.reset(copy);
  out = copy;
  return true;
}

// Ambiente mínimo do auxiliar, vindo do sistema (não de variáveis do processo):
// "SystemRoot=<Windows>\0windir=<Windows>\0\0" (em ordem alfabética).
bool BuildEnvironment() {
  const UINT windows = ::GetSystemWindowsDirectoryW(g_windowsDir, MAX_PATH + 1);
  const UINT system = ::GetSystemDirectoryW(g_systemDir, MAX_PATH + 1);
  if (windows == 0 || windows > MAX_PATH || system == 0 || system > MAX_PATH) return false;
  const std::size_t capacity = sizeof(g_environment) / sizeof(g_environment[0]);
  std::size_t at = 0;
  const wchar_t* parts[] = {L"SystemRoot=", g_windowsDir, nullptr, L"windir=", g_windowsDir, nullptr};
  for (const wchar_t* part : parts) {
    if (part == nullptr) {
      if (at + 1 > capacity) return false;
      g_environment[at++] = L'\0';
      continue;
    }
    const std::size_t length = BoundedLength(part, capacity);
    if (at + length > capacity) return false;
    std::wmemcpy(g_environment + at, part, length);
    at += length;
  }
  if (at + 1 > capacity) return false;
  g_environment[at] = L'\0';
  return true;
}

// Encerra o job (todos os processos dele) e espera o auxiliar terminar.
// Verdadeiro só com o fim confirmado pelo identificador do processo.
bool TerminateAndConfirm(HANDLE job, HANDLE process, UINT code) {
#if defined(GERPRO_HOST_DIAG_BUILD)
  const BOOL jobTerminated = ::TerminateJobObject(job, code);
  const DWORD jobError = jobTerminated ? 0 : ::GetLastError();
  if (!jobTerminated) ::TerminateProcess(process, code);
  const DWORD confirm = ::WaitForSingleObject(process, kTerminateConfirmMs);
  diag::Terminated(jobTerminated, jobError, confirm);
  return confirm == WAIT_OBJECT_0;
#else
  if (!::TerminateJobObject(job, code)) ::TerminateProcess(process, code);
  return ::WaitForSingleObject(process, kTerminateConfirmMs) == WAIT_OBJECT_0;
#endif
}

// Imagem do processo suspenso = arquivo travado (mesmo volume e FileId).
bool ImageMatches(HANDLE process, const FILE_ID_INFO& expected) {
  DWORD length = static_cast<DWORD>(kMaxPathChars);
  if (!::QueryFullProcessImageNameW(process, 0, g_imagePath, &length) || length == 0 || length >= kMaxPathChars) return false;
  if (!PathsEqual(g_imagePath, g_helperPath)) return false;
  Handle image(::CreateFileW(g_imagePath, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                             FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!image.valid() || IsReparsePoint(image.get(), false)) return false;
  FILE_ID_INFO actual = {};
  if (!::GetFileInformationByHandleEx(image.get(), FileIdInfo, &actual, sizeof(actual))) return false;
  return SameIdentity(actual, expected);
}

int Run(int argc, wchar_t** argv) {
  ::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);

  // 1. Argumentos, antes de qualquer outra ação.
  std::uint8_t expected[kSha256Bytes] = {};
  if (!ParseArguments(argc, argv, expected)) return kExitHostArguments;

  // 0. Proteções do próprio processo.
  if (!HardenProcess()) return kExitHostEnvironment;

  // 2. Saída padrão herdável (pipe do app).
  Handle duplicateOutput;
  HANDLE inheritableOutput = nullptr;
  if (!InheritableOutput(duplicateOutput, inheritableOutput)) return kExitHostEnvironment;

  // 3. Sem emulação de arquitetura.
  if (!RunningNatively()) return kExitHostEnvironment;
  if (!BuildEnvironment()) return kExitHostEnvironment;

  // 4. Caminho do auxiliar a partir do próprio executável; nada de argumentos.
  if (!ResolveOwnPath()) return kExitHostFile;
  if (!ResolveLayout(g_hostPath, g_archDir, g_helpersDir, g_helperPath, kMaxPathChars)) return kExitHostFile;

  // 5. Pastas travadas (sem FILE_SHARE_DELETE).
  Handle helpersDir;
  Handle archDir;
  if (!LockDirectory(g_helpersDir, helpersDir) || !LockDirectory(g_archDir, archDir)) return kExitHostFile;

  // 6. Arquivo travado (sem FILE_SHARE_WRITE/FILE_SHARE_DELETE).
  Handle helperFile;
  FILE_ID_INFO identity = {};
  ULONGLONG helperSize = 0;
  if (!LockHelperFile(helperFile, identity, helperSize)) return kExitHostFile;

  // 7. Hash prévio (rejeição barata).
  std::uint8_t digest[kSha256Bytes] = {};
  if (!HashOpenFile(helperFile.get(), helperSize, digest) || !DigestEquals(digest, expected)) return kExitHostIntegrity;
#if defined(GERPRO_HOST_TEST_BUILD)
  // Variante de testes: além do argumento, o resumo tem de ser um dos
  // auxiliares sintéticos fixados no build (nunca o auxiliar DXCore).
  if (!DigestInSet(expected, kSyntheticHelperDigests, kSyntheticHelperDigestCount)) return kExitHostIntegrity;
#endif

  // 8. Job Object.
  Handle job;
  if (!CreateContainmentJob(job)) return kExitHostJob;
#if defined(GERPRO_HOST_DIAG_BUILD)
  diag::JobCreated(job.get());
#endif

  // 9. Atributos de criação: job, herança mínima e política de filhos.
  SIZE_T attributeSize = 0;
  ::InitializeProcThreadAttributeList(nullptr, 3, 0, &attributeSize);
  if (attributeSize == 0 || attributeSize > sizeof(g_attributeBuffer)) return kExitHostJob;
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(g_attributeBuffer);
  if (!::InitializeProcThreadAttributeList(attributes, 3, 0, &attributeSize)) return kExitHostJob;
  // Os valores precisam existir até DeleteProcThreadAttributeList.
  HANDLE jobList[1] = {job.get()};
  HANDLE inheritList[1] = {inheritableOutput};
  DWORD childPolicy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
  const bool attributesOk =
      ::UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList, sizeof(jobList), nullptr, nullptr) &&
      ::UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritList, sizeof(inheritList), nullptr, nullptr) &&
      ::UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &childPolicy, sizeof(childPolicy), nullptr, nullptr);
  if (!attributesOk) {
    ::DeleteProcThreadAttributeList(attributes);
    return kExitHostJob;
  }

  // 10. Criação suspensa, já dentro do job.
  if (!Concat(g_commandLine, sizeof(g_commandLine) / sizeof(g_commandLine[0]), L"", kHelperCommandLine)) {
    ::DeleteProcThreadAttributeList(attributes);
    return kExitHostCreate;
  }
  STARTUPINFOEXW startup = {};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nullptr;
  startup.StartupInfo.hStdOutput = inheritableOutput;
  startup.StartupInfo.hStdError = nullptr;
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION created = {};
  // DETACHED_PROCESS: sem console (nem herdado, nem novo); saída só pelo pipe.
  const BOOL createdOk = ::CreateProcessW(g_helperPath, g_commandLine, nullptr, nullptr, TRUE,
                                          CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT, g_environment,
                                          g_systemDir, &startup.StartupInfo, &created);
#if defined(GERPRO_HOST_DIAG_BUILD)
  diag::Created(createdOk, created.dwProcessId);
#endif
  ::DeleteProcThreadAttributeList(attributes);
  if (!createdOk) return kExitHostCreate;
  Handle process(created.hProcess);
  Handle thread(created.hThread);

  // 11. Conferências com o processo suspenso.
  BOOL inJob = FALSE;
  const bool contained = ::IsProcessInJob(process.get(), job.get(), &inJob) && inJob == TRUE && JobAccountingIs(job.get(), 1) &&
                         ImageMatches(process.get(), identity);
#if defined(GERPRO_HOST_DIAG_BUILD)
  diag::PreResume(job.get(), process.get(), contained);
#endif
  if (!contained) {
    TerminateAndConfirm(job.get(), process.get(), kExitHostVerify);
    return kExitHostVerify;
  }

  // 12. Hash definitivo, com a imagem já mapeada pelo processo suspenso.
  std::uint8_t mapped[kSha256Bytes] = {};
  if (!HashOpenFile(helperFile.get(), helperSize, mapped) || !DigestEquals(mapped, expected)) {
    TerminateAndConfirm(job.get(), process.get(), kExitHostIntegrity);
    return kExitHostIntegrity;
  }

  // 13. Só agora as travas são liberadas.
  helperFile.Close();
  archDir.Close();
  helpersDir.Close();

  // 14. Única retomada do auxiliar.
#if defined(GERPRO_HOST_DIAG_BUILD)
  const DWORD resumed = ::ResumeThread(thread.get());
  diag::Resumed(resumed);
  if (resumed != 1) {
#else
  if (::ResumeThread(thread.get()) != 1) {
#endif
    TerminateAndConfirm(job.get(), process.get(), kExitHostVerify);
    return kExitHostVerify;
  }
  thread.Close();

  // 15. Espera com prazo próprio.
  const DWORD wait = ::WaitForSingleObject(process.get(), kHelperWaitMs);
#if defined(GERPRO_HOST_DIAG_BUILD)
  diag::Waited(job.get(), wait);
#endif
  if (wait == WAIT_TIMEOUT) {
    return TerminateAndConfirm(job.get(), process.get(), kExitHostTimeout) ? kExitHostTimeout : kExitHostUnconfirmed;
  }
  if (wait != WAIT_OBJECT_0) {
    return TerminateAndConfirm(job.get(), process.get(), kExitHostContainment) ? kExitHostContainment : kExitHostUnconfirmed;
  }
  DWORD helperExit = 0;
#if defined(GERPRO_HOST_DIAG_BUILD)
  const BOOL gotExit = ::GetExitCodeProcess(process.get(), &helperExit);
  diag::ExitCode(job.get(), gotExit, helperExit);
  if (!gotExit) return kExitHostContainment;
#else
  if (!::GetExitCodeProcess(process.get(), &helperExit)) return kExitHostContainment;
#endif
  // Qualquer outro processo associado ao job, ou encerrado por limite, é violação.
  if (!JobAccountingIs(job.get(), 0)) {
    TerminateAndConfirm(job.get(), process.get(), kExitHostContainment);
    return kExitHostContainment;
  }
  return MapHelperExit(helperExit);
  // Ao sair, o identificador do job é fechado: KILL_ON_JOB_CLOSE encerra qualquer resto.
}

}  // namespace

#if defined(GERPRO_HOST_DIAG_BUILD)
// Variante diagnóstica: a linha sai depois de Run (J já fechado).
int wmain(int argc, wchar_t** argv) {
  const int code = Run(argc, argv);
  gerpro::host::diag::Emit(code);
  return code;
}
#else
int wmain(int argc, wchar_t** argv) { return Run(argc, argv); }
#endif
