// Registro diagnóstico da variante de testes do launcher (Etapa 6C.6C.2C).
// Ver host_diag.h. Sem alocação dinâmica, sem CRT de formatação: a linha é
// montada num buffer fixo, só com números e marcas fixas.

#include "host_diag.h"

#include <cstddef>
#include <cstdint>

#include "synthetic_digests.h"
#if !defined(GERPRO_SYNTHETIC_DIGESTS)
#error "variante diagnóstica sem os resumos fixados"
#endif

namespace gerpro {
namespace host {
namespace diag {
namespace {

// Forma de criação do alvo (6C.6C.2E: DETACHED_PROCESS em todas as variantes).
constexpr char kCreationVariant[] = "detached";

constexpr ULONG_PTR kCompletionKey = 0x6C6C;
constexpr std::size_t kMaxMessages = 24;
constexpr int kMaxDrain = 64;

struct Accounting {
  bool queried;
  BOOL ok;
  DWORD error;
  DWORD active;
  DWORD total;
  DWORD terminated;
};

struct IdList {
  bool queried;
  BOOL ok;
  DWORD assigned;
  DWORD listed;
  DWORD others;
};

struct Message {
  DWORD type;
  char who;  // h = processo criado pelo launcher, o = outro, n = sem identificador
};

struct State {
  bool portTried;
  bool portOk;
  DWORD portError;
  HANDLE port;
  bool created;
  BOOL createOk;
  DWORD createError;
  DWORD pid;
  bool pre;
  BOOL inJobOk;
  BOOL inJob;
  bool contained;
  Accounting preAccounting;
  IdList preIds;
  bool resumed;
  DWORD resumePrevious;
  DWORD resumeError;
  bool waited;
  DWORD wait;
  DWORD waitError;
  Accounting waitAccounting;
  IdList waitIds;
  bool exitQueried;
  BOOL exitOk;
  DWORD exitError;
  DWORD rawExit;
  Accounting exitAccounting;
  DWORD terminations;
  BOOL terminateJobOk;
  DWORD terminateError;
  DWORD terminateWait;
  Message messages[kMaxMessages];
  std::size_t messageCount;
  DWORD messagesDropped;
};

State g_state;

Accounting QueryAccounting(HANDLE job) {
  Accounting result = {};
  result.queried = true;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {};
  result.ok = ::QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr);
  if (!result.ok) {
    result.error = ::GetLastError();
    return result;
  }
  result.active = info.ActiveProcesses;
  result.total = info.TotalProcesses;
  result.terminated = info.TotalTerminatedProcesses;
  return result;
}

// Lista de processos de J (até 8): só quantos são e quantos não são o
// processo criado pelo launcher. Nenhum identificador vai para a linha.
IdList QueryIds(HANDLE job) {
  IdList result = {};
  result.queried = true;
  struct {
    JOBOBJECT_BASIC_PROCESS_ID_LIST header;
    ULONG_PTR more[7];
  } list = {};
  result.ok = ::QueryInformationJobObject(job, JobObjectBasicProcessIdList, &list, sizeof(list), nullptr);
  if (!result.ok && ::GetLastError() == ERROR_MORE_DATA) result.ok = TRUE;
  if (!result.ok) return result;
  result.assigned = list.header.NumberOfAssignedProcesses;
  result.listed = list.header.NumberOfProcessIdsInList;
  const ULONG_PTR* ids = list.header.ProcessIdList;
  for (DWORD i = 0; i < result.listed && i < 8; ++i) {
    if (ids[i] != static_cast<ULONG_PTR>(g_state.pid)) ++result.others;
  }
  return result;
}

// Mensagens já entregues à porta (sem esperar). A entrega não é garantida
// (documentação de JOBOBJECT_ASSOCIATE_COMPLETION_PORT): ausência não prova nada.
void Drain() {
  if (g_state.port == nullptr) return;
  for (int i = 0; i < kMaxDrain; ++i) {
    DWORD type = 0;
    ULONG_PTR key = 0;
    LPOVERLAPPED overlapped = nullptr;
    if (!::GetQueuedCompletionStatus(g_state.port, &type, &key, &overlapped, 0)) break;
    if (key != kCompletionKey) continue;
    const ULONG_PTR id = reinterpret_cast<ULONG_PTR>(overlapped);
    const char who = id == 0 ? 'n' : (id == static_cast<ULONG_PTR>(g_state.pid) ? 'h' : 'o');
    if (g_state.messageCount < kMaxMessages) {
      g_state.messages[g_state.messageCount].type = type;
      g_state.messages[g_state.messageCount].who = who;
      ++g_state.messageCount;
    } else {
      ++g_state.messagesDropped;
    }
  }
}

class Line {
 public:
  void Text(const char* text) {
    for (; *text != '\0'; ++text) Put(*text);
  }
  void Char(char c) { Put(c); }
  void Dec(DWORD value) {
    char digits[10];
    int count = 0;
    do {
      digits[count++] = static_cast<char>('0' + value % 10);
      value /= 10;
    } while (value != 0 && count < 10);
    while (count > 0) Put(digits[--count]);
  }
  void Hex(DWORD value) {
    static const char kDigits[] = "0123456789ABCDEF";
    Text("0x");
    for (int shift = 28; shift >= 0; shift -= 4) Put(kDigits[(value >> shift) & 0xF]);
  }
  void Field(const char* key) {
    Put(' ');
    Text(key);
    Put('=');
  }
  void Flag(const char* key, bool known, BOOL value) {
    Field(key);
    if (!known) {
      Put('-');
      return;
    }
    Put(value ? '1' : '0');
  }
  void Error(const char* key, bool known, DWORD value) {
    Field(key);
    if (!known) {
      Put('-');
      return;
    }
    Dec(value);
  }
  void Acct(const char* key, const Accounting& a) {
    Field(key);
    if (!a.queried) {
      Put('-');
      return;
    }
    if (!a.ok) {
      Text("err");
      Dec(a.error);
      return;
    }
    Dec(a.active);
    Put(',');
    Dec(a.total);
    Put(',');
    Dec(a.terminated);
  }
  void Ids(const char* key, const IdList& l) {
    Field(key);
    if (!l.queried) {
      Put('-');
      return;
    }
    if (!l.ok) {
      Text("err");
      return;
    }
    Dec(l.assigned);
    Put(',');
    Dec(l.listed);
    Put(',');
    Dec(l.others);
  }
  const char* data() const { return buffer_; }
  DWORD size() const { return static_cast<DWORD>(length_); }

