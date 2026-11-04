# Ativação segura do auxiliar DXCore (Etapas 6C.6A a 6C.6C.1)

> **Estado no handoff (H2).** A ativação **não aconteceu**. O auxiliar DXCore e
> o launcher não estão autorizados para produção: `DXCORE_HELPER_SHA256`,
> `DXCORE_HOST_SHA256` e `DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES` continuam `null`,
> e o app usa `UnimplementedLocalDetector`. A seção 19 está superada pelos
> testes de contenção posteriores ([docs/11](11-testes-contencao.md), seções
> 10 a 21). Este documento serve a quem retomar a linha de hardware; os
> critérios para ativar estão na seção 7. Visão geral:
> [Guia de transferência](12-guia-de-transferencia.md).

**Situação:** a 6C.6A (seções 1–8) foi aprovada com ressalvas. A 6C.6B.1
(seções 9–16), aprovada com condições, valida os contratos do Windows e
detalha o launcher. A 6C.6B.2 (seções 17–19) **implementou e compilou** o
launcher, **sem executá-lo** e sem conectá-lo ao app. A 6C.6C.1 preparou e
compilou os artefatos só de teste (variante `gerpro-helper-host-test.exe` e
alvo sintético), **sem executá-los**; o roteiro dos testes reais está em
`docs/11-testes-contencao.md`. O detector não foi ativado, e os hashes de
produção continuam `null`.

**Decisões da aprovação da 6C.6A (D61):** a direção é um launcher nativo
separado (`gerpro-helper-host.exe`); planejar instalação por máquina com NSIS;
MSIX fica como alternativa futura; iniciar a avaliação corporativa de
certificado de assinatura; não ativar o detector nem alterar hashes de
produção.

**Correções da 6C.6B.1 ao texto da 6C.6A** (marcadas no lugar com "→ 6C.6B.1"):
a política de processos filhos **não** é uma barreira contra um auxiliar
comprometido (seção 9.2); a dúvida sobre `SILENT_BREAKAWAY_OK` ancestral foi
resolvida pela documentação (9.3); o TOCTOU do auxiliar é **reduzido, não
eliminado** (seção 13); os códigos de saída foram refeitos (11.6).

Nenhum código foi alterado. `DXCORE_HELPER_SHA256`
continua `{ x64: null, arm64: null }`. O serviço continua com
`UnimplementedLocalDetector`, o escopo concedido continua `demo-only` e o
auxiliar nunca foi executado pelo app. Cada etapa da seção 5 precisa de
aprovação própria.

