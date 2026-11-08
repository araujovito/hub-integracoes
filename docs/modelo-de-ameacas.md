# Modelo de ameaças

## Ativos

- Segredos HMAC e token administrativo.
- Integridade de pedidos e estado de entrega.
- Disponibilidade do recebimento e processamento.
- Dados mínimos do pedido e métricas agregadas de tokens.

## Limites de confiança

```text
Loja ── HTTPS + HMAC(horário.corpo) ──> Caddy ──> API ──> PostgreSQL/outbox ──> relay ──> Redis ──> worker ──> ERP simulado
Operador da loja ── X-Admin-Token (da loja) ──> operações/dashboard (só a própria loja)
Operador da plataforma ── X-Platform-Token ──> cadastro de lojas e credenciais (sem dados de loja)
```

Em `compose.prod.yaml`, PostgreSQL, Redis e API ficam só na rede interna do Compose; o único ponto exposto é o Caddy. O tráfego interno não usa TLS, o que vale num host único. Com serviços em máquinas diferentes, é preciso TLS também entre eles.

## Ameaças e mitigação atual

| Ameaça | Mitigação implementada | Limitação / próximo passo |
| --- | --- | --- |
| Webhook forjado ou corpo alterado | HMAC SHA-256 de horário + corpo bruto com a chave da loja, comparação em tempo constante | Chave vazada vale até a revogação; revogar e emitir outra com `graceHours: 0` |
| Replay de requisição capturada | horário assinado com janela de 300 s; dentro dela, deduplicação por `eventId` | Depende de relógio sincronizado no remetente |
| Acesso cruzado entre lojas | token admin resolvido para a loja; todas as consultas filtram por ela; testes de integração de isolamento | Plataforma e lojas usam tokens estáticos, sem expiração automática |
| Payload abusivo | limite de 256 KiB no Caddy e na API, schema estrito e rate limit por IP real (um proxy confiável) armazenado no Redis | Se Redis ficar indisponível, rotas limitadas falham fechadas; monitorar isso porque também afeta webhooks |
| Evento duplicado | unique key tenant/origem/evento; chave única no ERP simulado | Chaves do demo não são credenciais separadas por cliente |
| Perda entre persistência e fila | outbox transacional | PostgreSQL/Redis sem transação comum; possível publicação duplicada, tratada no consumidor |
| Crash do worker | PEL do consumer group e recuperação via XAUTOCLAIM | Retenção/trim/alertas de stream ainda requer política operacional |
| Retry infinito | máximo configurável e dead-letter | Redrive exige operador autenticado e entra pela outbox transacional; adicionar trilha de auditoria mais completa |
| Acesso indevido a operações | token admin por loja (SHA-256 no banco), revogável; token de plataforma separado; rate limit | Tokens sem expiração automática e sem papéis dentro da loja |
| Exposição em logs | logs estruturados sem corpo; headers de autenticação mascarados | Revisar logging/telemetria ao incluir novos campos e fornecedores |
| Vazamento de prompt/resposta | ledger guarda metadados e tokens, nunca conteúdo | Demo de provider usa prompt fixo; definir retenção e avaliar privacidade antes de prompts de usuário |
| Segredo comprometido | produção com Docker secrets (`*_FILE`), nada no ambiente; chaves de webhook cifradas no banco; gitleaks com histórico completo no CI e push protection do GitHub | Troca da `TENANT_SECRETS_KEY` sem parada (`rotate-master-key`); a troca é manual |
| Escuta na rede | HTTPS com TLS 1.3 e HSTS na borda (Caddy) | Tráfego interno sem TLS (host único) |
| Perda de dados | backup com SHA-256 e teste de restauração a cada push; retenção que preserva dead letters | Agendamento e cópia cifrada fora do servidor ficam por conta da operação |
| Indisponibilidade de dependência | processos sobrevivem a queda do PostgreSQL; 503 sem detalhes internos; outbox segura pedidos com o Redis fora | Sem réplica nem failover; sem alertas |
| Injeção SQL | consultas parametrizadas | Revisão contínua necessária |
| XSS no dashboard | renderização com escape de valores, sem CDN/script externo, CSP com nonce e headers de segurança | Revisão manual nos navegadores e testes de segurança mais amplos antes de exposição pública |

## Fora de escopo do MVP

PII, OAuth/papéis por loja, rotação automática de segredos, alta disponibilidade, disaster recovery entre regiões, SLA, billing e integração com ERP real. A lista completa do que falta está em `roteiro.md`.

## Exercícios (automatizados)

Antes manuais, agora cobertos por testes que rodam no CI:

1. Reenvio do mesmo `eventId`, inclusive concorrente: uma linha de evento e uma entrega (testes de integração).
2. SIGKILL no worker com mensagens pendentes: recuperação via `XAUTOCLAIM` e entrega única (`scripts/e2e-resilience.sh`).
3. PostgreSQL parado durante carga: 503 para o cliente, sem perda nem duplicação (`scripts/e2e-resilience.sh`).
4. Rotas sem token, com token de outra loja e com credencial de plataforma no lugar da de loja: 401 ou 404, sem dados alheios (`api.integration.test.ts`).
5. Restauração de backup: a cada push, após as quedas (`scripts/restore-test.sh`).
