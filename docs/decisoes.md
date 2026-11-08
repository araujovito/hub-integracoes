# Decisões técnicas

## ADR-001 — Outbox PostgreSQL + Redis Streams

**Decisão:** persistir pedido e outbox na mesma transação SQL; relay independente publica no Redis Streams; workers usam consumer group.

**Motivo:** manter confiável a fronteira de persistência e desacoplar integrações lentas, permitindo escalar workers.

**Consequência:** PostgreSQL e Redis não têm commit atômico conjunto; o relay pode republicar após falha entre `XADD` e atualização SQL. A entrega é *at-least-once*, portanto o consumidor usa chave única e só confirma após o commit do efeito.

## ADR-004 — Redrive também passa pela outbox

**Decisão:** atualizar o dead letter, reiniciar o evento e gravar a intenção de redrive na outbox na mesma transação PostgreSQL; o relay publica no Redis depois.

**Motivo:** evitar a janela Redis-publicou/SQL-rollback que deixaria o worker processar uma ação não confirmada no banco.

**Consequência:** o redrive é assíncrono e responde `202` após a transação local; a publicação ocorre no ciclo normal do relay.

## ADR-005 — Liveness separado de readiness

**Decisão:** `/health` informa que o processo HTTP está vivo; `/ready` verifica PostgreSQL e Redis.

**Motivo:** não reiniciar um processo saudável só porque uma dependência transitória está indisponível; readiness pode retirar o serviço do tráfego até a recuperação.

**Consequência:** monitoramento e orquestração devem usar `/ready` para tráfego e `/health` para liveness.

## ADR-002 — ERP simulado antes de integração externa

**Decisão:** demonstrar efeito de negócio numa tabela local com unique key.

**Motivo:** desenvolver e demonstrar sem contas, credenciais, dados reais ou custos de terceiros.

**Consequência:** os resultados mostram o pipeline e não certificam compatibilidade com ERP real.

## ADR-003 — Ledger de tokens sem conteúdo

**Decisão:** armazenar contagens reportadas pelo provedor, tarefa, provedor/modelo e request ID; não persistir prompt nem resposta e não converter tokens para moeda.

**Motivo:** medir consumo de tokens mantendo minimização de dados.

**Consequência:** até conectar provider autorizado, a métrica deve ficar vazia; contagem estimada não será apresentada como consumo real.
