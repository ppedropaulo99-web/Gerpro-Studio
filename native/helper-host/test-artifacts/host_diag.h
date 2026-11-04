// Registro diagnóstico da variante de testes do launcher (Etapa 6C.6C.2C;
// docs/11-testes-contencao.md, seção 11). Só existe com
// GERPRO_HOST_DIAG_BUILD e GERPRO_HOST_TEST_BUILD juntos: o launcher de
// produção e a variante de testes comum nunca incluem este arquivo.
//
// O registro é uma única linha ASCII, escrita pelo launcher na própria saída
// padrão DEPOIS que tudo terminou, com prefixo próprio. Só números e marcas
// fixas: nenhum caminho, nome de usuário, ambiente ou texto de terceiros.
// Nenhum acesso a outros processos (sem OpenProcess): só consultas ao job J,
// ao processo que o próprio launcher criou e a uma porta de conclusão própria.

#pragma once

#if !defined(GERPRO_HOST_DIAG_BUILD) || !defined(GERPRO_HOST_TEST_BUILD)
#error "host_diag.h só existe na variante diagnóstica de testes"
#endif

#include <windows.h>

namespace gerpro {
namespace host {
namespace diag {

// Porta de conclusão própria associada a J, antes de qualquer processo (só
// notificações; não muda limites).
void JobCreated(HANDLE job);
// Logo depois de CreateProcessW (GetLastError ainda intacto).
void Created(BOOL ok, DWORD pid);
// Processo suspenso: IsProcessInJob, contabilidade e lista de processos de J.
void PreResume(HANDLE job, HANDLE process, bool contained);
// Logo depois de ResumeThread.
void Resumed(DWORD previousSuspendCount);
// Logo depois da espera: resultado, contabilidade, lista e mensagens de J.
void Waited(HANDLE job, DWORD wait);
// Logo depois de GetExitCodeProcess: resultado, código bruto e contabilidade.
void ExitCode(HANDLE job, BOOL ok, DWORD code);
// Dentro de TerminateAndConfirm.
void Terminated(BOOL jobTerminated, DWORD jobError, DWORD confirmWait);
// Depois de Run (J já fechado): últimas mensagens e a linha.
void Emit(int hostExit);

}  // namespace diag
}  // namespace host
}  // namespace gerpro
