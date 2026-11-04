# gerpro-lock-holder-test.exe (só de teste)

Artefato nativo **só de diagnóstico** da Etapa 6C.6C.3F (docs/11, seção 20;
D75). Segura, por pouco tempo, as mesmas travas que o launcher
(`native/helper-host/src/main.cpp`) cria, para os cenários T-F1, T-F2 e T-F4.

- Nunca é distribuído: fica fora de `resources/`, de qualquer empacotamento
  e do git (`/native/lock-holder-test/build/`).
- O app não o conhece. Desde a 6C.6C.3G, o supervisor de diagnósticos o usa
  só em `--file-lock=T-F1.exit-ok` e `--file-lock=T-F4.exit-ok` (docs/11,
  seção 21): copia o binário conferido para a pasta do caso, confere a cópia
  de novo logo antes do início e a inicia com `TMP` = `TEMP` = pasta
  temporária resolvida.
- Nunca foi executado (nem na 6C.6C.3F nem na 6C.6C.3G).

## Linha de comando (fixa)

```
gerpro-lock-holder-test.exe --mode=<file|mapping|directory> --case-dir=<pasta>
```

`<pasta>` = `<pasta temporária do sistema>\gerpro-6c6c-<sufixo>\<NN>-T-F<n>.<id>`,
com `<n>` = 1 (`file`), 2 (`mapping`) ou 4 (`directory`). Os alvos têm nomes
fixos: `host-test`, `host-test\win32-x64` e
`host-test\win32-x64\gerpro-synthetic-helper.exe`.

| Modo | O que segura | Aberturas |
| --- | --- | --- |
| `file` | o arquivo do alvo | as do passo 6 do launcher: `GENERIC_READ`, só `FILE_SHARE_READ`, `FILE_FLAG_OPEN_REPARSE_POINT \| FILE_FLAG_SEQUENTIAL_SCAN` |
| `mapping` | seção `PAGE_READWRITE` e uma vista `FILE_MAP_WRITE` do arquivo | arquivo aberto com `GENERIC_READ \| GENERIC_WRITE` e só `FILE_SHARE_READ`, **fechado logo depois da seção**; a vista nunca é acessada |
| `directory` | `host-test` e `win32-x64` | as do passo 5: `FILE_LIST_DIRECTORY \| FILE_READ_ATTRIBUTES \| SYNCHRONIZE`, `FILE_SHARE_READ \| FILE_SHARE_WRITE`, `FILE_FLAG_BACKUP_SEMANTICS \| FILE_FLAG_OPEN_REPARSE_POINT` |

## Protocolo

1. A entrada padrão tem de ser um pipe (do supervisor); senão, 41.
2. Com as travas obtidas, uma linha na saída padrão:
   `gerpro-lock-holder-test v=1 ready mode=<modo> volume=<8 hex> index=<16 hex>[,<16 hex>]`
   (volume e índice iguais a `dev` e `ino` do `fs.statSync` do Node; no
   modo `directory`, `host-test` e depois `win32-x64`).
3. Liberação: a entrada padrão fechada ou qualquer byte nela (nada é lido).
4. Prazo próprio fixo de **10 s** desde o início, sem argumento que o mude.
5. Antes de sair, solta tudo (vista, seção, arquivo, pastas) e escreve
   `gerpro-lock-holder-test v=1 released reason=<stdin|deadline|wait-failure>`.

## Códigos de saída

| Código | Significado |
| --- | --- |
| 0 | liberação pedida pelo supervisor (entrada fechada ou byte) |
| 40 | argumentos fora do formato fixo |
| 41 | ambiente recusado (entrada não é pipe, saída ausente, endurecimento, pasta temporária) |
| 42 | caminho recusado (base, nomes, links/junções, caminho final, tipo, tamanho, hard link) |
| 43 | abertura, seção ou vista recusada |
| 44 | sinal de prontidão não escrito (travas já soltas) |
| 45 | prazo próprio vencido (travas soltas pelo prazo) |
| 46 | falha ao acompanhar a entrada padrão (travas soltas) |

## Build (sem execução)

No ambiente x64 do MSVC v143:

```
node scripts/native/build-lock-holder-test.mjs --confirm-native-build --reproducibility-check
```

Grava só em `native/lock-holder-test/build/{x64,x64-repro}` e
`lock-holder-manifest.json`; recusa e apaga o binário fora da política
(`checkLockHolderBinary` em `scripts/native/pe-inspect.ts`).
