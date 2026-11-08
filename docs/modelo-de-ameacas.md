# Modelo de ameaças (MVP local)

## Ativos

- Segredos HMAC e token administrativo.
- Integridade de pedidos e estado de entrega.
- Disponibilidade do recebimento e processamento.
- Dados mínimos do pedido e métricas agregadas de tokens.

## Limites de confiança

```text
Loja externa ── HMAC ──> API pública ──> PostgreSQL/outbox ──> relay ──> Redis ──> worker ──> ERP simulado
Operador local ── admin token ──> endpoints de operações/dashboard
```

Redis/PostgreSQL são dependências internas confiáveis no Compose de desenvolvimento. Em produção devem ficar em rede privada, com TLS, autenticação, ACLs e credenciais independentes.

## Ameaças e mitigação atual

| Ameaça | Mitigação implementada | Limitação / próximo passo |
| --- | --- | --- |
| Webhook forjado ou corpo alterado | HMAC SHA-256 de horário + corpo bruto com a chave da loja, comparação em tempo constante | Chave vazada vale até a revogação; revogar e emitir outra com `graceHours: 0` |
| Replay de requisição capturada | horário assinado com janela de 300 s; dentro dela, deduplicação por `eventId` | Depende de relógio sincronizado no remetente |
| Acesso cruzado entre lojas | token admin resolvido para a loja; todas as consultas filtram por ela; testes de integração de isolamento | Plataforma e lojas usam tokens estáticos, sem expiração automática |
| Payload abusivo | limite de 256 KiB, schema estrito e rate limit armazenado no Redis compartilhado | Se Redis ficar indisponível, rotas limitadas falham fechadas; monitorar isso porque também afeta webhooks |
| Evento duplicado | unique key tenant/origem/evento; chave única no ERP simulado | Chaves do demo não são credenciais separadas por cliente |
| Perda entre persistência e fila | outbox transacional | PostgreSQL/Redis sem transação comum; possível publicação duplicada, tratada no consumidor |
| Crash do worker | PEL do consumer group e recuperação via XAUTOCLAIM | Retenção/trim/alertas de stream ainda requer política operacional |
| Retry infinito | máximo configurável e dead-letter | Redrive exige operador autenticado e entra pela outbox transacional; adicionar trilha de auditoria mais completa |
| Acesso indevido a operações | token admin, comparação tempo constante, rate limit | Token único de demonstração, sem RBAC, rotação ou sessão web formal |
| Exposição em logs | logs estruturados sem corpo; headers de autenticação mascarados | Revisar logging/telemetria ao incluir novos campos e fornecedores |
| Vazamento de prompt/resposta | ledger guarda metadados e tokens, nunca conteúdo | Demo de provider usa prompt fixo; definir retenção e avaliar privacidade antes de prompts de usuário |
| Segredo comprometido | `.env` ignorado pelo Git e portas locais em loopback | Valores locais são demonstração; usar secret manager antes de qualquer deploy |
| Injeção SQL | consultas parametrizadas | Revisão contínua necessária |
| XSS no dashboard | renderização com escape de valores, sem CDN/script externo, CSP com nonce e headers de segurança | Revisão manual nos navegadores e testes de segurança mais amplos antes de exposição pública |

## Fora de escopo do MVP

Multi-tenant de produção, PII, OAuth/RBAC, TLS público, rotação automática de secrets, backups, disaster recovery, deploy, SLA, billing e integração com ERP real. Não apresentar como pronto para produção.

## Exercícios recomendados

1. Reenviar webhook assinado com mesmo `eventId` e verificar uma linha de evento/entrega.
2. Reiniciar worker durante mensagem pendente; observar recuperação após o período `WORKER_CLAIM_IDLE_MS`.
3. Derrubar Redis temporariamente e verificar outbox pendente sem perder evento.
4. Tentar rotas de operações sem token e validar 401; observar que payload e secrets não aparecem nos logs.
5. Testar restauração de backup antes de qualquer deploy real.
