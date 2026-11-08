# Roteiro — Hub de Integrações

Objetivo: um hub de integração de pedidos seguro, observável e escalável, com várias lojas, entrega assíncrona confiável a um ERP (simulado) e contagem do consumo de IA em tokens reportados pelo provedor, sem conversão para moeda.

## Estado atual (2026-11-08)

```text
Loja ── HTTPS ──> Caddy ──> API ──> PostgreSQL (evento + outbox na mesma transação)
        HMAC(horário.corpo)          │
                                     └─> relay ──> Redis Streams ──> worker ──> ERP simulado
                                                         ↑
                                         maintenance (trim do stream, retenção de payloads)
```

| Área | Implementado | Como foi verificado |
| --- | --- | --- |
| Entrega | Outbox transacional, relay com `SKIP LOCKED`, consumer group, `XACK` após commit, `XAUTOCLAIM`, dead letter e redrive pela outbox; entrega *at-least-once* com efeito idempotente | Testes de integração; `scripts/e2e-resilience.sh` no CI |
| Várias lojas | Chave de webhook por loja (AES-256-GCM, rotação com carência, revogação), token admin por loja (SHA-256), token de plataforma só para cadastro, FKs por loja | Testes de integração de isolamento (eventos, cursor, dead letters, redrive, métricas compartilhadas) |
| Replay | Assinatura sobre `<timestamp>.<corpo>`, janela de 300 s, deduplicação por `eventId` dentro da janela | Testes unitários e de integração; smoke no Compose |
| Resiliência | Processos sobrevivem a queda do PostgreSQL e a SIGKILL do worker; API responde 503 sem detalhes internos | `e2e-resilience.sh`: carga contínua, zero reinícios de api/relay, cada pedido aceito entregue uma vez |
| Retenção | Trim do stream sem tocar em pendentes/não lidas; payloads entregues limpos após 90 dias, identidade preservada | Testes de integração com Redis e PostgreSQL reais |
| Produção | `compose.prod.yaml`: Caddy com HTTPS automático, só o Caddy com portas publicadas, segredos como arquivos (`*_FILE`), um proxy confiável | Stack local com `DOMAIN=localhost`: TLS 1.3, HSTS, 413 na borda, IP real do cliente nos logs |
| Backup | `backup.sh` (pg_dump + SHA-256 + rotação), `restore-test.sh` (restaura e roda a aplicação contra o banco) | A cada push, no teste de resiliência, com contagem comparada à origem |
| Monitoramento | `/metrics` (Prometheus) com token; 7 regras de alerta com testes; Prometheus opcional | Testes de integração, `promtool test rules` no CI, Compose local e de produção |
| Dashboard | Acessível (WCAG 2.1 AA), status em português, papel e validade do token, ações bloqueadas para `viewer` | `scripts/dashboard-review.sh` em Chromium, Firefox e WebKit no CI |
| Banco | `statement_timeout` e `idle_in_transaction_session_timeout` em toda conexão; troca da chave mestra sem parada | Testes de integração; troca de chave no Compose local |
| Cadeia de suprimentos | Node 24 LTS; imagens e ações fixadas por digest/SHA; Dependabot; gitleaks com checksum sobre todo o histórico; `yarn audit` | CI |

## Escopo

Este é um projeto de portfólio, para demonstração pública do código. **Não haverá deploy num servidor real**, por decisão. A configuração de produção (`compose.prod.yaml`) existe e foi testada localmente, para mostrar como o sistema rodaria, mas os itens que dependem de infraestrutura paga ou de operação contínua ficam fora do escopo, e não pendentes:

- servidor, domínio e certificado público;
- alta disponibilidade (réplica e failover de PostgreSQL e Redis);
- entrega dos alertas (Alertmanager, canal, plantão); as regras e as métricas existem e são testadas;
- backup agendado e copiado para fora do servidor; os scripts de backup e de teste de restauração existem;
- TLS entre serviços em máquinas diferentes;
- integração com um ERP real;
- chamada real de IA, que gera custo (o modelo padrão `gpt-6-luna` só foi confirmado em catálogos de terceiros).

## Limites conhecidos no código

1. O token de plataforma é estático (arquivo ou variável de ambiente): a troca é manual e ele não expira. Os tokens de loja têm papel e validade.
2. Atualizações de versão principal propostas pelo Dependabot (Node 25, Redis 8, actions v7) estão abertas e não foram aplicadas: Node 25 não é LTS, e o Redis 8 muda de licença.
3. No ambiente de desenvolvimento usado aqui, o WebKit não roda localmente (faltam bibliotecas do sistema); a revisão do dashboard nele acontece só no CI.

## Critérios de pronto (MVP)

- [x] Reenviar o mesmo webhook não duplica evento nem efeito no ERP simulado.
- [x] Falha do Redis mantém o evento na outbox; queda do worker deixa a mensagem recuperável, com `XACK` só depois do efeito persistido.
- [x] Falhas transitórias têm tentativas limitadas e falha terminal visível, sem loop infinito.
- [x] Logs e respostas não revelam assinatura, tokens, credenciais, prompts ou mensagens internas.
- [x] Métricas de tokens ficam zeradas até existir chamada real; nenhum número é inventado.
- [x] `docker compose up --build`, testes, typecheck e build passam em ambiente limpo: o job `resilience` do CI sobe a stack de um clone novo, com volumes novos.

## Como retomar

Leia `context.md`, depois este roteiro e o `README.md`. Trabalhe em etapas pequenas e atualize os documentos a cada marco. Não altere o `.env`, não faça deploy nem configure serviço pago sem instrução explícita. Rode as verificações e diga com clareza o que foi e o que não foi testado.
