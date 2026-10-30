# Documentação do Gerpro Studio

Estado documentado: commit `9376ce4` (branch `main`), após a Etapa 3.1.

O Gerpro Studio é uma aplicação desktop proprietária de IA (Electron + React +
TypeScript), que no futuro será integrada ao Gerpro Web. Até agora, o projeto
tem a interface, os contratos, a persistência local, fluxos demonstrativos e
inferência local real pelo adaptador Ollama (Lote 3.3.6): em Conversas, o
usuário mantém conversas contínuas, gravadas e com contexto, com modelos
instalados neste computador, e a tela
Execuções acompanha o histórico da sessão, as métricas e os registros (Lote
3.3.7).
**Não há detecção real de hardware, execução de ferramentas
nem integração com servidores.**

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

## Outros documentos

- [`README.md`](../README.md): como instalar, rodar e testar.
- [`src/main/hardware/README.md`](../src/main/hardware/README.md): passos
  técnicos para implementar o detector real.
- [`src/main/engine/README.md`](../src/main/engine/README.md) e
  [`src/main/plugins/README.md`](../src/main/plugins/README.md): pastas
  reservadas.
