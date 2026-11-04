# Testes reais de contenção do launcher (Etapas 6C.6C.1 e 6C.6C.2A: preparação)

> **Estado no handoff (H2).** Este documento é **histórico de engenharia**, em
> ordem cronológica: os parágrafos de abertura descrevem a preparação, antes
> de qualquer execução. Depois, com os artefatos só de teste e nunca com o
> DXCore real, foram executados: o Grupo A (seções 10 e 14) e, do Grupo B,
> T-K1.hang (15), T-T1.hang (16), as repetições (17) e T-F3.hang (19). O
> `gerpro-lock-holder-test.exe`, T-F1, T-F2, T-F4 e o restante do Grupo B
> **não foram executados**. Nada daqui faz parte do app nem está autorizado
> para produção; os hashes de produção continuam `null`. Visão geral:
> [Guia de transferência](12-guia-de-transferencia.md).

**Situação:** os artefatos só de teste foram **preparados e compilados**, e
nenhum deles foi executado: a variante `gerpro-helper-host-test.exe` e um
alvo sintético `gerpro-synthetic-helper.exe` para cada cenário. Este documento
é o **roteiro** da execução controlada (6C.6C.2), que precisa de autorização
própria. O auxiliar DXCore real não aparece em nenhum teste. Os hashes de
produção continuam `null` e o detector continua desativado.

**6C.6C.2A:** o supervisor dos testes e a entrada Electron de teste foram
implementados (seção 8), e o Grupo A foi preparado caso a caso. **Nenhum
cenário foi executado.** Só rodaram o plano e a conferência de pré-condições
(`--check-only`), que não iniciam nenhum processo de teste. As técnicas para
os testes futuros estão na seção 9.

Base: `docs/10-ativacao-dxcore.md` (seções 9–19, em especial 15.2 e 16.2),
`native/helper-host/README.md` e D55 (supervisor), D61–D63.

---

## 1. Artefatos

| Artefato | Origem | Onde fica | Distribuído? |
| --- | --- | --- | --- |
| `gerpro-helper-host-test.exe` | os **mesmos** fontes do launcher (`native/helper-host/src`), com `/DGERPRO_HOST_TEST_BUILD` | `native/helper-host/build/test/x64/` (fora do git) | nunca |
| `gerpro-synthetic-helper.exe` (7 binários, um por cenário) | `native/helper-host/test-artifacts/synthetic_helper.cpp`, com `/DGERPRO_SYNTHETIC_SCENARIO=<n>` | `native/helper-host/build/test/x64/scenarios/<cenário>/` | nunca |
| `protocol_tests_test_variant.exe` | testes da lógica pura na variante | `native/helper-host/build/test/x64/` | nunca |
| `test-manifest.json` | hashes, tamanhos, importações e reprodutibilidade | `native/helper-host/build/test/x64/` | nunca |

Build: `scripts/native/build-host-test-artifacts.mjs` (no ambiente x64 do
MSVC v143, como o launcher). Cenários: `scripts/native/host-test-scenarios.ts`.

### 1.1 Diferenças entre os dois launchers

As duas variantes compilam **o mesmo código**. A variante só existe em quatro
blocos de pré-processador. Fora deles, a sequência de contenção é idêntica,
e um teste estático confere isso.

| Onde | Produção (padrão) | Testes (`GERPRO_HOST_TEST_BUILD`) |
| --- | --- | --- |
| `protocol.h`: nome do próprio executável | `gerpro-helper-host.exe` | `gerpro-helper-host-test.exe` |
| `protocol.h`: alvo | `gerpro-dxcore-helper.exe` | `gerpro-synthetic-helper.exe` |
| `protocol.h`: pasta acima de `win32-x64` | `helpers` | `host-test` |
| `main.cpp`: linha de comando do alvo | `gerpro-dxcore-helper.exe --protocol 1` | `gerpro-synthetic-helper.exe --protocol 1` |
| `main.cpp`: resumos aceitos | o do argumento | o do argumento **e** um dos 7 resumos sintéticos fixados no build (`synthetic_digests.h`, gerado) → senão 24 |

Não mudam: o protocolo (`--protocol 1 --helper-sha256 <hex>`), os códigos
20–29, os prazos, o job (`KILL_ON_JOB_CLOSE`, `ACTIVE_PROCESS = 1`,
`DIE_ON_UNHANDLED_EXCEPTION`, sem saída), `JOB_LIST`, `CREATE_SUSPENDED`, a
política de filhos, a herança mínima e todas as conferências antes de
`ResumeThread`. O launcher de testes também não escreve nada. A lista de
importações é a mesma: 105 funções, conferidas por `checkHostBinary`.

A variante nova **não mudou o build de produção**. Recompilado depois da
mudança, o launcher de produção saiu byte a byte igual ao da 6C.6B.2 (SHA-256
`9c8f4a36…20da0c`).

### 1.2 Isolamento

| Garantia | Como |
| --- | --- |
| O launcher de produção não executa o alvo sintético | só abre `helpers\win32-x64\gerpro-dxcore-helper.exe`, e o hash vem da constante do app (hoje `null`: não executa nada). O binário não contém os nomes da variante de testes (`checkVariantIdentity(…, 'production')` no build de produção). O alvo sintético recusa rodar (64) fora de `host-test\win32-x64\gerpro-synthetic-helper.exe` |
| A variante de testes não executa o auxiliar DXCore | nome do alvo, pasta e nome do próprio executável diferentes. Só aceita resumos de alvos sintéticos fixados no build: o auxiliar real nunca é aceito, mesmo renomeado e com o hash certo no argumento (24). O binário não contém `gerpro-dxcore-helper.exe` (`checkVariantIdentity(…, 'test')`) |
| Hash próprio do alvo | 7 resumos, um por cenário, diferentes entre si; o build recusa coincidência com o auxiliar ou o launcher compilados nesta máquina |
| Fora do app | nenhum arquivo de `src/`, `package.json` ou `electron.vite.config.ts` cita os artefatos (teste estático); nada é gravado em `resources/`; o build de produção não define a variante (teste estático) |
| Fora da distribuição | saídas só em `native/helper-host/build/test/` (ignorada pelo git); não existe configuração de empacotamento que inclua `native/` |
| Sem elevação | manifesto `asInvoker`/`uiAccess='false'` na variante e nos 7 alvos (conferido pelo build) |
| Sem rede, registro, hardware ou arquivos (alvo) | só `KERNEL32.dll`, com lista explícita de importações e proibições (`checkSyntheticBinary`); fonte sem APIs de arquivo, registro, rede, dispositivo, ambiente ou outros processos (teste estático); única saída: uma linha na saída padrão herdada |

### 1.3 Cenários do alvo sintético

| Nº | Cenário | O que faz | Código do alvo | Esperado do launcher de testes |
| --- | --- | --- | --- | --- |
| 1 | `exit-ok` | escreve uma linha e sai | 0 | 0 |
| 2 | `exit-contract` | escreve uma linha e sai | 12 | 12 |
| 3 | `exit-out-of-contract` | escreve uma linha e sai | 77 | 28 |
| 4 | `hang` | escreve `state=waiting` e espera 30 s (prazo próprio) | 13 | 27 (prazo de 2 s) |
| 5 | `spawn-child` | tenta criar o próprio executável **suspenso**, sem e com `CREATE_BREAKAWAY_FROM_JOB`; se conseguir, encerra o filho na hora | 0 (recusados) ou 11 | 0 (ou 28 se a contabilidade do job mudar) |
| 6 | `memory` | reserva e toca 64 MiB, relata `PeakProcessMemoryUsed`/`PeakJobMemoryUsed` do job imediato e libera | 0 (ou 10) | 0 |
| 7 | `job-probe` | relata o job imediato: presença, `LimitFlags`, `ActiveProcessLimit`, processos ativos/total | 0 | 0 |

Os esperados são **hipóteses** a confirmar, não fatos.

Formato da saída (ASCII, uma linha), por exemplo:
`gerpro-synthetic scenario=job-probe in-job=1 limit-flags=0x2408 active-limit=1 active=1 total=1 peak-process=… peak-job=…`.
Ela traz só números do próprio cenário: nenhum caminho, nome de usuário,
identificador de processo ou dado de hardware.

---

## 2. Ambiente e supervisor comuns

**Supervisor:** implementado na 6C.6C.2A (seção 8). A descrição abaixo é a
original da 6C.6C.1; onde houver diferença, vale a seção 8. Script Node no
padrão da D55:

