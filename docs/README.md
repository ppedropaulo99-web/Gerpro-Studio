# Documentação do Gerpro Studio

Estado documentado: encerramento do Lote 3.3.8 (branch `main`).

O Gerpro Studio é uma aplicação desktop proprietária de IA (Electron + React +
TypeScript), que será integrada ao Gerpro Web. Hoje, o projeto tem interface,
contratos, persistência local e inferência local real pelo adaptador Ollama.
O usuário configura agentes e mantém, em Conversas, conversas gravadas e com
contexto, usando modelos instalados neste computador. A tela Execuções
acompanha a sessão.
**Não há detecção real de hardware, execução de ferramentas nem integração com
servidores.**

## Legenda usada em todos os documentos

| Marca | Significado |
|---|---|
| **Implementado** | Funciona de verdade: lê e grava dados reais do usuário, com testes |
| **Simulado** | Fluxo demonstrativo com dados fictícios, sempre identificado como tal na interface |
| **Planejado** | Existe só como contrato, ponto de extensão ou intenção; nenhum comportamento real |
| **Proposta** | Sugestão técnica para a equipe avaliar; não é decisão tomada |

## Índice

1. [Etapas e estado atual](01-etapas.md): o que cada etapa entregou e o
   quadro implementado × simulado × planejado.
2. [Arquitetura](02-arquitetura.md): processos do Electron, limites de
   segurança, IPC, persistência e a arquitetura híbrida planejada com o
   Gerpro Web.
3. [Contratos](03-contratos.md): agentes, ferramentas, modelos, execuções,
   configurações e erros.
4. [Hardware Advisor](04-hardware-advisor.md): consentimento `demo-only` ×
   `device-detection`, proteção contra ampliação automática e recomendações
   demonstrativas.
5. [Motor de inferência](05-motor-de-inferencia.md): adaptador Ollama
   (Lote 3.3.6), mensagens por Conversas e monitoramento em Execuções (Lote
   3.3.7) e o motor próprio, decisão arquitetural futura.
6. [Pontos de integração](06-pontos-de-integracao.md): o que fica sob
   responsabilidade da equipe de desenvolvimento.
7. [Decisões e limitações](07-decisoes-e-limitacoes.md): histórico das
   decisões e limitações conhecidas.
8. [Handoff](08-handoff.md): ambiente, execução, testes, serviços, como
   adicionar funcionalidades, erros comuns e extensão para o Gerpro Web.
9. [Inventário e riscos](09-inventario-e-riscos.md): classificação verificável
   de cada funcionalidade e riscos remanescentes.

## Outros documentos

- [`README.md`](../README.md): como instalar, rodar e testar.
- [`src/main/hardware/README.md`](../src/main/hardware/README.md): passos
  técnicos para implementar o detector real.
- [`src/main/engine/README.md`](../src/main/engine/README.md): provedores de
  inferência e como adicionar um novo.
- [`src/main/plugins/README.md`](../src/main/plugins/README.md): pasta
  reservada.
