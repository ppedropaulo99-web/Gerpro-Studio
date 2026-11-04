// gerpro-synthetic-helper.exe: alvo SINTÉTICO dos testes reais do launcher
// (Etapa 6C.6C.1; roteiro em docs/11-testes-contencao.md). Só é iniciado pela
// variante de testes gerpro-helper-host-test.exe (ou, em T-R1, diretamente
// pelo roteiro). Nunca distribuído; nunca usado pelo app.
//
// Garantias:
// - Não acessa hardware, rede nem registro; não abre, cria, altera nem apaga
//   arquivos. A única saída é UMA linha fixa (ASCII) na saída padrão herdada,
//   com números do próprio cenário (códigos de erro, contadores do job,
//   memória do próprio processo); nada do usuário nem da máquina.
// - Não pede elevação (manifesto asInvoker).
// - Um cenário por binário, fixado no build (/DGERPRO_SYNTHETIC_SCENARIO=n):
//   não há opção de linha de comando, arquivo ou ambiente que mude o cenário.
// - Recusa rodar (64, sem fazer nada) com argumentos diferentes de
//   "--protocol 1" ou fora de ...\host-test\win32-x64\gerpro-synthetic-helper.exe:
//   copiado para a pasta do app ou renomeado como o auxiliar DXCore, não roda.
// - Prazo próprio: nenhum cenário passa de 30 s, mesmo se a contenção falhar.
// - O cenário de descendentes cria o processo SUSPENSO e o encerra: o
//   descendente nunca executa código.

#include <windows.h>

#include <cstddef>
#include <cstdint>
#include <cwchar>

#define GERPRO_SCENARIO_EXIT_OK 1
#define GERPRO_SCENARIO_EXIT_CONTRACT 2
#define GERPRO_SCENARIO_EXIT_OUT_OF_CONTRACT 3
#define GERPRO_SCENARIO_HANG 4
#define GERPRO_SCENARIO_SPAWN_CHILD 5
#define GERPRO_SCENARIO_MEMORY 6
#define GERPRO_SCENARIO_JOB_PROBE 7

#if !defined(GERPRO_SYNTHETIC_SCENARIO) || GERPRO_SYNTHETIC_SCENARIO < 1 || GERPRO_SYNTHETIC_SCENARIO > 7
#error "cenário sintético ausente ou desconhecido (GERPRO_SYNTHETIC_SCENARIO = 1..7)"
#endif