- cria uma pasta temporária exclusiva
  `%TEMP%\gerpro-6c6c-<aleatório>\host-test\win32-x64\`;
- copia a variante de testes e **um** cenário, renomeado para
  `gerpro-synthetic-helper.exe`;
- confere os dois hashes contra `test-manifest.json` antes de executar;
- inicia o launcher com `spawn` (sem shell), argumentos
  `['--protocol', '1', '--helper-sha256', <hash do cenário>]` e
  `stdio: ['ignore', 'pipe', 'pipe']`;
- registra o código de saída, a linha da saída padrão, os tempos (`exit`,
  `close`) e o censo de processos.

Os hashes vêm só do `test-manifest.json`, nunca das constantes do app.

**Censo de processos.** Os nomes `gerpro-helper-host-test.exe` e
`gerpro-synthetic-helper.exe` só existem nos testes. Por isso o censo é a
contagem de processos com esses dois nomes, e nunca precisa olhar outros
processos.

**Pré-condições comuns a todos os testes:**

1. Build de testes reprodutível, com `test-manifest.json` atual.
2. Censo inicial = 0.
3. Nenhum processo Gerpro Studio aberto.
4. Volume local NTFS.
5. Windows 10/11 x64 nativo.
6. Sessão sem elevação.

**Critérios de interrupção comuns** (encerram **a bateria inteira**, D61/16.2):

- censo > 0 depois da janela de limpeza do teste (3 s depois do `close`, ou
  depois do encerramento forçado previsto no teste);
- pedido de elevação, caixa de erro (WER) ou janela visível;
- qualquer gravação fora da pasta temporária do supervisor;
- código de saída fora da tabela esperada num teste de baixo risco;
- o supervisor não consegue confirmar a remoção da própria pasta.

**Limpeza comum:**

1. Esperar o `close` do launcher.
2. Fazer o censo.
3. Se o censo for maior que 0, registrar a falha e encerrar à força **só**
   processos com os dois nomes de teste. Refazer o censo; se ainda houver
   processo, interromper e pedir intervenção manual.
4. Remover a pasta temporária pelas regras da D55 (mesmo caminho,
   dispositivo e inode; sem seguir links).
5. Registrar o resultado sem caminhos nem identificadores de processo.

---

## 3. Grupo A: baixo risco

Em todos os testes deste grupo, o alvo termina sozinho em menos de 1 s, ou
nunca é retomado.

### T-E1: falha antes da retomada

**Objetivo:** cada recusa provocável pelo ambiente sai com o código certo, e o
alvo nunca roda.

**Pré-condições:** comuns. O cenário é `exit-ok`, ou seja, se o alvo rodasse,
a linha apareceria.

**Execução:** uma execução por caso.

| Caso | Código esperado |
| --- | --- |
| argumento a mais, hash em maiúsculas, versão 2 | 20 |
| saída padrão que não é pipe (`stdio: 'ignore'`) | 21 |
| launcher fora de `host-test\win32-x64` | 23 |
| launcher renomeado | 23 |
| alvo ausente | 23 |
| alvo com menos de 1 KiB | 23 |
| alvo como link simbólico (se a criação for permitida sem elevação) | 23 |
| hash de outro cenário no argumento | 24 |
| cópia de um cenário com 1 byte a mais e o hash dessa cópia (fora dos fixados) | 24 |

**Evidência esperada:** o código esperado de cada caso, a saída padrão vazia
e o censo 0.

**Aprovação:** todos os casos com o código esperado e nenhuma linha
`gerpro-synthetic`.

**Interrupção:** qualquer linha `gerpro-synthetic` (alvo retomado indevidamente).

**Limpeza:** comum. Cada caso usa uma pasta temporária própria.

**Não cobertos pelo ambiente:** 22 (job e atributos), 25 (`CreateProcessW`,
exceto via T-J1) e 26 (conferências com o processo suspenso). Hoje esses
códigos só têm a cobertura estática S1/S2. Para provocá-los seria preciso
injetar falhas numa terceira variante só de teste, o que exige decisão (seção
5).

### T-H1: saída herdada e `close`

**Objetivo:** a saída padrão chega pelo pipe herdado, e o `close` do Node
só chega depois do fim do alvo.

**Pré-condições:** comuns.

**Execução:**

- `exit-ok`, `exit-contract` e `exit-out-of-contract`, uma vez cada (6C.6C.2A:
  sem repetição automática; as repetições do plano original ficam para
  baterias seguintes, cada uma com nova autorização);
- `hang`: passou para o Grupo B (T-T1), porque pode deixar processo ativo.

**Evidência esperada:**

- códigos 0, 12 e 28;
- a linha de cada cenário;
- `close` depois de `exit`;
- no `hang`, `close` em ≈2,0–2,6 s.

**Aprovação:** os códigos, as linhas e a ordem dos eventos conferem nas
12 execuções, e o censo é 0.

**Interrupção:** `close` ausente 2 s depois de `exit`, ou censo > 0.

**Limpeza:** comum.

### T-F5: `CreateProcessW` com o alvo travado

**Objetivo:** confirmar H-F5, isto é, que o carregador abre o executável
enquanto o launcher o mantém aberto só com `FILE_SHARE_READ`.

**Pré-condições:** comuns.

**Execução:** é a mesma execução de `exit-ok` do T-H1, sem nada a mais. O
launcher sempre cria o alvo com o arquivo travado.

**Evidência esperada:** código 0 com a linha, e não 25.

**Aprovação:** 0 em todas as execuções do T-H1.

**Interrupção:** 25 (H-F5 refutada). Nesse caso a bateria para e o desenho da
seção 11 de `docs/10` é revisto.

**Limpeza:** comum.

### T-R1: job da libuv no Electron 45

**Objetivo:** descobrir se o Electron 45 associa os processos filhos ao job
da libuv, e com quais limites.

**Pré-condições:**

- comuns;
- um script de entrada do Electron **só de teste** (a escrever na 6C.6C.2),
  que inicia o cenário `job-probe` com `child_process.spawn`;
- o Electron do projeto (45), sem o app.

**Execução:**

1. O Electron inicia `job-probe` **diretamente**, sem o launcher (o mesmo
   layout de pasta), e lê a linha.
2. O Electron inicia o launcher de testes com `job-probe`.

**Evidência esperada:**

- na execução 1: `in-job=1`, `limit-flags` com `KILL_ON_JOB_CLOSE` e
  `SILENT_BREAKAWAY_OK` (hipótese: `0x3c00`; **[verificar]**);
- na execução 2: o job imediato é J, com `limit-flags=0x2408`,
  `active-limit=1`, `active=1` e `total=1`.

**Aprovação:** as duas linhas são registradas e a execução 2 mostra J
exatamente com os limites do launcher. Qualquer resultado da execução 1 é
**registrado**, não reprovado; ele decide o T-K2.

**Interrupção:** na execução 2, `in-job=0` ou limites diferentes de J (a
contenção não vale).

**Limpeza:** comum. O Electron é encerrado pelo próprio script de teste, e o
censo inclui o Electron iniciado pelo supervisor.

### T-R2 e T-R4: descendentes e saída do job

**Objetivo:** confirmar que o alvo não cria descendentes, nem comuns
(política de filhos e `ACTIVE_PROCESS = 1`) nem com
`CREATE_BREAKAWAY_FROM_JOB` (job sem saída).

**Pré-condições:** comuns.

**Execução:** o cenário `spawn-child` pelo launcher, 5 vezes. Os filhos que
eventualmente sejam criados nascem suspensos, e o próprio alvo os encerra.

**Evidência esperada:**

- `plain=denied,error=<n>` e `breakaway=denied,error=<n>`;
- alvo 0 e launcher 0;
- censo 0.

Os códigos de erro do Windows são registrados para documentar qual camada
recusou (política de filhos ou limite do job).

**Aprovação:** as duas tentativas recusadas nas 5 execuções.

**Interrupção:** `created` em qualquer tentativa. A linha também informa se o
filho estava em algum job e se o encerramento foi confirmado. O launcher
deve então sair com 11 ou 28. Nesse caso a bateria para e a contenção é
revista.

**Limpeza:** comum. Mesmo com `created`, o filho nunca foi retomado; o censo
confirma.

### T-M1: pico de memória (parte sintética)

**Objetivo:** medir o pico observado pelo job e confirmar que o relato de
memória funciona. Isso prepara a medição do auxiliar real (6C.6D), da qual
sai o limite.

**Pré-condições:** comuns.

**Execução:** o cenário `memory` pelo launcher, 5 vezes.

**Evidência esperada:** alvo 0 e launcher 0, com `committed=67108864`,
`peak-process` ≥ 64 MiB e `peak-job` ≥ `peak-process`.

**Aprovação:** valores coerentes nas 5 execuções.

**Interrupção:** `alloc=denied` (não existe limite que explique a recusa) ou
censo > 0.

**Limpeza:** comum.

**Pendente:** a parte "alocação acima do limite falha" só pode ser testada
**depois** que o limite for escolhido a partir do pico real, o que exige uma
nova variante de build com o limite. Até lá, `memory-limit-pending` continua
bloqueando a produção.

---

## 4. Grupo B: pode deixar processos ativos

Estes testes usam o cenário `hang` ou mexem no ambiente. Antes de começar o
grupo B, o grupo A inteiro tem de ter passado. O alvo `hang` tem prazo
próprio de 30 s, que é o tempo máximo de vida de um resto mesmo se a
contenção falhar.

### T-T1: prazo do launcher

**Objetivo:** confirmar que um alvo travado é encerrado pelo
`TerminateJobObject` e que o fim é confirmado em até 500 ms (H-T1).

**Pré-condições:** comuns.

**Execução:** `hang` pelo launcher, 10 vezes, sem interferência.

**Evidência esperada:** código 27 (não 29), `exit` em ≈2,0–2,6 s e censo 0
logo depois do `close`.

**Aprovação:** 27 nas 10 execuções e censo 0.

**Interrupção:** 29, censo > 0, ou `exit` depois de 3 s.

**Limpeza:** comum, com encerramento forçado por nome se o censo for maior
que 0.

### T-K1: Node encerra o launcher no meio

**Objetivo:** confirmar que fechar o identificador do job (fim do launcher)
encerra o alvo via `KILL_ON_JOB_CLOSE`, e que o `close` chega em até 2 s.

**Pré-condições:** comuns.

**Execução:** `hang` pelo launcher. Depois da linha `state=waiting`, o
supervisor encerra o launcher (`child.kill()`). São 10 execuções.

**Evidência esperada:** `close` em até 2 s depois do `kill` e censo 0.

**Aprovação:** os dois critérios nas 10 execuções.

**Interrupção:** `close` ausente em 2 s (situação `exit-unconfirmed`), ou
alvo vivo.

**Limpeza:** comum.

### T-K2: Electron encerrado no meio

**Objetivo:** confirmar que nenhum processo sobra quando o Electron sai,
normalmente ou à força.

**Pré-condições:**

- T-R1 concluído;
- o mesmo script de entrada do Electron só de teste.

**Execução:** o Electron inicia o launcher com `hang`. Depois da linha, o
Electron é encerrado:

- (a) por `app.quit()`;
- (b) pelo supervisor, à força.

São 5 execuções de cada.

**Evidência esperada:** censo 0 em até 3 s depois do fim do Electron, em (a)
e em (b). Se o T-R1 mostrar que não existe job da libuv, o caso (b) depende só
do prazo do launcher (≤ 2,5 s).

**Aprovação:** censo 0 em todas as execuções, dentro do prazo.

**Interrupção:** censo > 0 depois de 3 s.

**Limpeza:** comum, incluindo os processos do Electron iniciados pelo
supervisor.

### T-K3: 100 execuções com cancelamento aleatório

**Objetivo:** confirmar que não sobra nenhum processo sob repetição.

**Pré-condições:** T-T1 e T-K1 aprovados.

**Execução:** 100 execuções de `hang`. Cada uma é cancelada num instante
aleatório entre 0 e 2.500 ms; a semente é registrada para reprodução.

**Evidência esperada:**

- censo 0 depois de cada execução e no fim;
- distribuição dos códigos (27, 1 ou encerramento pelo Node);
- tempos de `close`.

**Aprovação:** censo 0 nas 100 execuções.

**Interrupção:** o primeiro censo maior que 0.

**Limpeza:** comum, a cada execução.

### T-F1 a T-F4: travas de arquivo e pastas

**Objetivo:** confirmar H-F1 a H-F4 nas mesmas condições de abertura usadas
pelo launcher.

**Método:** a janela travada do launcher dura milissegundos e não pode ser
alongada sem uma opção nova. Por isso, as hipóteses são testadas pelo
supervisor reproduzindo **as mesmas aberturas** do launcher (acesso e modos de
compartilhamento). O efeito sobre o launcher em si é confirmado
indiretamente: o T-H1 roda com as travas, e o passo 12 detecta a mudança.

**Pré-condições:** comuns. Cópias de cenários na pasta temporária; nunca o
auxiliar real.

**Execução:**

| Teste | O que o supervisor faz | Esperado |
| --- | --- | --- |
| T-F1 | abre o alvo como o launcher (`GENERIC_READ`, só `FILE_SHARE_READ`) e tenta, por outro identificador: abrir para escrita, renomear e apagar | as três tentativas recusadas (violação de compartilhamento) |
| T-F2 | cria um mapeamento gravável do alvo e, com ele aberto, inicia o launcher de testes | 25, ou 24 se a seção for criada e o conteúdo mudar; nunca 0 com conteúdo alterado |
| T-F3 | inicia o alvo `hang` pelo launcher e, com a seção de imagem existente, tenta abrir o arquivo para escrita | escrita recusada; código 27 |
| T-F4 | abre as pastas como o launcher (`FILE_LIST_DIRECTORY`, sem `FILE_SHARE_DELETE`) e tenta renomear `host-test` e `win32-x64` | renomeações recusadas |

**Evidência esperada:** o resultado de cada tentativa (permitida ou
recusada, com o código do Windows) e o código do launcher, quando houver.

**Aprovação:** as quatro hipóteses confirmadas. Uma hipótese refutada não
reprova a bateria, mas reabre a janela correspondente da seção 13 de
`docs/10`, que deve ser atualizada.

**Interrupção:** alvo alterado e executado com código 0 (falha de
integridade), ou censo > 0.

**Limpeza:** comum. Os identificadores e mapeamentos do supervisor são
fechados antes da remoção da pasta.

---

## 5. Testes que ainda não podem ser executados

Cada item precisa de decisão antes da 6C.6C.2.

| Teste | Por quê | Proposta |
| --- | --- | --- |
| T-R3 (Electron dentro de um job externo sem saída) | falta uma ferramenta que crie o job externo e inicie o Electron dentro dele; nenhum artefato desta etapa faz isso | um terceiro binário só de teste (`gerpro-outer-job-test.exe`, mesmas regras de isolamento), ou PowerShell com `Add-Type`; ambas as opções criam jobs e processos fora do launcher e precisam de aprovação |
| T-J1 (associação impossível → 25, nenhum processo) | também exige um job externo, com `ActiveProcessLimit` já atingido | a mesma ferramenta do T-R3 |
| T-R5 (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`) | o alvo sintético **não** abre outros processos (proibido pela política desta etapa); o teste exige `OpenProcess` com `PROCESS_CREATE_PROCESS` num processo-isca | um cenário 8, `parent-process`, que só usa um processo-isca iniciado pelo supervisor (outro `hang` fora do launcher), com `OpenProcess` liberado só para esse cenário; o resultado esperado é que o escape **funcione** (R15) |
| T-E1, códigos 22, 25 e 26 | não são provocáveis pelo ambiente | variante de injeção de falhas (`GERPRO_HOST_FAULT_STEP`), só de teste; não recomendado agora, porque a cobertura estática S1/S2 já confere a ordem |
| T-M1, alocação acima do limite | não existe limite | depois da 6C.6D (pico do auxiliar real) |

---

## 6. Ordem proposta e registro

1. Grupo A: T-E1 → T-H1/T-F5 → T-R1 → T-R2/T-R4 → T-M1.
2. Revisão dos resultados do grupo A.
3. Grupo B: T-T1 → T-K1 → T-F1…T-F4 → T-K2 → T-K3.

Os resultados entram neste documento, numa tabela por hipótese
(confirmada ou refutada, efeito no desenho), sem caminhos nem identificadores
de processo. Os itens da seção 5 só entram com a decisão correspondente.

## 7. Resultados do build (6C.6C.1)

MSVC 14.44.35207, Windows SDK 10.0.26100.0, `/W4 /WX` sem avisos, dois
builds limpos idênticos byte a byte (variante, 7 alvos e testes).

| Artefato | Tamanho | SHA-256 |
| --- | --- | --- |
| `gerpro-helper-host-test.exe` | 115.200 | `94507dc4ff655c46ec7bb1adb254e5d2c27403a1331bf8e0dcad8d8b6058d1eb` |
| alvo `exit-ok` | 106.496 | `8616bddbd4a7f530f9c48b5abd55ee3ea14fdc1b4dcdbfaf1a23e61ad4c6ac44` |
| alvo `exit-contract` | 106.496 | `fbd4e54263dd188de43d2df1e18f53d16ed3400116a6268444023a537eab4dc9` |
| alvo `exit-out-of-contract` | 106.496 | `2068082f62bde1b8de84cfa9d3175560073ace17c779f58a1ac22caf45d5fe64` |
| alvo `hang` | 106.496 | `d88431fb48cd5067c439d5a4a0f3e6397f5da1dd6a4a63887876c9ca7b255461` |
| alvo `spawn-child` | 108.032 | `097a4c3cccb11d7e1a282264a118b0468d5edae1d66e59f7bb916c2ecad456cd` |
| alvo `memory` | 109.056 | `cc8c56b831c9f698167a101b4083bc7454c361cdc093234cab6731622f4c9d32` |
| alvo `job-probe` | 108.032 | `ea78c3fcbceec3f18c80eeeced3a32a5c58f59d266d881eb28483c197dd4ffcb` |
| `protocol_tests_test_variant.exe` | — | `a892726cf6f24894f7d41a1087442d393b2a65d28473522fed29dcbe55bf7346` |

Esses valores só valem para esta toolchain e estes fontes, e nenhum deles
entra no app.

Inspeção de PE (`pe-inspect.ts` e `dumpbin`, de acordo), nos 8 executáveis:

- x64, PE32+, console;
- `DllCharacteristics 0xC160`, Guard Flags `0x10017500`, CET compatível,
  `DependentLoadFlags 0x800`;
- `asInvoker`, `supportedOS` do Windows 10;
- sem PDB e sem caminhos embutidos.

As importações diferem por binário:

- **Variante de testes:** `KERNEL32.dll` e `bcrypt.dll`, exatamente as mesmas
  105 funções do launcher de produção.