 private:
  void Put(char c) {
    if (length_ + 2 < sizeof(buffer_)) buffer_[length_++] = c;
  }
  char buffer_[1024] = {};
  std::size_t length_ = 0;
};

}  // namespace

void JobCreated(HANDLE job) {
  g_state.portTried = true;
  g_state.port = ::CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1);
  if (g_state.port == nullptr) {
    g_state.portError = ::GetLastError();
    return;
  }
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = {};
  association.CompletionKey = reinterpret_cast<PVOID>(kCompletionKey);
  association.CompletionPort = g_state.port;
  g_state.portOk = ::SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof(association)) != FALSE;
  if (!g_state.portOk) g_state.portError = ::GetLastError();
}

void Created(BOOL ok, DWORD pid) {
  g_state.created = true;
  g_state.createOk = ok;
  g_state.createError = ok ? 0 : ::GetLastError();
  g_state.pid = ok ? pid : 0;
}

void PreResume(HANDLE job, HANDLE process, bool contained) {
  g_state.pre = true;
  g_state.contained = contained;
  BOOL inJob = FALSE;
  g_state.inJobOk = ::IsProcessInJob(process, job, &inJob);
  g_state.inJob = inJob;
  g_state.preAccounting = QueryAccounting(job);
  g_state.preIds = QueryIds(job);
}

void Resumed(DWORD previousSuspendCount) {
  g_state.resumed = true;
  g_state.resumePrevious = previousSuspendCount;
  g_state.resumeError = previousSuspendCount == static_cast<DWORD>(-1) ? ::GetLastError() : 0;
}

