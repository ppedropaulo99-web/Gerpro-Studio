// Códigos de saída de gerpro-lock-holder-test.exe (SÓ DE TESTE; 6C.6C.3F;
// docs/11, seção 20). Faixa 40–46, separada da do launcher (20–29) e da do
// auxiliar DXCore, para que um código nunca seja confundido com outro.
#pragma once

namespace gerpro::lockholder {

// Travas obtidas, sinal de prontidão escrito e liberação pedida pelo
// supervisor (entrada padrão fechada ou um byte recebido).
constexpr int kExitReleased = 0;
// Argumentos fora do formato fixo (modo, pasta do caso, quantidade).
constexpr int kExitArgs = 40;
// Ambiente recusado: entrada padrão não é pipe, saída padrão ausente,
// endurecimento do processo ou pasta temporária do sistema indisponível.
constexpr int kExitEnvironment = 41;
// Caminho recusado: fora da pasta exclusiva, nome inesperado, componente que
// é link/junção, caminho final diferente do pedido, objeto do tipo errado,
// tamanho fora da faixa ou arquivo com mais de um nome (hard link).
constexpr int kExitPath = 42;
// Abertura com as flags do launcher, mapeamento ou vista recusados.
constexpr int kExitLock = 43;
// Não foi possível escrever o sinal de prontidão (travas já soltas).
constexpr int kExitSignal = 44;
// Prazo próprio vencido sem pedido de liberação (travas soltas pelo prazo).
constexpr int kExitDeadline = 45;
// Falha ao acompanhar a entrada padrão (travas soltas na hora).
constexpr int kExitWait = 46;

}  // namespace gerpro::lockholder
