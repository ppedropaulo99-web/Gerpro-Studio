// Códigos de saída do launcher gerpro-helper-host.exe (docs/10-ativacao-dxcore.md,
// seção 11.6). Iguais a DXCORE_HOST_EXIT_CODES em
// src/main/hardware/local/dxcore-host-contract.ts (conferido por teste estático).
//
// Os códigos 20 a 26 significam que o auxiliar NÃO executou nenhuma
// instrução: ou o processo não foi criado, ou foi encerrado ainda suspenso.

#pragma once

namespace gerpro {
namespace host {

constexpr int kExitHostArguments = 20;
constexpr int kExitHostEnvironment = 21;
constexpr int kExitHostJob = 22;
constexpr int kExitHostFile = 23;
constexpr int kExitHostIntegrity = 24;
constexpr int kExitHostCreate = 25;
constexpr int kExitHostVerify = 26;
constexpr int kExitHostTimeout = 27;
constexpr int kExitHostContainment = 28;
constexpr int kExitHostUnconfirmed = 29;

// Códigos do auxiliar (DXCORE_EXIT_CODES), repassados sem alteração.
constexpr unsigned long kHelperContractCodes[] = {0, 10, 11, 12, 13, 64};

}  // namespace host
}  // namespace gerpro
