# Contexto do projeto para Claude

Você está trabalhando no repositório local `hub-integracoes`, um projeto de portfólio para demonstrar integração segura e escalável de pedidos entre sistemas, incluindo contabilização do consumo de IA em tokens, sem conversão monetária.

## Objetivo e narrativa

Demonstrar competências úteis para vagas de integração e desenvolvimento full stack: APIs/webhooks, validação, PostgreSQL, Redis Streams, processamento assíncrono, idempotência, segurança, observabilidade, testes e uma interface operacional. O fluxo de pedidos deve continuar funcionando mesmo sem IA. O ERP é simulado no MVP.

## Stack e execução

- Node.js 24 LTS (imagem e CI; 22+ para desenvolvimento local), TypeScript, Fastify, Zod, PostgreSQL 17, Redis 7.4, Docker Compose.
- Diretório da API: `backend/`; schema e migrations: `db/migrations/`; Compose: `compose.yaml`.
- `docker compose up --build` inicia os serviços locais. API: `http://localhost:3000/health`; Postgres/Redis têm portas locais 5433/6380 vinculadas a `127.0.0.1`.
- Variáveis sensíveis aceitam `NOME_FILE` (lido de arquivo, convenção de Docker secrets/Kubernetes/gerenciadores de segredos): `backend/src/env-files.ts`. Definir `NOME` e `NOME_FILE` juntos é erro.
- Várias lojas (migration `009`, `backend/src/tenants.ts`): chave de webhook por loja (cifrada com `TENANT_SECRETS_KEY`, rotação com carência), token admin por loja (SHA-256), `PLATFORM_ADMIN_TOKEN` só para cadastro. `PLATFORM_ADMIN_TOKEN` e `TENANT_SECRETS_KEY` existem só na API (`loadApiSecrets()`); relay/worker não os recebem. `DEMO_TENANT_ID`, `WEBHOOK_SECRET` e `ADMIN_API_TOKEN` foram removidos.
- Rotas HTTP montadas em `backend/src/app.ts` (`buildApp`), testadas com `app.inject()` em `backend/test/api.integration.test.ts`, inclusive isolamento entre lojas.
- O Compose exige `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `PLATFORM_ADMIN_TOKEN` e `TENANT_SECRETS_KEY` no `.env` (`${VAR:?}`); não há senha padrão embutida.
- `.env` é local e ignorado pelo Git. Nunca leia, imprima, copie, altere ou inclua o conteúdo de `.env` em mensagens, commits, screenshots ou documentos. Use `.env.example` somente como referência de nomes e placeholders.
- O ambiente já foi criado e os containers estavam rodando. Confirme estado com `docker compose ps` antes de agir; não derrube volumes nem use comandos destrutivos.

## Implementado

- `POST /v1/webhooks/orders`: `X-Tenant-Id` + `X-Webhook-Timestamp` + HMAC-SHA256 de `<timestamp>.<corpo bruto>` com a chave da loja; janela `WEBHOOK_TOLERANCE_SECONDS` (300 s) contra replay; comparação em tempo constante, schema estrito, limite de tamanho e rate limit Redis compartilhado; grava `integration_events` e `outbox_events` na mesma transação; deduplica com unique key.
- O webhook responde 415 `expected_application_json` quando o corpo não veio do parser JSON do app (sem corpo, `text/plain` etc.), antes de verificar o HMAC; antes disso esses casos davam 500 com a mensagem interna (`backend/src/json-body.ts`).
- `GET /health`: liveness do processo; `GET /ready`: readiness que testa PostgreSQL e Redis.
- `GET /v1/usage/tokens`: exige `X-Admin-Token`, aceita período e retorna tokens agregados por modelo/tarefa e total do período.
- `recordTokenUsage()` em `backend/src/token-usage.ts` guarda metadados e uso oficial (entrada, cache, saída e raciocínio), sem armazenar prompt/resposta nem converter para moeda. `backend/src/openai-provider.ts` chama OpenAI Responses com prompt fixo, limite de saída, `store:false`, timeout, zero retries, idempotência por request ID e teto diário configurável (admissão serializada por advisory lock; reserva conservadora de entrada). Rota admin `POST /v1/ai/demo`, rate-limited, e botão no painel; sem `OPENAI_API_KEY`, permanece desabilitada. Nunca executar uma chamada externa paga durante desenvolvimento sem ação explícita do usuário.
- Migrations iniciais em `db/migrations/001_init.sql`.
- Relay dedicado em `backend/src/outbox-relay.ts`, migrações ordenadas e aditivas, worker em `backend/src/worker.ts`, retry limitado/dead-letter, backoff com jitter em erros de dependência e tabela `erp_deliveries` idempotente (migration `002`).
- Produção: `compose.prod.yaml` + `deploy/Caddyfile` (HTTPS automático, só o Caddy publica portas, segredos como Docker secrets via `*_FILE`, gerados por `scripts/generate-prod-secrets.sh`; `TRUST_PROXY_HOPS=1`). Testado localmente com `DOMAIN=localhost`; não houve deploy.
- Backup: `scripts/backup.sh` (pg_dump + sha256 + rotação) e `scripts/restore-test.sh` (restaura em PostgreSQL descartável e roda a imagem da app contra ele); o teste de resiliência faz os dois a cada execução.
- Limites de sessão no PostgreSQL: `DB_STATEMENT_TIMEOUT_MS` (10 s) e `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (30 s) em toda conexão do pool; migrations rodam sem limite. Consulta cancelada (57014) vira 503.
- `backend/src/database.ts`: `createPool` (trata `error` de conexão ociosa, que antes derrubava o processo quando o PostgreSQL reiniciava) e `migrateWhenReady` (espera o banco na partida). Handler de erro global em `app.ts`: 503 para dependência indisponível, 500 genérico, sem mensagem interna.
- `scripts/e2e-resilience.sh`: stack isolada (`hub-e2e`), carga contínua, SIGKILL no worker e parada do PostgreSQL; exige entrega única, zero reinícios de api/relay e zero erros de rede.
- Compose sobe serviços `api`, `relay`, `worker` e `maintenance` além de PostgreSQL/Redis. `maintenance` (`backend/src/maintenance.ts`, migration `010`) faz o trim do stream (nunca pendentes/não lidas) e a retenção de payloads entregues.
- API operacional: summary, eventos paginados, dead letters e redrive via outbox transacional; dashboard local em `/dashboard` com token mantido só em memória. O painel inclui foco visível, mensagens de carregamento/erro e filtro de datas em UTC.
- 10 testes de integração opcionais em `backend/test/integration.test.ts` cobrindo migrations repetíveis, recuperação de outbox após falha Redis, idempotência do ledger por request ID, lock concorrente do teto de tokens, recusa do provedor sem bloqueio, duplicata concorrente no destino, retry/DLQ, consumer group e recuperação via `XAUTOCLAIM`; os testes do dashboard (`backend/test/dashboard.test.ts`, happy-dom) executam o script da página contra uma API simulada e verificam o comportamento: valores hostis viram texto, o token só vai no header e não fica no DOM nem no storage, e o 401 mostra erro. Workflow CI inclui lint, auditoria de todas as dependências e secret scan (gitleaks 8.24.3 com checksum fixo, analisando todo o histórico a cada execução); ações fixadas por SHA, atualizadas via Dependabot (`.github/dependabot.yml`); imagens base fixadas por digest no Dockerfile, no Compose e no CI. Vitest está em 4.1.12 e minimatch é resolvido para versão corrigida; auditoria completa local passou com zero vulnerabilidades.
- `yarn test` roda num clone limpo: `backend/test/setup-env.ts` (via `vitest.config.ts`) preenche só as variáveis ausentes com placeholders inertes. Com `RUN_INTEGRATION_TESTS=true` nada é preenchido, e a falta de conexão real falha na hora.
- Migrations `003_ai_usage_details.sql` e `005_token_only_usage.sql` mantêm breakdown de cache/raciocínio e removem colunas de custo/preço em moeda; a migration `004` é histórica. `OPENAI_MODEL` default `gpt-6-luna` é o modelo enviado à API da OpenAI; a métrica cobre só as chamadas feitas pelo app.

