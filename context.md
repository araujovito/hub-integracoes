# Contexto do projeto para Claude

Você está trabalhando no repositório local `hub-integracoes`, um projeto de portfólio para demonstrar integração segura e escalável de pedidos entre sistemas, incluindo contabilização do consumo de IA em tokens, sem conversão monetária.

## Objetivo e narrativa

Demonstrar competências úteis para vagas de integração e desenvolvimento full stack: APIs/webhooks, validação, PostgreSQL, Redis Streams, processamento assíncrono, idempotência, segurança, observabilidade, testes e uma interface operacional. O fluxo de pedidos deve continuar funcionando mesmo sem IA. O ERP é simulado no MVP.

## Stack e execução

- Node.js 24 LTS (imagem e CI; 22+ para desenvolvimento local), TypeScript, Fastify, Zod, PostgreSQL 17, Redis 7.4, Docker Compose.
- Diretório da API: `backend/`; schema e migrations: `db/migrations/`; Compose: `compose.yaml`.
- `docker compose up --build` inicia os serviços locais. API: `http://localhost:3000/health`; Postgres/Redis têm portas locais 5433/6380 vinculadas a `127.0.0.1`.
- `WEBHOOK_SECRET` e `ADMIN_API_TOKEN` só existem na API: `loadApiSecrets()` em `config.ts` os valida, e relay/worker não os recebem no Compose.
- O Compose exige `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `WEBHOOK_SECRET` e `ADMIN_API_TOKEN` no `.env` (`${VAR:?}`); não há senha padrão embutida.
- `.env` é local e ignorado pelo Git. Nunca leia, imprima, copie, altere ou inclua o conteúdo de `.env` em mensagens, commits, screenshots ou documentos. Use `.env.example` somente como referência de nomes e placeholders.
- O ambiente já foi criado e os containers estavam rodando. Confirme estado com `docker compose ps` antes de agir; não derrube volumes nem use comandos destrutivos.

## Implementado

- `POST /v1/webhooks/orders`: HMAC-SHA256 do corpo bruto, comparação em tempo constante, schema estrito, limite de tamanho e rate limit Redis compartilhado; grava `integration_events` e `outbox_events` na mesma transação; deduplica com unique key.
- O webhook responde 415 `expected_application_json` quando o corpo não veio do parser JSON do app (sem corpo, `text/plain` etc.), antes de verificar o HMAC; antes disso esses casos davam 500 com a mensagem interna (`backend/src/json-body.ts`).
- `GET /health`: liveness do processo; `GET /ready`: readiness que testa PostgreSQL e Redis.
- `GET /v1/usage/tokens`: exige `X-Admin-Token`, aceita período e retorna tokens agregados por modelo/tarefa e total do período.
- `recordTokenUsage()` em `backend/src/token-usage.ts` guarda metadados e uso oficial (entrada, cache, saída e raciocínio), sem armazenar prompt/resposta nem converter para moeda. `backend/src/openai-provider.ts` chama OpenAI Responses com prompt fixo, limite de saída, `store:false`, timeout, zero retries, idempotência por request ID e teto diário configurável (admissão serializada por advisory lock; reserva conservadora de entrada). Rota admin `POST /v1/ai/demo`, rate-limited, e botão no painel; sem `OPENAI_API_KEY`, permanece desabilitada. Nunca executar uma chamada externa paga durante desenvolvimento sem ação explícita do usuário.
- Migrations iniciais em `db/migrations/001_init.sql`.
- Relay dedicado em `backend/src/outbox-relay.ts`, migrações ordenadas e aditivas, worker em `backend/src/worker.ts`, retry limitado/dead-letter, backoff com jitter em erros de dependência e tabela `erp_deliveries` idempotente (migration `002`).
- Compose sobe serviços `api`, `relay` e `worker` além de PostgreSQL/Redis.
- API operacional: summary, eventos paginados, dead letters e redrive via outbox transacional; dashboard local em `/dashboard` com token mantido só em memória. O painel inclui foco visível, mensagens de carregamento/erro e filtro de datas em UTC.
- 10 testes de integração opcionais em `backend/test/integration.test.ts` cobrindo migrations repetíveis, recuperação de outbox após falha Redis, idempotência do ledger por request ID, lock concorrente do teto de tokens, recusa do provedor sem bloqueio, duplicata concorrente no destino, retry/DLQ, consumer group e recuperação via `XAUTOCLAIM`; os testes do dashboard (`backend/test/dashboard.test.ts`, happy-dom) executam o script da página contra uma API simulada e verificam o comportamento: valores hostis viram texto, o token só vai no header e não fica no DOM nem no storage, e o 401 mostra erro. Workflow CI inclui lint, auditoria de todas as dependências e secret scan (gitleaks 8.24.3 com checksum fixo, analisando todo o histórico a cada execução); ações fixadas por SHA, atualizadas via Dependabot (`.github/dependabot.yml`); imagens base fixadas por digest no Dockerfile, no Compose e no CI. Vitest está em 4.1.12 e minimatch é resolvido para versão corrigida; auditoria completa local passou com zero vulnerabilidades.
- `yarn test` roda num clone limpo: `backend/test/setup-env.ts` (via `vitest.config.ts`) preenche só as variáveis ausentes com placeholders inertes. Com `RUN_INTEGRATION_TESTS=true` nada é preenchido, e a falta de conexão real falha na hora.
- Migrations `003_ai_usage_details.sql` e `005_token_only_usage.sql` mantêm breakdown de cache/raciocínio e removem colunas de custo/preço em moeda; a migration `004` é histórica. `OPENAI_MODEL` default `gpt-6-luna` é o modelo enviado à API da OpenAI; a métrica cobre só as chamadas feitas pelo app.

## Decisões/limites

- Escopo inicial single-tenant `demo`, com payload sem PII de cliente.
- A entrega distribuída é *at-least-once*. Duplicatas entre PostgreSQL e Redis são possíveis; a operação do consumidor deve ser idempotente.
- Preferir migrations aditivas, com `IF NOT EXISTS`, sem apagar dados. Não presumir que o container foi recriado ou o banco está vazio.
- Segredos e credenciais não devem ir para código, logs, testes reais ou Git. Portas de serviços locais permanecem em loopback.
- Sem publicação, candidatura, deploy, criação de conta ou serviço pago nesta tarefa.

## Próximos passos imediatos

Atualização: migrations são serializadas e registradas; eventos falhos não são entregues por duplicatas; testes de integração usam esquema isolado. Chamadas de IA criam journal antes do envio e bloqueiam novas chamadas se o resultado for incerto. Recusas do provedor (400/401/403/404/422/429) encerram a intenção como `rejected` (migration `008`) e não bloqueiam; o request ID é gravado na intenção assim que a resposta chega. O administrador pode consultar pendências e reconciliar dados individuais comprovados via API; a contagem exata permanece desconhecida quando o provedor não disponibiliza esses dados. Consulte o README. A chamada real segue sem teste e não é autorizada automaticamente.

Validado nesta etapa: imagem Docker e cinco serviços saudáveis, `/health` 200, `/ready` 200, rota admin sem token 401, CSP nonce para script e estilo, redrive ponta a ponta com uma entrega, recuperação após worker parado/reiniciado e limpeza dos dados de teste; ledger de tokens continua vazio. Auditoria completa `yarn audit` sem vulnerabilidades (267 dependências), lint, typecheck, 11 testes padrão e 8 testes de integração passaram. O adaptador OpenAI não foi chamado; continua opt-in e exigiria chave/autorização, portanto a chamada externa não foi validada. O sistema está pronto para apresentação como MVP local de portfólio, não para produção. Deploy continua fora de escopo. Consulte `roteiro.md`.

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
