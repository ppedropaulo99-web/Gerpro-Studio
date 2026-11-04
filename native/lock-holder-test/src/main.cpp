// gerpro-lock-holder-test.exe: SÓ DE TESTE (6C.6C.3F; docs/11, seção 20).
//
// Segura, por um tempo curto e limitado, as MESMAS travas que o launcher
// (native/helper-host/src/main.cpp) cria, para os cenários T-F1, T-F2 e T-F4:
//
//   --mode=file      arquivo do alvo sintético, como no passo 6 do launcher
//                    (LockHelperFile): GENERIC_READ, só FILE_SHARE_READ,
//                    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN.
//   --mode=mapping   seção gravável (PAGE_READWRITE) e uma vista gravável do
//                    mesmo arquivo; o identificador do arquivo é fechado logo
//                    depois de criar a seção. Nenhum byte é escrito: a vista
//                    nunca é lida nem escrita.
//   --mode=directory pastas host-test e win32-x64, como no passo 5 do launcher
//                    (LockDirectory): FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES
//                    | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE (sem
//                    FILE_SHARE_DELETE), FILE_FLAG_BACKUP_SEMANTICS |
//                    FILE_FLAG_OPEN_REPARSE_POINT.
//
// Linha de comando FIXA (não é uma interface genérica de arquivos):
//
//   gerpro-lock-holder-test.exe --mode=<file|mapping|directory> --case-dir=<pasta>
//
// <pasta> = <pasta temporária do sistema>\gerpro-6c6c-<sufixo>\<NN>-T-F<n>.<id>
// O número do cenário tem de ser o do modo (file: T-F1, mapping: T-F2,
// directory: T-F4). Os alvos são derivados da pasta, com nomes fixos:
// host-test\win32-x64\gerpro-synthetic-helper.exe.
//
// Protocolo:
// - a entrada padrão TEM de ser um pipe (o do supervisor);
// - com as travas obtidas, uma linha ASCII na saída padrão:
//     gerpro-lock-holder-test v=1 ready mode=<modo> volume=<8 hex> index=<16 hex>[,<16 hex>]
// - liberação controlada: a entrada padrão fechada (ou qualquer byte nela);
// - prazo próprio: kHoldDeadlineMs desde o início, sem argumento que o mude;
// - antes de sair, as travas são soltas e uma linha
//     gerpro-lock-holder-test v=1 released reason=<stdin|deadline|wait-failure>
//   é escrita (melhor esforço);
// - códigos de saída em exit_codes.h.
//
// Garantias:
// - não escreve, não trunca, não renomeia e não apaga nada; não cria pastas;
// - não cria processos nem threads, não abre outros processos, não pede
//   elevação, não toca em ACLs, registro ou serviços (só KERNEL32 e lista
//   explícita de importações, conferidas no build);
// - não segue links nem junções abaixo da pasta temporária do sistema, e
//   confere o caminho final de cada objeto aberto;
// - recusa arquivo com mais de um nome (um hard link para um arquivo de fora
//   passaria pela conferência de caminho).

#include <windows.h>

#include <cstddef>
#include <cstdint>

#include "exit_codes.h"

namespace {

using namespace gerpro::lockholder;

// Prazo próprio, curto e fixo; inclui a preparação.
constexpr ULONGLONG kHoldDeadlineMs = 10000;
// Intervalo de consulta da entrada padrão.
constexpr DWORD kPollMs = 20;

constexpr std::size_t kMaxPathChars = 512;
// Teto do caminho pedido: sobra espaço para os componentes fixos.
constexpr std::size_t kMaxCaseDirChars = 300;
// Mesma faixa de tamanho aceita para o alvo pelo launcher (HELPER_SIZE).
constexpr ULONGLONG kMinFileBytes = 1024;
constexpr ULONGLONG kMaxFileBytes = 8ull * 1024ull * 1024ull;

constexpr wchar_t kModeFlag[] = L"--mode=";
constexpr wchar_t kCaseDirFlag[] = L"--case-dir=";
constexpr wchar_t kScratchPrefix[] = L"gerpro-6c6c-";
constexpr std::size_t kScratchSuffixMax = 16;
constexpr std::size_t kCaseIdMax = 40;
constexpr wchar_t kTopDirectory[] = L"host-test";
constexpr wchar_t kArchDirectory[] = L"win32-x64";
constexpr wchar_t kTargetFile[] = L"gerpro-synthetic-helper.exe";

constexpr char kLinePrefix[] = "gerpro-lock-holder-test v=1 ";

enum class Mode { kFile, kMapping, kDirectory };

// Identificador com fechamento garantido.
class Handle {
 public:
  Handle() = default;
  explicit Handle(HANDLE handle) : handle_(handle) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { reset(); }
  HANDLE get() const { return handle_; }
  bool valid() const { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }
  void reset(HANDLE handle = nullptr) {
    if (valid()) ::CloseHandle(handle_);
    handle_ = handle;
  }

