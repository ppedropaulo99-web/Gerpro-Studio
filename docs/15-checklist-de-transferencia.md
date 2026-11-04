# Checklist de transferência

Roteiro para formalizar o recebimento do Gerpro Studio pela equipe Cognitiva.
Marque cada item na sessão de transferência e registre as observações.

Referência entregue: repositório `ppedropaulo99-web/Gerpro-Studio`, branch
`main`, commit `6996e5563ddd9435a962e44b8991685c2edfe5c5`.

> O que é entregue é um **protótipo de referência, não pronto para
> produção**.

## 1. Acesso

- [ ] Membros da equipe Cognitiva com acesso ao repositório no GitHub
      (leitura; escrita conforme decisão do PM/PO).
- [ ] Definido quem administra o repositório depois da transferência.
- [ ] Combinada a política de branches e revisão (por exemplo, proteção da
      `main` e PRs obrigatórios).

## 2. Clonar e executar

Sempre a partir do **clone** do repositório, nunca de uma cópia da pasta
local, que contém binários e arquivos ignorados.

- [ ] Node.js ≥ 22.18 e npm ≥ 10 instalados.
- [ ] `git clone` e `npm install` sem erros.
- [ ] `npm run typecheck` sem erros.
- [ ] `npm test`: 1.565 testes, **1.539 aprovados e 26 pulados** num clone
      limpo. Os pulados dependem de builds nativos locais.
- [ ] `npm run build` sem erros.
- [ ] `npm run dev` abre o app.
- [ ] Opcional: Ollama instalado em `127.0.0.1:11434`, com pelo menos um
      modelo de conversa.

## 3. Leitura dos documentos

- [ ] [Guia de transferência](12-guia-de-transferencia.md)
- [ ] [Visão do produto](13-visao-do-produto.md)
- [ ] [Inventário e riscos](09-inventario-e-riscos.md)
- [ ] [Handoff](08-handoff.md)
- [ ] [Roadmap de engenharia](14-roadmap-de-engenharia.md)
- [ ] [Arquitetura](02-arquitetura.md), [Contratos](03-contratos.md) e
      [Pontos de integração](06-pontos-de-integracao.md)

## 4. Demonstração funcional

Roteiro sugerido, com o que é real e o que é simulado:

| Passo | O que mostrar | Natureza |
|---|---|---|
| 1 | **Agentes**: criar, editar, arquivar e restaurar um agente; duplicar um exemplo | Real |
| 2 | **Conversas**: conversar com um agente usando um modelo do Ollama; fechar e reabrir o app e ver a conversa preservada | Real (exige Ollama) |
| 3 | **Execuções**: acompanhar e cancelar uma execução da sessão | Real, só em memória |
| 4 | **Modelos**: lista dos modelos instalados | Real; a biblioteca é de exemplo |
| 5 | **Configurações**: tema claro/escuro | Real; as demais preferências ainda não têm efeito |
| 6 | **Configurações › Hardware e desempenho** e **Agentes › Recomendações** | Consentimento real; perfis **fictícios** |
| 7 | **Apresentação Guiada** | Percorre as telas reais com execução **simulada** |
| 8 | **Ferramentas**, **Gerpro AI**, **Desenvolvedor** | Catálogo declarado e telas informativas, sem execução |

- [ ] Demonstração feita e registrada.
- [ ] Ficou claro que **não há** personalização (campos, telas, layouts,
      workflows, regras, publicação) nem integração com o Gerpro.com.

## 5. Limitações e componentes desativados

- [ ] Lidas as limitações e os riscos
      ([Inventário › Riscos e pendências](09-inventario-e-riscos.md#riscos-e-pendências)).
- [ ] Entendido que o detector local, o auxiliar DXCore, o launcher e o Lock
      Holder **não estão autorizados para produção**: hashes `null`,
      `UnimplementedLocalDetector`, escopo `demo-only`
      ([Handoff §11](08-handoff.md#11-componentes-desativados-e-ferramentas-de-diagnóstico)).
- [ ] Entendido que `scripts/diagnostics/` não entra em CI e só roda com
      flags de confirmação.
- [ ] Limitações adicionais encontradas pela equipe registradas abaixo.

## 6. Responsáveis

| Área | Responsável |
|---|---|
| Liderança técnica | |
| Integração Gerpro.com | |
| Motor de personalização | |
| Segurança | |
| Engenharia de produto (CI, empacotamento) | |
| Módulo de agentes de IA | |
| PM/PO (visão e priorização) | responsável pelo produto (Gerpro) |

## 7. Pendências e aceite

**Pendências registradas na transferência:**

| # | Pendência | Responsável | Observação |
|---|---|---|---|
| 1 | | | |

**Aceite de recebimento**

Este aceite registra o **recebimento do protótipo de referência e da sua
documentação**. Ele **não** é uma homologação para produção, não aprova a
arquitetura como definitiva e não autoriza a ativação de nenhum componente
desativado.

- [ ] O repositório no commit indicado foi recebido, executado e entendido.
- [ ] As limitações e os componentes desativados foram registrados.
- [ ] Os responsáveis técnicos foram definidos.

| | Nome | Data | Assinatura |
|---|---|---|---|
| Pela Cognitiva | | | |
| Pelo produto (PM/PO) | | | |