namespace {

// Códigos do alvo sintético. 0, 10–13 e 64 estão no contrato repassado pelo
// launcher; 77 está fora dele de propósito (o launcher deve devolver 28).
constexpr int kExitOk = 0;
constexpr int kExitScenarioFailed = 10;
constexpr int kExitChildCreated = 11;
constexpr int kExitContractSample = 12;
constexpr int kExitSelfDeadline = 13;
constexpr int kExitRefused = 64;
constexpr int kExitOutOfContract = 77;

constexpr DWORD kSelfDeadlineMs = 30000;
constexpr SIZE_T kMemoryBytes = 64u * 1024u * 1024u;
constexpr SIZE_T kPageBytes = 4096;
constexpr DWORD kChildCleanupMs = 1000;
constexpr std::size_t kMaxPathChars = 1024;

constexpr wchar_t kOwnName[] = L"gerpro-synthetic-helper.exe";
constexpr wchar_t kArchDirectory[] = L"win32-x64";
constexpr wchar_t kTestDirectory[] = L"host-test";

wchar_t g_selfPath[kMaxPathChars];
char g_line[256];
std::size_t g_lineLength = 0;

void Append(const char* text) {
  while (*text != '\0' && g_lineLength + 2 < sizeof(g_line)) g_line[g_lineLength++] = *text++;
}

#if GERPRO_SYNTHETIC_SCENARIO >= GERPRO_SCENARIO_SPAWN_CHILD
// Número em decimal ou hexadecimal (só nos cenários que relatam números).
void AppendNumber(unsigned long long value, bool hex) {
  char digits[24];
  std::size_t count = 0;
  const unsigned base = hex ? 16u : 10u;
  do {
    const unsigned digit = static_cast<unsigned>(value % base);
    digits[count++] = static_cast<char>(digit < 10 ? '0' + digit : 'a' + (digit - 10));
    value /= base;
  } while (value != 0 && count < sizeof(digits));
  if (hex) Append("0x");
  while (count > 0 && g_lineLength + 2 < sizeof(g_line)) g_line[g_lineLength++] = digits[--count];
}
#endif

// Escreve a linha (com "\n") na saída padrão herdada. Nenhum outro destino.
bool Flush() {
  g_line[g_lineLength++] = '\n';
  const HANDLE output = ::GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  return ::WriteFile(output, g_line, static_cast<DWORD>(g_lineLength), &written, nullptr) && written == g_lineLength;
}

bool Equals(const wchar_t* a, const wchar_t* b) { return a != nullptr && b != nullptr && std::wcscmp(a, b) == 0; }

// Segmento [start, end) igual a `expected`, sem diferenciar maiúsculas.
bool SegmentEquals(const wchar_t* text, std::size_t start, std::size_t end, const wchar_t* expected) {
  const std::size_t length = end - start;
  if (length != std::wcslen(expected) || length > 0x7fffffff) return false;
  return ::CompareStringOrdinal(text + start, static_cast<int>(length), expected, static_cast<int>(length), TRUE) == CSTR_EQUAL;
}

long LastSeparator(const wchar_t* text, std::size_t end) {
  for (std::size_t i = end; i > 0; --i) {
    if (text[i - 1] == L'\\') return static_cast<long>(i - 1);
  }
  return -1;
}

// O próprio executável tem de estar em ...\host-test\win32-x64\gerpro-synthetic-helper.exe.
bool InTestLayout() {
  const DWORD length = ::GetModuleFileNameW(nullptr, g_selfPath, static_cast<DWORD>(kMaxPathChars));
  if (length == 0 || length >= kMaxPathChars) return false;
  const long fileSep = LastSeparator(g_selfPath, length);
  if (fileSep < 0 || !SegmentEquals(g_selfPath, static_cast<std::size_t>(fileSep) + 1, length, kOwnName)) return false;
  const long archSep = LastSeparator(g_selfPath, static_cast<std::size_t>(fileSep));
  if (archSep < 0 || !SegmentEquals(g_selfPath, static_cast<std::size_t>(archSep) + 1, static_cast<std::size_t>(fileSep), kArchDirectory)) return false;
  const long testSep = LastSeparator(g_selfPath, static_cast<std::size_t>(archSep));
  return testSep >= 3 && SegmentEquals(g_selfPath, static_cast<std::size_t>(testSep) + 1, static_cast<std::size_t>(archSep), kTestDirectory);
}

#if GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_SPAWN_CHILD
// Tenta criar um descendente: o próprio executável, SUSPENSO (nunca executa
// código) e encerrado logo em seguida se a criação for aceita.
bool TryCreateChild(DWORD extraFlags, const char* label) {
  wchar_t commandLine[] = L"gerpro-synthetic-helper.exe --protocol 1";
  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child = {};
  Append(" ");
  Append(label);
  if (!::CreateProcessW(g_selfPath, commandLine, nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW | extraFlags, nullptr, nullptr, &startup,
                        &child)) {
    Append("=denied,error=");
    AppendNumber(::GetLastError(), false);
    return false;
  }
  BOOL inAnyJob = FALSE;
  const BOOL queried = ::IsProcessInJob(child.hProcess, nullptr, &inAnyJob);
  ::TerminateProcess(child.hProcess, kExitSelfDeadline);
  const bool ended = ::WaitForSingleObject(child.hProcess, kChildCleanupMs) == WAIT_OBJECT_0;
  ::CloseHandle(child.hThread);
  ::CloseHandle(child.hProcess);
  Append("=created,in-job=");
  AppendNumber(queried ? (inAnyJob ? 1u : 0u) : 9u, false);
  Append(ended ? ",ended=1" : ",ended=0");
  return true;
}
#endif

#if GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_MEMORY || GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_JOB_PROBE
// Limites e picos do job IMEDIATO do próprio processo (identificador nulo).
void AppendImmediateJob(bool withLimits) {
  BOOL inAnyJob = FALSE;
  if (!::IsProcessInJob(::GetCurrentProcess(), nullptr, &inAnyJob)) {
    Append(" in-job=unknown");
    return;
  }
  Append(inAnyJob ? " in-job=1" : " in-job=0");
  if (!inAnyJob) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  if (!::QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr)) {
    Append(" job-query=denied,error=");
    AppendNumber(::GetLastError(), false);
    return;
  }
  if (withLimits) {
    Append(" limit-flags=");
    AppendNumber(limits.BasicLimitInformation.LimitFlags, true);
    Append(" active-limit=");
    AppendNumber(limits.BasicLimitInformation.ActiveProcessLimit, false);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
    if (::QueryInformationJobObject(nullptr, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) {
      Append(" active=");
      AppendNumber(accounting.ActiveProcesses, false);
      Append(" total=");
      AppendNumber(accounting.TotalProcesses, false);
    }
  }
  Append(" peak-process=");
  AppendNumber(limits.PeakProcessMemoryUsed, false);
  Append(" peak-job=");
  AppendNumber(limits.PeakJobMemoryUsed, false);
}
#endif

int RunScenario() {
#if GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_EXIT_OK
  Append("gerpro-synthetic scenario=exit-ok");
  return Flush() ? kExitOk : kExitScenarioFailed;
#elif GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_EXIT_CONTRACT
  Append("gerpro-synthetic scenario=exit-contract");
  Flush();
  return kExitContractSample;
#elif GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_EXIT_OUT_OF_CONTRACT
  Append("gerpro-synthetic scenario=exit-out-of-contract");
  Flush();
  return kExitOutOfContract;
#elif GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_HANG
  // A linha sai antes da espera: o roteiro sabe que o alvo está rodando.
  Append("gerpro-synthetic scenario=hang state=waiting");
  if (!Flush()) return kExitScenarioFailed;
  ::Sleep(kSelfDeadlineMs);
  return kExitSelfDeadline;
#elif GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_SPAWN_CHILD
  Append("gerpro-synthetic scenario=spawn-child");
  const bool plain = TryCreateChild(0, "plain");
  const bool breakaway = TryCreateChild(CREATE_BREAKAWAY_FROM_JOB, "breakaway");
  if (!Flush()) return kExitScenarioFailed;
  return plain || breakaway ? kExitChildCreated : kExitOk;
#elif GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_MEMORY
  Append("gerpro-synthetic scenario=memory");
  void* block = ::VirtualAlloc(nullptr, kMemoryBytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
  if (block == nullptr) {
    Append(" alloc=denied,error=");
    AppendNumber(::GetLastError(), false);
    Flush();
    return kExitScenarioFailed;
  }
  volatile unsigned char* bytes = static_cast<volatile unsigned char*>(block);
  for (SIZE_T at = 0; at < kMemoryBytes; at += kPageBytes) bytes[at] = 1;
  Append(" committed=");
  AppendNumber(kMemoryBytes, false);
  AppendImmediateJob(false);
  ::VirtualFree(block, 0, MEM_RELEASE);
  return Flush() ? kExitOk : kExitScenarioFailed;
#elif GERPRO_SYNTHETIC_SCENARIO == GERPRO_SCENARIO_JOB_PROBE
  Append("gerpro-synthetic scenario=job-probe");
  AppendImmediateJob(true);
  return Flush() ? kExitOk : kExitScenarioFailed;
#endif
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  ::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (argc != 3 || argv == nullptr || !Equals(argv[1], L"--protocol") || !Equals(argv[2], L"1")) return kExitRefused;
  if (!::SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)) return kExitRefused;
  if (!InTestLayout()) return kExitRefused;
  return RunScenario();
}
