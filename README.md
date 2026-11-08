# Hub de Integrações

Projeto de portfólio para receber eventos de pedidos, validá-los, persistir a entrada com idempotência e preparar a entrega assíncrona a um ERP simulado. Inclui uma trilha de uso de IA que registra os tokens reportados pelo provedor sem guardar prompts ou respostas.

## Ambiente local

Requisitos: Node.js 22+ (a imagem Docker e o CI usam Node.js 24 LTS), Yarn 1.22+ e Docker Compose.

```bash
cp .env.example .env
docker compose up --build
```

Quando os serviços estiverem prontos, a API estará em `http://localhost:3000/health` (liveness) e `/ready` (PostgreSQL + Redis). Para executar testes fora do Docker:

```bash
cd backend
yarn install
yarn dev
yarn test
yarn test:integration
yarn lint
yarn typecheck
```

`yarn test:integration` requer PostgreSQL e Redis ativos e variáveis de conexão explícitas no ambiente de teste. Cria um esquema PostgreSQL temporário isolado e streams próprios, removidos ao final; o usuário do banco precisa poder criar esquemas. Inclui cenário de Redis indisponível e recuperação da outbox. O dashboard fica em `http://localhost:3000/dashboard`.

Os valores de `.env.example` são apenas para desenvolvimento local. Não os reutilize fora da máquina. As portas do banco e do Redis estão vinculadas a `127.0.0.1`.

## Fluxo do MVP

```text
Webhook assinado → validação → PostgreSQL (evento + outbox na mesma transação)
                                               ↓
                                      relay para Redis Streams
                                               ↓
                                   worker → ERP simulado
```

A API recebe webhook assinado e grava evento + outbox na mesma transação. Um relay independente reivindica a outbox com `FOR UPDATE SKIP LOCKED` e publica no Redis Streams. Um worker em consumer group recupera mensagens pendentes via `XAUTOCLAIM`, aplica o efeito numa tabela ERP simulada com chave única e confirma com `XACK` depois do commit. Falhas são contabilizadas e, ao atingir o limite, vão para `dead_letter_events`.

## Contagem de tokens

`ai_token_usage` guarda, por execução, tarefa, provedor, modelo, tokens de entrada, saída, total, cache e raciocínio, além do request ID. `recordTokenUsage()` aceita somente números reportados pelo provider; não estima tokens por caracteres nem converte o uso em moeda. Cache é subconjunto da entrada e raciocínio é subconjunto da saída; não devem ser somados ao total outra vez. O endpoint `GET /v1/usage/tokens` agrega o uso e exige `X-Admin-Token`.

O backend inclui um exemplo opcional via OpenAI Responses API, usando `gpt-6-luna`, pergunta fixa, saída limitada, `store: false`, sem retries automáticos e limite de 3 chamadas por hora. Configure `OPENAI_API_KEY` no `.env` local para habilitar o botão; sem chave, nenhuma chamada externa acontece. Acionar o exemplo pode gerar cobrança na conta da API. Prompt e resposta não são persistidos pelo app. O painel contabiliza tokens reportados pelo provedor (entrada, cache, saída e raciocínio), não calcula preço em reais ou outra moeda. A contagem cobre só as chamadas feitas pelo próprio app.

O exemplo tem um teto diário configurável (`OPENAI_DAILY_TOKEN_LIMIT`, padrão 5.000), serializa admissões entre instâncias via advisory lock no PostgreSQL e limita `max_output_tokens` com base no uso real já registrado. Por padrão, reserva 256 tokens para a entrada fixa antes de admitir uma chamada (`OPENAI_RESERVED_INPUT_TOKENS`). O provedor só informa a contagem exata depois de executar; a reserva é uma margem de admissão, não uma contagem nem garantia matemática contra qualquer overhead.

Antes da chamada, o app registra uma intenção persistente. Quando a resposta e o uso são recebidos, grava o ledger e conclui essa intenção na mesma transação. Se o provedor recusar a requisição com 400, 401, 403, 404, 422 ou 429 (chave inválida, modelo inexistente, limite de taxa ou cota), a intenção é encerrada como `rejected`, com o status HTTP e o request ID, e não bloqueia chamadas futuras: são recusas anteriores à geração, sem consumo de tokens. Se houver queda, timeout, erro 5xx ou falha ao gravar o uso, a chamada fica pendente e novas chamadas são bloqueadas: o consumo real pode ser desconhecido. O request ID do provedor é guardado na intenção assim que a resposta chega, e `GET /v1/ai/unresolved` o devolve para facilitar a reconciliação. Consulte os registros do provedor e reconcilie manualmente a ocorrência antes de liberar novas chamadas; não interprete o total registrado como completo enquanto existir pendência. O provedor pode não disponibilizar dados suficientes para recuperar a contagem exata de uma chamada perdida.