 private:
  HANDLE handle_ = nullptr;
};

// Vista com desmapeamento garantido. O endereço nunca é lido nem escrito.
class View {
 public:
  View() = default;
  View(const View&) = delete;
  View& operator=(const View&) = delete;
  ~View() { reset(); }
  bool valid() const { return address_ != nullptr; }
  void reset(void* address = nullptr) {
    if (address_ != nullptr) ::UnmapViewOfFile(address_);
    address_ = address;
  }

 private:
  void* address_ = nullptr;
};

// Tudo o que é segurado. Release() solta na ordem: vista, seção, arquivo,
// pastas (filhas antes das mães).
struct Held {
  View view;
  Handle mapping;
  Handle file;
  Handle archDir;
  Handle topDir;
  void Release() {
    view.reset();
    mapping.reset();
    file.reset();
    archDir.reset();
    topDir.reset();
  }
};

// Identidade (volume + índice), a mesma que o Node expõe em stat (dev, ino).
struct Identity {
  DWORD volume = 0;
  std::uint64_t index = 0;
};

wchar_t g_caseDir[kMaxPathChars];
wchar_t g_expected[kMaxPathChars];
wchar_t g_finalPath[kMaxPathChars];
wchar_t g_tempPath[kMaxPathChars];

std::size_t BoundedLength(const wchar_t* text, std::size_t cap) {
  std::size_t n = 0;
  while (n < cap && text[n] != L'\0') ++n;
  return n;
}

bool StartsWith(const wchar_t* text, const wchar_t* prefix) {
  for (std::size_t i = 0; prefix[i] != L'\0'; ++i) {
    if (text[i] != prefix[i]) return false;
  }
  return true;
}

bool SameText(const wchar_t* a, const wchar_t* b) {
  std::size_t i = 0;
  for (; a[i] != L'\0' && b[i] != L'\0'; ++i) {
    if (a[i] != b[i]) return false;
  }
  return a[i] == b[i];
}

// Comparação de caminhos sem diferenciar maiúsculas (regra do NTFS).
bool PathsEqual(const wchar_t* a, const wchar_t* b) {
  const std::size_t la = BoundedLength(a, kMaxPathChars);
  const std::size_t lb = BoundedLength(b, kMaxPathChars);
  if (la != lb || la == 0 || la >= kMaxPathChars) return false;
  return ::CompareStringOrdinal(a, static_cast<int>(la), b, static_cast<int>(lb), TRUE) == CSTR_EQUAL;
}

bool IsAsciiAlnum(wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z'); }

bool IsDriveLetter(wchar_t c) { return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z'); }

// Concatena "<base>\<name>" em out, com limite.
bool Join(const wchar_t* base, const wchar_t* name, wchar_t* out) {
  const std::size_t lb = BoundedLength(base, kMaxPathChars);
  const std::size_t ln = BoundedLength(name, kMaxPathChars);
  if (lb == 0 || ln == 0 || lb + 1 + ln >= kMaxPathChars) return false;
  for (std::size_t i = 0; i < lb; ++i) out[i] = base[i];
  out[lb] = L'\\';
  for (std::size_t i = 0; i < ln; ++i) out[lb + 1 + i] = name[i];
  out[lb + 1 + ln] = L'\0';
  return true;
}

bool ParseMode(const wchar_t* arg, Mode& mode) {
  if (!StartsWith(arg, kModeFlag)) return false;
  const wchar_t* value = arg + (sizeof(kModeFlag) / sizeof(wchar_t) - 1);
  if (SameText(value, L"file")) {
    mode = Mode::kFile;
  } else if (SameText(value, L"mapping")) {
    mode = Mode::kMapping;
  } else if (SameText(value, L"directory")) {
    mode = Mode::kDirectory;
  } else {
    return false;
  }
  return true;
}

wchar_t ScenarioDigit(Mode mode) {
  switch (mode) {
    case Mode::kFile:
      return L'1';
    case Mode::kMapping:
      return L'2';
    case Mode::kDirectory:
      return L'4';
  }
  return L'0';
}

const char* ModeName(Mode mode) {
  switch (mode) {
    case Mode::kFile:
      return "file";
    case Mode::kMapping:
      return "mapping";
    case Mode::kDirectory:
      return "directory";
  }
  return "none";
}

// "gerpro-6c6c-" + 1..16 letras ou dígitos ASCII.
bool ValidScratchName(const wchar_t* name, std::size_t length) {
  constexpr std::size_t prefix = sizeof(kScratchPrefix) / sizeof(wchar_t) - 1;
  if (length <= prefix || length > prefix + kScratchSuffixMax) return false;
  for (std::size_t i = 0; i < prefix; ++i) {
    if (name[i] != kScratchPrefix[i]) return false;
  }
  for (std::size_t i = prefix; i < length; ++i) {
    if (!IsAsciiAlnum(name[i])) return false;
  }
  return true;
}

// "<2 dígitos>-T-F<n>." + 1..40 de [a-z0-9-], com <n> o número do modo.
bool ValidCaseName(const wchar_t* name, std::size_t length, Mode mode) {
  constexpr std::size_t fixed = 8;  // "NN-T-Fn."
  if (length <= fixed || length > fixed + kCaseIdMax) return false;
  if (name[0] < L'0' || name[0] > L'9' || name[1] < L'0' || name[1] > L'9') return false;
  if (name[2] != L'-' || name[3] != L'T' || name[4] != L'-' || name[5] != L'F') return false;
  if (name[6] != ScenarioDigit(mode) || name[7] != L'.') return false;
  for (std::size_t i = fixed; i < length; ++i) {
    const wchar_t c = name[i];
    const bool ok = (c >= L'a' && c <= L'z') || (c >= L'0' && c <= L'9') || c == L'-';
    if (!ok) return false;
  }
  return true;
}

// Forma do caminho pedido, sem tocar no disco:
// - absoluto com letra de unidade ("X:\"), sem prefixo \\?\, rede ou dispositivo;
// - sem "/", sem ":" fora da unidade (fluxos alternativos), sem curingas,
//   aspas, controles, "~" (nomes curtos) ou componentes vazios, "." e "..";
// - os dois últimos componentes são a pasta exclusiva e a pasta do caso.
// Devolve em baseLength o tamanho da parte que tem de ser a pasta temporária.
bool ValidCaseDirShape(const wchar_t* path, Mode mode, std::size_t& baseLength) {
  const std::size_t length = BoundedLength(path, kMaxCaseDirChars + 1);
  if (length < 4 || length > kMaxCaseDirChars) return false;
  if (!IsDriveLetter(path[0]) || path[1] != L':' || path[2] != L'\\') return false;
  std::size_t componentStart = 3;
  std::size_t separators[kMaxCaseDirChars];
  std::size_t count = 0;
  for (std::size_t i = 3; i <= length; ++i) {
    const wchar_t c = path[i];
    if (c == L'\\' || c == L'\0') {
      const std::size_t size = i - componentStart;
      if (size == 0) return false;
      if (path[componentStart] == L'.' && (size == 1 || (size == 2 && path[componentStart + 1] == L'.'))) return false;
      const wchar_t last = path[i - 1];
      if (last == L'.' || last == L' ') return false;
      if (c == L'\\') separators[count++] = i;
      componentStart = i + 1;
      continue;
    }
    if (c < 0x20 || c == L'/' || c == L':' || c == L'*' || c == L'?' || c == L'"' || c == L'<' || c == L'>' || c == L'|' || c == L'~') return false;
  }
  // Pelo menos "<base>\<exclusiva>\<caso>", com a base fora da raiz.
  if (count < 2) return false;
  const std::size_t caseSep = separators[count - 1];
  const std::size_t scratchSep = separators[count - 2];
  if (!ValidCaseName(path + caseSep + 1, length - caseSep - 1, mode)) return false;
  if (!ValidScratchName(path + scratchSep + 1, caseSep - scratchSep - 1)) return false;
  if (scratchSep <= 3) return false;
  baseLength = scratchSep;
  return true;
}

// Caminho final do identificador, "X:\..." (sem \\?\UNC, volume ou dispositivo).
const wchar_t* FinalPath(HANDLE handle) {
  const DWORD length = ::GetFinalPathNameByHandleW(handle, g_finalPath, static_cast<DWORD>(kMaxPathChars), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length < 7 || length >= kMaxPathChars) return nullptr;
  if (g_finalPath[0] != L'\\' || g_finalPath[1] != L'\\' || g_finalPath[2] != L'?' || g_finalPath[3] != L'\\') return nullptr;
  if (!IsDriveLetter(g_finalPath[4]) || g_finalPath[5] != L':' || g_finalPath[6] != L'\\') return nullptr;
  return g_finalPath + 4;
}

// Atributos do objeto aberto: não pode ser ponto de nova análise (link,
// junção) e tem de ser do tipo esperado.
bool PlainObject(HANDLE handle, bool expectDirectory) {
  FILE_ATTRIBUTE_TAG_INFO tag = {};
  if (!::GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) return false;
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  const bool directory = (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return directory == expectDirectory;
}

// Mesmo objeto que o caminho pedido: sem link, tipo certo, caminho final igual.
bool SameObject(HANDLE handle, const wchar_t* expected, bool expectDirectory) {
  if (!PlainObject(handle, expectDirectory)) return false;
  const wchar_t* resolved = FinalPath(handle);
  return resolved != nullptr && PathsEqual(resolved, expected);
}

bool ReadIdentity(HANDLE handle, bool requireSingleName, Identity& identity) {
  BY_HANDLE_FILE_INFORMATION info = {};
  if (!::GetFileInformationByHandle(handle, &info)) return false;
  if (requireSingleName && info.nNumberOfLinks != 1) return false;
  identity.volume = info.dwVolumeSerialNumber;
  identity.index = (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
  return true;
}

// Pasta temporária do sistema, resolvida pelo próprio sistema de arquivos.
// É a ÚNICA base aceita: a pasta pedida tem de estar exatamente dois níveis
// abaixo dela.
bool ResolveTempBase(const wchar_t*& base) {
  const DWORD length = ::GetTempPathW(static_cast<DWORD>(kMaxPathChars), g_tempPath);
  if (length == 0 || length >= kMaxPathChars) return false;
  Handle dir(::CreateFileW(g_tempPath, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                           FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!dir.valid() || !PlainObject(dir.get(), true)) return false;
  base = FinalPath(dir.get());
  if (base == nullptr) return false;
  // Copia para g_tempPath: g_finalPath é reutilizado nas próximas conferências.
  const std::size_t n = BoundedLength(base, kMaxPathChars);
  if (n <= 3 || n >= kMaxPathChars) return false;  // nunca a raiz de uma unidade
  for (std::size_t i = 0; i < n; ++i) g_tempPath[i] = base[i];
  g_tempPath[n] = L'\0';
  base = g_tempPath;
  return true;
}

// Inspeção de uma pasta intermediária (sem trava: compartilhamento total e
// só leitura de atributos). Recusa links, junções e caminho final diferente.
bool InspectDirectory(const wchar_t* path) {
  Handle dir(::CreateFileW(path, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                           FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  return dir.valid() && SameObject(dir.get(), path, true);
}

// Pasta travada com as flags do launcher (LockDirectory, passo 5).
bool LockDirectory(const wchar_t* path, Handle& out, Identity& identity) {
  out.reset(::CreateFileW(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                          FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!out.valid()) return false;
  if (!SameObject(out.get(), path, true) || !ReadIdentity(out.get(), false, identity)) {
    out.reset();
    return false;
  }
  return true;
}

// Conferências do arquivo já aberto: disco, sem link, um só nome, tamanho na
// faixa e caminho final igual ao pedido.
bool CheckTargetFile(HANDLE file, const wchar_t* path, Identity& identity) {
  if (::GetFileType(file) != FILE_TYPE_DISK) return false;
  if (!SameObject(file, path, false)) return false;
  LARGE_INTEGER size = {};
  if (!::GetFileSizeEx(file, &size) || size.QuadPart < 0) return false;
  const ULONGLONG bytes = static_cast<ULONGLONG>(size.QuadPart);
  if (bytes < kMinFileBytes || bytes > kMaxFileBytes) return false;
  return ReadIdentity(file, true, identity);
}

// Arquivo travado com as flags do launcher (LockHelperFile, passo 6).
bool LockFile(const wchar_t* path, Handle& out, Identity& identity) {
  out.reset(::CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!out.valid()) return false;
  if (!CheckTargetFile(out.get(), path, identity)) {
    out.reset();
    return false;
  }
  return true;
}

// Seção gravável e uma vista gravável, com o arquivo FECHADO em seguida
// (docs/11, 18.1: com o arquivo aberto, o launcher pararia no passo 6 com
// 23). Nenhum byte é escrito: a vista nunca é acessada; o tamanho da seção é
// o do arquivo (0, 0), sem extensão.
bool HoldMapping(const wchar_t* path, Held& held, Identity& identity) {
  Handle file(::CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.valid()) return false;
  if (!CheckTargetFile(file.get(), path, identity)) return false;
  held.mapping.reset(::CreateFileMappingW(file.get(), nullptr, PAGE_READWRITE, 0, 0, nullptr));
  // O arquivo é fechado logo depois da criação da seção, com ou sem sucesso.
  file.reset();
  if (!held.mapping.valid()) {
    held.mapping.reset();
    return false;
  }
  held.view.reset(::MapViewOfFile(held.mapping.get(), FILE_MAP_WRITE, 0, 0, 0));
  return held.view.valid();
}

// Escrita ASCII na saída padrão (só o sinal de prontidão e o de liberação).
bool WriteLine(HANDLE out, const char* text, std::size_t length) {
  DWORD written = 0;
  return ::WriteFile(out, text, static_cast<DWORD>(length), &written, nullptr) != FALSE && written == length;
}

class Line {
 public:
  void Append(const char* text) {
    for (std::size_t i = 0; text[i] != '\0'; ++i) Put(text[i]);
  }
  void Hex(std::uint64_t value, int digits) {
    for (int shift = (digits - 1) * 4; shift >= 0; shift -= 4) Put("0123456789abcdef"[(value >> shift) & 0xF]);
  }
  bool Send(HANDLE out) {
    Put('\n');
    return !overflow_ && WriteLine(out, buffer_, length_);
  }

 private:
  void Put(char c) {
    if (length_ < sizeof(buffer_)) {
      buffer_[length_++] = c;
    } else {
      overflow_ = true;
    }
  }
  char buffer_[160] = {};
  std::size_t length_ = 0;
  bool overflow_ = false;
};

bool SendReady(HANDLE out, Mode mode, const Identity& first, const Identity* second) {
  Line line;
  line.Append(kLinePrefix);
  line.Append("ready mode=");
  line.Append(ModeName(mode));
  line.Append(" volume=");
  line.Hex(first.volume, 8);
  line.Append(" index=");
  line.Hex(first.index, 16);
  if (second != nullptr) {
    line.Append(",");
    line.Hex(second->index, 16);
  }
  return line.Send(out);
}

void SendReleased(HANDLE out, const char* reason) {
  Line line;
  line.Append(kLinePrefix);
  line.Append("released reason=");
  line.Append(reason);
  line.Send(out);  // melhor esforço: as travas já foram soltas
}

enum class WaitResult { kStdin, kDeadline, kFailure };

// Espera a liberação: entrada padrão fechada (ERROR_BROKEN_PIPE) ou com algum
// byte. Nada é lido. O prazo conta desde o início do processo.
WaitResult WaitForRelease(HANDLE in, ULONGLONG start) {
  for (;;) {
    DWORD available = 0;
    if (!::PeekNamedPipe(in, nullptr, 0, nullptr, &available, nullptr)) {
      return ::GetLastError() == ERROR_BROKEN_PIPE ? WaitResult::kStdin : WaitResult::kFailure;
    }
    if (available > 0) return WaitResult::kStdin;
    if (::GetTickCount64() - start >= kHoldDeadlineMs) return WaitResult::kDeadline;
    ::Sleep(kPollMs);
  }
}

int Run(int argc, wchar_t** argv) {
  const ULONGLONG start = ::GetTickCount64();
  ::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (!::SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)) return kExitEnvironment;

  // 1. Argumentos: exatamente --mode=<...> --case-dir=<...>, nessa ordem.
  Mode mode = Mode::kFile;
  if (argc != 3 || argv == nullptr || argv[1] == nullptr || argv[2] == nullptr) return kExitArgs;
  if (!ParseMode(argv[1], mode)) return kExitArgs;
  if (!StartsWith(argv[2], kCaseDirFlag)) return kExitArgs;
  const wchar_t* requested = argv[2] + (sizeof(kCaseDirFlag) / sizeof(wchar_t) - 1);
  const std::size_t requestedLength = BoundedLength(requested, kMaxCaseDirChars + 1);
  if (requestedLength == 0 || requestedLength > kMaxCaseDirChars) return kExitArgs;
  for (std::size_t i = 0; i <= requestedLength; ++i) g_caseDir[i] = requested[i];

  // 2. Supervisor presente: entrada padrão é um pipe; saída padrão existe.
  const HANDLE in = ::GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE out = ::GetStdHandle(STD_OUTPUT_HANDLE);
  if (in == nullptr || in == INVALID_HANDLE_VALUE || ::GetFileType(in) != FILE_TYPE_PIPE) return kExitEnvironment;
  if (out == nullptr || out == INVALID_HANDLE_VALUE) return kExitEnvironment;

  // 3. Forma do caminho e base autorizada (a pasta temporária do sistema).
  std::size_t baseLength = 0;
  if (!ValidCaseDirShape(g_caseDir, mode, baseLength)) return kExitPath;
  const wchar_t* tempBase = nullptr;
  if (!ResolveTempBase(tempBase)) return kExitEnvironment;
  if (BoundedLength(tempBase, kMaxPathChars) != baseLength) return kExitPath;
  if (::CompareStringOrdinal(g_caseDir, static_cast<int>(baseLength), tempBase, static_cast<int>(baseLength), TRUE) != CSTR_EQUAL) return kExitPath;

  // 4. Cada componente abaixo da base: pasta comum, sem link nem junção, e
  //    caminho final igual ao pedido. Começa pela pasta exclusiva.
  const std::size_t caseLength = BoundedLength(g_caseDir, kMaxPathChars);
  for (std::size_t i = baseLength + 1; i <= caseLength; ++i) {
    if (g_caseDir[i] != L'\\' && g_caseDir[i] != L'\0') continue;
    for (std::size_t k = 0; k < i; ++k) g_expected[k] = g_caseDir[k];
    g_expected[i] = L'\0';
    if (!InspectDirectory(g_expected)) return kExitPath;
  }
  wchar_t topPath[kMaxPathChars];
  wchar_t archPath[kMaxPathChars];
  wchar_t filePath[kMaxPathChars];
  if (!Join(g_caseDir, kTopDirectory, topPath) || !Join(topPath, kArchDirectory, archPath) || !Join(archPath, kTargetFile, filePath)) return kExitPath;

  // 5. Travas do modo. Falha de caminho e falha de trava têm códigos próprios.
  Held held;
  Identity first;
  Identity second;
  bool twoObjects = false;
  switch (mode) {
    case Mode::kFile:
      if (!InspectDirectory(topPath) || !InspectDirectory(archPath)) return kExitPath;
      if (!LockFile(filePath, held.file, first)) return kExitLock;
      break;
    case Mode::kMapping:
      if (!InspectDirectory(topPath) || !InspectDirectory(archPath)) return kExitPath;
      if (!HoldMapping(filePath, held, first)) {
        held.Release();
        return kExitLock;
      }
      break;
    case Mode::kDirectory:
      if (!LockDirectory(topPath, held.topDir, first)) return kExitLock;
      if (!LockDirectory(archPath, held.archDir, second)) {
        held.Release();
        return kExitLock;
      }
      twoObjects = true;
      break;
  }

  // 6. Prazo já vencido na preparação: solta sem anunciar prontidão.
  if (::GetTickCount64() - start >= kHoldDeadlineMs) {
    held.Release();
    SendReleased(out, "deadline");
    return kExitDeadline;
  }

  // 7. Prontidão; depois, espera a liberação ou o prazo.
  if (!SendReady(out, mode, first, twoObjects ? &second : nullptr)) {
    held.Release();
    return kExitSignal;
  }
  const WaitResult result = WaitForRelease(in, start);
  held.Release();
  switch (result) {
    case WaitResult::kStdin:
      SendReleased(out, "stdin");
      return kExitReleased;
    case WaitResult::kDeadline:
      SendReleased(out, "deadline");
      return kExitDeadline;
    case WaitResult::kFailure:
      break;
  }
  SendReleased(out, "wait-failure");
  return kExitWait;
}

}  // namespace

int wmain(int argc, wchar_t** argv) { return Run(argc, argv); }