## Decisões/limites

- Várias lojas desde a migration `009`; a loja `demo` vem do backfill dos dados antigos e não tem chaves até a plataforma emiti-las. Payload sem PII de cliente.
- A entrega distribuída é *at-least-once*. Duplicatas entre PostgreSQL e Redis são possíveis; a operação do consumidor deve ser idempotente.
- Preferir migrations aditivas, com `IF NOT EXISTS`, sem apagar dados. Não presumir que o container foi recriado ou o banco está vazio.
- Segredos e credenciais não devem ir para código, logs, testes reais ou Git. Portas de serviços locais permanecem em loopback.
- Sem deploy, criação de conta ou serviço pago sem pedido explícito. O repositório é público em github.com/araujovito/hub-integracoes.

## Estado e próximos passos

Validado em 2026-11-08: lint, typecheck (src + scripts), 31 testes unitários, 30 de integração (`yarn test:integration` contra PostgreSQL/Redis descartáveis), `scripts/e2e-resilience.sh` (carga com SIGKILL no worker e PostgreSQL parado: zero reinícios de api/relay, entrega única, backup restaurado) e `compose.prod.yaml` com `DOMAIN=localhost` (HTTPS, segredos como arquivos). O CI roda tudo isso, menos o teste do Compose de produção. Não houve deploy nem chamada real de IA.

O que falta para uma operação real está em `roteiro.md`, na seção "O que ainda falta". As atualizações de versão principal abertas pelo Dependabot (Node 25, Redis 8, actions v7) não foram aplicadas e precisam de avaliação.

Para rodar o Compose de desenvolvimento, o `.env` precisa de `PLATFORM_ADMIN_TOKEN` e `TENANT_SECRETS_KEY` (ver `.env.example`); as antigas `WEBHOOK_SECRET`, `ADMIN_API_TOKEN` e `DEMO_TENANT_ID` não são mais lidas.

## Instruções de colaboração

1. Inspecione o estado e as alterações antes de editar; preserve trabalho local.
2. Faça mudanças pequenas, tipadas e cobertas por testes; prefira comandos não destrutivos.
3. Não alegue segurança/escala de produção: descreva o que está implementado e limitações reais.
4. Após mudanças, rode typecheck, testes, build e smoke tests apropriados.
5. Atualize `README.md`, `roteiro.md` e este arquivo quando arquitetura/estado mudarem.
6. Ao concluir uma etapa, informe arquivos alterados, comandos/resultados e próximos riscos conhecidos.

## Documentos para leitura

- `roteiro.md`: etapas, critérios de pronto e evolução sugerida.
- `README.md`: como rodar e capacidades atuais.
