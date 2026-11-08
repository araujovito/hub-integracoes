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

## Lojas e credenciais

Cada loja (tenant) tem chaves de webhook e tokens administrativos próprios. O operador da plataforma usa `PLATFORM_ADMIN_TOKEN` (header `X-Platform-Token`) para cadastrar lojas e emitir credenciais; esse token não lê dados de nenhuma loja. Segredos e tokens aparecem **uma única vez**, na resposta de criação.

```bash
H='X-Platform-Token: <PLATFORM_ADMIN_TOKEN>'
curl -X POST localhost:3000/v1/platform/tenants -H "$H" -H 'content-type: application/json' -d '{"id":"loja-a","name":"Loja A"}'
curl -X POST localhost:3000/v1/platform/tenants/loja-a/webhook-keys -H "$H" -H 'content-type: application/json' -d '{}'
curl -X POST localhost:3000/v1/platform/tenants/loja-a/admin-tokens -H "$H" -H 'content-type: application/json' -d '{"label":"operador"}'
```

A loja envia pedidos para `POST /v1/webhooks/orders` com três headers:

- `X-Tenant-Id: loja-a`
- `X-Webhook-Timestamp`: horário do envio em segundos Unix
- `X-Webhook-Signature: sha256=<hex>`: HMAC-SHA256, com o segredo da loja, de `<timestamp>.<corpo bruto>`

```bash
TS=$(date +%s); SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/.* //')
```

**Proteção contra replay:** pedidos com horário a mais de `WEBHOOK_TOLERANCE_SECONDS` (padrão 300) do relógio do servidor são recusados com `timestamp_out_of_tolerance`, mesmo com assinatura válida. Como o horário faz parte da assinatura, não dá para atualizá-lo numa requisição capturada. Dentro da janela, um reenvio idêntico cai na deduplicação por `eventId` e não gera efeito. O relógio do remetente precisa estar sincronizado (NTP). Loja inexistente, loja desativada e assinatura errada recebem a mesma resposta (401), para o endpoint não revelar quais lojas existem.

- **Troca de chave sem parada:** criar uma chave nova dá às anteriores uma carência (`graceHours`, padrão 24). Durante a carência, as duas são aceitas; `graceHours: 0` encerra as antigas na hora. `DELETE .../webhook-keys/<keyId>` revoga imediatamente.
- **Token administrativo por loja:** o dashboard e as rotas de operações usam `X-Admin-Token` da loja e só enxergam os dados dela. `DELETE .../admin-tokens/<tokenId>` revoga.
- **Armazenamento:** segredos de webhook ficam cifrados com AES-256-GCM sob `TENANT_SECRETS_KEY`; tokens administrativos, só como SHA-256. Perder `TENANT_SECRETS_KEY` torna as chaves de webhook ilegíveis: as lojas precisam de chaves novas.

## Fluxo do MVP

```text
Webhook assinado → validação → PostgreSQL (evento + outbox na mesma transação)
                                               ↓
                                      relay para Redis Streams
                                               ↓
                                   worker → ERP simulado
```

A API recebe webhook assinado e grava evento + outbox na mesma transação. Um relay independente reivindica a outbox com `FOR UPDATE SKIP LOCKED` e publica no Redis Streams. Um worker em consumer group recupera mensagens pendentes via `XAUTOCLAIM`, aplica o efeito numa tabela ERP simulada com chave única e confirma com `XACK` depois do commit. Falhas são contabilizadas e, ao atingir o limite, vão para `dead_letter_events`.

## Retenção

O serviço `maintenance` roda a cada `MAINTENANCE_INTERVAL_SECONDS` (padrão 1 h), com advisory lock para réplicas não se sobreporem:

- **Redis Streams:** remove entradas mais antigas que `STREAM_RETENTION_HOURS` (padrão 72), mas nunca uma mensagem pendente (lida e sem `XACK`) nem uma que o consumer group ainda não leu. Sem o consumer group, não remove nada.
- **PostgreSQL:** depois de `DATA_RETENTION_DAYS` (padrão 90), o payload de pedidos entregues e das entregas no ERP simulado vira `{}` e a data fica em `payload_redacted_at`. A linha do evento continua, então um `eventId` antigo segue sendo reconhecido como duplicado. Linhas publicadas da outbox mais antigas que o prazo são apagadas. Pedidos em dead letter mantêm o payload, para poderem ser reprocessados.
- Tudo é feito em lotes curtos, sem transação longa nem lock de tabela.

## Contagem de tokens

`ai_token_usage` guarda, por execução, tarefa, provedor, modelo, tokens de entrada, saída, total, cache e raciocínio, além do request ID. `recordTokenUsage()` aceita somente números reportados pelo provider; não estima tokens por caracteres nem converte o uso em moeda. Cache é subconjunto da entrada e raciocínio é subconjunto da saída; não devem ser somados ao total outra vez. O endpoint `GET /v1/usage/tokens` agrega o uso da loja e exige o `X-Admin-Token` dela.