- **Alvos sintéticos:** só `KERNEL32.dll`, dentro da lista explícita
  `SYNTHETIC_ALLOWED_FUNCTIONS`. Funções além do CRT, por cenário:
  - `hang`: `Sleep`;
  - `spawn-child`: `CreateProcessW`, `IsProcessInJob`, `WaitForSingleObject`;
  - `memory`: `VirtualAlloc`, `VirtualFree`, `IsProcessInJob`,
    `QueryInformationJobObject`;
  - `job-probe`: `IsProcessInJob`, `QueryInformationJobObject`.

  `CreateFileW` aparece em todos os alvos, importada pelo CRT estático; o
  código do alvo não a chama (teste estático).

Executados: só os testes da lógica pura nas duas variantes. Eles não criam
processos nem jobs e não abrem arquivos:

- `protocol_tests.exe`: 73 verificações, 0 falhas;
- `protocol_tests_test_variant.exe`: 67 verificações, 0 falhas.

---

## 8. Supervisor dos testes (6C.6C.2A)

Nenhum cenário foi executado nesta etapa.

### 8.1 Arquivos

| Arquivo | Papel |
| --- | --- |
| `scripts/diagnostics/run-host-containment.mjs` | ponto de entrada (Node); liga as chamadas reais do sistema |
| `scripts/diagnostics/host-containment/plan.ts` | plano do Grupo A: hashes aprovados, casos, pré-condições, prazos, esperados e avaliação (lógica pura) |
| `scripts/diagnostics/host-containment/system-checks.ts` | censo com identidade (script fixo do PowerShell), classificação de sobreviventes, trava e prefixo (lógica pura) |
| `scripts/diagnostics/host-containment/battery.ts` | ordem da bateria, conferências, prazos, sobreviventes e limpeza; todo acesso ao sistema é injetado |
| `scripts/diagnostics/host-containment-electron.mjs` | entrada Electron **só de teste** (T-R1) |
| `scripts/diagnostics/scratch-lifecycle.ts` | (alterado) prefixo opcional da pasta exclusiva; o padrão continua o do diagnóstico de hardware |

Nenhum arquivo do app (`src/`), do build (`electron.vite.config.ts`) ou do
pacote (`package.json`) cita esses arquivos; um teste estático confere isso.
IPC, Preload, Renderer, consentimentos, `services/index.ts` e os hashes de
produção não mudaram.

### 8.2 Modos

```
node scripts/diagnostics/run-host-containment.mjs
node scripts/diagnostics/run-host-containment.mjs --check-only
node scripts/diagnostics/run-host-containment.mjs --group=A --confirm-host-containment-run [--only=T-E1,T-H1,T-R1,T-R2,T-M1]
```

- **Sem argumentos:** mostra o plano e não inicia nada.
- **`--check-only`:** confere as pré-condições e os artefatos. Inicia só o
  `whoami.exe` e o PowerShell do censo; nenhum processo de teste.
- **Execução:** exige a confirmação explícita e `--group=A`. O Grupo B é
  recusado. `--only` aceita só testes executáveis do Grupo A; T-F5 e T-R4
  saem de T-H1 e T-R2. Argumento desconhecido ou repetido não inicia nada
  (código 2).

### 8.3 Identidade e integridade (antes de qualquer processo de teste)

1. **Plataforma:** Windows x64, pasta temporária numa unidade local.
2. **Sem elevação:** `whoami /groups` tem de dar nível médio ou baixo; nível
   desconhecido também recusa.
3. **Censo = 0** para as imagens `gerpro-helper-host-test.exe`,
   `gerpro-synthetic-helper.exe` e `gerpro-helper-host-test-renamed.exe`.
   Censo indisponível recusa.
4. **Artefatos.** A fonte dos valores é `APPROVED_ARTIFACTS` (`plan.ts`):
   tamanho e **SHA-256 completo** do launcher de testes e dos 6 alvos do
   Grupo A, iguais aos aprovados na 6C.6C.1 (seção 7). O
   `test-manifest.json` é só conferido contra esses valores. Também passam:
   - `checkHostBinary` e `checkVariantIdentity(…, 'test')` no launcher;
   - `checkSyntheticBinary` em cada alvo.
5. **T-R1:** Electron do projeto na versão 45.
6. **Trava exclusiva:** `gerpro-host-containment.lock`, criada de forma
   atômica (`wx`) na pasta temporária do sistema.
7. **Cada caso:** cópias gravadas sem sobrescrever (`wx`) e relidas pelo
   hash. A entrada Electron confere os hashes de novo antes de iniciar
   qualquer processo.

Cada processo iniciado é registrado no terminal com PID, imagem e prefixo
do SHA-256 do launcher e do alvo.

### 8.4 Execução única

- Cada caso roda **uma vez**. Não há laço de repetição nem nova tentativa.
- Qualquer reprovação encerra a bateria, e os casos seguintes ficam
  `not-run`.
- Uma bateria por vez (trava).
- `Ctrl+C` impede que um novo caso comece; o caso atual termina pelo prazo
  dele.

### 8.5 Prazos

| Situação | Prazo |
| --- | --- |
| Caso com o launcher | 5 s; o próprio launcher termina em ≤ 2,5 s |
| T-R1 | 30 s para o Electron; 5 s para cada processo dentro dele |
| `close` depois do encerramento | 2 s; sem `close`, "situação incerta" e a bateria para |

Ao estourar o prazo, o supervisor encerra **só o processo que iniciou**,
pelo identificador desse processo (`child.kill()`).

### 8.6 Limpeza

Depois de cada caso:

1. Esperar o `close`.
2. Fazer o censo.

No fim da bateria, sempre (`finally`):

1. Remover a pasta exclusiva pelas regras da D55: mesmo caminho,
   dispositivo e inode; prefixo `gerpro-6c6c-`; sem seguir links.
2. Liberar a trava.
3. Fazer o censo final.

O supervisor grava só na pasta exclusiva e na trava. A entrada Electron
grava seus dados (cache, preferências) na subpasta do caso.

### 8.7 Sobreviventes (revisto na 6C.6C.2B)

Qualquer processo de teste no censo depois de um caso **encerra a bateria**
(código 5). Desde a 6C.6C.2B, **nenhum sobrevivente é encerrado
automaticamente**, nem por PID.

O motivo: o Node não tem um identificador do processo encontrado pelo censo,
só o PID. Entre a releitura da identidade e o encerramento, o PID pode ser
reutilizado, então a identidade não pode ser garantida no instante do
encerramento.

Os sobreviventes são só classificados e registrados (PID, imagem, pai):

- **desta bateria:** o caminho do executável é um arquivo copiado por ela, e
  o processo foi criado depois do início;
- **qualquer outro.**

Nos dois casos o terminal pede **inspeção manual**. O único encerramento
automático que resta é o do processo que o próprio supervisor iniciou, no
prazo, pelo identificador desse processo (`child.kill()`).

**Electron de teste.** Depois do T-R1 há um censo **só de leitura** dos
`electron.exe`: considera só o executável do Electron do projeto e só os
processos criados durante o caso (a instância iniciada e os filhos dela).
Outras instâncias nunca entram. São até 3 leituras em 3 s; o resultado tem
de ser 0, senão a bateria para, sem encerrar nada.

Não existe encerramento por nome de processo (conferido por teste
estático).

### 8.8 Entrada Electron de teste (T-R1)

`host-containment-electron.mjs` só roda com:

- a confirmação;
- a pasta exclusiva da bateria, aceita por `acceptScratch` com o prefixo
  próprio;
- a subpasta do caso, filha direta dessa pasta.

O que ela faz:

1. Desliga a aceleração de hardware e grava os dados do Electron na
   subpasta do caso.
2. Confere os hashes do launcher de testes e do alvo `job-probe`.
3. Inicia o alvo **direto** e depois **pelo launcher**, uma vez cada, sem
   shell e com prazo de 5 s cada.
4. Imprime `GERPRO-6C6C-RESULT {json}` e sai.

O que ela não faz: abrir janela, página, IPC ou rede; carregar código do
app; tocar a pasta de dados do Gerpro Studio, os consentimentos ou o
auxiliar real.

### 8.9 Códigos do supervisor

| Código | Significado |
| --- | --- |
| 0 | bateria aprovada |
| 2 | uso inválido |
| 4 | pré-condição não atendida (nada iniciado) |
| 5 | sobrevivente ou censo indisponível |
| 6 | caso reprovado |
| 7 | pasta ou trava não removida |
| 130 | interrompida |

### 8.10 Riscos remanescentes do supervisor

- **Troca de arquivo depois da conferência.** O hash da cópia é conferido
  antes do `spawn`. Quem escreve na pasta temporária do usuário pode trocar
  a cópia do launcher entre a conferência e o `spawn` (mesma janela T1 da
  seção 13 de `docs/10`). O alvo é conferido de novo pelo próprio launcher,
  contra os hashes fixados.
