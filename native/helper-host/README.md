# gerpro-helper-host (launcher do auxiliar DXCore)

Launcher nativo do Gerpro Studio (D61). Cria o auxiliar
`gerpro-dxcore-helper.exe` **suspenso e já dentro de um Job Object**, confere
a contenção e a integridade, e só então o deixa rodar. Desenho e validação:
`docs/10-ativacao-dxcore.md`, seções 9–16.

**Situação (Etapa 6C.6B.2):** implementado e compilado (MSVC 14.44.35207,
Windows SDK 10.0.26100.0, x64), reproduzível em dois builds limpos. **Nunca
foi executado.** Só o binário de testes da lógica pura (`protocol_tests.exe`)
foi executado: ele não cria processos nem jobs e não abre arquivos. **Não
está conectado ao app:** o `BundledHelperRunner` não o conhece,
`DXCORE_HOST_SHA256` e `DXCORE_HELPER_SHA256` continuam `null`, e
`dxcoreHostBlockers` aponta, além dos hashes, o limite de memória pendente.

## Estrutura

| Arquivo | Papel |
| --- | --- |
| `src/main.cpp` | sequência de inicialização (passos 0–15), job, criação suspensa, conferências, espera e códigos de saída |
| `src/protocol.h/.cpp` | lógica pura: argumentos, hash em texto, comparação em tempo constante, caminhos, repasse do código do auxiliar |
| `src/integrity.h/.cpp` | SHA-256 pelo identificador travado (BCrypt, provedor do sistema) |
| `src/exit_codes.h` | códigos 20–29 (iguais a `DXCORE_HOST_EXIT_CODES`) |
| `src/host.manifest` | `supportedOS` do Windows 10/11 (o nível `asInvoker` vem do linker) |
| `tests/protocol_tests.cpp` | testes da lógica pura (73 verificações; 67 na variante de testes) |
| `test-artifacts/synthetic_helper.cpp` | alvo SINTÉTICO só de teste (6C.6C.1; nunca distribuído) |

Sem dependências de terceiros, sem exceções, sem RTTI, sem alocação dinâmica
pelo launcher (buffers estáticos). Importações estáticas: só `KERNEL32.dll` e
`bcrypt.dll`, ambas da System32 (`/DEPENDENTLOADFLAG:0x800`), com **lista
explícita** de funções em `HOST_ALLOWED_FUNCTIONS` (`scripts/native/pe-inspect.ts`).

## Protocolo

```
gerpro-helper-host.exe --protocol 1 --helper-sha256 <64 hex minúsculos>
```

Nada mais é aceito (código 20). O caminho do auxiliar nunca vem de argumento:
é `<pasta do próprio launcher>\gerpro-dxcore-helper.exe`, e a pasta tem de
terminar em `helpers\win32-x64`. O launcher não lê variáveis de ambiente. O
ambiente do auxiliar (`SystemRoot`, `windir`) e o diretório de trabalho
(System32) vêm das APIs do sistema.

Saídas: o launcher **não escreve nada**. A saída padrão é a do auxiliar, pelo
pipe herdado. O código de saída é o do auxiliar (0, 10–13, 64) ou um destes:

| Código | Quando | O auxiliar rodou? |
| --- | --- | --- |
| 20 | argumentos | não |
| 21 | proteções do processo, saída padrão não é pipe, emulação de arquitetura, ambiente | não |
| 22 | job ou atributos de criação | não |
| 23 | caminho do launcher, pastas, arquivo do auxiliar (tipo, tamanho, link, caminho final) | não |
| 24 | hash do auxiliar (prévio ou definitivo) | não |
| 25 | `CreateProcessW` falhou | não |
| 26 | conferência antes da retomada (job, contabilidade, imagem) ou `ResumeThread` | não |
| 27 | prazo de 2 s; job encerrado e fim confirmado | sim, interrompido |
| 28 | código fora do contrato (inclusive exceção), processo extra ou encerrado por limite no job, falha de espera | sim |
| 29 | job encerrado sem confirmação do fim em 500 ms | sim, situação incerta |

## Sequência implementada

A ordem é a da seção 11 de `docs/10`, com uma diferença: os argumentos são
conferidos **antes** das proteções do processo (como no auxiliar), para que
uma linha de comando errada saia com 20 sem fazer mais nada.