O backend inclui um exemplo opcional via OpenAI Responses API, usando `gpt-6-luna`, pergunta fixa, saída limitada, `store: false`, sem retries automáticos e limite de 3 chamadas por hora. Configure `OPENAI_API_KEY` no `.env` local para habilitar o botão; sem chave, nenhuma chamada externa acontece. Acionar o exemplo pode gerar cobrança na conta da API. Prompt e resposta não são persistidos pelo app. O painel contabiliza tokens reportados pelo provedor (entrada, cache, saída e raciocínio), não calcula preço em reais ou outra moeda. A contagem cobre só as chamadas feitas pelo próprio app.

O exemplo tem um teto diário configurável (`OPENAI_DAILY_TOKEN_LIMIT`, padrão 5.000), serializa admissões entre instâncias via advisory lock no PostgreSQL e limita `max_output_tokens` com base no uso real já registrado. Por padrão, reserva 256 tokens para a entrada fixa antes de admitir uma chamada (`OPENAI_RESERVED_INPUT_TOKENS`). O provedor só informa a contagem exata depois de executar; a reserva é uma margem de admissão, não uma contagem nem garantia matemática contra qualquer overhead.

Antes da chamada, o app registra uma intenção persistente. Quando a resposta e o uso são recebidos, grava o ledger e conclui essa intenção na mesma transação. Se o provedor recusar a requisição com 400, 401, 403, 404, 422 ou 429 (chave inválida, modelo inexistente, limite de taxa ou cota), a intenção é encerrada como `rejected`, com o status HTTP e o request ID, e não bloqueia chamadas futuras: são recusas anteriores à geração, sem consumo de tokens. Se houver queda, timeout, erro 5xx ou falha ao gravar o uso, a chamada fica pendente e novas chamadas são bloqueadas: o consumo real pode ser desconhecido. O request ID do provedor é guardado na intenção assim que a resposta chega, e `GET /v1/ai/unresolved` o devolve para facilitar a reconciliação. Consulte os registros do provedor e reconcilie manualmente a ocorrência antes de liberar novas chamadas; não interprete o total registrado como completo enquanto existir pendência. O provedor pode não disponibilizar dados suficientes para recuperar a contagem exata de uma chamada perdida.

Para reconciliação, o administrador consulta `GET /v1/ai/unresolved` e, somente quando houver dados individuais confirmados pelo provedor, envia `POST /v1/ai/unresolved/<id>/reconcile` com `X-Admin-Token` e JSON contendo `providerRequestId`, `model`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `totalTokens` e `evidence` (descrição da fonte da evidência, sem segredos). A soma de entrada e saída deve coincidir com o total; cache e raciocínio são partes desses valores. A operação rejeita request IDs duplicados, preserva a data original da chamada e registra a evidência. Nunca preencha números estimados como se fossem dados do provedor. Se não houver dados individuais verificáveis, mantenha a pendência: não há como reconstruir uma contagem exata a partir de informação ausente.

Para habilitar: adicione a chave API ao `.env` local (não ao Git), execute `docker compose up -d --build` e abra o dashboard. O painel mostrará o modelo configurado e habilitará o botão. Cada clique envia uma pergunta fixa de demonstração; não usa pedidos nem conteúdo fornecido pelo usuário.

Exemplo de consulta:

```bash
curl -H "X-Admin-Token: $STORE_ADMIN_TOKEN" \
  "http://localhost:3000/v1/usage/tokens?from=2026-11-01&to=2026-12-01"
```

## Segurança e crescimento

- O webhook exige HMAC SHA-256 sobre horário + corpo bruto com a chave da loja, recusa horários fora da janela de tolerância, comparado em tempo constante, valida schema estrito e aplica limite de requisições compartilhado pelo Redis e limite de tamanho.
- O banco usa chaves únicas para impedir duplicação e uma outbox para não separar a persistência do evento da intenção de publicá-lo.
- Cada token administrativo é de uma loja e todas as consultas de operações filtram por ela; testes de integração cobrem o acesso cruzado (eventos, cursor, dead letters, redrive).
- A API é stateless e pode escalar horizontalmente; os workers poderão escalar pela fila. A entrega deve ser tratada como *at-least-once*, com idempotência também no consumidor.
- Limites que continuam valendo estão em `roteiro.md` e no modelo de ameaças.

## Operações

As rotas abaixo exigem o `X-Admin-Token` de uma loja e respondem só com dados dela:

- `GET /v1/operations/summary`: contagem por status, outbox não publicada, idade da mais antiga e dead letters.
- `GET /v1/operations/events?limit=25&status=failed&cursor=<uuid>`: eventos paginados por cursor.
- `GET /v1/operations/dead-letters`: falhas terminais ainda não reprocessadas.
- `POST /v1/operations/dead-letters/:id/redrive`: grava redrive na outbox transacional e reinicia tentativas; o relay publica no stream.
- `GET /v1/usage/tokens?from=YYYY-MM-DD&to=YYYY-MM-DD`: tokens por provider/modelo/tarefa e total do período.
- `GET /v1/ai/status`: estado do provider, tokens reais usados no dia UTC e teto configurado.
- `POST /v1/ai/demo`: executa o prompt fixo opcional; respeita o rate limit, teto diário e reserva de entrada configurados.

