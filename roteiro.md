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
| Cadeia de suprimentos | Node 24 LTS; imagens e ações fixadas por digest/SHA; Dependabot; gitleaks com checksum sobre todo o histórico; `yarn audit` | CI |

## O que ainda falta

Lista do que separa este código de uma operação real. Nada disso está implementado:

1. **Deploy.** Nunca rodou num servidor público. `compose.prod.yaml` foi testado só localmente, com o certificado interno do Caddy.
2. **Alta disponibilidade.** É um host só: PostgreSQL e Redis sem réplica nem failover. Para escalar, a API é stateless e o worker escala pelo consumer group, mas banco e Redis precisam de serviço gerenciado ou de replicação.
3. **Monitoramento e alertas.** Há logs JSON e as rotas `/v1/platform/queue` e `/v1/operations/summary`, mas não há exportação de métricas (Prometheus/OpenTelemetry) nem alerta de backlog, dead letter ou certificado.
6. **Token de plataforma** é estático (arquivo/variável): troca manual, sem expiração. Os tokens de loja já têm papel e validade.
7. **Backup agendado e fora do servidor.** Os scripts existem; agendar (cron/systemd), cifrar e copiar para outro lugar é configuração de quem opera.
8. **TLS entre serviços internos.** API, PostgreSQL e Redis conversam em texto claro dentro da rede do Compose. Vale num host só; com serviços em máquinas diferentes, é preciso TLS também ali.
9. **Integração com ERP real.** O destino é uma tabela simulada. Um ERP real traz timeouts, limites e erros próprios, que o worker teria de tratar.
10. **Chamada real de IA.** O adaptador nunca foi chamado de verdade, porque gera custo. O modelo padrão `gpt-6-luna` só foi confirmado em catálogos de terceiros.
11. **Dashboard:** falta revisão manual em navegadores e de acessibilidade, e não há capturas na documentação.
12. **Atualizações de versão principal** propostas pelo Dependabot (Node 25, Redis 8, actions v7) estão abertas e precisam de avaliação: Node 25 não é LTS, e o Redis 8 muda de licença.

## Critérios de pronto (MVP)

- [x] Reenviar o mesmo webhook não duplica evento nem efeito no ERP simulado.
- [x] Falha do Redis mantém o evento na outbox; queda do worker deixa a mensagem recuperável, com `XACK` só depois do efeito persistido.
- [x] Falhas transitórias têm tentativas limitadas e falha terminal visível, sem loop infinito.
- [x] Logs e respostas não revelam assinatura, tokens, credenciais, prompts ou mensagens internas.
- [x] Métricas de tokens ficam zeradas até existir chamada real; nenhum número é inventado.
- [x] `docker compose up --build`, testes, typecheck e build passam em ambiente limpo: o job `resilience` do CI sobe a stack de um clone novo, com volumes novos.

## Como retomar

Leia `context.md`, depois este roteiro e o `README.md`. Trabalhe em etapas pequenas e atualize os documentos a cada marco. Não altere o `.env`, não faça deploy nem configure serviço pago sem instrução explícita. Rode as verificações e diga com clareza o que foi e o que não foi testado.