1. `SetErrorMode` (sem caixas de diálogo).
2. Argumentos exatos → 20.
3. `SetDefaultDllDirectories(SYSTEM32)`, política de imagens, pontos de
   extensão desligados, handles estritos → 21.
4. Saída padrão é pipe; herdável (ou duplicada como herdável) → 21.
5. `IsWow64Process2`: sem emulação, máquina nativa = x64 → 21.
6. Ambiente mínimo pelas APIs do sistema → 21.
7. Caminho do próprio executável igual ao caminho final (sem junção, link,
   nome curto, unidade substituta, rede); nome e pastas fixos → 23.
8. Pastas `helpers` e `win32-x64` abertas com `FILE_LIST_DIRECTORY`, sem
   `FILE_SHARE_DELETE`, sem seguir ponto de reanálise, caminho final
   conferido → 23.
9. Auxiliar aberto com `GENERIC_READ` e só `FILE_SHARE_READ`, sem seguir ponto
   de reanálise; arquivo de disco comum, 1 KiB–8 MiB, caminho final conferido;
   volume + FileId guardados → 23.
10. SHA-256 prévio pelo identificador travado → 24.
11. Job: `CreateJobObjectW(nullptr, nullptr)` (sem nome, não herdável),
    `KILL_ON_JOB_CLOSE | ACTIVE_PROCESS(1) | DIE_ON_UNHANDLED_EXCEPTION`, sem
    saída de job, sem restrições de interface; limites relidos e comparados → 22.
12. Atributos: `JOB_LIST = {job}`, `HANDLE_LIST = {saída padrão}`,
    `CHILD_PROCESS_POLICY = RESTRICTED` (só defesa adicional) → 22.
13. `CreateProcessW` com `CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
    DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT`, herança limitada pela
    lista, entrada e erro nulos → 25. Sem console: até a 6C.6C.2D era
    `CREATE_NO_WINDOW`, e o auxiliar morria na inicialização (D67).
14. Com o processo suspenso: `IsProcessInJob`; contabilidade do job
    (1 ativo, 1 no total, nenhum encerrado por limite); imagem do processo
    com o mesmo caminho, volume e FileId do arquivo travado → senão encerra o
    job e sai com 26.
15. SHA-256 definitivo pelo identificador travado → senão encerra o job e
    sai com 24.
16. Travas liberadas; `ResumeThread` (única chamada) deve devolver 1 → senão 26.
17. Espera de 2 s. Fim: contabilidade conferida de novo (senão 28) e código
    do auxiliar repassado (fora do contrato → 28). Prazo: `TerminateJobObject`
    e espera de 500 ms pelo processo → 27, ou 29 sem confirmação.

Ao sair, o identificador do job é fechado; `KILL_ON_JOB_CLOSE` encerra
qualquer resto.

## Limites de recursos

| Limite | Situação |
| --- | --- |
| `KILL_ON_JOB_CLOSE` | implementado |
| `ACTIVE_PROCESS = 1` | implementado |
| `DIE_ON_UNHANDLED_EXCEPTION` | implementado |
| Saída de job (`BREAKAWAY_OK`, `SILENT_BREAKAWAY_OK`) | nunca concedida |
| Memória (`PROCESS_MEMORY`, `JOB_MEMORY`) | **pendente**: só depois de medir o pico real (T-M1, 6C.6C). Nenhum valor arbitrário. Enquanto isso, `DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES = null` mantém `memory-limit-pending` em `dxcoreHostBlockers` |
| Tempo | prazo de parede no launcher (2 s + 500 ms); sem limite de CPU do job |

## O que **não** está garantido

- O TOCTOU é **reduzido, não eliminado** (docs/10, seção 13). As travas
  dependem das hipóteses H-F1 a H-F5, ainda não testadas.
- A política de processos filhos e o job **não** são fronteira de segurança
  contra um auxiliar comprometido do mesmo usuário (R15).
- O comportamento real de `JOB_LIST`, do job da libuv no Electron 45, do
  aninhamento e do encerramento só será conhecido na 6C.6C.

## Build

No ambiente x64 do MSVC v143 (`vcvarsall.bat x64 -vcvars_ver=14.44`), na
raiz do projeto:

