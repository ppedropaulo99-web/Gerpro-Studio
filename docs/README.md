# Documentação do Gerpro Studio

Estado documentado: Etapa H4, handoff para a equipe Cognitiva (branch
`main`). O app é o do Lote 3.3.8. A linha de hardware do Lote 3.3.9 existe
fora do app e está desativada.

**Visão do produto.** O Gerpro Studio é uma plataforma DIY/low-code para
desenvolvimento e personalização do ecossistema Gerpro. O público inclui
usuários comuns, usuários avançados e equipes técnicas, cada um dentro das
permissões do seu perfil. O objetivo central é permitir incluir e configurar
campos, personalizar telas e layouts, criar workflows e regras de negócio e
publicar as alterações de forma controlada. Os agentes de IA são um módulo
complementar dessa plataforma.

**O que existe hoje.** Este repositório é um protótipo de referência da base
desktop (Electron + React + TypeScript) e do módulo de agentes de IA. Ele tem
interface, contratos, persistência local e inferência local real pelo
adaptador Ollama. O usuário configura agentes e mantém, em Conversas, conversas
gravadas e com contexto, usando modelos instalados neste computador. A tela
Execuções acompanha a sessão.
**O motor de personalização e a integração com o Gerpro.com (Gerpro Web) ainda
não estão implementados.** A equipe Cognitiva assume a continuidade técnica
após o handoff, incluindo essas duas frentes.
**O app não lê o hardware real, não executa ferramentas e não se integra a
servidores.** O detector local de hardware e o auxiliar DXCore existem no
código, mas estão dormentes e **não estão autorizados para produção**.

**Para começar:** [Guia de transferência](12-guia-de-transferencia.md).

## Legenda usada em todos os documentos

| Marca | Significado |
|---|---|
| **Implementado** | Funciona de verdade: lê e grava dados reais do usuário, com testes |
| **Simulado** | Fluxo demonstrativo com dados fictícios, sempre identificado como tal na interface |
| **Planejado** | Existe só como contrato, ponto de extensão ou intenção; nenhum comportamento real |
| **Proposta** | Sugestão técnica para a equipe avaliar; não é decisão tomada |

O [Inventário](09-inventario-e-riscos.md) detalha ainda: parcialmente
implementado, ferramenta de diagnóstico (fora do app) e experimental
desativado.

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
10. [Ativação do auxiliar DXCore](10-ativacao-dxcore.md): plano da Etapa
   6C.6A (Job Object, empacotamento, aprovação do hash, etapas), validação
   técnica do launcher da 6C.6B.1 (contratos do Windows, sequência segura,
   encerramento, TOCTOU, testes) e implementação do launcher na 6C.6B.2
   (compilado, nunca executado pelo app, não conectado). Ativação não
   autorizada.
11. [Testes reais de contenção](11-testes-contencao.md): artefatos só de
   teste, isolamento, roteiro dos testes T-R/T-J/T-H/T-M/T-T/T-K/T-F/T-E,
   supervisor e resultados das execuções com artefatos de teste (Grupo A,
   T-K1, T-T1, T-F3), além do segurador de travas, nunca executado. Histórico
   de engenharia, fora do app.
12. [Guia de transferência](12-guia-de-transferencia.md): leitura de entrada
   para a equipe Cognitiva (visão, execução, arquitetura, ordem de leitura,
   limitações e responsabilidades) e guia técnico de continuidade.
13. [Visão do produto](13-visao-do-produto.md): plataforma DIY/low-code,
   público, proposta de valor, capacidades planejadas, agentes como módulo
   complementar e existente × planejado.
14. [Roadmap de engenharia](14-roadmap-de-engenharia.md): sequência proposta
   de implementação, sem prazos, sujeita à validação da Cognitiva.
15. [Checklist de transferência](15-checklist-de-transferencia.md): acesso,
   execução, demonstração, responsáveis, pendências e aceite.

## Outros documentos

- [`README.md`](../README.md): como instalar, rodar e testar.
- [`src/main/hardware/README.md`](../src/main/hardware/README.md): passos
  técnicos para implementar o detector real.
- [`src/main/engine/README.md`](../src/main/engine/README.md): provedores de
  inferência e como adicionar um novo.
- [`src/main/plugins/README.md`](../src/main/plugins/README.md): pasta
  reservada.