void Waited(HANDLE job, DWORD wait) {
  g_state.waited = true;
  g_state.wait = wait;
  g_state.waitError = wait == WAIT_FAILED ? ::GetLastError() : 0;
  g_state.waitAccounting = QueryAccounting(job);
  g_state.waitIds = QueryIds(job);
  Drain();
}

void ExitCode(HANDLE job, BOOL ok, DWORD code) {
  g_state.exitQueried = true;
  g_state.exitOk = ok;
  g_state.exitError = ok ? 0 : ::GetLastError();
  g_state.rawExit = ok ? code : 0;
  g_state.exitAccounting = QueryAccounting(job);
}

void Terminated(BOOL jobTerminated, DWORD jobError, DWORD confirmWait) {
  ++g_state.terminations;
  g_state.terminateJobOk = jobTerminated;
  g_state.terminateError = jobError;
  g_state.terminateWait = confirmWait;
}

void Emit(int hostExit) {
  Drain();
  Line line;
  line.Text("gerpro-host-diag v=1");
  line.Field("creation");
  line.Text(kCreationVariant);
  line.Field("digests");
  line.Dec(static_cast<DWORD>(kSyntheticHelperDigestCount));
  line.Flag("port", g_state.portTried, g_state.portOk);
  line.Error("port-err", g_state.portTried, g_state.portError);
  line.Flag("create", g_state.created, g_state.createOk);
  line.Error("create-err", g_state.created, g_state.createError);
  line.Flag("pre-contained", g_state.pre, g_state.contained);
  line.Flag("pre-injob", g_state.pre && g_state.inJobOk, g_state.inJob);
  line.Acct("pre-acct", g_state.preAccounting);
  line.Ids("pre-ids", g_state.preIds);
  line.Field("resume");
  if (g_state.resumed) {
    line.Dec(g_state.resumePrevious);
  } else {
    line.Char('-');
  }
  line.Error("resume-err", g_state.resumed, g_state.resumeError);
  line.Field("wait");
  if (g_state.waited) {
    line.Hex(g_state.wait);
  } else {
    line.Char('-');
  }
  line.Error("wait-err", g_state.waited, g_state.waitError);
  line.Acct("wait-acct", g_state.waitAccounting);
  line.Ids("wait-ids", g_state.waitIds);
  line.Flag("gec", g_state.exitQueried, g_state.exitOk);
  line.Error("gec-err", g_state.exitQueried, g_state.exitError);
  line.Field("raw");
  if (g_state.exitQueried && g_state.exitOk) {
    line.Hex(g_state.rawExit);
  } else {
    line.Char('-');
  }
  line.Acct("exit-acct", g_state.exitAccounting);
  line.Field("term");
  line.Dec(g_state.terminations);
  line.Flag("term-job", g_state.terminations > 0, g_state.terminateJobOk);
  line.Error("term-err", g_state.terminations > 0, g_state.terminateError);
  line.Field("term-wait");
  if (g_state.terminations > 0) {
    line.Hex(g_state.terminateWait);
  } else {
    line.Char('-');
  }
  line.Field("msgs");
  if (g_state.messageCount == 0) line.Char('-');
  for (std::size_t i = 0; i < g_state.messageCount; ++i) {
    if (i > 0) line.Char(',');
    line.Dec(g_state.messages[i].type);
    line.Char(g_state.messages[i].who);
  }
  line.Field("msgs-dropped");
  line.Dec(g_state.messagesDropped);
  line.Field("host");
  line.Dec(static_cast<DWORD>(hostExit));
  line.Char('\n');

  if (g_state.port != nullptr) {
    ::CloseHandle(g_state.port);
    g_state.port = nullptr;
  }
  HANDLE output = ::GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE || ::GetFileType(output) != FILE_TYPE_PIPE) return;
  DWORD written = 0;
  ::WriteFile(output, line.data(), line.size(), &written, nullptr);
}

}  // namespace diag
}  // namespace host
}  // namespace gerpro