```
node scripts/native/build-helper-host.mjs --check-toolchain
node scripts/native/build-helper-host.mjs --confirm-native-build --reproducibility-check
```

Mesmo ambiente restrito e mesmas opções do auxiliar (`msvc-toolchain.mjs`),
mais `/MANIFESTINPUT:src\host.manifest` e `bcrypt.lib`. O script não executa
nada do que compila. Saídas (fora do git): `resources/helpers/win32-x64/
gerpro-helper-host.exe` e `native/helper-host/build/` (objetos, testes,
`build-manifest.json`).

### Primeiro build (Etapa 6C.6B.2)

- Launcher: 114.688 bytes, SHA-256
  `9c8f4a3678f36976a65490f7c9a2eec2e1ed9cba8f343b1332946fa02020da0c`
  (**não** aplicado ao app). `protocol_tests.exe`: SHA-256
  `f7ba14e3f9011408a523e0ed8b9e46e7f5dc91f4420105194c700765796f9ec1` (na 6C.6C.1, com os testes novos de `DigestInSet` e do layout de testes:
  `db01eeb22cfb90f72f1930f2c4ed118d8ef61caf6949fef44848e805d00de47b`).
- Dois builds limpos: launcher e testes idênticos byte a byte.
- `pe-inspect.ts` e `dumpbin` concordam: `0x8664`, PE32+, console,
  DllCharacteristics `0xC160`, Guard Flags `0x10017500`, CET compatível,
  Dependent Load Flag `0x800`, só `KERNEL32.dll` e `bcrypt.dll`, manifesto
  `asInvoker`/`uiAccess='false'` com `supportedOS` do Windows 10, sem PDB e
  sem caminhos embutidos.
- `/W4 /WX` sem avisos; nenhuma proteção desligada.
- O auxiliar foi recompilado com o script refatorado e manteve o SHA-256
  `d2e3aabc…84b13b`: a extração de `msvc-toolchain.mjs` não mudou o build dele.

## Variante de testes (6C.6C.1)

`scripts/native/build-host-test-artifacts.mjs` compila os **mesmos** fontes
com `/DGERPRO_HOST_TEST_BUILD` (`gerpro-helper-host-test.exe`) e o alvo
sintético `test-artifacts/synthetic_helper.cpp`, um binário por cenário
(`gerpro-synthetic-helper.exe`). A variante muda só a identidade (nome do
launcher, do alvo e a pasta `host-test`, em `protocol.h`), a linha de comando
do alvo e exige, além do argumento, um dos resumos sintéticos fixados no
build (`synthetic_digests.h`, gerado na pasta de build; nunca nos fontes). A
sequência, o protocolo, os códigos e a lista de importações são os mesmos.

Saídas só em `native/helper-host/build/test/` (fora do git, fora de
`resources/`). Nada foi executado além dos testes da lógica pura das duas
variantes (73 e 67 verificações, 0 falhas). Isolamento, cenários, hashes e
roteiro dos testes reais: `docs/11-testes-contencao.md`.

O launcher de produção, recompilado depois da mudança, continuou com SHA-256
`9c8f4a36…20da0c` (byte a byte igual); o build de produção confere que o
binário não contém nomes da variante de testes (`checkVariantIdentity`).

## Variante diagnóstica (6C.6C.2C)

`scripts/native/build-host-diag-artifacts.mjs` compila os mesmos fontes com
`/DGERPRO_HOST_TEST_BUILD /DGERPRO_HOST_DIAG_BUILD` e
`test-artifacts/host_diag.cpp`. Os pontos de registro ficam em blocos `#if`
próprios de `main.cpp`. A variante:

- tem uma porta de conclusão própria;
- faz consultas só de leitura a J;
- escreve uma linha ASCII no fim (`gerpro-host-diag v=1 …`);
- aceita só o resumo do alvo `exit-ok`.

Desde a 6C.6C.2E, a variante usa a mesma criação da produção
(`DETACHED_PROCESS`). A antiga chave de comparação
`GERPRO_HOST_DIAG_DETACHED` e a variante `nowindow` deixaram de existir.
Saída em `native/helper-host/build/test/diag/detached/`.

O próprio build recompila os fontes sem a variante e confere que o launcher
de produção e o de testes saem byte a byte iguais aos aprovados. Resultado e
interpretação: `docs/11-testes-contencao.md`, seção 11.
