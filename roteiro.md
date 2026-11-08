# Roteiro de evolução — Hub de Integrações

Objetivo: transformar o MVP em uma demonstração de portfólio segura, observável e escalável de integrações de pedidos, contabilizando o consumo de IA em tokens reportados pelo provedor, sem converter para moeda. O escopo inicial é deliberadamente local e usa um ERP simulado; nenhuma credencial externa é necessária.

## Estado atual

- API Fastify em TypeScript, PostgreSQL e Redis em Docker Compose; portas locais vinculadas a loopback.
- Webhook de pedidos autenticado por HMAC sobre o corpo bruto, schema estrito, rate limit e limite de payload.
- Evento e intenção de publicação (outbox) gravados na mesma transação PostgreSQL; deduplicação por tenant/origem/evento.
- `ai_token_usage` e `recordTokenUsage()` registram metadados de uso reportados pelo provedor, sem guardar prompt/resposta nem calcular preço em moeda. A chamada de demonstração permanece opt-in.
- Health check e endpoint administrativo agregado de tokens protegidos.
- Typecheck, testes, build e smoke tests anteriores passaram. Revalidar após as novas mudanças.

## Arquitetura alvo do MVP

```text
Webhook HMAC → validação → PostgreSQL (evento + outbox atômicos)
                                      ↓
                              relay outbox → Redis Streams
                                                ↓
                                  consumer group / worker
                                                ↓
                                  ERP simulado idempotente
                                                ↓
                                   status + métricas
```