Base: D54, D56–D60, `docs/04-hardware-advisor.md` (seções "Executor do
auxiliar empacotado", "Encerramento do processo", "Integração do DXCore ao
detector" e "Distribuição do auxiliar") e `native/dxcore-helper/README.md`
(seção "Job Object").

Afirmações marcadas **[verificar]** vêm da documentação do Windows, da libuv
ou do Electron e ainda não foram confirmadas nesta máquina. Elas viram
critérios da seção 7: nenhuma pode ser presumida na ativação.

---

## 1. Arquitetura do Job Object

### 1.1 Por que `child_process.spawn` não basta

- O `spawn` do Node (libuv) cria o processo e já o deixa rodar. Não há
  `CREATE_SUSPENDED`, nem atributo de criação (`STARTUPINFOEX`), nem acesso
  ao identificador do processo antes da primeira instrução. Qualquer
  associação a um job feita pelo JavaScript viria **depois** de o auxiliar
  já estar rodando, e o Node não tem API de Job Object.
- A libuv coloca todo filho num job global próprio, com `KILL_ON_JOB_CLOSE`,
  `BREAKAWAY_OK` e `SILENT_BREAKAWAY_OK` **[verificar no Electron 45]**. Esse
  job garante só que o **filho direto** morre quando o Electron sai. Com
  `SILENT_BREAKAWAY_OK`, os netos já nascem **fora** dele. Logo, esse job não
  impede o auxiliar de criar processos e não encerra descendentes.
- `ProcessChildProcessPolicy` só pode ser aplicada na criação, por atributo.
  O processo não consegue aplicá-la a si mesmo depois de iniciado (README do
  auxiliar).

Conclusão: a contenção tem de ser feita por código nativo que **cria** o
processo do auxiliar.

### 1.2 Sequência recomendada (no criador nativo; ver seção 2)

```
1. Job J  = CreateJobObjectW(lpJobAttributes = NULL, lpName = NULL)
            → sem nome (ninguém o abre por nome), identificador NÃO herdável.
2. SetInformationJobObject(J, JobObjectExtendedLimitInformation):
     LimitFlags = KILL_ON_JOB_CLOSE
                | ACTIVE_PROCESS        (ActiveProcessLimit = 1)
                | DIE_ON_UNHANDLED_EXCEPTION
                | JOB_MEMORY            (JobMemoryLimit = 64 MiB, provisório)
     Sem BREAKAWAY_OK, sem SILENT_BREAKAWAY_OK.
   Sem JobObjectBasicUIRestrictions (ver 1.4, jobs aninhados).
   Falha → código de saída próprio (1.6), nenhum processo criado.
3. Arquivo do auxiliar aberto pelo criador:
     CreateFileW(caminho fixo, GENERIC_READ, FILE_SHARE_READ, ...,
                 FILE_FLAG_OPEN_REPARSE_POINT)
   → recusa ponto de reanálise (link/junção no arquivo); sem
     FILE_SHARE_WRITE/DELETE: ninguém escreve, renomeia ou apaga o arquivo
     enquanto o identificador estiver aberto. SHA-256 calculado PELO
     IDENTIFICADOR e comparado com o esperado (1.5). Guardar
     FileId + VolumeSerialNumber (GetFileInformationByHandleEx(FileIdInfo)).
4. Atributos de criação (InitializeProcThreadAttributeList, STARTUPINFOEXW):
     PROC_THREAD_ATTRIBUTE_JOB_LIST     = { J }   → associação NA criação
     PROC_THREAD_ATTRIBUTE_HANDLE_LIST  = { saída padrão (pipe) }
     PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY
                                        = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED
5. CreateProcessW(caminho fixo, linha "--protocol 1",
                  bInheritHandles = TRUE (restrito pela HANDLE_LIST),
                  CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT
                  | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                  ambiente mínimo (SystemRoot, windir), cwd = System32)
   Falha (inclusive associação ao job recusada) → nada rodou.
6. Antes de ResumeThread, conferir, nesta ordem:
     a. IsProcessInJob(processo, J) == TRUE;
     b. imagem do processo == arquivo travado: QueryFullProcessImageNameW
        → abrir esse caminho → FileId + VolumeSerial iguais aos do passo 3;
     c. (opcional) QueryInformationJobObject(J, BasicAccountingInformation)
        com ActiveProcesses == 1.
   Qualquer falha → TerminateJobObject(J) (o processo ainda está suspenso:
   nenhuma instrução do auxiliar rodou) e código próprio.
7. Fechar o identificador do arquivo (passo 3) só DEPOIS da conferência 6b.
8. ResumeThread; fechar o identificador da thread.
9. WaitForSingleObject(processo, prazo próprio < prazo do Node).
   Prazo → TerminateJobObject(J, código) e código próprio.
10. Repassar o código de saída do auxiliar; fechar J (KILL_ON_JOB_CLOSE
    encerra qualquer resto).
```

**Por que `JOB_LIST` e `CREATE_SUSPENDED` juntos.** Com
`PROC_THREAD_ATTRIBUTE_JOB_LIST` (Windows 10+), a associação faz parte da
criação: se falhar, `CreateProcessW` falha e não existe processo. O
`CREATE_SUSPENDED` é a segunda barreira. Ele garante a janela das
conferências 6a–6c sem que o auxiliar rode, e serve de caminho alternativo
caso `JOB_LIST` não esteja disponível: criar suspenso, chamar
`AssignProcessToJobObject` e, se falhar, `TerminateProcess` sem nunca chamar
`ResumeThread`. O Windows 10 já é o mínimo do DXCore e do Electron 45, então o
caminho alternativo deve ser só defesa; a recomendação é **exigir** `JOB_LIST`
e tratar a ausência como indisponível.

**Por que a política de processos filhos além do `ACTIVE_PROCESS_LIMIT`.**
`PROCESS_CREATION_CHILD_PROCESS_RESTRICTED` faz o kernel recusar a criação de
processos pelo auxiliar. O `ACTIVE_PROCESS_LIMIT = 1` é a segunda camada, e
`KILL_ON_JOB_CLOSE` a terceira. **→ 6C.6B.1:** a política só é efetiva em
processos isolados (AppContainer). Fora disso, um auxiliar comprometido, com o
mesmo usuário, pode contorná-la, e também o job (9.2). As três camadas contêm
comportamento acidental, não um atacante dentro do auxiliar. A dúvida sobre
`SILENT_BREAKAWAY_OK` ancestral foi resolvida pela documentação (9.3).

### 1.3 Encerramento em cada situação

| Situação | Quem encerra | Garantia |
| --- | --- | --- |
| Auxiliar termina sozinho | — | criador repassa o código; fecha J |
| Prazo do criador (ex.: 2,5 s) | `TerminateJobObject(J)` | todo processo do job encerrado; criador sai com código próprio |
| Prazo do Node (3 s) ou cancelamento | `superviseProcess` encerra o **criador** | kernel fecha os identificadores do criador → J fecha → `KILL_ON_JOB_CLOSE` encerra o auxiliar |
| Criador trava ou falha | kernel, ao encerrar o criador | idem |
| Electron sai ou falha | job da libuv (`KILL_ON_JOB_CLOSE`) encerra o criador → J fecha | **[verificar]** que o criador está no job da libuv no Electron 45 |
| Job da libuv ausente e app sai | o próprio criador, pelo prazo do passo 9 | vida máxima limitada ao prazo do criador mesmo sem o job da libuv |

**Propriedade útil para o `superviseProcess`.** A saída padrão do auxiliar é
o mesmo pipe que o Node deu ao criador, herdado pela `HANDLE_LIST`. O evento
`close` do Node só chega quando **todas** as pontas de escrita fecham, ou seja,
quando criador **e** auxiliar terminaram. `close` passa a confirmar o fim da
árvore inteira, e `exit-unconfirmed`/`kill-failed` (D60) passam a significar
"o kernel ainda não terminou de encerrar o job", não "pode haver órfão".

### 1.4 Jobs aninhados e processos já associados

- Desde o Windows 8, um processo pode pertencer a vários jobs em hierarquia;
  os limites valem pelo mais restritivo da cadeia.
- O auxiliar criado pelo criador **nasce fora** do job da libuv por causa do
  `SILENT_BREAKAWAY_OK` **[verificar]**, mas pode herdar jobs mais externos (por
  exemplo, um job em que o Electron foi iniciado pelo terminal, IDE ou
  instalador). Nesse caso J vira filho desse job. **→ 6C.6B.1, confirmado:** o
  aninhamento exige que J esteja vazio e que nenhum dos dois jobs tenha
  restrições de interface (9.3). Por isso J não usa
  `JobObjectBasicUIRestrictions`.
- Um job externo com `KILL_ON_JOB_CLOSE` só **acrescenta** encerramento, não
  remove. Um job externo com limites menores (memória, processos) pode fazer a
  criação falhar, e o resultado é o fallback, nunca execução sem contenção.
- Um job externo com `BREAKAWAY_OK` não afeta J: J não permite saída, e a
  política de processos filhos impede filhos de qualquer forma.

### 1.5 Herança de identificadores e permissões mínimas

- `HANDLE_LIST` com **só** a ponta de escrita da saída padrão. Entrada e saída
  de erro não são passadas (o auxiliar não usa nenhuma das duas). O criador
  abre seus próprios identificadores sem herança.
- J sem nome e não herdável: o auxiliar não o recebe e não consegue abri-lo.
  Para mudar limites seria preciso `JOB_OBJECT_SET_ATTRIBUTES` num
  identificador de J, que ele não tem.
- Criador e auxiliar rodam como `asInvoker`, sem privilégios. Atribuir ao job
  exige só `JOB_OBJECT_ASSIGN_PROCESS` no job (o criador o criou) e
  `PROCESS_SET_QUOTA | PROCESS_TERMINATE` no processo (o criador tem, por
  ser o criador).
- Ambiente: só `SystemRoot` e `windir`; diretório de trabalho: System32
  (igual ao executor atual).

### 1.6 Códigos de saída do criador (proposta; **substituída pela 11.6**)

Faixa nova, **20–29**, distinta de `DXCORE_EXIT_CODES` (0, 10–13, 64), para o
diagnóstico distinguir "o criador recusou" de "o auxiliar falhou". Hoje o
parser trata qualquer código desconhecido como `crashed`, o que já leva ao
fallback. Mesmo antes de o contrato ser atualizado, o comportamento seguro está
garantido.

| Código | Significado |
| --- | --- |
| 20 | Argumentos do criador inválidos |
| 21 | Job não criado ou limites não aplicados |
| 22 | Arquivo do auxiliar ausente, não arquivo comum, ponto de reanálise ou não travado |
| 23 | Hash do auxiliar diferente do esperado |
| 24 | `CreateProcessW` falhou (inclusive associação recusada ou `JOB_LIST` indisponível) |
| 25 | Conferência antes de `ResumeThread` falhou (job ou imagem) |
| 26 | Prazo do criador |
| 27 | Execução sob emulação (x64 em ARM64; ver 3.3) |

### 1.7 TOCTOU e troca do executável

| Ponto | Situação com o plano |
| --- | --- |
| Auxiliar entre conferência e execução | **Reduzido, não eliminado (→ 6C.6B.1, seção 13).** O criador confere pelo identificador aberto sem compartilhamento de escrita ou exclusão, e confere que a imagem do processo suspenso é o mesmo arquivo (FileId). Restam hipóteses de sistema de arquivos a testar. |
| Criador entre conferência do Node e `spawn` | **Continua aberto**, igual ao de hoje (D56). O Node confere hash, `lstat` e `realpath` antes e depois, mas não executa a partir de um identificador. Fica mitigado pela instalação por máquina e pela assinatura (seção 3). |
| Pacote do app (asar, com os hashes) | Fora do alcance de qualquer verificação interna: quem escreve na pasta do app troca o app. Mitigado só pela pasta protegida e pela assinatura. |

---

## 2. Alternativas de implementação

| Critério | A. Criador nativo supervisionado (`gerpro-helper-host.exe`) | B. Extensão nativa Node/Electron (`.node`) | C. Auxiliar que se contém (cria o job e se reinicia) | D. PowerShell / .NET chamando a API |
| --- | --- | --- | --- | --- |
| Auxiliar contido antes da 1ª instrução | Sim (`JOB_LIST` + suspenso) | Sim | **Não**: a primeira instância já rodou fora do job | Sim, mas por P/Invoke em script |
| Código nativo no processo principal | Não | **Sim**: falha de memória derruba o app | Não | Não, mas carrega o runtime .NET |
| Reaproveita `superviseProcess` (D60) | Sim, sem mudança | Não: pipes, prazo e cancelamento seriam refeitos em C++ | Sim | Sim |
| Build | Mais um alvo no script MSVC já existente | node-gyp/cmake-js, cabeçalhos do Electron, ABI (N-API reduz), `asarUnpack` | Mesmo alvo | Nenhum |
| Superfície de ataque | Mais um executável, mínimo, só `KERNEL32` | DLL carregada no Main (troca da `.node` = código no Main) | Auxiliar ganha API de criação de processos (quebra a propriedade "sem `CreateProcess`" da D57) | Script e runtime grandes; política de execução do PowerShell |
| Manutenção | Baixa: ~300–400 linhas C++ sem dependências | Média/alta: acompanha as versões do Electron | Baixa, mas mistura papéis | Baixa no código, alta na confiabilidade |
| Hash/assinatura | 2 binários por arquitetura | 1 DLL por arquitetura e versão do Electron | 1 binário | Script dentro do asar |
| Encerramento quando o app sai | Kernel (cadeia de jobs) + prazo próprio | Kernel (J no Main com `KILL_ON_JOB_CLOSE`) | Kernel | Igual à A, mas o processo pai é o PowerShell |

**Recomendação: A, criador nativo supervisionado.**

1. É a única opção que contém o auxiliar desde a criação **sem** pôr código
   nativo no processo principal.
2. Mantém intacta toda a camada já revisada e testada (`BundledHelperRunner`,
   `superviseProcess`, D56/D60). Do ponto de vista do Node, muda só *qual*
   executável conferido é iniciado.
3. Usa o mesmo conjunto de ferramentas, o mesmo script de build, a mesma
   inspeção do PE (`pe-inspect.ts`) e o mesmo processo de reprodutibilidade do
   auxiliar.
4. Preserva a propriedade da D57 de que o auxiliar não importa nenhuma API de
   criação de processos. Essa API fica num binário cujo único papel é criar
   **um** processo fixo.

B fica como alternativa caso a equipe já precise de uma extensão nativa por
outro motivo. C e D foram descartadas: C não cumpre "contido antes de
executar" e D troca código mínimo por um runtime inteiro.

### 2.1 Como o `BundledHelperRunner` usaria o criador

- `DXCORE_HELPER` ganha a identidade do criador:
  `helpers\win32-<arch>\gerpro-helper-host.exe`, argumentos fixos
  `--protocol 1 --expect-sha256 <hash do auxiliar>`. O hash do auxiliar vem
  da constante do app, nunca de fora.
- `DXCORE_HELPER_SHA256` passa a ter **dois** valores por arquitetura
  (criador e auxiliar). O Node confere o criador (como hoje, antes e depois)
  e também o arquivo do auxiliar (para recusar cedo e manter a conferência
  posterior). O criador confere o auxiliar de novo pelo identificador travado.
- O criador não aceita outro caminho: o auxiliar é sempre
  `<pasta do próprio criador>\gerpro-dxcore-helper.exe`, obtida por
  `GetModuleFileNameW` e conferida com `GetFinalPathNameByHandleW` (sem
  link ou junção).
- O executor **não chama o auxiliar diretamente** em nenhum caminho. Sem
  criador, ou com o criador recusado, o resultado é `helper-unavailable` e o
  fallback. Não existe um modo "sem contenção".
- O protocolo de saída não muda: o criador não lê nem reescreve a saída do
  auxiliar (pipe herdado).

---

## 3. Empacotamento

O app ainda não tem empacotador. Nada foi instalado ou configurado. As opções
abaixo são para a decisão da etapa 6C.7A.

### 3.1 Opções compatíveis com Electron

| Opção | Recursos fora do asar | Pasta de instalação | Atualização | Observação |
| --- | --- | --- | --- | --- |
| electron-builder + NSIS | `extraResources` → `process.resourcesPath` | por máquina (`perMachine`, Program Files) ou por usuário | electron-updater (por máquina pede UAC a cada atualização) | Mais usado, assinatura integrada |
| electron-builder + MSIX/AppX | idem | `WindowsApps` (somente leitura para o usuário, mesmo por usuário) | Loja ou App Installer | Exige assinatura sempre; o melhor para TOCTOU |
| Electron Forge + Squirrel.Windows | `packagerConfig.extraResource` | só por usuário (`%LOCALAPPDATA%`) | Squirrel | Pasta gravável pelo usuário: o pior caso de TOCTOU |
| Electron Forge + WiX (MSI) | idem | por máquina | MSI | Mais trabalho de configuração |

**Decisão (D61):** instalação **por máquina** com NSIS (`perMachine`,
`Program Files`). MSIX fica como alternativa futura. Squirrel (somente por
usuário) não é usado para ativar o auxiliar. Nenhum empacotador foi instalado
ou configurado.

### 3.2 Estrutura dos recursos

```
<instalação>\resources\
  app.asar                          ← contém DXCORE_HELPER_SHA256
  helpers\
    win32-x64\
      gerpro-helper-host.exe        ← criador (assinado)
      gerpro-dxcore-helper.exe      ← auxiliar (assinado)
    win32-arm64\                    ← só quando houver build ARM64 aprovado
```

- Nada do auxiliar entra no asar nem em `asarUnpack`: só em `extraResources`.
  Um executável dentro do asar não pode ser executado.
- `build-manifest.json` **não** é distribuído. Ele fica no registro de
  aprovação (seção 4), não ao lado do executável: um manifesto ao lado não é
  fonte de confiança.
- O build do app copia os binários **aprovados** (do registro de aprovação),
  não a saída de um build local. A cópia confere o hash contra a constante do
  código e falha o empacotamento se for diferente.

### 3.3 Arquiteturas

- **x64:** único alvo inicial.
- **ARM64 nativo:** hash `arm64: null` até haver build ARM64 próprio (MSVC
  ARM64 cruzado, mesmo processo da seção 4). Até lá, `integrity-unknown` e
  fallback.
- **x64 emulado em ARM64:** `process.arch === 'x64'`. Antes de criar o
  executor, o Main confere `app.runningUnderARM64Translation`: se `true`, não
  passa `helperResourcesRoot` e vale o fallback. Como segunda barreira, o
  criador confere `IsWow64Process2` e sai com 27. O comportamento do DXCore
  sob emulação não é presumido.

### 3.4 Permissões, integridade e assinatura

- **Pasta:** por máquina, só administradores escrevem. O criador **não**
  confere ACLs (decisão: a pasta é confiável ou não é. Conferir ACL dá falsa
  segurança, porque quem escreve na pasta também troca o asar).
- **Integridade:** SHA-256 no código, conferido pelo Node (antes e depois) e
  pelo criador (identificador travado).
- **Assinatura Authenticode:** recomendada para os dois binários e para o
  app. A assinatura **altera os bytes do arquivo** e, portanto, o SHA-256
  (ver seção 4). Conferir a assinatura em tempo de execução (`WinVerifyTrust`)
  no criador fica como item opcional: o hash fixo já é mais forte que "qualquer
  binário assinado pela Gerpro".
- **Auxiliar ausente:** `not-found` → `helper-unavailable` → fallback, sem
  erro na interface (comportamento atual).
- **Atualização:** os hashes mudam junto com o app (estão no asar). Uma
  atualização parcial, com binário novo e asar antigo ou o contrário, resulta
  em `integrity-mismatch` e fallback, nunca em execução de binário não
  aprovado. O instalador substitui `resources\` por inteiro.

---

## 4. Processo de aprovação do hash

Objetivo: o valor em `DXCORE_HELPER_SHA256` corresponde a um binário
produzido por um build limpo, reproduzível e inspecionado. Nenhum outro
binário consegue ser ativado.

1. **Build limpo.** Commit marcado, árvore sem alterações (`git status`
   vazio nos fontes nativos), toolchain fixa (MSVC 14.44.x, SDK 10.0.26100.0),
   `build-dxcore-helper.mjs --confirm-native-build --reproducibility-check`
   estendido ao criador.
2. **Reprodutibilidade.** Dois builds na mesma máquina: binários idênticos
   (já existe). **Novo:** um terceiro build numa segunda máquina ou VM limpa
   com a mesma toolchain, com o mesmo SHA-256 sem assinatura. Toolchain
   diferente → novo manifesto e nova aprovação.
3. **Validação do PE.** `pe-inspect.ts` e `dumpbin` independentes. Para o
   criador, a lista de importações permitida passa a incluir as APIs de job e
   de processo, e só elas (lista explícita no script).
4. **Hash sem assinatura** (`sha256Unsigned`): o valor reproduzível.
5. **Assinatura** (quando houver certificado): assinar **uma vez**, com
   carimbo de tempo. O arquivo assinado é o artefato de produção. Conferir que
   remover a assinatura (`signtool remove /s` numa cópia) devolve exatamente
   `sha256Unsigned`. Reassinar muda o hash (o carimbo de tempo muda), então
   nunca se reassina um artefato aprovado.
6. **Hash de produção** (`sha256`) = SHA-256 do arquivo assinado (ou do não
   assinado, enquanto não houver certificado).
7. **Registro de aprovação**, versionado (proposta:
   `native/dxcore-helper/approved/win32-x64.json`): commit, toolchain,
   hash de cada fonte, `sha256Unsigned`, `sha256`, tamanho, propriedades do
   PE, quem aprovou e data. Sem caminhos, usuário ou máquina. O binário
   aprovado é guardado como artefato de release, fora do git.
8. **Mudança separada.** Um commit que altera só `DXCORE_HELPER_SHA256` e o
   registro de aprovação, com revisão própria. Nenhuma outra mudança junto.
9. **Barreiras automáticas** (testes novos, sem executar binários):
   - a constante é igual ao `sha256` do registro de aprovação;
   - o hash de cada fonte em `native/dxcore-helper/src` é igual ao registrado.
     Mudar um fonte sem nova aprovação quebra o teste;
   - o empacotamento falha se o binário copiado não tiver o hash da constante.
10. **Em execução:** o executor e o criador recusam qualquer hash diferente
    (`integrity-mismatch` / código 23).

Enquanto os passos 1–9 não forem cumpridos e aprovados,
`DXCORE_HELPER_SHA256` continua `null`.

---

## 5. Plano de ativação por etapas

Cada etapa pede aprovação própria. Nenhuma ativa o detector antes da 6C.8.

| Etapa | Conteúdo | Executa binário? |
| --- | --- | --- |
| **6C.6B** | Fontes do criador (C++17, só `KERNEL32`), extensão do script de build e do `pe-inspect`, contrato dos códigos 20–29 no app, testes do `BundledHelperRunner` com o criador simulado | Não (só compilação, se autorizada) |
| **6C.6C** | Teste nativo autorizado da contenção, com um alvo de teste (não o auxiliar) que tenta `CreateProcess`, aloca acima do limite e trava. Confere: filho recusado, encerramento ao matar o criador, encerramento ao fechar o Electron, comportamento aninhado sob o job da libuv, `JOB_LIST` disponível, job da libuv presente no Electron 45 | Sim, só o alvo de teste e o criador, pelo supervisor da D55 |
| **6C.6D** | Diagnóstico manual (D58) passando pelo criador, com o auxiliar real e hash injetado só no diagnóstico | Sim, manual |
| **6C.7A** | Escolha e configuração do empacotador (`extraResources`, instalação por máquina), sem assinatura | Não |
| **6C.7B** | Certificado e assinatura; aprovação do hash (seção 4) numa mudança separada | Não |
| **6C.8** | Ativação (abaixo) | Sim, pelo app, com consentimento |

### 5.1 Ativação (6C.8)

- **Detector.** Em `services/index.ts`, trocar `UnimplementedLocalDetector`
  por `createLocalHardwareDetector({ ..., helperResourcesRoot })`. O
  `helperResourcesRoot` vem de
  `resolveHelperResourcesRoot({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })`
  e vale `null` sob emulação ARM64 (3.3). Uma raiz `null` resulta no detector
  sem auxiliar (Electron + Registro), não em erro.
- **Consentimento.** Escopo `device-detection` concedido só por ação
  explícita numa tela própria. A proteção contra ampliação automática
  (`demo-only` nunca vira `device-detection` sozinho) continua. Quem tem
  `demo-only` continua sem leitura real até decidir de novo.
- **Texto ao usuário (rascunho):** "Para recomendar modelos compatíveis, o
  Gerpro Studio pode ler neste computador: processador, memória, espaço livre
  na pasta de dados, sistema e placas de vídeo. Para as placas de vídeo, o app
  usa um pequeno programa próprio, incluído na instalação, que consulta o
  Windows e termina em seguida. Nada é enviado à internet. Você pode revogar
  a autorização e apagar os dados a qualquer momento."
- **Cancelamento e prazo:** sem mudança (sinal global, orçamento de GPU de
  11 s, pior caso de 13 s). Prazo do criador < 3 s do Node.
- **Fallback:** qualquer resultado diferente de `ok` devolve o mesmo objeto do
  Electron + Registro (D59), inclusive nos códigos 20–29.
- **Auxiliar indisponível** (ausente, ARM64, emulação, hash `null`): perfil
  igual ao de hoje, sem aviso de erro. O diagnóstico interno registra o
  motivo enumerado.
- **IPC, Preload e Renderer:** a tela de consentimento é a única mudança de
  interface prevista. O contrato do IPC já tem o escopo.

### 5.2 Testes

- **Regressão:** todos os testes atuais de `dxcore-*`, `bundled-helper`,
  `hardware-*` passam sem alteração de expectativa.
- **Executor com criador (simulado):** argumentos fixos (inclusive o hash
  vindo da constante), dois hashes conferidos, códigos 20–29 → `crashed` ou
  status próprio → fallback, ausência de qualquer caminho que execute o
  auxiliar direto.
- **Main (estáticos):** `resolveHelperResourcesRoot` só com valores de `app` e
  `process`; emulação ARM64 → sem raiz; nenhum valor vindo de IPC.
- **Consentimento:** sem `device-detection`, `detect()` nunca é chamado e o
  executor nunca é criado (espiões); a revogação apaga o perfil.
- **Hash:** barreiras da seção 4, passo 9.
- **Integração manual (6C.6C/6C.6D/6C.8):** roteiro com resultado registrado,
  sem identificadores completos.

---

## 6. Segurança, privacidade e riscos

Preservado em todas as etapas: execução só local; nenhum dado de hardware
enviado à nuvem (`serverSharing` independente e sem integração); nenhuma
elevação (`asInvoker` nos dois binários); diagnósticos só com valores
enumerados (sem LUID, PCI, nome, caminho); nada roda sem `device-detection`;
o auxiliar lê só as propriedades da D54.

### 6.1 Matriz de riscos

| # | Risco | Prob. | Impacto | Mitigação | Residual |
| --- | --- | --- | --- | --- | --- |
| R1 | Auxiliar trocado entre conferência e execução (TOCTOU) | Baixa | Alto | Identificador travado, hash depois da criação, FileId da imagem suspensa (12) | Reduzido; hipóteses H1–H5 da seção 13 a testar |
| R2 | Criador trocado entre conferência do Node e `spawn` | Baixa (por máquina) / Média (por usuário) | Alto | Instalação por máquina, assinatura, conferência posterior | Aberto; aceito, porque quem escreve na pasta já troca o asar |
| R3 | Instalação por usuário (pasta gravável) | Média | Alto | Recomendar por máquina/MSIX; Squirrel não recomendado | Se a equipe escolher por usuário, R2 sobe; registrar a decisão |
| R4 | Binários não assinados | Alta até 6C.7B | Médio | Hash fixo no código; assinatura antes da 6C.8 | Critério de liberação (7) |
| R5 | Processo órfão | Baixa | Médio | `KILL_ON_JOB_CLOSE` + cadeia de jobs + prazo do criador; `close` confirma a árvore | Auxiliar comprometido pode duplicar o identificador do job (R15); nesse caso `close` não chega e vale `previous-unconfirmed` (D60) |
| R6 | Auxiliar cria processos (sem estar comprometido) | Muito baixa | Alto | Sem API na D57 + política de filhos + `ACTIVE_PROCESS_LIMIT` | Três camadas contra comportamento acidental |
| R7 | Neto escapa do job aninhado (`SILENT_BREAKAWAY_OK` ancestral) | Baixa | Alto | Documentado: só o job imediato decide a saída (9.3); J não permite saída | Confirmar no teste real T-R4 |
| R8 | Job externo impede associação | Baixa | Baixo | Falha → fallback; nunca execução sem job | Nenhum |
| R9 | x64 emulado em ARM64 | Baixa | Baixo | `runningUnderARM64Translation` + `IsWow64Process2` | Nenhum |
| R10 | Hash de produção divergente do aprovado | Baixa | Alto | Processo da seção 4 + testes de barreira | Nenhum |
| R11 | Atualização parcial | Baixa | Baixo | `integrity-mismatch` → fallback | Nenhum |
| R12 | Falha no criador derruba o app | — | — | Criador fora do processo principal (alternativa A) | Nenhum |
| R13 | `CommandRunner` (PowerShell, `reg`) sem job | Média | Médio | Fora do escopo; o criador pode ser generalizado depois para catálogos do sistema | Aberto (já registrado na 6C.5C) |
| R14 | Exposição de identificadores | Baixa | Médio | Parser e diagnóstico só com enumerados; LUID não persiste | Nenhum |
| R15 | Auxiliar comprometido (ex.: falha de memória explorada por dado do driver) | Muito baixa | Alto | Código mínimo da D57, mitigações do PE, job e política de filhos | **Aberto:** com o mesmo usuário e o mesmo nível de integridade, ele pode abrir outros processos do usuário (inclusive o launcher, para duplicar o identificador do job) e criar processos fora de J. Isolamento real exige AppContainer ou token restrito (seção 16, item opcional) |

---

## 7. Critérios objetivos para liberar a ativação (6C.8)

Todos obrigatórios:

1. Criador implementado com `JOB_LIST`, `CREATE_SUSPENDED`, política de
   filhos, `HANDLE_LIST`, travamento do arquivo e conferência de FileId;
   revisão de código aprovada.
2. PE do criador e do auxiliar inspecionado (lista de importações explícita,
   `asInvoker`, mitigações), com builds idênticos em duas máquinas.
3. 6C.6C concluída com registro: criação de filho recusada; encerramento do
   alvo em ≤ 1 s após matar o criador; encerramento ao fechar o Electron;
   presença do job da libuv no Electron 45 confirmada; nenhum processo
   remanescente após 100 execuções com cancelamento aleatório.
4. 6C.6D concluída: diagnóstico manual pelo criador com `dxcoreStatus: 'ok'`
   numa máquina real e fallback idêntico com o auxiliar removido.
5. Empacotador configurado com `extraResources` e instalação por máquina (ou
   MSIX), e binários fora do asar conferidos no pacote gerado.
6. Binários assinados; registro de aprovação versionado; hashes aplicados
   numa mudança separada e revisada; testes de barreira ativos.
7. Tela de consentimento `device-detection` aprovada (texto e fluxo), sem
   ampliação automática.
8. `npm run typecheck` e `npm test` sem falhas; nenhum teste de regressão
   alterado na expectativa.
9. Nenhum identificador completo em diagnóstico, log ou arquivo (teste
   estático).

---

## 8. Complexidade e dependências

| Etapa | Complexidade | Dependências externas |
| --- | --- | --- |
| 6C.6B criador + build | Média (C++ Win32 ~300–400 linhas, script e testes) | Nenhuma nova (MSVC v143 e SDK já instalados) |
| 6C.6C teste de contenção | Média (roteiro, alvo de teste, supervisor) | Autorização para executar binários |
| 6C.6D diagnóstico | Baixa | Idem |
| 6C.7A empacotador | Média | Dependência de dev nova (electron-builder ou Forge) — exige aprovação |
| 6C.7B assinatura e hash | Média, mais processo | Certificado de assinatura (custo, validação da empresa); segunda máquina ou VM de build |
| 6C.8 ativação | Média (Main, consentimento, interface, testes) | Aprovação do texto de consentimento |

Ordem crítica: 6C.6B → 6C.6C (decide se o desenho de jobs se sustenta) →
6C.6D → 6C.7A → 6C.7B → 6C.8. O certificado é o item de prazo mais longo e
pode ser solicitado em paralelo.

---

# Parte II — Validação técnica do launcher (Etapa 6C.6B.1)

Fontes:
- **[SDK]** headers do Windows SDK 10.0.26100.0 instalado nesta máquina:
  `um\WinBase.h`, `um\winnt.h`, `um\jobapi.h`, `um\jobapi2.h`,
  `um\processthreadsapi.h`;
- **[MS]** documentação oficial da Microsoft (learn.microsoft.com, consultada
  em 2026-11-04): `UpdateProcThreadAttribute`, `Nested Jobs`, `Job Objects`,
  `JOBOBJECT_BASIC_LIMIT_INFORMATION`, `AssignProcessToJobObject`,
  `TerminateJobObject`.

Cada item é classificado assim:

| Marca | Significado |
| --- | --- |
| **Confirmado** | Declarado no header e/ou escrito na documentação oficial |
| **Hipótese** | Coerente com a documentação, mas não escrito nela; precisa de teste real |
| **Teste real** | Depende do ambiente (Electron 45, libuv, sistema de arquivos, drivers); só um teste autorizado decide |

## 9. Contratos confirmados

### 9.1 Atributos de criação e `CreateProcessW`

| Item | Fonte | Contrato | Classificação |
| --- | --- | --- | --- |
| `CREATE_SUSPENDED` | [SDK] `WinBase.h`: `0x00000004` | Thread principal criada suspensa | Confirmado |
| `EXTENDED_STARTUPINFO_PRESENT` | [SDK] `WinBase.h`: `0x00080000` | `lpStartupInfo` é um `STARTUPINFOEXW` com `lpAttributeList` | Confirmado |
| `CREATE_NO_WINDOW` / `CREATE_BREAKAWAY_FROM_JOB` | [SDK] `0x08000000` / `0x01000000` | O launcher **nunca** usa `CREATE_BREAKAWAY_FROM_JOB` | Confirmado |
| `PROC_THREAD_ATTRIBUTE_JOB_LIST` | [SDK] `ProcThreadAttributeJobList = 13`, sob `_WIN32_WINNT >= _WIN32_WINNT_WINTHRESHOLD`; [MS] "list of job handles to be assigned to the child process, in the order specified. Supported in Windows 10 and newer" | Associação durante a criação | Confirmado (declaração e versão) |
| Falha da associação por `JOB_LIST` faz `CreateProcessW` falhar sem deixar processo | [MS] não diz explicitamente | — | **Hipótese H-J1** → teste T-J1 |
| `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` | [SDK] `ProcThreadAttributeHandleList = 2`; [MS] "list of handles to be inherited… must be created as inheritable handles and must not include pseudo handles… pass TRUE for bInheritHandles" | Só os identificadores listados são herdados | Confirmado |
| Identificador de saída padrão recebido do Node é herdável dentro do launcher | — | Se não for, `DuplicateHandle` com `bInheritHandle = TRUE` | **Teste real** T-H1 |
| `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY` | [SDK] `ProcThreadAttributeChildProcessPolicy = 14`, `PROCESS_CREATION_CHILD_PROCESS_RESTRICTED = 0x01`, sob `WINTHRESHOLD`; [MS] "Supported in Windows 10 and newer" | O processo criado não pode criar filhos | Confirmado (declaração e versão) |
| Limite da política de filhos | [MS] "only effective in sandboxed applications (such as AppContainer)… if a process restricting child process creation is able to access another process handle with PROCESS_CREATE_PROCESS or PROCESS_VM_WRITE… it may be possible to bypass" | Ver 9.2 | Confirmado |
| `lpValue` precisa durar até `DeleteProcThreadAttributeList` | [MS] | Buffers estáticos no launcher | Confirmado |
| `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` herda o job do processo indicado | [MS] "Attributes inherited from the specified process include handles… and job object" | Ver 9.2 | Confirmado |

### 9.2 O que a política de filhos e o job **não** garantem

A documentação confirma o seguinte. Um processo com a política de filhos,
rodando com o mesmo usuário e o mesmo nível de integridade, que consiga abrir
**outro** processo com `PROCESS_CREATE_PROCESS` (por exemplo, o Electron ou o
próprio launcher), pode criar um processo com esse outro como pai
(`PARENT_PROCESS`). O processo novo herda os jobs **do pai indicado**, não J.
Portanto:

- contra o auxiliar **sem** comprometimento (o caso projetado: ele não
  importa nenhuma API de criação de processos, D57), o job e a política são
  defesa em profundidade;
- contra o auxiliar **comprometido**, nem a política nem o job são barreira
  de segurança. A mesma condição permite abrir o launcher com
  `PROCESS_DUP_HANDLE`, duplicar o identificador de J e impedir o
  `KILL_ON_JOB_CLOSE` (R15).

O plano deixa de afirmar que a política "independe dos jobs" ou que "fecha"
a criação de processos. Isolamento real (AppContainer, ou token restrito com
integridade baixa) fica como avaliação opcional (16.3). Se adotado, exige
teste de compatibilidade com o DXCore.

### 9.3 Jobs, limites e aninhamento

| Item | Fonte | Contrato | Classificação |
| --- | --- | --- | --- |
| `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | [SDK] `0x00002000`; [MS] "all processes associated with the job… terminate when the last handle to the job is closed"; exige `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` | Fechar o **último** identificador encerra os processos | Confirmado |
| Job aninhado com `KILL_ON_JOB_CLOSE` | [MS] "closing the last job object handle terminates all processes associated with the job and its child jobs" | Inclui jobs filhos | Confirmado |
| `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | [SDK] `0x00000008`; [MS] "If you try to associate a process with a job, and this causes the active process count to exceed this limit, the process is terminated and the association fails" | Um processo excedente é **encerrado** na associação | Confirmado |
| Nenhuma instrução do processo excedente roda antes de ele ser encerrado | [MS] não diz | — | **Hipótese H-J2** → T-R2 |
| A contagem só cai quando o processo termina **e** todos os identificadores dele fecham | [MS] Remarks de `JOBOBJECT_BASIC_LIMIT_INFORMATION` | Sem efeito: um job novo por execução, sem reuso | Confirmado |
| `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (por processo) e `JOB_MEMORY` (soma do job) | [SDK] `0x100`, `0x200`; [MS] "attempts to commit memory that would exceed the… limit, it fails"; exigem a estrutura estendida; aninhado: "the effective memory limit is the most restrictive" (por processo) | Limite de **commit**: a alocação falha, o processo não é encerrado por isso | Confirmado |
| Valor do limite de memória | — | Medir o pico (`PeakProcessMemoryUsed`) no teste real antes de fixar | **Teste real** T-M1 |
| `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` | [SDK] `0x400`; [MS] força `SEM_NOGPFAULTERRORBOX`; sem depurador, o processo termina com o código da exceção | Sem caixa de diálogo de falha | Confirmado |
| `BREAKAWAY_OK` / `SILENT_BREAKAWAY_OK` | [SDK] `0x800` / `0x1000` | J não usa nenhum dos dois | Confirmado |
| Saída de job em hierarquia | [MS] "If the immediate job object does not allow breakaway, the child process does not break away even if jobs in its parent job chain allow it" | Com J como job **imediato** do auxiliar e sem saída permitida, um filho criado normalmente por ele fica em J, mesmo com `SILENT_BREAKAWAY_OK` no job da libuv | Confirmado (resolve a dúvida do README do auxiliar) |
| Filho do **launcher** sob o job da libuv | [MS] com `SILENT_BREAKAWAY_OK` no job imediato, o filho sai dele e de cada job acima "until it reaches a job that does not permit breakaway" | O auxiliar nasce fora do job da libuv; pode continuar num job externo que não permita saída | Regra confirmada; presença e flags do job da libuv no Electron 45: **Teste real** T-R1 |
| Ordem entre herança implícita e `JOB_LIST` | [MS] não diz | J vira filho do job externo que restar | **Hipótese H-J3** → T-R3 |
| Condições de aninhamento | [MS] `AssignProcessToJobObject`: o job "must be empty or it must be in the hierarchy… and it cannot have UI limits"; [MS] `Nested Jobs`: "neither job sets UI limits" | J é criado vazio e sem `JobObjectBasicUIRestrictions` | Confirmado |
| Jobs aninhados | [MS] desde o Windows 8 | — | Confirmado |
| `AssignProcessToJobObject` | [SDK] `(HANDLE hJob, HANDLE hProcess)`; [MS] exige `JOB_OBJECT_ASSIGN_PROCESS` no job e `PROCESS_SET_QUOTA \| PROCESS_TERMINATE` no processo; falha se algum job da cadeia estiver terminando | Não usado (ver 10) | Confirmado |
| `IsProcessInJob` | [SDK] `jobapi.h` `(HANDLE, HANDLE opt, PBOOL)` | Conferência antes de `ResumeThread` | Confirmado |
| Sessão | [MS] "All processes within a job must run within the same session" | Atendido (mesma sessão) | Confirmado |

### 9.4 Encerramento e identificadores

| Item | Fonte | Contrato | Classificação |
| --- | --- | --- | --- |
| `TerminateJobObject(hJob, uExitCode)` | [SDK] `jobapi2.h`; [MS] "as if TerminateProcess were called for each process"; exige `JOB_OBJECT_TERMINATE` e `PROCESS_TERMINATE` | Encerra todos os processos do job e dos jobs filhos, com o código `uExitCode` | Confirmado |
| O fim real dos processos pode vir depois do retorno de `TerminateJobObject` | [MS] remete ao `TerminateProcess`, que é assíncrono | O launcher **espera** o identificador do auxiliar (prazo curto) antes de declarar o encerramento | Hipótese conservadora H-T1; o desenho não depende dela |
| Destruição do job | [MS] "The job is destroyed when its last handle has been closed and all associated processes have been terminated" | — | Confirmado |
| Job sem nome | [MS] "Only named job objects can be opened" (`OpenJobObject`) | J sem nome; só se obtém um identificador por duplicação | Confirmado |
| Duplicação do identificador de J por outro processo do usuário | regra geral de `DuplicateHandle` | Mantém J vivo depois da morte do launcher (R15) | Possibilidade confirmada; ver 9.2 |
| `close` do Node só depois de o processo terminar **e** de a stdio fechar | documentação do Node (evento `'close'`) | Com a saída padrão herdada pelo auxiliar, `close` exige o fim do launcher **e** do auxiliar | Confirmado (Node); no Electron 45: T-H1 |

## 10. Compatibilidade mínima do Windows

| Requisito | Origem | Versão mínima |
| --- | --- | --- |
| `PROC_THREAD_ATTRIBUTE_JOB_LIST` | [SDK] guarda `WINTHRESHOLD`; [MS] | Windows 10 |
| `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY` | [SDK] guarda `WINTHRESHOLD`; [MS] | Windows 10 |
| Jobs aninhados | [MS] | Windows 8 |
| `STARTUPINFOEXW`, `HANDLE_LIST` | [MS] | Windows Vista |
| DXCore | — | Windows 10 (versão exata não confirmada; a ausência já resulta em código 10) |
| Electron 45 | — | Windows 10 |

**Mínimo: Windows 10 x64.** O launcher não confere a versão do Windows: a
versão informada depende de manifesto e não prova suporte. Ele depende da
falha das próprias APIs. Um `UpdateProcThreadAttribute` ou `CreateProcessW`
recusado resulta em código de falha e no fallback, **nunca** em execução sem o
atributo. O build usa `/D_WIN32_WINNT=0x0A00` (como o auxiliar), e o
manifesto declara `supportedOS` do Windows 10.

**Sem caminho alternativo.** A seção 1.2 deixava aberta a opção de chamar
`AssignProcessToJobObject` depois da criação suspensa. A 6C.6B.1 a descarta:
sem `JOB_LIST`, o launcher falha. Assim existe um único caminho, que é o
testado.

## 11. Sequência de inicialização segura

Notação: **[F n]** = falha fechada. O launcher sai com o código `n`, e o
auxiliar não executou nenhuma instrução.

```
 0. Política do próprio launcher (como no auxiliar, D57):
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32), SetErrorMode,
    mitigações do processo. Falha → [F 21].
 1. Argumentos: exatamente  --protocol 1 --helper-sha256 <64 hex minúsculos>,
    nessa ordem, sem nada além. Senão → [F 20], antes de qualquer outra ação.
 2. Saída padrão: GetStdHandle(STD_OUTPUT_HANDLE) é pipe (GetFileType);
    senão → [F 21]. Se não for herdável (GetHandleInformation), duplicá-la
    como herdável; falha → [F 21].
 3. Arquitetura: IsWow64Process2; máquina nativa diferente da imagem do
    launcher (emulação) → [F 21].
 4. Caminho do auxiliar: pasta do próprio launcher (GetModuleFileNameW,
    conferido por GetFinalPathNameByHandleW do próprio executável) + nome
    fixo gerpro-dxcore-helper.exe. Nada vem de argumentos.
 5. Travar as pastas: abrir helpers\ e helpers\win32-<arch>\ com
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT e
    compartilhamento FILE_SHARE_READ | FILE_SHARE_WRITE (sem
    FILE_SHARE_DELETE). Ponto de reanálise recusado. Falha → [F 23].
 6. Travar o arquivo: CreateFileW(GENERIC_READ, FILE_SHARE_READ,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN).
    Conferir: arquivo comum, sem ponto de reanálise, tamanho de 1 KiB a
    8 MiB, GetFinalPathNameByHandleW igual ao caminho esperado (sem link nem
    junção). Guardar FileId + VolumeSerialNumber (FileIdInfo). Falha → [F 23].
 7. Hash prévio: SHA-256 lido pelo identificador do passo 6 (BCrypt,
    provedor do sistema) igual ao argumento. Diferente → [F 24]. É só uma
    rejeição barata; o hash que vale é o do passo 12.
 8. Job: CreateJobObjectW(NULL, NULL) → SetInformationJobObject(
    JobObjectExtendedLimitInformation) com KILL_ON_JOB_CLOSE |
    ACTIVE_PROCESS(1) | DIE_ON_UNHANDLED_EXCEPTION | PROCESS_MEMORY |
    JOB_MEMORY; sem BREAKAWAY_OK/SILENT_BREAKAWAY_OK; sem restrições de
    interface. Reler com QueryInformationJobObject e comparar as flags.
    Falha → [F 22].
 9. Lista de atributos (3 entradas, buffer estático):
    JOB_LIST = { J }, HANDLE_LIST = { saída padrão },
    CHILD_PROCESS_POLICY = RESTRICTED. Falha → [F 22].
10. CreateProcessW(caminho do passo 4, "gerpro-dxcore-helper.exe --protocol 1",
    NULL, NULL, TRUE,
    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW |
    CREATE_UNICODE_ENVIRONMENT,
    ambiente { SystemRoot, windir }, cwd = System32,
    STARTF_USESTDHANDLES só com hStdOutput; entrada e erro NULL).
    Falha → [F 25] (por H-J1, sem processo).
11. Conferências com o processo SUSPENSO, nesta ordem:
    a. IsProcessInJob(processo, J) == TRUE;
    b. QueryInformationJobObject(J, JobObjectBasicAccountingInformation):
       ActiveProcesses == 1 e TotalProcesses == 1;
    c. imagem: QueryFullProcessImageNameW(processo) → abrir esse caminho
       (só leitura de atributos) → FileId + VolumeSerial iguais aos do
       passo 6.
    Qualquer falha → TerminateJobObject(J, 26) → [F 26].
12. Hash definitivo: reler o arquivo pelo identificador do passo 6 e
    recalcular o SHA-256. Com a imagem já mapeada pelo processo suspenso,
    nenhuma escrita deve ser possível (H-F3). Diferente → TerminateJobObject
    → [F 24].
13. Só agora fechar os identificadores do arquivo e das pastas.
14. ResumeThread: uma única chamada no código, depois de 11 e 12. Retorno
    diferente de 1 → TerminateJobObject → [F 26].
15. Esperar o processo (prazo do launcher; ver 12).
```

**Por que o hash definitivo vem depois da criação (passo 12).** Um
mapeamento gravável criado **antes** do passo 6 continua podendo alterar o
arquivo depois que o identificador dele é fechado, e o modo de
compartilhamento não impede isso. Pela regra que se espera do gerenciador de
memória, a criação da seção de imagem falha enquanto houver referência
gravável ao arquivo, e abrir para escrita falha enquanto a seção de imagem
existir (H-F2, H-F3). Se essas hipóteses se confirmarem, o conteúdo relido no
passo 12 é o que o processo suspenso mapeou. Se não se confirmarem, o passo 12
continua detectando trocas feitas até ali, mas não prova o conteúdo mapeado.
Isso fica registrado na seção 13.

### 11.6 Códigos de saída do launcher (substituem a 1.6)

O launcher **não escreve nada** na própria saída padrão nem na de erro. A
única saída é a do auxiliar, pelo pipe herdado. Em qualquer falha anterior ao
passo 14, o pipe fica vazio.

| Código | Nome (proposta para o contrato) | Quando | O auxiliar rodou? |
| --- | --- | --- | --- |
| 0, 10, 11, 12, 13, 64 | os de `DXCORE_EXIT_CODES` | código do auxiliar, repassado sem alteração | sim |
| 20 | `host-arguments` | passo 1 | não |
| 21 | `host-environment` | passos 0, 2, 3 | não |
| 22 | `host-job` | passos 8, 9 | não |
| 23 | `host-file` | passos 5, 6 | não |
| 24 | `host-integrity` | passos 7, 12 | não |
| 25 | `host-create` | passo 10 | não |
| 26 | `host-verify` | passos 11, 14 | não |
| 27 | `host-timeout` | prazo do launcher; job encerrado e fim confirmado | sim, interrompido |
| 28 | `host-containment` | auxiliar terminou com código fora do contrato (inclusive exceção do Windows), ou a contabilidade do job mostra mais de um processo | sim |
| 29 | `host-unconfirmed` | job encerrado sem confirmação do fim do processo dentro da tolerância | sim, situação incerta |

O app trata 20–29 como `failed/exit-code`. Hoje isso já cai em `crashed` e no
fallback. O contrato tipado entra na 6C.6B.2 só para o diagnóstico interno,
com valores enumerados e sem texto do sistema. Nenhum código carrega caminho,
identificador de processo, LUID ou mensagem.

## 12. Modelo de encerramento

### 12.1 Protocolo Node ↔ launcher

| Aspecto | Contrato |
| --- | --- |
| Executável | `<recursos>\helpers\win32-<arch>\gerpro-helper-host.exe` (nome, pasta e arquitetura fixos) |
| Argumentos | `['--protocol', '1', '--helper-sha256', <hash do auxiliar, da constante do app>]`; o launcher recusa qualquer outra forma (20) |
| Entrada | `ignore` (sem entrada) |
| Saída padrão | pipe; até 64 KiB (`DXCORE_HELPER.maxStdoutBytes`), lida só com código 0 |
| Saída de erro | pipe; até 4 KiB, só contada; o launcher não escreve nela |
| Ambiente e diretório | os do executor atual (`SystemRoot`, `windir`, `PATH` = System32; cwd = System32) |
| Prazos | auxiliar no launcher: 2.000 ms; confirmação do fim do job: 500 ms; Node: 3.000 ms + 2.000 ms de tolerância (inalterados) |

### 12.2 Situações

| Situação | O que acontece | `process` (D60) | Resultado |
| --- | --- | --- | --- |
| Falha antes do `ResumeThread` | launcher sai com 20–26; job (se criado) fechado; o auxiliar nunca rodou | `exited` | `failed/exit-code` → fallback |
| Auxiliar termina sozinho | launcher repassa o código e fecha J | `exited` | `success` ou `failed/exit-code` |
| Prazo do launcher (2 s) | `TerminateJobObject(J, 27)`; espera até 500 ms o identificador do auxiliar; sai com 27 (ou 29 sem confirmação) | `exited` | `failed/exit-code` → fallback |
| Prazo do Node (3 s) ou cancelamento | `superviseProcess` encerra o launcher; o kernel fecha o identificador de J; `KILL_ON_JOB_CLOSE` encerra o auxiliar; `close` só chega quando as duas pontas do pipe fecham | `stopped` | `timeout` / `cancelled` |
| `close` não chega em 2 s | algum processo ainda segura o pipe (ex.: J mantido vivo por identificador duplicado, R15) | `exit-unconfirmed` | o executor bloqueia novas execuções (`previous-unconfirmed`) até o `close` |
| App sai | o job da libuv (se presente, T-R1) encerra o launcher → J fecha | — | sem resultado; nenhum órfão esperado |
| App sai sem o job da libuv | o launcher segue até o próprio prazo (2,5 s no máximo) e encerra J | — | vida máxima limitada |
| Descendentes do auxiliar | ficam em J (job imediato sem saída, 9.3); `ACTIVE_PROCESS = 1` os encerra na associação; `TerminateJobObject`/`KILL_ON_JOB_CLOSE` cobrem qualquer resto | — | contabilidade > 1 → 28 |

**Confirmação de encerramento.** O launcher só declara o fim quando o
identificador do auxiliar fica sinalizado: `TerminateJobObject` sozinho não
conta (H-T1). Do lado do Node continua valendo a regra da D60 (só o `close`
confirma), e agora ela cobre a árvore inteira.

## 13. TOCTOU: o que resta

O desenho **reduz** as janelas. **Não há evidência** de que as elimine: cada
item abaixo depende de um teste real antes de qualquer afirmação mais forte.

| # | Janela | Situação | Depende de |
| --- | --- | --- | --- |
| T1 | Launcher trocado entre a conferência do Node e o `spawn` | **Aberta**, igual à D56: o Node não executa a partir de identificador. A conferência posterior detecta só trocas que permanecem | Instalação por máquina + assinatura |
| T2 | Auxiliar alterado por escrita direta entre os passos 6 e 12 | Fechada **se** H-F1 (identificador sem `FILE_SHARE_WRITE` impede novas aberturas para escrita) | T-F1 |
| T3 | Auxiliar renomeado, apagado ou substituído | Fechada **se** H-F1 (sem `FILE_SHARE_DELETE`) e H-F4 (pastas abertas sem `FILE_SHARE_DELETE` não podem ser renomeadas) | T-F1, T-F4 |
| T4 | Mapeamento gravável anterior ao passo 6 | Detectada no passo 12 **se** H-F2/H-F3 | T-F2, T-F3 |
| T5 | `CreateProcessW` abre o caminho de novo (resolução por nome) | Conferida no passo 11c pelo FileId; a própria conferência resolve o caminho de novo, mas com arquivo e pastas travados | T-F4 |
| T6 | `CreateProcessW` recusado pelo modo de compartilhamento do launcher | Não é risco de segurança (falha fechada, 25), mas é risco de funcionamento: o carregador precisa abrir o arquivo para execução enquanto o launcher o mantém aberto só com `FILE_SHARE_READ` (H-F5) | T-F5 |
| T7 | Pastas acima de `helpers\` (raiz da instalação) trocadas por junção | O Node confere `realpath`; o launcher confere `GetFinalPathNameByHandleW` do próprio executável e do auxiliar | — |
| T8 | Quem escreve na pasta da instalação troca o asar com os hashes | **Fora do alcance** de qualquer verificação interna | Instalação por máquina |
| T9 | Auxiliar comprometido em execução (R15) | Não é TOCTOU, mas limita o que as conferências garantem | Isolamento opcional (16.3) |

Hipóteses de sistema de arquivos (NTFS, volume local):

- **H-F1** Um identificador aberto sem `FILE_SHARE_WRITE`/`FILE_SHARE_DELETE`
  faz falhar novas aberturas para escrita, renomeação ou exclusão do arquivo.
- **H-F2** A criação da seção de imagem (dentro de `CreateProcessW`) falha
  enquanto houver mapeamento gravável do arquivo.
- **H-F3** Com a seção de imagem existente, o arquivo não pode ser aberto
  para escrita.
- **H-F4** Uma pasta aberta sem `FILE_SHARE_DELETE` não pode ser renomeada nem
  apagada.
- **H-F5** `CreateProcessW` consegue abrir o executável enquanto o launcher o
  mantém aberto com `GENERIC_READ` e só `FILE_SHARE_READ`.

## 14. Verificação dos dois binários

| Etapa | Launcher (`gerpro-helper-host.exe`) | Auxiliar (`gerpro-dxcore-helper.exe`) |
| --- | --- | --- |
| Build | mesmo script, mesma toolchain, `/Brepro`, reprodutível | idem (inalterado) |
| PE (`pe-inspect.ts`) | x64, console, ASLR/alta entropia/NX/CFG/CET, `DependentLoadFlags 0x800`, `asInvoker`, só `KERNEL32.dll` (mais `bcrypt.dll` da System32, se o SHA-256 usar BCrypt), com **lista explícita** de importações permitidas, incluindo as de job e de processo | regra atual; **nenhuma** API de criação de processo ou de job permitida |
| Registro de aprovação | `approved/win32-x64.json` com dois blocos (`host`, `helper`), cada um com `sha256Unsigned`, `sha256`, tamanho e hash dos fontes | idem |
| Constante no app | proposta: `DXCORE_HELPER_SHA256 = { x64: { host: null, helper: null }, arm64: { host: null, helper: null } }`; hoje continua `{ x64: null, arm64: null }` | — |
| Ativação | **só com os dois valores não nulos**; um nulo → `integrity-unknown` | — |
| Conferência pelo Node, antes | todas as regras da D56 (raiz, link, junção, tamanho, hash) | as mesmas regras, no arquivo do auxiliar (rejeição cedo) |
| Conferência pelo launcher | — (ele não confere a si mesmo; não teria valor) | passos 6, 7, 11c, 12 |
| Conferência pelo Node, depois | identidade (dispositivo, inode, tamanho, data, hash) igual | idem |
| Recusas | `rejected/<motivo>` com `component: 'host' \| 'helper'` (enumerado) | idem |
| Hash do auxiliar entregue ao launcher | só pelo argumento, vindo da constante do app | — |
| Testes de barreira (estáticos) | constante = registro; fontes = hashes registrados; importações = lista | idem |

**Alternativa registrada, não recomendada:** embutir o hash do auxiliar
**no** launcher durante o build. Isso elimina o argumento, mas acopla os
builds (mudar o auxiliar exige reconstruir e reaprovar o launcher) e não
aumenta a garantia: quem troca a constante do app também consegue trocar o
launcher.

### 14.1 Integração ao `BundledHelperRunner` sem enfraquecer o que existe

| Garantia atual | Como continua |
| --- | --- |
| Hash obrigatório | dois hashes, ambos obrigatórios; nulo → recusa |
| Verificações de caminho | as mesmas (`isTrustedRoot`, `lstat`, `realpath`, tamanho) para os dois arquivos |
| Limites de saída | inalterados: 64 KiB e 4 KiB, aplicados ao launcher (a saída é a do auxiliar) |
| Fila de execução | inalterada: uma execução por vez, `previous-unconfirmed` (D60) |
| `AbortSignal` | inalterado: cancelar encerra o launcher; o job encerra o auxiliar |
| Fallback | inalterado: qualquer resultado diferente de `ok` devolve o mesmo objeto Electron + Registro (D59) |
| Consentimento | inalterado: o executor só roda dentro de `detect()` com `device-detection` |
| Entrada do executor | inalterada: só `AbortSignal`; nenhum caminho, argumento ou hash vem de quem chama |

## 15. Plano de testes

### 15.1 Sintéticos (sem executar binários; podem entrar na 6C.6B.2)

| ID | Teste |
| --- | --- |
| S1 | Fontes do launcher: `JOB_LIST`, `CHILD_PROCESS_POLICY`, `HANDLE_LIST`, `CREATE_SUSPENDED` e `EXTENDED_STARTUPINFO_PRESENT` presentes na única chamada de `CreateProcessW`; ausência de `BREAKAWAY_OK`, `SILENT_BREAKAWAY_OK`, `CREATE_BREAKAWAY_FROM_JOB`, `JobObjectBasicUIRestrictions`, `OpenJobObject`, nome de job e `AssignProcessToJobObject` |
| S2 | Uma única chamada de `ResumeThread`, depois das conferências (ordem verificada no fonte) |
| S3 | Nenhuma escrita na saída padrão ou de erro pelo launcher |
| S4 | Tabela de códigos 20–29 idêntica no header C++ e no contrato TS |
| S5 | Executor: argumentos fixos com o hash da constante; nenhum caminho do código executa o auxiliar diretamente (`spawn` sempre recebe o launcher) |
| S6 | Executor: os dois hashes conferidos antes e depois; um nulo → `integrity-unknown`; `component` correto em cada recusa |
| S7 | Executor (simulado): cada código 20–29 → `failed/exit-code` → fallback com perfil idêntico (padrão `deepEqual` da D59) |
| S8 | Fila, `AbortSignal`, `previous-unconfirmed` e limites de saída inalterados (os testes atuais passam sem mudar a expectativa) |
| S9 | `pe-inspect.ts`: lista de importações do launcher, com recusa de qualquer importação fora dela; o auxiliar continua sem APIs de processo ou de job |

### 15.2 Reais (exigem autorização; 6C.6C)

Executados com o supervisor da D55 e um **alvo de teste** separado (nunca
distribuído) no lugar do auxiliar. O DXCore não é executado nesses testes.

| ID | Objetivo | Hipótese |
| --- | --- | --- |
| T-R1 | De dentro do launcher iniciado pelo Electron 45, ler o próprio job (`QueryInformationJobObject(NULL, …)`): existência e flags do job da libuv | — |
| T-R2 | Alvo tenta `CreateProcess` comum: recusado; contabilidade de J | H-J2 |
| T-R3 | Electron iniciado dentro de um job externo **sem** saída permitida: o aninhamento funciona e J fica abaixo dele | H-J3 |
| T-R4 | Alvo tenta `CREATE_BREAKAWAY_FROM_JOB`: recusado | 9.3 |
| T-R5 | Alvo tenta `PARENT_PROCESS` com um processo do usuário: **documentar** o resultado (espera-se que seja possível; R15) | 9.2 |
| T-J1 | Associação impossível (ex.: job externo com limite já atingido): `CreateProcessW` falha e nenhum processo existe | H-J1 |
| T-H1 | Saída padrão herdada pelo alvo; `close` do Node só depois do fim do alvo | 9.4 |
| T-M1 | Pico de memória (`PeakProcessMemoryUsed`) do alvo e, na 6C.6D, do auxiliar real; alocação acima do limite falha | — |
| T-T1 | Prazo do launcher: alvo travado é encerrado, com confirmação em até 500 ms | H-T1 |
| T-K1 | Node encerra o launcher no meio: alvo encerrado; `close` em até 2 s | 9.3 |
| T-K2 | Electron encerrado (normal e forçado) no meio: nenhum processo remanescente | T-R1 |
| T-K3 | 100 execuções com cancelamento aleatório: zero processos remanescentes | — |
| T-F1…T-F5 | Escrita, renomeação, exclusão, mapeamento gravável prévio e renomeação de pastas durante a janela travada; `CreateProcessW` com o arquivo travado | H-F1…H-F5 |
| T-E1 | Falha forçada em cada passo de 0 a 14, provocada pelo ambiente de teste (nunca por opção do launcher distribuído): código correto e alvo nunca retomado | — |

Os resultados serão registrados neste documento numa tabela por hipótese
(confirmada ou refutada, e o efeito no desenho), sem identificadores de
processo nem caminhos.

## 16. Critérios para autorizar a implementação 6C.6B.2

### 16.1 Obrigatórios para começar a 6C.6B.2 (fontes, script e testes sintéticos)

1. Esta validação aceita, incluindo as correções à 6C.6A (9.2, 13) e a
   recusa do caminho sem `JOB_LIST` (10).
2. R15 aceito como risco **aberto**, com o isolamento (16.3) tratado depois,
   sem bloquear a 6C.6B.2.
3. Aprovados: a tabela de códigos 20–29 (11.6), o protocolo de argumentos
   (12.1), a forma da constante com dois hashes (14) e a lista inicial de
   importações do launcher.
4. Decisão explícita sobre **compilar** o launcher na 6C.6B.2 (a execução
   fica para a 6C.6C em qualquer caso).
5. Confirmado que o alvo de teste da 6C.6C será um fonte separado, fora do
   empacotamento, com nome que nunca colida com o do auxiliar.

### 16.2 Obrigatórios antes de qualquer execução (6C.6C)

- S1–S9 passando; PE do launcher aprovado; builds reprodutíveis.
- Roteiro dos testes reais aprovado, com critério de interrupção: qualquer
  processo remanescente encerra a bateria.

### 16.3 Opcional (avaliação separada)

- Executar o auxiliar em AppContainer (`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`)
  ou com token restrito de integridade baixa, para que a política de filhos e
  o job passem a valer contra um auxiliar comprometido (9.2). Exige teste de
  compatibilidade do DXCore nesse ambiente e fica fora do caminho crítico.
- Mitigações extras na criação (`PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY`:
  `PROHIBIT_DYNAMIC_CODE`; `BLOCK_NON_MICROSOFT_BINARIES` para as DLLs),
  depois de medir o efeito no DXCore.

---

# Parte III — Implementação do launcher (Etapa 6C.6B.2)

## 17. Situação

Implementado e compilado; **nunca executado**; **não conectado** ao app.
Detalhes do código, do build e da inspeção do binário:
`native/helper-host/README.md`.

| Item | Situação |
| --- | --- |
| Fontes | `native/helper-host/src` (C++17, MSVC v143, SDK 10.0.26100.0) |
| Build | `scripts/native/build-helper-host.mjs`; ambiente compartilhado com o auxiliar em `scripts/native/msvc-toolchain.mjs` (o auxiliar recompilado manteve o SHA-256 `d2e3aabc…84b13b`) |
| Binário | 114.688 bytes, SHA-256 `9c8f4a36…20da0c`, idêntico em dois builds limpos; **não** aplicado ao app |
| PE | x64, PE32+, `0xC160`, CFG instrumentado, CET, `DependentLoadFlags 0x800`, `asInvoker`, `supportedOS` do Windows 10, só `KERNEL32.dll` e `bcrypt.dll`, lista explícita de 105 funções (`HOST_ALLOWED_FUNCTIONS`) |
| Contrato TS | `src/main/hardware/local/dxcore-host-contract.ts`: argumentos, códigos 20–29, prazos, `DXCORE_HOST_SHA256 = null`, `DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES = null`, `dxcoreHostBlockers`. Nenhum módulo do app o importa (teste S5) |
| Executado | só `protocol_tests.exe` (lógica pura, 64 verificações, 0 falhas; sem APIs de processo, job ou arquivo no código de teste) |

## 18. Diferenças em relação ao plano (seções 11–12)

1. **Ordem dos passos 0 e 1.** Os argumentos são conferidos antes das
   proteções do processo, como no auxiliar: uma linha de comando errada sai
   com 20 sem fazer mais nada. Os códigos não mudam.
2. **Limite de memória não implementado.** Nenhum valor foi medido, e a
   etapa proíbe valor arbitrário. O job usa só `KILL_ON_JOB_CLOSE`,
   `ACTIVE_PROCESS = 1` e `DIE_ON_UNHANDLED_EXCEPTION`. A produção continua
   bloqueada também por `memory-limit-pending` (`dxcoreHostBlockers`), além
   dos hashes nulos.
3. **Contabilidade do job.** As conferências antes da retomada e depois do
   fim usam também `TotalTerminatedProcesses == 0` (processo encerrado por
   limite → 28).
4. **Caminho da imagem.** O passo 11c compara também o caminho devolvido por
   `QueryFullProcessImageNameW` com o caminho esperado (sem diferenciar
   maiúsculas), além do volume e do FileId.
5. **Falha de espera** (`WAIT_FAILED`) depois da retomada: job encerrado; 28
   com confirmação, 29 sem.

## 19. Pendências antes da 6C.6C

- **Alvo de teste.** Preparado na 6C.6C.1 (aguarda aprovação): variante
  de build `GERPRO_HOST_TEST_BUILD` dos mesmos fontes, com outro nome de
  launcher, de alvo e de pasta e com os resumos dos alvos sintéticos fixados
  no build; o protocolo de produção não mudou e o launcher de produção saiu
  byte a byte igual. Detalhes, isolamento e roteiro: `docs/11-testes-contencao.md`.
- **Limite de memória** (T-M1).
- Todas as hipóteses H-J1…H-J3, H-T1, H-F1…H-F5 e T-R1 continuam sem
  evidência real.
- Testes que o ambiente da 6C.6C.1 não cobre (T-R3, T-J1, T-R5, códigos 22,
  25 e 26 do T-E1): `docs/11-testes-contencao.md`, seção 5.
- **Falha do T-H1 (6C.6C.2B/2C).** Com `CREATE_NO_WINDOW`, o alvo de console
  morre na inicialização (`0xC0000142`) e o launcher sai com 28; J nunca
  contou outro processo. A produção, como está, não serviria ao auxiliar
  real. Correção `DETACHED_PROCESS` validada na 6C.6C.2D e **aplicada** na
  6C.6C.2E (novo launcher de produção `101c3b4a…9bc7`, ainda não aprovado no
  app; testes `4b7f9c7f…2e26`). Falta repetir o Grupo A.
  `docs/11-testes-contencao.md`, seções 11 a 13.