Rotas da plataforma (`X-Platform-Token`): `POST /v1/platform/tenants`, `POST|DELETE /v1/platform/tenants/:id/webhook-keys[/:keyId]`, `POST|DELETE /v1/platform/tenants/:id/admin-tokens[/:tokenId]` e `GET /v1/platform/queue` (outbox e pendências do Redis Streams, que é compartilhado por todas as lojas).

Abra o dashboard, informe o token administrativo da loja e use o redrive apenas em dados fictícios. O painel não persiste o token em `localStorage`.

## Produção (um servidor com Docker)

`compose.prod.yaml` é a configuração de produção, independente da de desenvolvimento:

```bash
scripts/generate-prod-secrets.sh                       # uma vez: cria ./secrets (fora do Git)
DOMAIN=hub.exemplo.com.br docker compose -f compose.prod.yaml up -d --build
```

- **HTTPS:** o Caddy recebe nas portas 80/443 e emite e renova o certificado sozinho (Let's Encrypt). O DNS do `DOMAIN` precisa apontar para o servidor, com as portas 80 e 443 abertas. HTTP redireciona para HTTPS, e o HSTS fica ligado. Com `DOMAIN=localhost`, o Caddy usa a autoridade certificadora interna dele, útil só para testar.
- **Rede:** só o Caddy publica portas. PostgreSQL, Redis e a API ficam acessíveis apenas dentro da rede do Compose. A API confia em exatamente um proxy (`TRUST_PROXY_HOPS=1`), então limite por IP e logs usam o IP real do cliente.
- **Segredos:** arquivos em `./secrets`, montados como Docker secrets e lidos pela convenção `*_FILE`. Nenhum segredo vai para variáveis de ambiente nem aparece no `docker inspect`. A senha do Redis fica num arquivo de configuração, não na linha de comando. Para usar um gerenciador de segredos (Vault, AWS/GCP Secret Manager), basta o agente dele gravar os mesmos arquivos.
- **`TENANT_SECRETS_KEY`** é a chave que decifra as chaves de webhook das lojas. Guarde uma cópia dela separada dos backups do banco: sem ela, um backup restaurado não verifica nenhum webhook.

## Backup e restauração

```bash
COMPOSE_ARGS="-f compose.prod.yaml" scripts/backup.sh /caminho/backups   # pg_dump + .sha256, mantém os 14 mais recentes
scripts/restore-test.sh /caminho/backups/hub-<data>.dump                  # prova que o backup restaura
```

- `backup.sh` gera um dump consistente (`pg_dump`, formato custom), confere que ele é legível antes de dar o arquivo por concluído e grava o SHA-256. Agende com cron ou um timer do systemd, e copie os dumps para um armazenamento **cifrado e fora do servidor**: eles contêm dados de pedidos.
- `restore-test.sh` confere o checksum, restaura num PostgreSQL descartável (mesma imagem da produção) com `--exit-on-error` e roda a imagem da aplicação contra o banco restaurado. As migrations precisam bater pelo checksum, e o script mostra a contagem das tabelas. Não toca na stack em execução. O teste de resiliência do CI faz backup e restauração a cada push e compara a contagem com o banco de origem.
- Restaurar de verdade é uma decisão de operação: parar api/relay/worker/maintenance e rodar `pg_restore --clean --if-exists` no banco de produção. Isso substitui os dados atuais, então não está automatizado.
- O dump não contém `TENANT_SECRETS_KEY`. Sem essa chave, as chaves de webhook restauradas não podem ser lidas e as lojas precisam de chaves novas.

## Verificação e documentação

```bash
cd backend
yarn audit && yarn lint && yarn typecheck && yarn test && yarn test:integration && yarn build
```

O CI executa estes passos com PostgreSQL/Redis. Consulte [`docs/modelo-de-ameacas.md`](docs/modelo-de-ameacas.md), [`docs/decisoes.md`](docs/decisoes.md) e [`roteiro.md`](roteiro.md).

## Limites conhecidos antes de publicar

O MVP pode ser apresentado como projeto de portfólio local com as limitações declaradas no roteiro. Não publique `.env`, tokens reais, dados de clientes ou capturas com credenciais. A chamada real de IA não foi exercitada; o recurso é opt-in. O modelo padrão `gpt-6-luna` aparece em catálogos de terceiros como modelo da API da OpenAI (lançado em 22/09/2026), mas o ID não foi confirmado na documentação oficial nem testado aqui; ajuste `OPENAI_MODEL` se necessário. Se o ID estiver errado, a API responde 404, a intenção é encerrada como `rejected` e o exemplo continua disponível. Descrições de terceiros apontam suporte a raciocínio; com o limite padrão de 96 tokens de saída, a resposta pode vir truncada ou vazia se o modelo gastar a saída raciocinando. O uso reportado é registrado do mesmo jeito. Consulte [`roteiro.md`](roteiro.md) e [`context.md`](context.md) para o estado técnico.