Redis Streams com consumer groups permite distribuir mensagens e mantê-las pendentes até o `XACK`; a recuperação de mensagens pendentes deve ser considerada. Isso é entrega *at-least-once*, não exactly-once. Portanto a idempotência do efeito de negócio no destino é obrigatória. Referência: documentação oficial Redis sobre [consumer groups](https://redis.io/docs/latest/develop/data-types/streams/), [XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/), [XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim/) e [XACK](https://redis.io/docs/latest/commands/xack/).

## Próximos passos detalhados

### 1. Fechar a entrega assíncrona confiável (MVP implementado; recuperação Redis automatizada e manualmente testada)

1. Evoluir migrations de forma aditiva e idempotente; rodar todas em ordem sem apagar dados.
2. Criar relay separado que reivindica linhas da outbox com `FOR UPDATE SKIP LOCKED`, publica no stream e marca o registro publicado. Aceitar que uma queda após `XADD` e antes do commit pode publicar duplicata.
3. Criar worker com consumer group, reconhecimento somente depois do commit do efeito no banco e recuperação de pendências antigas com `XAUTOCLAIM`.
4. Implementar ERP simulado numa tabela de entregas com chave única por tenant/evento; uma repetição não cria efeito duplicado.
5. Contabilizar tentativas, falha terminal e dead-letter; redrive transacional pela outbox implementado e validado ponta a ponta (202 → outbox → relay → worker → uma entrega).
6. Testes de integração cobrem migrations repetíveis, ledger de tokens idempotente, lock concorrente do teto de tokens, dedupe concorrente, limite de retries/DLQ, recuperação via XAUTOCLAIM e indisponibilidade Redis seguida de recuperação da outbox com evento preservado. Testes manuais com processos reais confirmaram recuperação após Redis indisponível e após worker parado/reiniciado; ambos entregaram uma vez e os dados foram removidos. Ainda falta automatizar crash/restart dos processos ponta a ponta.

### 2. Operação e observabilidade (MVP local implementado; endurecimento pendente)

1. Expor contagens de recebidos, fila, entregues, falhos, pendentes e dead-letter sem incluir payload/segredos (feito no MVP).
2. Logs estruturados com `eventId`, correlação e resultado já mascaram os headers de autenticação; revisar logging ao adicionar integrações externas.
3. Relay e worker agora mantêm o processo vivo em falhas transitórias e tentam novamente com backoff exponencial limitado e jitter. Ainda faltam timeouts SQL explícitos e política de concorrência/carga sustentada.
4. Configurar retenção/trim de streams e política de retenção/auditoria PostgreSQL; monitorar backlog e idade do evento mais antigo.
5. Health/readiness distintos: `/health` informa liveness; `/ready` verifica dependências (implementado).

### 3. Segurança e isolamento

1. Sair do tenant demo: autenticação de tenants, autorização por recurso e chaves HMAC individuais com rotação.
2. Validar replay (timestamp/nonce), limites por cliente e política de tamanho/campos permitidos.
3. Segregar credenciais por ambiente via secret manager; TLS em trânsito e backups/restauração testados.
4. Minimizar dados pessoais; hoje o pedido aceita somente identificadores/SKUs/quantidades/valores e não guarda dados de cliente.
5. Threat model e testes contra abuso, vazamento via logs, injection e acesso cruzado entre tenants.

### 4. Integração real e medição de IA (adaptador e ledger de tokens implementados; chamada externa opt-in)

1. IA permanece opcional; caso demonstrativo fixo não envia dados reais de pedidos.
2. Adaptador OpenAI Responses implementado; modelo default `gpt-6-luna` configurável. Executar somente após configurar chave e clicar conscientemente no botão, pois pode gerar cobrança.
3. São registrados tokens reportados, breakdown cache/raciocínio, modelo, tarefa, latência no log e request ID; prompt/resposta não são persistidos pelo app.
4. Tokens de entrada, cache, saída, raciocínio e total são persistidos por chamada, agregados no endpoint e exibidos no dashboard; cache é subconjunto da entrada e raciocínio da saída, sem dupla contagem; não converter o uso para moeda.
5. Nunca inferir tokens por caracteres quando o provedor oferece contagem oficial; nunca persistir prompt/resposta por padrão. Métrica do app não corresponde ao uso interno de uma conversa do Codex.
6. Teto diário de tokens implementado com advisory lock PostgreSQL, reserva conservadora para entrada, limite dinâmico de saída e rate limit; a contagem real só é registrada após a resposta do provedor, então não é possível prever exatamente o consumo antes da chamada. Timeout de 30s e zero retries automáticos; avaliar fallback apenas quando houver um segundo provider.
7. Testar agregação por período, idempotência por request ID, campos ausentes e resposta de erro.

### 5. API de operações e interface de portfólio (MVP local implementado; auditoria/UX pendentes)

1. API protegida para listar eventos com paginação e filtros, detalhar status sem expor segredos e pedir redrive via outbox transacional (validado ponta a ponta).
2. Dashboard local com fila, sucesso/falha, latência, tentativas e tokens por período/modelo/tarefa; controles responsivos, foco visível e estados de carregamento/erro implementados. Revisão manual em navegadores e documentação visual ainda pendentes.
3. Filtro de tokens por período implementado (padrão 30 dias; API limita a janela a 366 dias). O intervalo do dashboard é enviado em UTC; acessibilidade automatizada básica coberta, revisão completa ainda necessária.
4. Não permitir que a interface seja a única barreira de autorização; autorização vive na API.

### 6. Qualidade, deploy e apresentação (CI, auditoria de dependências e documentação base implementadas)

1. CI executa typecheck, testes unitários/de integração, build, lint, auditoria de dependências e secret scan.
2. Testes automatizados cobrem recuperação da outbox após falha Redis e recuperação de mensagem pendente via XAUTOCLAIM. Foram validadas manualmente recuperação do relay/worker após indisponibilidade breve do Redis e recuperação da fila após parada/reinício do worker, ambas com entrega única. Ainda faltam testes automatizados de indisponibilidade PostgreSQL, crash/restart do worker e carga sustentada. Foi feito burst local controlado de 30 pedidos + 30 duplicatas concorrentes, com 30 entregas únicas.
3. Docker executa como usuário não-root; tags das imagens base são explícitas, mas ainda não fixadas por digest. Rever/pinar ações de CI e imagens por digest antes de deploy.
4. Guia local de demonstração, diagrama, decisões ADR, limitações conhecidas e threat model resumido.
5. Só então considerar deploy de demonstração com dados fictícios, orçamento/limites e segredos gerenciados.

## Critérios de pronto do MVP

- Reenviar o mesmo webhook não duplica evento nem efeito no ERP simulado.
- Falha Redis mantém evento na outbox para publicação posterior; queda do worker deixa mensagem recuperável, reconhecida somente depois do efeito persistido.
- Falhas transitórias têm tentativas limitadas e falha terminal visível, sem loop infinito.
- Logs e respostas não revelam assinatura, token administrativo, credenciais, prompts ou payloads sensíveis.
- Métricas de tokens permanecem zeradas até existir chamada real; números não são inventados.
- `docker compose up --build`, testes, typecheck e build passam em ambiente limpo.

## Como retomar

Leia primeiro `context.md`, depois este roteiro e `README.md`. Trabalhe em etapas pequenas, atualize os documentos após cada marco, não altere `.env`, não faça deploy nem configure serviço pago sem instrução explícita. Rode verificações e relate claramente o que foi e não foi testado.
# Atualização: reconciliação de tokens

O journal registra chamadas antes do envio e bloqueia novas chamadas quando o consumo fica incerto. A API administrativa permite consultar pendências e registrar somente contagens individuais verificadas, com evidência e proteção contra duplicação. Sem dados recuperáveis do provedor, a pendência permanece e não é possível garantir um total exato. Testar o adaptador real exige autorização explícita para uma chamada potencialmente paga.