- **Morte do próprio supervisor.** Se o supervisor for encerrado à força, a
  trava e a pasta ficam para trás. A próxima bateria recusa ("trava
  antiga"), e a remoção é manual.
- **Censo e Electron.** O censo olha só as imagens de teste. Os processos do
  Electron iniciados para o T-R1 são encerrados pelo identificador do
  supervisor no prazo, mas o censo não os cobre.
- **Fim sem confirmação.** Se um processo for encerrado e o `close` não
  chegar, o resultado é "situação incerta", sem nova tentativa.

## 9. Implementação futura (não implementada)

Cada item precisa de aprovação própria. Todos seguem as mesmas regras:

- fonte separado, nome que só existe nos testes (e entra no censo);
- hash fixado em `APPROVED_ARTIFACTS`;
- saída só em `native/helper-host/build/test/`;
- sem elevação.

### 9.1 Ferramenta de Job Object externo (T-R3, T-J1)

`gerpro-outer-job-test.exe`, em C++ com o mesmo build:

- **Protocolo:** `--outer-job <perfil>`, com perfis enumerados no build,
  nunca valores livres:
  - `no-breakaway`: `KILL_ON_JOB_CLOSE`, sem saída;
  - `active-limit-reached`: `ACTIVE_PROCESS = 1`, já ocupado pela própria
    ferramenta.
- **Alvo:** só o Electron do projeto (com a entrada de teste, T-R3) ou a
  variante de testes (T-J1), com caminho e hash fixados.
- **Sequência:** igual à do launcher (`CreateJobObjectW` sem nome,
  `JOB_LIST`, `CREATE_SUSPENDED`, conferência antes de `ResumeThread`).
- **Saída:** uma linha com o resultado e a contabilidade do job externo.
- **Evidência esperada:**
  - T-R3: na entrada Electron, `job-probe` mostra J e a execução direta
    mostra o job externo;
  - T-J1: launcher sai com 25 e a contabilidade não muda.

A alternativa em PowerShell (`Add-Type`) foi descartada: compila código em
tempo de execução, fora da política de PE e de hash.

### 9.2 Cenário de criação de descendente com outro pai (T-R5)

Cenário 8 do alvo sintético, `parent-process`:

1. O supervisor inicia um processo-isca: outro alvo `hang`, **fora** do
   launcher, na pasta da bateria.
2. O supervisor informa o PID dele pela única forma aceita: um arquivo
   `decoy.pid` na subpasta do caso, lido pelo alvo, que confere o caminho da
   imagem do PID antes de usá-lo.
3. O alvo abre a isca com `PROCESS_CREATE_PROCESS` e cria o próprio
   executável **suspenso** com `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`.
4. O alvo relata se o filho ficou fora de J e o encerra.

A política do alvo passaria a aceitar `OpenProcess` e
`UpdateProcThreadAttribute` **só nesse binário** (lista própria). Espera-se
que o escape **funcione**: o teste documenta o R15, não o fecha. É o único
cenário que lê um arquivo; por isso o desenho precisa de revisão própria.

### 9.3 Falhas injetadas (códigos 22, 25, 26)

Terceira variante, `GERPRO_HOST_FAULT_BUILD`, com nome próprio
(`gerpro-helper-host-fault.exe`):

- uma tabela fixa no build escolhe, por **hash do alvo** (não por argumento),
  em que passo falhar: depois de criar o job, depois de `CreateProcessW` e
  antes da conferência, ou na conferência de imagem;
- o protocolo não muda;
- os pontos de injeção ficam atrás de `#if` e são conferidos por teste
  estático para não existirem nas outras variantes;
- a variante de produção tem de continuar byte a byte igual, como na
  6C.6C.1.

**Evidência esperada:** o código certo e o alvo nunca retomado (censo e
ausência de linha).

### 9.4 Janelas reais de TOCTOU (T-F1 a T-F4 no launcher)

A janela travada dura milissegundos. Testá-la de verdade exige uma pausa
**só de teste**, também por variante (`GERPRO_HOST_PAUSE_BUILD`):

- o launcher recebe por herança (via `HANDLE_LIST`, nunca por nome global)
  dois eventos sem nome criados pelo supervisor;
- ele sinaliza o primeiro ao entrar na janela, entre os passos 6 e 14;
- depois espera o segundo, com prazo.

Nesse intervalo o supervisor tenta:

- escrita, renomeação e exclusão do alvo;
- renomeação das pastas;
- mapeamento gravável.

O resultado de cada tentativa e o código do launcher são registrados.

O Node não cria eventos herdáveis sem módulo nativo. Por isso o lado do
supervisor seria um pequeno auxiliar de teste em C++, sujeito às mesmas
regras.

Até lá, T-F1 a T-F4 seguem o método da seção 4: o supervisor reproduz as
mesmas aberturas do launcher.

## 10. Resultados da execução do Grupo A (6C.6C.2B)

Uma única execução, autorizada, com
`node scripts/diagnostics/run-host-containment.mjs --group=A --confirm-host-containment-run`.
Só os artefatos sintéticos. Nada foi repetido.

**Pré-condições conferidas antes**, com `--check-only` e na própria bateria:

- nível de integridade médio, Windows x64;
- censo 0;
- Electron 45.0.0;
- tamanho, SHA-256, PE e identidade do launcher de testes e dos 6 alvos;
- pasta temporária sem pasta `gerpro-6c6c-*` nem trava antigas;
- `DXCORE_HOST_SHA256`, `DXCORE_HELPER_SHA256` e
  `DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES` nulos.

**Resultado da bateria:** código 6 (caso reprovado). A bateria parou no
13º caso; pasta exclusiva removida, trava liberada, censo final 0.

| Caso | Resultado | Código | Tempo | Natureza |
| --- | --- | --- | --- | --- |
| T-E1.extra-arg | PASSOU | 20 | 174 ms | protocolo |
| T-E1.uppercase-hash | PASSOU | 20 | 98 ms | protocolo |
| T-E1.protocol-2 | PASSOU | 20 | 599 ms | protocolo |
| T-E1.stdout-not-pipe | PASSOU | 21 | 153 ms | protocolo |
| T-E1.wrong-folder | PASSOU | 23 | 689 ms | protocolo (layout) |
| T-E1.renamed-launcher | PASSOU | 23 | 658 ms | protocolo (layout) |
| T-E1.helper-missing | PASSOU | 23 | 164 ms | protocolo (arquivo) |
| T-E1.helper-tiny | PASSOU | 23 | 662 ms | protocolo (arquivo) |
| T-E1.helper-symlink | PULADO | — | — | sessão sem permissão para criar link simbólico |
| T-E1.other-scenario-hash | PASSOU | 24 | 194 ms | integridade |
| T-E1.modified-helper | PASSOU | 24 | 246 ms | integridade (resumos fixados da variante) |
| T-H1.exit-ok | **FALHOU** | **28** (esperado 0) | — | nenhuma linha do alvo |
| T-H1.exit-contract, T-H1.exit-out-of-contract, T-R2, T-M1, T-R1 | PULADO (não executados: bateria interrompida) | — | — | — |

Em todos os casos de T-E1 executados, nenhuma linha do alvo apareceu: o
alvo nunca foi retomado.

### 10.1 O que o código 28 do T-H1.exit-ok prova e o que não prova

O 28 só existe **depois** do `ResumeThread` (seção 11.6 de `docs/10`). Por
isso a execução prova, pelos próprios passos do launcher:

1. **`CreateProcessW` funcionou com o alvo travado** só com
   `FILE_SHARE_READ`. Isso **confirma H-F5**: se não funcionasse, o código
   seria 25.
2. **O alvo foi criado suspenso já dentro de J**, com `IsProcessInJob`
   verdadeiro e contabilidade de 1 processo ativo, 1 no total e 0
   encerrados, antes da retomada. A imagem tinha o mesmo caminho e FileId
   do arquivo travado, e o hash definitivo bateu; se algo disso falhasse, o
   código seria 26 ou 24. É a **primeira evidência real** de que a
   associação por `JOB_LIST` funciona nesta máquina.
3. **`ResumeThread` devolveu 1.**

O que **não** se sabe: qual dos quatro caminhos para o 28 ocorreu.

- O código do alvo ficou fora do contrato (ex.: exceção ou falha de
  inicialização).
- A contabilidade de J mudou depois da retomada (mais de um processo, ou um
  encerrado por limite).
- `GetExitCodeProcess` falhou.
- A espera falhou.

O alvo não escreveu a linha, e uma falha de `WriteFile` daria 10 (dentro
do contrato), então ele terminou antes de escrever ou foi encerrado.

**Hipótese principal (H-C1, não confirmada):** no Windows 8 e posteriores,
um programa de console criado **sem** `DETACHED_PROCESS` (o launcher usa
`CREATE_NO_WINDOW`) ganha uma instância de `conhost.exe` que é criada no
**mesmo job**. Com `ACTIVE_PROCESS = 1`, esse `conhost.exe` passa do limite
e é encerrado na associação. A inicialização do console do alvo falha
(provavelmente `STATUS_DLL_INIT_FAILED`) e/ou a contabilidade passa a
mostrar 2 processos ou 1 encerrado. Os dois efeitos levam ao 28.

A hipótese vale também para o auxiliar DXCore real, que é um programa de
console: **sem correção, o launcher de produção falharia no uso real**.

**Correção possível (não implementada; exige aprovação):** criar o alvo
com `DETACHED_PROCESS` em vez de `CREATE_NO_WINDOW`, sem console e sem
`conhost.exe`. A saída padrão continua pelo pipe de `STARTUPINFO`. Isso
muda o binário de produção, que teria novo hash. Para confirmar a hipótese
**antes** da correção, a próxima execução autorizada precisaria de uma
evidência que distinga os caminhos. Uma opção é uma variante de diagnóstico
que registre, no código de saída ou numa linha própria, o código bruto do
alvo e a contabilidade do job.

### 10.2 Classificação por teste

| Teste | Classificação | Demonstrou contenção? |
| --- | --- | --- |
| T-E1 | PASSOU (10 de 11 casos; 1 PULADO) | **Não**: verifica protocolo, layout e integridade antes da retomada. Também mostra que a variante recusa um alvo fora dos resumos fixados |
| T-H1 | **FALHOU** | — |
| T-F5 (H-F5) | PASSOU (inferido do código 28; o supervisor não o avalia separadamente) | Parcial: mostra que a trava do arquivo não impede a criação |
| Associação a J antes da retomada | evidência obtida (conferências do launcher) | **Sim**, mas só a associação, não o comportamento depois da retomada |
| T-R1, T-R2, T-R4, T-M1 | INCONCLUSIVO (não executados) | — |

**Limpeza:**

- pasta exclusiva removida, trava liberada;
- censo final 0;
- nenhuma pasta `gerpro-6c6c-*` e nenhuma trava na pasta temporária depois
  da execução;
- nenhum processo foi encerrado pelo supervisor (nenhum prazo estourou,
  nenhum sobrevivente).

Nada foi gravado fora da pasta exclusiva.

## 11. Investigação da falha do T-H1 (6C.6C.2C)

### 11.1 Variante diagnóstica

Os mesmos fontes do launcher, com `GERPRO_HOST_TEST_BUILD` e
`GERPRO_HOST_DIAG_BUILD`. Os pontos de registro ficam em blocos `#if`
próprios de `main.cpp`, sem aninhamento (conferido por teste estático), e
em `test-artifacts/host_diag.*`. A sequência, as conferências, `JOB_LIST`, a
criação suspensa, a política de filhos e os códigos de saída são os mesmos.

**Diferenças em relação à variante de testes:**

- Uma porta de conclusão própria é associada a J **antes** de criar
  qualquer processo. Ela só recebe mensagens e não muda os limites.
- Há consultas só de leitura a J: contabilidade e lista de processos (só
  as quantidades). O launcher não abre outros processos: `OpenProcess`
  continua proibida, e por isso a identidade de um processo extra
  **não** pode ser conhecida pelo launcher.
- O resultado de `ResumeThread`, da espera, de `GetExitCodeProcess` (com
  o código bruto do alvo) e do encerramento é registrado, com
  `GetLastError` nas falhas.
- No fim, depois de J fechado, o launcher escreve **uma** linha ASCII na
  própria saída padrão, com o prefixo `gerpro-host-diag v=1`. A linha só
  tem números e marcas fixas: nenhum caminho, usuário ou ambiente.
- O launcher aceita **um único** resumo, o do alvo `exit-ok` aprovado.
- Importa duas funções a mais: `CreateIoCompletionPort` e
  `GetQueuedCompletionStatus` (`DIAG_HOST_ALLOWED_FUNCTIONS`).

**Builds** (`scripts/native/build-host-diag-artifacts.mjs`): só gravam em
`native/helper-host/build/test/diag*`. Reprodutível em dois builds limpos.

| Variante | Criação do alvo | Bytes | SHA-256 | Execução |
| --- | --- | --- | --- | --- |
| `diag/nowindow` | `CREATE_NO_WINDOW` (igual à produção) | 128.000 | `8faa7b81e97b2d95beb51ba2d4802374e17c70e15a3a12ea2a364019cca784c1` | autorizada uma vez (6C.6C.2C) |
| `diag/detached` | `DETACHED_PROCESS` (só comparação) | 128.000 | `16acca858157e94e8032e31d98eecda1a253b90d998a68f845f79c75853bdac3` | **não executada** |

**Controle.** No mesmo build, os fontes alterados foram compilados de novo
**sem** a variante diagnóstica:

- o launcher de produção saiu byte a byte igual ao aprovado
  (`9c8f4a36…20da0c`);
- o de testes também (`94507dc4…58d1eb`);
- nenhum dos dois contém a marca diagnóstica.

As cópias de controle são apagadas depois da comparação.

### 11.2 Filtro restrito do supervisor

O modo diagnóstico tem dois usos:

- `--diagnose=T-H1.exit-ok --diag-variant=<nowindow|detached> --confirm-host-containment-run`
  executa;
- `--diagnose=T-H1.exit-ok --diag-variant=<nowindow|detached> --check-only`
  só confere as pré-condições.

Desde a 6C.6C.2D, a variante é **obrigatória e explícita**: não existe
variante padrão. Cada execução lê e confere só a variante escolhida, com o
SHA-256 dela fixado em `APPROVED_DIAG_LAUNCHERS`.

O filtro aceita **exatamente** `T-H1.exit-ok`. Recusa outro caso, lista,
curinga, maiúsculas, `--group`, `--only`, repetição e falta de confirmação
(testes em `tests/main/host-diagnosis.test.ts`). O parser do Grupo A
continua recusando `--diagnose`.

O caminho é o mesmo da bateria:

- pré-condições;
- trava;
- pasta exclusiva;
- prazo de 5 s;
- censo depois do caso e no fim;
- nenhum encerramento de sobrevivente.

A única troca é o launcher, que passa a ser a variante `nowindow`,
conferida pelo tamanho, SHA-256, PE com a lista diagnóstica, identidade de
testes e marca diagnóstica. A variante `detached` nunca é lida pelo
supervisor.

### 11.3 O que a documentação oficial diz (e o que não diz)

- **`CREATE_NO_WINDOW`** (Process Creation Flags): *"The process is a
  console application that is being run without a console window.
  Therefore, the console handle for the application is not set"*. O
  alvo ganha um console **novo**, sem janela.
- **`DETACHED_PROCESS`**: *"For console processes, the new process does
  not inherit its parent's console"*. Segundo "Creation of a Console", um
  processo de console criado assim *"is not attached to a console"*. Os
  dois flags não se combinam: `CREATE_NO_WINDOW` é ignorado junto com
  `DETACHED_PROCESS`.
- **`ActiveProcessLimit`**: *"If you try to associate a process with a
  job, and this causes the active process count to exceed this limit, the
  process is terminated and the association fails."*
- **`PROCESS_CREATION_CHILD_PROCESS_RESTRICTED`**: *"The process being
  created is not allowed to create child processes."*
- **Mensagens da porta de conclusão:** são só notificações, e *"their
  delivery to the completion port is not guaranteed"*.
- **Não documentado:** a documentação oficial **não diz** que o
  `conhost.exe` de um console novo seja criado pelo próprio processo de
  console, nem que entre no job dele. Essa parte da H-C1 não tem base
  documental.

### 11.4 Execução única (6C.6C.2C)

Comando executado uma vez:
`node scripts/diagnostics/run-host-containment.mjs --diagnose=T-H1.exit-ok --confirm-host-containment-run`.

**Pré-condições conferidas antes:**

- integridade média, Windows x64;
- censo 0;
- artefatos conferidos;
- hashes de produção e limite de memória nulos;
- nenhuma pasta `gerpro-6c6c-*` nem trava na pasta temporária;
- o filtro recusou `--diagnose=T-H1.exit-contract`.

**Resultado:** o launcher saiu com **28** (esperado 0) e o alvo não
escreveu nenhuma linha. A falha foi reproduzida. O supervisor saiu com o
código 6.

- Pasta exclusiva removida e trava liberada.
- Censo final 0, também confirmado por um censo só de leitura independente.
- Nenhum processo encerrado nem pelo supervisor nem pelo launcher
  (`term=0`).

Linha diagnóstica registrada:

```
gerpro-host-diag v=1 creation=nowindow digests=1 port=1 port-err=0 create=1 create-err=0
pre-contained=1 pre-injob=1 pre-acct=1,1,0 pre-ids=1,1,0 resume=1 resume-err=0
wait=0x00000000 wait-err=0 wait-acct=0,1,0 wait-ids=0,0,0 gec=1 gec-err=0 raw=0xC0000142
exit-acct=0,1,0 term=0 term-job=- term-err=- term-wait=- msgs=6h,7h,4n msgs-dropped=0 host=28
```

(A linha original é uma só; aqui foi quebrada para leitura.)

| Momento | Ativos | Total | Encerrados por limite | Processos listados (outros) |
| --- | --- | --- | --- | --- |
| Antes da retomada | 1 | 1 | 0 | 1 (0) |
| Depois da espera | 0 | 1 | 0 | 0 (0) |
| Depois de `GetExitCodeProcess` | 0 | 1 | 0 | — |

**Outros registros:**

- `ResumeThread` devolveu 1.
- A espera terminou com `WAIT_OBJECT_0`, dentro do prazo de 2 s.
- `GetExitCodeProcess` funcionou.
- **O código bruto do alvo foi `0xC0000142` (`STATUS_DLL_INIT_FAILED`).**
- Mensagens de J: `NEW_PROCESS` (alvo), `EXIT_PROCESS` (alvo),
  `ACTIVE_PROCESS_ZERO`. Nenhuma `ACTIVE_PROCESS_LIMIT` nem
  `ABNORMAL_EXIT_PROCESS`, e nenhuma mensagem com outro identificador.

### 11.5 Interpretação

**Confirmado (pelos registros):**

- O 28 veio de `MapHelperExit`: o código `0xC0000142` está fora do
  contrato. Os outros três caminhos para o 28 não ocorreram: a espera, o
  `GetExitCodeProcess` e a contabilidade depois da saída (`0,1,0`, aceita
  por `JobAccountingIs(job, 0)`) funcionaram.
- O alvo morreu **na inicialização das DLLs**, antes do próprio código. Por
  isso não escreveu a linha.
- **Só o alvo foi associado a J** em toda a execução: total 1, nenhum
  encerrado por limite, lista sem outros processos e nenhuma mensagem de
  outro processo.

**H-C1: INCONCLUSIVA, refutada na forma como foi enunciada.** A H-C1
previa que um `conhost.exe` entrasse em J e passasse do limite de processos
ativos, deixando a contabilidade com 2 processos ou 1 encerrado. Nada disso
aconteceu: J nunca contou um segundo processo.

Os dados combinam com uma falha na **criação** do console novo, antes de
qualquer associação a J. Essa conclusão vem da combinação
`STATUS_DLL_INIT_FAILED` + `CREATE_NO_WINDOW` + "nenhum outro processo em
J". **Não foi demonstrada.** Há duas causas compatíveis, e esta execução
não as distingue:

- **H-C2:** a política `PROCESS_CREATION_CHILD_PROCESS_RESTRICTED` impede o
  alvo de criar o processo do console.
- **H-C3:** o limite `ACTIVE_PROCESS = 1` recusa a criação antes de qualquer
  contagem. A ausência de `ACTIVE_PROCESS_LIMIT` pesa contra, mas a
  entrega das mensagens não é garantida.

Nenhum registro identifica `conhost.exe`. As contagens não são tratadas
como prova da existência ou da ausência dele.

### 11.6 Riscos remanescentes

- O launcher de produção, como está, **falharia com o auxiliar DXCore
  real**, que é um programa de console. A produção continua bloqueada:
  hashes nulos e `dxcoreHostBlockers`.
- O mecanismo exato não foi isolado entre H-C2 e H-C3. Uma correção que só
  remova o console resolve os dois, mas não explica qual deles agiu.
- Nenhuma contenção depois da retomada foi demonstrada até agora (T-R1,
  T-R2, T-M1 não executados).
- A variante diagnóstica tem uma porta de conclusão a mais. É só
  notificação, mas é uma diferença em relação à produção.
- A evidência vem de uma única execução, numa única máquina (Windows 11
  26200).

### 11.7 Correção recomendada (não aplicada)

Criar o alvo com **`DETACHED_PROCESS`** no lugar de `CREATE_NO_WINDOW`. O
alvo não precisa de console: a saída padrão é o pipe passado em
`STARTUPINFO`. Isso remove a criação do console, que é o fator comum de H-C2
e H-C3, sem mexer em `JOB_LIST`, `ACTIVE_PROCESS = 1`, na política de
filhos ou na integridade.

Antes de mudar a produção, o passo de menor risco é **uma** execução do
T-H1.exit-ok com a variante `diag/detached`, já compilada e não executada.

- **Se sair 0 com a linha do alvo,** fica demonstrado que a falha é da
  criação do console e que a correção funciona com a contenção intacta.
- **Se não sair 0,** a linha diagnóstica mostra o novo ponto de falha.

Depois, aplicar a mudança na produção (novo SHA-256 do launcher), recompilar
as variantes e repetir o Grupo A completo. Tudo isso exige autorização.

## 12. Validação de `DETACHED_PROCESS` (6C.6C.2D)

### 12.1 Mudanças no supervisor

- **Variante explícita.** `--diag-variant=` passou a ser obrigatório, uma
  única vez, com o valor `nowindow` ou `detached`. Os dois SHA-256 estão
  fixados. O supervisor lê só a variante escolhida e recusa a falta da
  variante, valores desconhecidos, valores em maiúsculas ou vazios e duas
  variantes ao mesmo tempo. A variante sozinha não abre o modo
  diagnóstico, e o Grupo A não a aceita.
- **Critérios de aprovação** em `evaluateDiagnosis`, além do caso em si
  (código do launcher 0 e exatamente uma linha `exit-ok` do alvo):
  - código bruto 0;
  - alvo em J antes da retomada (`pre-contained=1`, `pre-injob=1`,
    `pre-acct=1,1,0`);
  - `ResumeThread` = 1;
  - espera `WAIT_OBJECT_0`;
  - J com `0,1,0` depois da espera e depois de `GetExitCodeProcess`;
  - lista de J sem outros processos;
  - nenhuma mensagem de outro processo nem de limite;
  - nenhum encerramento pelo launcher.
- **Saída do alvo no registro.** Só as linhas no formato do alvo sintético
  são mostradas; as demais são apenas contadas.
- **Tempo do caso** no relatório.

O launcher e as variantes não mudaram: o arquivo `diag/detached` executado
é o mesmo compilado na 6C.6C.2C.

### 12.2 Execução única

Comando:
`node scripts/diagnostics/run-host-containment.mjs --diagnose=T-H1.exit-ok --diag-variant=detached --confirm-host-containment-run`.

**Pré-condições conferidas antes:**

- integridade média, Windows x64;
- censo 0;
- artefatos e SHA-256 `16acca85…bdac3` conferidos;
- hashes de produção e limite de memória nulos;
- nenhuma pasta `gerpro-6c6c-*` nem trava na pasta temporária;
- o filtro recusou outro caso e a execução sem variante.

**Resultado: APROVADO.** O supervisor saiu com o código 0. O caso levou
796 ms, do início ao `close`.

- Pasta exclusiva removida e trava liberada.
- Censo final 0, também confirmado por um censo independente só de leitura.
- Nenhuma sobra na pasta temporária.
- Nenhum processo encerrado nem pelo supervisor nem pelo launcher.

| Evidência | `diag/nowindow` (6C.6C.2C) | `diag/detached` (6C.6C.2D) |
| --- | --- | --- |
| Criação do alvo | `CREATE_NO_WINDOW` | `DETACHED_PROCESS` |
| Em J antes da retomada (`IsProcessInJob`, contabilidade) | sim, `1,1,0` | sim, `1,1,0` |
| `ResumeThread` | 1 | 1 |
| Espera | `WAIT_OBJECT_0` | `WAIT_OBJECT_0` |
| Código bruto do alvo | `0xC0000142` (`STATUS_DLL_INIT_FAILED`) | **`0x00000000`** |
| Código do launcher | 28 | **0** |
| Saída pelo pipe | nenhuma | `gerpro-synthetic scenario=exit-ok` |
| J depois da espera / da saída | `0,1,0` / `0,1,0` | `0,1,0` / `0,1,0` |
| Encerrados por limite | 0 | 0 |
| Mensagens de J | `NEW_PROCESS`, `EXIT_PROCESS` (alvo), `ACTIVE_PROCESS_ZERO` | iguais |
| Encerramentos pelo launcher | 0 | 0 |
| Supervisor | 6 | 0 |

### 12.3 Hipóteses

- **Causa da falha do T-H1: CONFIRMADA.** É o console novo criado por
  `CREATE_NO_WINDOW`. A única diferença entre os dois binários é a forma
  de criação do alvo. Com ela trocada, o mesmo alvo, no mesmo job, com os
  mesmos limites e a mesma política de filhos, inicializa e termina
  normalmente.
- **H-C1** (um `conhost.exe` entra em J e excede o limite): **REFUTADA**.
  Nas duas execuções, J contou um único processo e nenhum encerrado.
- **H-C2** (a política de filhos impede a criação do console) e **H-C3** (o
  limite recusa a criação antes de qualquer contagem): **ABERTAS**. As duas
  continuam compatíveis com os dados. A correção funciona para as duas,
  porque elimina a criação do console. Separar as duas exigiria afrouxar
  uma das defesas numa variante própria, o que não é necessário para a
  correção.
- **H-F5** (o arquivo travado só com `FILE_SHARE_READ` não impede
  `CreateProcessW`): **CONFIRMADA**, agora com a execução completa.
- **Associação a J antes da retomada:** **confirmada**, com o alvo de
  fato executando depois. Comunicação por pipe herdado: **confirmada**.
- **Ainda não demonstrado:** contenção de descendentes (T-R2, T-R4),
  memória (T-M1), Electron (T-R1), prazo e encerramento (Grupo B).

### 12.4 Recomendação (não aplicada)

Aplicar `DETACHED_PROCESS` no lugar de `CREATE_NO_WINDOW` no launcher de
produção. É a mesma linha já validada na variante diagnóstica; o resto da
sequência não muda. O alvo não usa console: escreve só no identificador de
saída recebido em `STARTUPINFO`.

Consequências:

- novo SHA-256 do launcher de produção;
- novo build da variante de testes, com novo SHA-256 aprovado para o
  supervisor;
- atualização dos testes estáticos, que hoje exigem `CREATE_NO_WINDOW`;
- repetição do Grupo A completo antes de qualquer outro passo.

Antes de usar o auxiliar DXCore real, conferir que ele não depende de um
console: deve escrever só pela saída padrão e não usar `GetConsoleWindow`,
`AllocConsole` nem `printf` sem a saída redirecionada. Tudo isso exige nova
autorização.

## 13. Correção aplicada: `DETACHED_PROCESS` (6C.6C.2E)

### 13.1 Mudança

Em `native/helper-host/src/main.cpp`, a única chamada a `CreateProcessW`
passou a usar `CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT`, no lugar de
`CREATE_NO_WINDOW`. A mesma linha vale para a produção, a variante de testes
e a variante diagnóstica. O bloco `GERPRO_HOST_DIAG_DETACHED` e a variante
`nowindow` foram retirados: não há mais duas formas de criação.

Não mudaram:

- J (`KILL_ON_JOB_CLOSE`, `ACTIVE_PROCESS=1`, `DIE_ON_UNHANDLED_EXCEPTION`),
  `PROC_THREAD_ATTRIBUTE_JOB_LIST`, política de filhos e `HANDLE_LIST` só com
  a saída;
- conferência de integridade, identidade do arquivo, novo hash depois da
  criação e conferências antes de `ResumeThread`;
- protocolo, argumentos e códigos de saída 20–29;
- os 7 alvos sintéticos (o `CREATE_NO_WINDOW` em
  `test-artifacts/synthetic_helper.cpp` é o dos filhos que o próprio alvo
  tenta criar, não o caminho do launcher).

### 13.2 Novos binários

Dois builds limpos, idênticos byte a byte (`/Brepro`, MSVC 14.44.35207, SDK
10.0.26100.0, `/W4 /WX` sem avisos). Nada foi executado além dos testes de
lógica pura (`protocol_tests*.exe`).

| Artefato | Tamanho | SHA-256 |
| --- | --- | --- |
| `gerpro-helper-host.exe` (produção) | 114.688 | `101c3b4a52fd911a5b6bc31aa55a1fd7455b9accccfa28ef1dfe885ff17a9bc7` |
| `gerpro-helper-host-test.exe` | 115.200 | `4b7f9c7f5ddf21049276b0b9333cce9aaf95857dc8968698e1372adcb90e2e26` |
| `diag/detached/gerpro-helper-host-test.exe` | 128.000 | `16acca858157e94e8032e31d98eecda1a253b90d998a68f845f79c75853bdac3` (o mesmo executado na 6C.6C.2D) |

Hashes anteriores, agora recusados: produção `9c8f4a36…20da0c`, testes
`94507dc4…58d1eb`, `diag/nowindow` `8faa7b81…784c1`.

- `APPROVED_ARTIFACTS.launcher` (supervisor de testes) passou para
  `4b7f9c7f…2e26`. Os hashes dos alvos sintéticos não mudaram.
- `DXCORE_HOST_SHA256` e `DXCORE_HELPER_SHA256` continuam `null`; o detector
  continua desativado.
- PE: x64, `0xC160`, CFG, CET, só `KERNEL32.dll` e `bcrypt.dll`, a mesma
  lista de 105 funções; nenhuma função de console nova.

### 13.3 Auxiliar DXCore (inspeção estática, sem execução)

`gerpro-dxcore-helper.exe` (SHA-256 `d2e3aabc…84b13b`, subsistema console):

- o código só usa `GetStdHandle(STD_OUTPUT_HANDLE)`, exige
  `GetFileType == FILE_TYPE_PIPE` e escreve com `WriteFile`. Não lê a
  entrada padrão, não usa a saída de erro nem `printf`/`iostream`, e não
  chama `GetConsoleWindow`, `AllocConsole` nem `AttachConsole`;
- a única importação de console é `WriteConsoleW`, que vem do CRT estático
  (`/MT`, caminho de relatório de erro fatal) e não é chamada pelo código. O
  alvo sintético, que rodou normalmente com `DETACHED_PROCESS` na 6C.6C.2D,
  importa ainda mais funções de console do mesmo CRT.

Conclusão: nenhuma dependência de console. O comportamento real de
`dxcore.dll` sob J e sob a política de filhos ainda não foi observado.

### 13.4 Próximo passo (não autorizado)

Repetir o Grupo A completo com o launcher de testes `4b7f9c7f…2e26`.

## 14. Reexecução do Grupo A (6C.6C.2F)

Execução única: `node scripts/diagnostics/run-host-containment.mjs --group=A --confirm-host-containment-run`,
com o launcher de testes `4b7f9c7f…2e26` (`DETACHED_PROCESS`).

Antes: integridade média, Windows x64, censo 0, artefatos e hashes
conferidos (`--check-only`), nenhuma pasta `gerpro-6c6c-*` nem trava,
`DXCORE_HOST_SHA256` e `DXCORE_HELPER_SHA256` nulos.

**Resultado: supervisor 0; 16 casos aprovados, 1 pulado, nenhum reprovado.**

| Caso | Resultado | Código | Tempo |
| --- | --- | --- | --- |
| T-E1.extra-arg | aprovado | 20 | 165 ms |
| T-E1.uppercase-hash | aprovado | 20 | 60 ms |
| T-E1.protocol-2 | aprovado | 20 | 64 ms |
| T-E1.stdout-not-pipe | aprovado | 21 | 55 ms |
| T-E1.wrong-folder | aprovado | 23 | 159 ms |
| T-E1.renamed-launcher | aprovado | 23 | 154 ms |
| T-E1.helper-missing | aprovado | 23 | 148 ms |
| T-E1.helper-tiny | aprovado | 23 | 164 ms |
| T-E1.helper-symlink | pulado (sem permissão para link simbólico) | — | — |
| T-E1.other-scenario-hash | aprovado | 24 | 172 ms |
| T-E1.modified-helper | aprovado | 24 | 215 ms |
| T-H1.exit-ok | aprovado (H-F5 confirmada) | 0 | 284 ms |
| T-H1.exit-contract | aprovado | 12 | 352 ms |
| T-H1.exit-out-of-contract | aprovado | 28 | 374 ms |
| T-R2.spawn-child (cobre T-R4) | aprovado | 0 | 280 ms |
| T-M1.memory | aprovado | 0 | 356 ms |
| T-R1.electron-job | aprovado | 0 | 1102 ms |

- **T-R2/T-R4:** o alvo, dentro de J, teve recusados o descendente comum e o
  com `CREATE_BREAKAWAY_FROM_JOB` (`denied,error=N` nos dois).
- **T-M1:** alvo em job, 64 MiB comprometidos, pico do job ≥ pico do
  processo ≥ alocação. O limite de memória continua nulo: o caso mede, não
  limita.
- **T-R1 (Electron 45.0.0):** pelo launcher, o job imediato do alvo é J
  (`limit-flags=0x2408`, limite 1, um único processo). Direto, o alvo está
  no job da libuv (`limit-flags=0x3c00`, que permite *breakaway*). Censo do
  Electron depois do caso: 0.
- Censo final 0 (também por censo independente), pasta exclusiva removida,
  trava liberada, nenhum processo encerrado por nome ou pelo supervisor.

Ainda não demonstrados: Grupo B (prazo e encerramento por fechamento do job
com o alvo travado, `hang`), T-E1.helper-symlink, limite de memória efetivo,
e o auxiliar DXCore real sob J.

## 15. Encerramento pelo supervisor: T-K1.hang (6C.6C.3A)

### 15.1 Filtro restrito

- `--terminate=T-K1.hang` com `--confirm-host-containment-run` (executa) ou
  `--check-only` (só confere), sem nenhum outro argumento. Qualquer outro
  valor, lista, curinga, executável, `--group`, `--only` ou `--diagnose` é
  recusado. O Grupo A e o diagnóstico não aceitam o `hang` nem `T-K1`.
- Artefatos conferidos: só o launcher de testes `4b7f9c7f…2e26`, o alvo
  `hang` `d88431fb…5461` e o manifesto.
- Roteiro (`runTermination`): mesmas pré-condições, trava, pasta exclusiva e
  censos do Grupo A.
  1. O launcher é iniciado e o supervisor espera a linha
     `gerpro-synthetic scenario=hang state=waiting` (até 1500 ms).
  2. 500 ms depois da linha, o supervisor encerra o launcher que iniciou,
     pelo identificador do processo (`child.kill()`). O prazo interno do
     launcher (2000 ms desde a retomada) ainda não venceu, então o launcher
     não chega a chamar `TerminateJobObject`.
  3. O supervisor registra o resultado do pedido, o `exit` (sinal) e o
     `close`.
  4. Censo logo depois.
- O `close` só chega quando todas as pontas de escrita do pipe fecham,
  inclusive a herdada pelo alvo. Por isso o `close` é a observação direta do
  fim do alvo. Sozinho, o alvo só sairia em 30 s.
- Sem nova tentativa; sobreviventes nunca são encerrados.
- 43 testes automatizados novos (`tests/main/host-termination.test.ts`).

### 15.2 Execução única

Comando:
`node scripts/diagnostics/run-host-containment.mjs --terminate=T-K1.hang --confirm-host-containment-run`.

**Resultado: APROVADO** (supervisor 0, 1319 ms).

| Evento | Instante | Tipo |
| --- | --- | --- |
| launcher iniciado (PID 19084, `4b7f9c7f…`) | 0 ms | observado |
| linha do alvo `state=waiting` | 799 ms | observado |
| encerramento do launcher pedido, pelo identificador (aceito) | 1314 ms (515 ms depois da linha; prazo 500 ms) | pedido |
| `exit` do launcher: sinal `SIGTERM`, sem código próprio | 1319 ms | observado |
| `close` (pipe fechado também pelo alvo) | 1319 ms | observado |
| censo logo depois | 0 | observado |
| censo final e censo independente | 0 e 0 | observado |

- Pasta exclusiva removida e trava liberada.
- Nenhum processo encerrado por nome.

### 15.3 Conclusão

Encerrar o launcher fecha o último identificador de J, e
`KILL_ON_JOB_CLOSE` encerra o alvo em menos de 5 ms. A associação a J é
garantida pelo launcher, que só retoma o alvo depois de `IsProcessInJob`;
nesta execução, o alvo não informou o job.

Ainda não demonstrados:

- **T-T1:** prazo interno do launcher, código 27;
- **T-K2:** Electron encerrado no meio;
- **T-K3:** cancelamento aleatório;
- **T-F1…T-F4**;
- repetições (o roteiro do Grupo B prevê 10 execuções do T-K1).

## 16. Prazo interno do launcher: T-T1.hang (6C.6C.3B)

### 16.1 Filtro restrito

- `--launcher-timeout=T-T1.hang` com `--confirm-host-containment-run` ou
  `--check-only`, sem nenhum outro argumento. Recusa outros casos, cenários,
  listas, curingas, `--group`, `--only`, `--diagnose` e `--terminate`. Os
  outros modos não aceitam `T-T1`.
- Mesmo roteiro do T-K1 (pré-condições, trava, pasta exclusiva, conferência
  só do launcher de testes, do alvo `hang` e do manifesto, censos), mas
  **sem intervenção**: o supervisor só espera o launcher sair sozinho.
- **Prazo externo:** 5000 ms desde o início, o mesmo de todos os casos do
  launcher no Grupo A, sem aumento. O pior caso do launcher é 4500 ms:
  linha em até 1500 ms, mais 2000 ms de espera, mais 2 × 500 ms de
  confirmação. Só se o prazo externo vencer o supervisor encerra o launcher
  pelo identificador, e o caso reprova.
- **Aprovação:**
  - alvo anunciado;
  - nenhuma intervenção;
  - código 27 (29 reprova: fim não confirmado);
  - `exit` entre 1500 e 3000 ms depois da linha;
  - `close` até 2 s depois do `exit`;
  - censo logo depois 0.
- 40 testes automatizados novos (`tests/main/host-launcher-timeout.test.ts`).

### 16.2 Execução única

Comando:
`node scripts/diagnostics/run-host-containment.mjs --launcher-timeout=T-T1.hang --confirm-host-containment-run`.

**Resultado: APROVADO** (supervisor 0, 2267 ms).

| Evento | Instante | Tipo |
| --- | --- | --- |
| launcher iniciado (PID 27780, `4b7f9c7f…`) | 0 ms | observado |
| linha do alvo `state=waiting` | 255 ms | observado |
| prazo interno do launcher (2000 ms) vencido, `TerminateJobObject(J, 27)` | — | pedido pelo launcher (deduzido do código 27) |
| fim do alvo confirmado pelo launcher (identificador do processo, até 500 ms) | — | confirmado pelo launcher (código 27) |
| `exit` do launcher, código 27, sem sinal | 2266 ms (2011 ms depois da linha) | observado |
| `close` (pipe fechado também pelo alvo) | 2266 ms (0 ms depois do `exit`) | observado |
| encerramento pelo supervisor | nenhum | — |
| censo logo depois, final e independente | 0, 0 e 0 | observado |

- Pasta exclusiva removida e trava liberada.

### 16.3 Conclusão e limites

O prazo interno funciona: o launcher detecta o fim do prazo, encerra o
alvo, confirma o fim e devolve 27, sem nenhum sobrevivente. Diferença para
o T-K1: aqui o encerramento é feito pelo próprio launcher e confirmado
**antes** de ele sair (o `close` chega junto com o `exit`). No T-K1, o
launcher foi encerrado de fora e o alvo caiu pelo `KILL_ON_JOB_CLOSE`.

Limite da evidência: o launcher de testes só informa o código. O 27 prova
que o fim do alvo foi confirmado, mas não diz se `TerminateJobObject`
funcionou ou se o recurso a `TerminateProcess` foi usado. Separar os dois
exige uma variante diagnóstica que aceite o alvo `hang` (novo build e
autorização). A variante atual só aceita o `exit-ok`.

Pendentes: as 10 repetições do T-T1 e do T-K1, T-K2, T-K3, T-F1…T-F4.

## 17. Repetibilidade: T-K1.hang e T-T1.hang (6C.6C.3C)

### 17.1 Modo restrito de repetição

- `--repeat=<lista> --times=<n>` com `--confirm-host-containment-run` ou
  `--check-only`, sem nenhum outro argumento.
  - A lista aceita só `T-K1.hang` e `T-T1.hang`, sem duplicatas.
  - `n` vai de 1 a 10, sem zero à esquerda.
  - Os outros modos não aceitam `--repeat` nem `--times`.
- Execução sequencial (nunca dois launchers ao mesmo tempo): todos os T-K1,
  depois todos os T-T1.
- Cada execução usa o MESMO roteiro e os MESMOS critérios da execução
  isolada (seções 15 e 16).
- Antes de cada execução:
  - nenhuma pasta `gerpro-6c6c-*` residual;
  - depois, o roteiro confere de novo o censo 0, a trava livre e a
    identidade e integridade dos artefatos.
- O lote para na primeira falha, sem nova tentativa.
- 33 testes automatizados novos (`tests/main/host-repeat.test.ts`). O teste
  que proibia `repeat` no supervisor passou a aceitar só os nomes do modo
  restrito; nova tentativa continua proibida.

### 17.2 Execução do lote (uma vez)

Comando:
`node scripts/diagnostics/run-host-containment.mjs --repeat=T-K1.hang,T-T1.hang --times=10 --confirm-host-containment-run`.

**Resultado: 20/20 aprovadas** (supervisor 0, nenhuma interrupção).

| nº | caso | linha (ms) | fim (ms) | código | intervenção do supervisor | censo depois | limpeza |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | T-K1 | 256 | 774 | SIGTERM | prevista (770 ms) | 0 | completa |
| 2 | T-K1 | 339 | 859 | SIGTERM | prevista (852 ms) | 0 | completa |
| 3 | T-K1 | 358 | 872 | SIGTERM | prevista (864 ms) | 0 | completa |
| 4 | T-K1 | 337 | 860 | SIGTERM | prevista (854 ms) | 0 | completa |
| 5 | T-K1 | 321 | 843 | SIGTERM | prevista (835 ms) | 0 | completa |
| 6 | T-K1 | 328 | 841 | SIGTERM | prevista (832 ms) | 0 | completa |
| 7 | T-K1 | 351 | 871 | SIGTERM | prevista (864 ms) | 0 | completa |
| 8 | T-K1 | 290 | 800 | SIGTERM | prevista (793 ms) | 0 | completa |
| 9 | T-K1 | 875 | 1382 | SIGTERM | prevista (1375 ms) | 0 | completa |
| 10 | T-K1 | 890 | 1399 | SIGTERM | prevista (1392 ms) | 0 | completa |
| 11 | T-T1 | 845 | 2846 | 27 | não | 0 | completa |
| 12 | T-T1 | 784 | 2794 | 27 | não | 0 | completa |
| 13 | T-T1 | 320 | 2331 | 27 | não | 0 | completa |
| 14 | T-T1 | 343 | 2359 | 27 | não | 0 | completa |
| 15 | T-T1 | 350 | 2344 | 27 | não | 0 | completa |
| 16 | T-T1 | 284 | 2298 | 27 | não | 0 | completa |
| 17 | T-T1 | 353 | 2361 | 27 | não | 0 | completa |
| 18 | T-T1 | 367 | 2376 | 27 | não | 0 | completa |
| 19 | T-T1 | 378 | 2405 | 27 | não | 0 | completa |
| 20 | T-T1 | 338 | 2356 | 27 | não | 0 | completa |

"Fim" é o `close` no T-K1 e o `exit` no T-T1. No T-T1, o `close` chegou
junto com o `exit`.

| Medida | mín | máx | média |
| --- | --- | --- | --- |
| T-K1: linha do alvo | 256 | 890 | 435 ms |
| T-K1: pedido → `close` (fim do alvo) | 4 | 9 | 7 ms |
| T-T1: linha do alvo | 284 | 845 | 436 ms |
| T-T1: linha → `exit` 27 | 1994 | 2027 | 2011 ms |
| T-T1: `exit` desde o início | 2298 | 2846 | 2447 ms |

- Censo final de cada execução: 0 (20 vezes).
- Censo final do lote: 0. Censos independentes depois do lote: 0 e 0.
- Nenhuma pasta exclusiva ou trava residual.

### 17.3 Observações

- O tempo até a linha do alvo variou de 256 a 890 ms. Os casos mais lentos
  vieram em sequência (9–12). O limite de 1500 ms nunca foi atingido, mas a
  folga mínima foi de cerca de 600 ms.
- O T-T1 mostrou o prazo interno estável: 2011 ± 17 ms da linha ao `exit`.
- O limite da seção 16.3 continua: o código 27 não distingue
  `TerminateJobObject` do recurso a `TerminateProcess`.

## 18. Revisão estática de T-F1 a T-F4 (6C.6C.3D)

Só inspeção de código e documentos; nada foi implementado nem executado.

### 18.1 Fatos do código que mudam o desenho da seção 4

- **Aberturas do launcher** (`native/helper-host/src/main.cpp`):
  - auxiliar (passo 6, `LockHelperFile`): `GENERIC_READ`, só
    `FILE_SHARE_READ`, `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN`;
  - pastas `host-test` e `win32-x64` (passo 5, `LockDirectory`):
    `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE`,
    `FILE_SHARE_READ | FILE_SHARE_WRITE` (sem `FILE_SHARE_DELETE`),
    `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`.
- **As travas acabam antes da retomada.** O passo 13 fecha os três
  identificadores **antes** do `ResumeThread`. Enquanto o alvo roda, a
  única proteção do arquivo é a seção de imagem. Por isso:
  - o T-F3 isola exatamente o H-F3, sem a trava do launcher;
  - o T-F1 e o T-F4 não podem ser observados com o alvo rodando (a janela
    travada dura milissegundos, seção 9.4).
- **O Node não reproduz as aberturas.** Ele (libuv) abre arquivos sempre
  com `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, não cria
  mapeamento de arquivo e não abre identificador de pasta. O Node serve para
  as **tentativas** (abrir para escrita, renomear, apagar), não para
  **segurar** as travas. Só o T-F3 dispensa um processo que segure algo.
- **PowerShell sem `Add-Type`** (.NET Framework) reproduz o T-F1
  (`[IO.File]::Open(…, Read, FileShare.Read)` = `GENERIC_READ` com só
  `FILE_SHARE_READ`) e o T-F2 (`MemoryMappedFile.CreateFromFile` com
  `leaveOpen` e o arquivo fechado em seguida). Mas não abre pastas como o
  launcher; para isso seria preciso o `Add-Type`, que compila código e grava
  arquivos fora da pasta exclusiva. **Não recomendado.**
- **T-F2: o arquivo do mapeamento precisa estar fechado.** Se o processo que
  segura o mapeamento mantiver o arquivo aberto para escrita, o launcher
  falha já no passo 6 (violação de compartilhamento → 23) e nunca chega à
  criação da seção. Para testar o H-F2, quem segura o mapeamento fecha o
  arquivo e mantém só a seção e uma vista gravável, **sem escrever nada**.

### 18.2 Matriz

| | T-F1 | T-F2 | T-F3 | T-F4 |
| --- | --- | --- | --- | --- |
| Hipótese | H-F1: arquivo aberto sem `FILE_SHARE_WRITE`/`DELETE` impede escrita, renomeação e exclusão | H-F2: criação da seção de imagem falha com mapeamento gravável | H-F3: com a seção de imagem existente, abrir para escrita falha | H-F4: pasta aberta sem `FILE_SHARE_DELETE` não pode ser renomeada nem apagada |
| Falha provocada | tentativas de escrita, renomeação e exclusão contra o arquivo travado | `CreateProcessW` com mapeamento gravável vivo | tentativa de abrir o executável em uso para escrita | tentativas de renomear `host-test` e `win32-x64` |
| Launcher envolvido | não (reprodução) | sim (alvo `exit-ok`) | sim (alvo `hang`, como no T-T1) | não (reprodução) |
| Quem segura a trava | processo auxiliar de teste | processo auxiliar de teste | o próprio sistema (imagem em execução) | processo auxiliar de teste |
| Quem tenta | Node | — (o launcher) | Node | Node |
| Arquivos | cópia do `exit-ok` na pasta do caso | cópias do launcher de testes e do `exit-ok` | cópias do launcher de testes e do `hang` | pastas do caso |
| Alteração temporária | nenhuma no conteúdo; renomeação ou exclusão só se a hipótese falhar, dentro da pasta exclusiva | mapeamento gravável, sem escrita | nenhuma: a abertura é fechada na hora, sem escrever | renomeação só se a hipótese falhar, dentro da pasta exclusiva |
| Privilégio de administrador | não | não | não | não |
| Código esperado | — | **25** (`CreateProcessW` recusado); 23 indica desenho errado (arquivo aberto); **0 refuta o H-F2** | **27** (como no T-T1) | — |
| Evidência | resultado de cada tentativa e código do Windows (`EBUSY`/`EPERM`, isto é, 32 ou 5) | código do launcher, saída vazia, censo | resultado da tentativa (`EBUSY` esperado), código 27, saída do T-T1 | resultado de cada renomeação e código do Windows |
| Aprovação | as 3 tentativas recusadas | 25 e nenhuma linha do alvo | escrita recusada, 27, sem intervenção, censo 0 | as 2 renomeações recusadas |
| Interrupção | trava não obtida; censo > 0; processo auxiliar sem fim confirmado | código 0 com conteúdo diferente (não deve ocorrer: nada é escrito); censo > 0 | escrita **permitida** (não escrever; parar); código ≠ 27; censo > 0 | trava não obtida; censo > 0 |
| Limpeza | fechar a trava (fim do processo auxiliar) e remover a pasta exclusiva | fechar a vista e o mapeamento, depois remover a pasta | igual ao T-T1 | fechar as pastas, depois remover a pasta exclusiva |
| Resíduos possíveis | processo auxiliar vivo (prazo próprio + encerramento pelo identificador); arquivo renomeado só dentro da pasta exclusiva | processo auxiliar vivo; se o H-F2 falhar, o `exit-ok` roda e sai sozinho | os mesmos do T-T1 (nenhum em 21 execuções) | processo auxiliar vivo; pasta renomeada só dentro da pasta exclusiva |
| Risco | baixo | médio (resultado incerto; envolve o launcher) | **muito baixo** | baixo |

H-F1 e H-F4, quando testados assim, confirmam a semântica do Windows com as
mesmas aberturas, não o launcher em si. Testar a janela real exigiria a
variante com pausa da seção 9.4.

### 18.3 Proposta de supervisor (não implementada)

- **Reaproveitável sem mudança:**
  - pré-condições, trava, pasta exclusiva e `prepareCase`;
  - censos e limpeza (D55);
  - `validateArtifacts` (`hang`, `exit-ok`);
  - o padrão de filtro restrito.
- **T-F3:** uma terceira estratégia no roteiro do alvo `hang`
  (`runHangCase`), com filtro `--file-lock=T-F3.hang`.
  1. Depois da linha `state=waiting`, uma única `fs.openSync(alvo, 'r+')`.
  2. Se a abertura falhar, registrar o código.
  3. Se der certo, fechar na hora, sem escrever, e reprovar.
  4. Em seguida, os mesmos critérios do T-T1 (27, sem intervenção).
  - Nenhum artefato novo.
- **T-F1, T-F2 e T-F4:** um processo que segure as travas.
  - **Recomendado:** um terceiro binário só de teste,
    `gerpro-lock-holder-test.exe` (C++, mesmas regras de build, `/Brepro`,
    hash aprovado, PE com lista explícita).
    - Uma ação fixa por argumento: segurar o arquivo (mesmas flags do passo
      6), segurar as duas pastas (mesmas flags do passo 5) ou segurar um
      mapeamento gravável com o arquivo já fechado.
    - Só aceita caminhos dentro de uma pasta `gerpro-6c6c-*` e com os nomes
      esperados.
    - Escreve `held` quando a trava existe e solta tudo quando a entrada
      fecha ou quando vence um prazo próprio curto (por exemplo, 10 s).
    - Entra no censo.
  - **Alternativa** só para T-F1 e T-F2: PowerShell do sistema, com script
    fixo e sem `Add-Type`. Não cobre o T-F4.
  - Filtro: `--file-lock=T-F1|T-F2|T-F4`, um caso por vez, com confirmação
    explícita, sem repetição.
  - O processo que segura a trava é iniciado e, se preciso, encerrado só
    pelo identificador do supervisor.
- **Censo:** acrescentar a imagem do processo que segura as travas a
  `CENSUS_IMAGES`.
- **Limpeza:** conferir em teste que a remoção pela D55 cobre entradas
  renomeadas dentro da pasta exclusiva.

### 18.4 Ordem e autorizações

1. **T-F3**: autorização isolada. Usa só o que já existe e é o de menor
   risco.
2. **Construção do `gerpro-lock-holder-test.exe`**: autorização própria,
   sem execução, como na 6C.6C.1.
3. **T-F1 e T-F4**: podem ser **agrupados**. Ambos são só reproduções, sem
   o launcher, com o mesmo processo auxiliar.
4. **T-F2**: autorização isolada. Envolve o launcher, um mapeamento
   gravável e o resultado mais incerto.

## 19. Trava pela imagem em execução: T-F3.hang (6C.6C.3E)

### 19.1 Suporte

- **Filtro:** `--file-lock=T-F3.hang` com `--confirm-host-containment-run`
  ou `--check-only`, sem nenhum outro argumento. Recusa T-F1, T-F2, T-F4,
  listas, curingas, caminhos e combinações com os outros modos.
- **Roteiro:** o do T-T1 (`runHangCase`, terceira estratégia), sem
  executável novo. Logo depois da linha do alvo, com o launcher ainda
  ativo, o supervisor:
  1. confere o caminho sem abri-lo para escrita (existe, arquivo comum,
     tamanho aprovado, sem atributo somente leitura, dentro da pasta
     exclusiva);
  2. calcula o SHA-256;
  3. faz **uma** abertura para escrita;
  4. recalcula o SHA-256.

  Depois, os critérios do T-T1 sem mudança, e um terceiro SHA-256 depois
  do fim do launcher.
- **Abertura:** `fs.openSync(caminho, 'r+')`, isto é, libuv `CreateFileW`
  com `GENERIC_READ | GENERIC_WRITE`, `FILE_SHARE_READ | FILE_SHARE_WRITE |
  FILE_SHARE_DELETE` e `OPEN_EXISTING`.
  - Qualquer identificador obtido é fechado num `finally`, sem escrita.
  - A função só aceita a cópia do alvo sintético dentro de uma pasta
    `gerpro-6c6c-*`.
  - Não há escrita, truncamento, renomeação nem exclusão; isso é conferido
    por teste.
- **Aprovação:** recusa com `EBUSY`. `EPERM`, `EACCES` ou `ENOENT` não
  confirmam o H-F3.
- 52 testes automatizados novos (`tests/main/host-file-lock.test.ts`).

### 19.2 Execução única

Comando:
`node scripts/diagnostics/run-host-containment.mjs --file-lock=T-F3.hang --confirm-host-containment-run`.

**Resultado: APROVADO** (supervisor 0, 2227 ms).

| Evento | Instante | Tipo |
| --- | --- | --- |
| launcher iniciado (PID 16100, `4b7f9c7f…`) | 0 ms | observado |
| linha do alvo `state=waiting` | 221 ms | observado |
| conferência do caminho: arquivo comum, 106.496 bytes, sem somente leitura, na pasta exclusiva | antes da tentativa | observado |
| abertura para escrita | 222 ms, com o launcher ativo | tentativa |
| resultado | **recusada: `EBUSY`** (errno libuv −4082) | observado |
| SHA-256 antes, logo depois e no fim | `d88431fb…5461` nos três | observado |
| `exit` do launcher, código 27, sem intervenção | 2227 ms (2006 ms depois da linha) | observado |
| `close` | 2227 ms | observado |
| censo logo depois, final e independente | 0, 0 e 0 | observado |

- Pasta exclusiva removida e trava liberada.
- O artefato de origem continua com o SHA-256 aprovado.

### 19.3 Conclusão e limites

**H-F3 confirmada nesta execução.** Com o alvo em execução e sem nenhuma
trava do launcher (fechada no passo 13), a abertura para escrita foi
recusada por violação de compartilhamento, e o arquivo ficou intacto.

Limites:

- O libuv traduz para `EBUSY` tanto `ERROR_SHARING_VIOLATION` (32) quanto
  `ERROR_LOCK_VIOLATION` (33). O código exato do Windows não aparece no
  Node. O 33 se refere a travas de intervalo de bytes, que ninguém cria
  aqui, e não a aberturas.
- Ficou provado só o caso **depois** da retomada. O H-F3 no passo 12, com
  o processo suspenso e a imagem já mapeada, não é observável sem a
  variante com pausa (seção 9.4). Pelo mesmo mecanismo, espera-se o mesmo
  resultado.
- Só a abertura para escrita foi testada. Renomear um executável em uso
  costuma ser permitido no Windows e não foi tentado: depois do mapeamento,
  isso não afeta o conteúdo executado.
- Uma execução; NTFS em volume local.

## 20. Segurador de travas só de teste: gerpro-lock-holder-test.exe (6C.6C.3F)

Construído sem execução. Fontes em `native/lock-holder-test/` (README com o
protocolo e os códigos), build em `scripts/native/build-lock-holder-test.mjs`,
política do PE em `checkLockHolderBinary` (`scripts/native/pe-inspect.ts`) e
27 testes estáticos em `tests/main/lock-holder-sources.test.ts`.

### 20.1 Desenho

- Linha de comando fixa: `--mode=<file|mapping|directory> --case-dir=<pasta>`.
  A pasta é `<temp do sistema>\gerpro-6c6c-<sufixo>\<NN>-T-F<n>.<id>`, com o
  número amarrado ao modo (1, 2, 4). Os alvos são derivados com nomes fixos
  (`host-test`, `win32-x64`, `gerpro-synthetic-helper.exe`).
- `file` e `directory` repetem, texto a texto, as aberturas dos passos 6 e 5
  do launcher (conferido por teste contra `main.cpp` do launcher).
- `mapping`: arquivo aberto com `GENERIC_READ | GENERIC_WRITE` e só
  `FILE_SHARE_READ`, seção `PAGE_READWRITE` do tamanho do arquivo, arquivo
  **fechado** logo depois da seção, e uma vista `FILE_MAP_WRITE` nunca
  acessada (a classe da vista não expõe o endereço).
- Caminhos: forma pura (unidade local, sem `\?\`, rede, `/`, `:` extra,
  curingas, `~`, `.`, `..`), base = pasta temporária do sistema resolvida
  pelo próprio sistema de arquivos, exatamente dois níveis acima do caso;
  cada componente abaixo da base aberto com `FILE_FLAG_OPEN_REPARSE_POINT`,
  sem atributo de ponto de nova análise, do tipo certo e com caminho final
  igual ao pedido; o arquivo com tamanho na faixa do launcher e **um só
  nome** (recusa hard link para arquivo de fora).
- Supervisão: entrada padrão tem de ser pipe; prontidão
  `gerpro-lock-holder-test v=1 ready …` com volume e índice (iguais a `dev`
  e `ino` do Node); liberação pela entrada fechada ou por um byte; prazo
  próprio fixo de 10 s desde o início; travas soltas antes de qualquer sinal
  de liberação e de qualquer saída. Códigos 0 e 40–46.

### 20.2 Build

| Item | Valor |
| --- | --- |
| Arquivo | `native/lock-holder-test/build/x64/gerpro-lock-holder-test.exe` |
| Tamanho | 114.176 bytes |
| SHA-256 | `74a99a07290c9850b13de7cb10a35893fe8e53755a59b91f4a15ac6db5e359e0` |
| Reprodutibilidade | 2 builds limpos (`x64`, `x64-repro`) idênticos byte a byte |
| Ferramentas | MSVC 14.44.35207, Windows SDK 10.0.26100.0 |
| Avisos | nenhum (`/W4 /WX`) |
| PE | x64, console, DllCharacteristics `0xc160` (ASLR alta entropia, NX, CFG), GuardFlags `0x10017500`, CET, DependentLoadFlags `0x800`, manifesto `asInvoker`, `supportedOS` Windows 10/11 |
| Importações | só `KERNEL32.dll`, 89 funções: 20 do código e 69 do CRT estático (o mesmo conjunto aceito no alvo sintético) |

Os 30 binários nativos já existentes (`resources/helpers`,
`native/helper-host/build`, `native/dxcore-helper/build`) ficaram com os
mesmos resumos.

### 20.3 Limites

- Não executado: nada aqui prova que as travas se comportam como descrito.
- A base vem de `GetTempPathW` (`TMP` antes de `TEMP`); o Node usa `TEMP`
  antes de `TMP`. Se as duas variáveis divergirem, o segurador recusa (42),
  sem risco, mas o cenário não roda.
- Um nome de usuário com `~` na pasta temporária faz o segurador recusar.
- A identidade comprova o objeto aberto, não o conteúdo; o supervisor deve
  conferir o SHA-256 da cópia antes e depois.

## 21. Integração estática do segurador ao supervisor (6C.6C.3G)

Só código, testes e `--check-only`. O `gerpro-lock-holder-test.exe` **não
foi executado**; T-F1, T-F2 e T-F4 não foram executados.

### 21.1 Revisão de segurança do fonte nativo

Sem falha real no `native/lock-holder-test/src/main.cpp`: o binário aprovado
(`74a99a07…e359e0`, 114.176 bytes) fica **inalterado**, sem novo build.

| Ponto | Resultado |
| --- | --- |
| Contagem de hard links | Conferida: `ReadIdentity(handle, true, …)` recusa `nNumberOfLinks != 1`, no próprio identificador aberto, em `CheckTargetFile` (modos `file` e `mapping`). Pastas não têm hard links no NTFS |
| Objeto aberto = objeto validado | Sim, para tudo o que é segurado: cada conferência (atributos, caminho final, tipo, tamanho, identidade) é feita **no identificador já aberto** (`LockFile`, `LockDirectory`, `HoldMapping` → `CreateFileMappingW(file.get())`). A prontidão anuncia o volume e o índice desse mesmo identificador |
| Janela entre validação e abertura | Só nas pastas intermediárias (pasta exclusiva e do caso), inspecionadas e fechadas antes. Uma troca nessa janela por junção muda o caminho final normalizado do objeto travado, e `SameObject` recusa (42). Depois da prontidão, renomear uma pasta mãe não troca o objeto segurado; o segurador nunca escreve |
| Junções, links, pontos de nova análise | Recusados: todo componente abaixo da base é aberto com `FILE_FLAG_OPEN_REPARSE_POINT` e recusado com `FILE_ATTRIBUTE_REPARSE_POINT`; um ponto de montagem também é ponto de nova análise. Só a pasta temporária (a base) é seguida, de propósito, e usada já resolvida |
| Identidade por volume e índice | Correta no nativo (`dwVolumeSerialNumber`, 32 bits; `nFileIndexHigh:Low`, 64 bits). **Exigência no supervisor:** comparar com `lstat` **bigint**. Um `Number` perde precisão acima de 2^53, e os índices NTFS levam o número de sequência nos 16 bits altos. Do `dev`, só os 32 bits baixos são comparados |
| `TMP` e `TEMP` divergentes | Seguro (fecha): base diferente da pedida → 42, sem tocar em nada. **Exigência no supervisor:** com só `SystemRoot`/`windir` no ambiente, `GetTempPathW` cairia em `C:\Windows`, e o caso nunca rodaria. O supervisor passa `TMP` = `TEMP` = a pasta temporária que ele resolveu (`lockHolderEnv`) |
| Pasta atual do filho | **Exigência no supervisor:** o processo filho mantém aberta a própria pasta atual, sem `FILE_SHARE_DELETE`. Dentro de `host-test`, isso bastaria para recusar a renomeação no T-F4 e mascararia o resultado. A cópia do segurador e a pasta atual ficam em `<caso>\lock-holder`, fora de `host-test` |

Observação sem correção: no modo `directory`, a prontidão traz um só
volume para as duas pastas. Isso basta, porque `win32-x64` é filha direta
de `host-test` e um ponto de montagem entre elas seria recusado. O
supervisor confere o volume das duas.

### 21.2 Filtro

- `--file-lock=` aceita exatamente **um** de `T-F3.hang` (inalterado),
  `T-F1.exit-ok` ou `T-F4.exit-ok`, com `--confirm-host-containment-run` ou
  `--check-only` e nenhum outro argumento.
- Recusa:
  - T-F2 e outros cenários;
  - grafias diferentes, listas e curingas;
  - dois `--file-lock`, caminhos e executáveis;
  - `--group`, `--only`, `--diagnose`, `--terminate`, `--launcher-timeout`,
    `--repeat` e `--times`.
- Os outros filtros não aceitam T-F1 nem T-F4.

### 21.3 Artefatos e integridade

- `APPROVED_ARTIFACTS.lockHolder = { size: 114176, sha256: 74a99a07… }`.
  Os hashes de produção ficam inalterados (`null`).
- Pré-condições, iguais às dos outros modos (Windows x64, sem elevação,
  censo 0, trava da bateria), mais:
  - build de testes com o `exit-ok`;
  - segurador com tamanho, SHA-256, PE com a lista explícita e identidade
    (`checkLockHolderBinary`);
  - `lock-holder-manifest.json` igual ao aprovado;
  - pasta temporária na forma que o segurador aceita.
- A cópia do segurador na pasta do caso é conferida de novo **logo antes do
  início**. Uma cópia diferente: nada é iniciado.
- `gerpro-lock-holder-test.exe` entra em `CENSUS_IMAGES` (todos os modos).

### 21.4 Roteiro (`runLockHolderCase`)

1. Pasta exclusiva `gerpro-6c6c-*`. Caso em `01-T-F<n>.exit-ok`, com:
   - `host-test\win32-x64\gerpro-synthetic-helper.exe`: cópia do `exit-ok`,
     nunca executada;
   - `lock-holder\gerpro-lock-holder-test.exe`: cópia do segurador.
2. Cópias conferidas pelo hash. A do segurador é conferida de novo.
3. Só o segurador é iniciado:
   - argumentos fixos `--mode=<file|directory> --case-dir=<caso>`;
   - sem shell; entrada, saída e erro em pipe;
   - ambiente `SystemRoot`, `windir`, `TMP`, `TEMP`.
4. Prontidão em até **2 s** (qualquer linha do segurador; tem de ser uma
   prontidão válida do modo do caso).
5. Identidade dos objetos: `lstat` bigint contra a prontidão. Confere tipo,
   ausência de link e um só nome no arquivo.
6. Tentativas, na ordem, **uma vez cada**, cada uma com o segurador ativo:
   - T-F1: abertura `r+`, renomeação para
     `gerpro-synthetic-helper.renamed` e exclusão;
   - T-F4: `host-test` → `host-test-renamed`, depois `win32-x64` →
     `win32-x64-renamed`.
7. Erros registrados (código e errno do libuv).
8. Liberação: a ponta do supervisor da entrada é **fechada**, sem escrever
   nenhum byte.
9. Em até **1 s**: `released reason=stdin`, código 0 e `close`.
10. Censo logo depois = 0; pasta exclusiva removida (D55); trava liberada;
    censo final.

Se uma tentativa **funcionar**:

- o resultado é registrado e o caso reprova (`H-F1/H-F4 REFUTADA`);
- nenhuma outra tentativa é feita;
- só numa renomeação, o objeto movido volta ao nome original, e só se a
  identidade no destino for a do original;
- uma exclusão não tem restauração; a limpeza remove a pasta exclusiva.

Falha depois do início (sem prontidão, liberação fora do prazo): o
supervisor encerra **só o segurador que iniciou**, por `child.kill()`
(identificador do processo), e espera o `close` por até 2 s. Nunca por
nome. Sobreviventes nunca são encerrados (inspeção manual). Não há nova
tentativa nem repetição.

Guardas na entrada (`run-host-containment.mjs`), conferidas antes de cada
operação:

- `holderImageAllowed`: só a cópia na pasta do caso;
- `renameAllowed`: só os pares fixos do caso, nos dois sentidos;
- `unlinkAllowed`: só a cópia do alvo no T-F1;
- `identityAllowed`.

Todas exigem `<temp>\gerpro-6c6c-<sufixo>\01-T-F<1|4>.exit-ok\…`.

### 21.5 Aprovação

| | T-F1.exit-ok | T-F4.exit-ok |
| --- | --- | --- |
| Tentativas | abertura `r+`, renomeação, exclusão | renomeação de `host-test`, de `win32-x64` |
| Esperado | as 3 recusadas com `EBUSY` | as 2 recusadas com `EBUSY` |
| Outra recusa (`EPERM`, `EACCES`…) | registrada; **não confirma** o H-F1 | registrada; **não confirma** o H-F4 |
| Comum | prontidão ≤ 2 s; identidade antes e depois; segurador ativo em todas as tentativas; `released reason=stdin` e 0 em ≤ 1 s, sem encerramento; só 2 linhas na saída; erro vazio; SHA-256 do `exit-ok` igual ao aprovado antes, depois das tentativas e depois da liberação; censo 0 | igual |

### 21.6 Testes e `--check-only`

`tests/main/host-lock-holder.test.ts`: 115 testes. O segurador é simulado e
nenhum processo é iniciado. Cobrem:

- filtros;
- integridade e adulteração da cópia;
- ordem das operações;
- prontidão e identidade (inclusive índice acima de 2^53);
- prazos de prontidão e de liberação;
- tentativas que funcionam, com restauração;
- restauração recusada;
- guardas;
- falha de limpeza, sobreviventes e execução paralela;
- ausência de repetição.

Os testes de execução simulada leem os builds locais e são pulados se eles
faltarem. Os ajustes em testes antigos são intencionais: `--file-lock`
agora devolve `caseId`, e há um `spawn`, um `run.kill()`, um `renameSync`
e um `unlinkSync` a mais.

`--check-only` com `T-F1.exit-ok` e `T-F4.exit-ok`: pré-condições
atendidas, código 0. Nenhum processo iniciado, nenhuma trava ou pasta
criada.

### 21.7 Riscos remanescentes

- O segurador nunca rodou. Duas suposições só a execução confirma:
  - fechar a ponta do supervisor (libuv) faz o `PeekNamedPipe` do filho
    devolver `ERROR_BROKEN_PIPE`. Se não fizer, o resultado é 46
    `wait-failure`: as travas são soltas e o caso reprova;
  - o Node expõe em `dev` e `ino` os mesmos valores do segurador. Se não,
    a identidade reprova (fecha, sem tentativas).
- `EBUSY` cobre `ERROR_SHARING_VIOLATION` e `ERROR_LOCK_VIOLATION`; o
  código exato do Windows não aparece no Node.
- Fora do NTFS (ReFS, com IDs de 128 bits), o índice de 64 bits pode não
  identificar o objeto. A pasta temporária daqui é NTFS local.
- Entre a última conferência da cópia do segurador e o `CreateProcessW`,
  outro processo do mesmo usuário poderia trocá-la. É a mesma janela do
  launcher de testes, sem trava de arquivo possível pelo Node.
- T-F1 e T-F4 confirmam a semântica do Windows com as aberturas do
  launcher, não o launcher em si (seção 18.2).

### 21.8 Recomendação para a primeira execução (não autorizada)

1. Repetir `--check-only` para os dois casos e o censo independente
   (zero processos de teste).
2. `--file-lock=T-F1.exit-ok --confirm-host-containment-run`, uma vez.
   Parar em qualquer reprovação.
3. Só se o T-F1 for aprovado: `--file-lock=T-F4.exit-ok
   --confirm-host-containment-run`, uma vez.
4. Depois de cada execução:
   - conferir que não sobrou pasta `gerpro-6c6c-*` nem a trava;
   - conferir que o SHA-256 dos artefatos de origem não mudou.