Para reconciliação, o administrador consulta `GET /v1/ai/unresolved` e, somente quando houver dados individuais confirmados pelo provedor, envia `POST /v1/ai/unresolved/<id>/reconcile` com `X-Admin-Token` e JSON contendo `providerRequestId`, `model`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `totalTokens` e `evidence` (descrição da fonte da evidência, sem segredos). A soma de entrada e saída deve coincidir com o total; cache e raciocínio são partes desses valores. A operação rejeita request IDs duplicados, preserva a data original da chamada e registra a evidência. Nunca preencha números estimados como se fossem dados do provedor. Se não houver dados individuais verificáveis, mantenha a pendência: não há como reconstruir uma contagem exata a partir de informação ausente.

Para habilitar: adicione a chave API ao `.env` local (não ao Git), execute `docker compose up -d --build` e abra o dashboard. O painel mostrará o modelo configurado e habilitará o botão. Cada clique envia uma pergunta fixa de demonstração; não usa pedidos nem conteúdo fornecido pelo usuário.

Exemplo de consulta:

```bash
curl -H "X-Admin-Token: $ADMIN_API_TOKEN" \
  "http://localhost:3000/v1/usage/tokens?from=2026-11-01&to=2026-12-01"
```

## Segurança e crescimento

- O webhook exige HMAC SHA-256 sobre o corpo bruto, comparado em tempo constante, valida schema estrito e aplica limite de requisições compartilhado pelo Redis e limite de tamanho. Sem autenticação por tenant, o escopo segue sendo um demo de tenant único.
- O banco usa chaves únicas para impedir duplicação e uma outbox para não separar a persistência do evento da intenção de publicá-lo.
- O endpoint de métricas exige token administrativo e retorna agregados, sem prompts ou respostas.
- A API é stateless e pode escalar horizontalmente; os workers poderão escalar pela fila. A entrega deve ser tratada como *at-least-once*, com idempotência também no consumidor.
- Este ambiente é um MVP de tenant único. Não é produção: antes de exposição pública, implementar autenticação/autorização por tenant, replay protection, secret manager/rotação, TLS, política de retenção e restauração de backups.

## Operações

As rotas abaixo exigem `X-Admin-Token`:

- `GET /v1/operations/summary`: contagem por status, outbox não publicada, idade da mais antiga, mensagens pendentes no Redis e dead letters.
- `GET /v1/operations/events?limit=25&status=failed&cursor=<uuid>`: eventos paginados por cursor.
- `GET /v1/operations/dead-letters`: falhas terminais ainda não reprocessadas.
- `POST /v1/operations/dead-letters/:id/redrive`: grava redrive na outbox transacional e reinicia tentativas; o relay publica no stream.
- `GET /v1/usage/tokens?from=YYYY-MM-DD&to=YYYY-MM-DD`: tokens por provider/modelo/tarefa e total do período.
- `GET /v1/ai/status`: estado do provider, tokens reais usados no dia UTC e teto configurado.
- `POST /v1/ai/demo`: executa o prompt fixo opcional; respeita o rate limit, teto diário e reserva de entrada configurados.

Abra o dashboard, informe o token administrativo local e use o redrive apenas em dados fictícios. O painel não persiste o token em `localStorage`.

## Verificação e documentação

```bash
cd backend
yarn audit && yarn lint && yarn typecheck && yarn test && yarn test:integration && yarn build
```

O CI executa estes passos com PostgreSQL/Redis. Consulte [`docs/modelo-de-ameacas.md`](docs/modelo-de-ameacas.md), [`docs/decisoes.md`](docs/decisoes.md) e [`roteiro.md`](roteiro.md).

## Limites conhecidos antes de publicar

O MVP pode ser apresentado como projeto de portfólio local com as limitações declaradas no roteiro. Não publique `.env`, tokens reais, dados de clientes ou capturas com credenciais. A chamada real de IA não foi exercitada; o recurso é opt-in. O modelo padrão `gpt-6-luna` aparece em catálogos de terceiros como modelo da API da OpenAI (lançado em 22/09/2026), mas o ID não foi confirmado na documentação oficial nem testado aqui; ajuste `OPENAI_MODEL` se necessário. Se o ID estiver errado, a API responde 404, a intenção é encerrada como `rejected` e o exemplo continua disponível. Descrições de terceiros apontam suporte a raciocínio; com o limite padrão de 96 tokens de saída, a resposta pode vir truncada ou vazia se o modelo gastar a saída raciocinando. O uso reportado é registrado do mesmo jeito. Consulte [`roteiro.md`](roteiro.md) e [`context.md`](context.md) para o estado técnico.
