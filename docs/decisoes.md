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

## ADR-006 — Segredo de webhook cifrado, token admin como hash

**Decisão:** chaves HMAC das lojas guardadas com AES-256-GCM sob `TENANT_SECRETS_KEY`, com loja e id da chave como dados autenticados; tokens administrativos guardados como SHA-256.

**Motivo:** o HMAC exige o segredo em claro na verificação, então ele não pode ser hash. Já o token admin só precisa ser comparado, e por ser aleatório de 256 bits dispensa bcrypt/argon2. Os dados autenticados impedem que o ciphertext de uma loja, copiado para outra no banco, decifre.

**Consequência:** `TENANT_SECRETS_KEY` vira o segredo mais crítico do sistema. Ele fica fora do banco e do backup, e precisa de cópia própria. A troca é feita sem parada: a chave antiga só decifra enquanto `rotate-master-key` recifra as linhas (ADR-012).

## ADR-007 — Proteção contra replay por horário assinado

**Decisão:** assinatura sobre `<timestamp>.<corpo>`, janela de 300 s; dentro da janela, a deduplicação por `eventId` absorve o reenvio.

**Motivo:** é o mesmo padrão de Stripe e Slack, conhecido por quem integra. Um nonce guardado por requisição exigiria mais estado por pedido, e o `eventId` já cumpre esse papel.

**Consequência:** o remetente precisa de relógio sincronizado. A mudança quebrou a compatibilidade do protocolo, o que foi aceitável porque ainda não havia remetente real.

## ADR-008 — Trim do stream por piso seguro, não por tamanho

**Decisão:** `XTRIM MINID` com o menor entre o corte por idade, a mensagem pendente mais antiga e a primeira não lida pelo grupo.

**Motivo:** `MAXLEN` apaga por contagem, inclusive mensagens pendentes ou ainda não lidas. Um worker parado perderia pedidos.

**Consequência:** com o worker parado, o stream cresce até ele voltar. Isso é preferível a perder pedidos, mas exige monitorar a memória do Redis.

## ADR-009 — Retenção limpa o payload, mas mantém a identidade do evento

**Decisão:** depois de `DATA_RETENTION_DAYS`, o payload de pedidos entregues vira `{}`; a linha, com `eventId`, status e datas, permanece. Dead letters mantêm o payload.

**Motivo:** apagar a linha faria a deduplicação esquecer o `eventId`, e um reenvio tardio do remetente geraria uma segunda entrega. O redrive precisa do payload.

**Consequência:** a tabela de eventos cresce em número de linhas, mas não em volume de dados de pedido.

## ADR-010 — Produção num host com Caddy e Docker secrets

**Decisão:** `compose.prod.yaml` separado do de desenvolvimento, com Caddy (HTTPS automático) como único serviço exposto, segredos como arquivos (`*_FILE`) e a API confiando em exatamente um proxy.

**Motivo:** a configuração não depende de provedor, e a convenção `*_FILE` funciona igual com Docker secrets, Kubernetes ou agentes de gerenciadores de segredos.

**Consequência:** sem alta disponibilidade. Escalar exige PostgreSQL e Redis gerenciados ou replicados (ver `roteiro.md`).

## ADR-011 — Falha de dependência é 503, nunca queda do processo

**Decisão:** listener de `error` em todo pool `pg`, espera do banco na partida e tratador global que responde 503 para indisponibilidade e 500 genérico para o resto.

**Motivo:** o teste de resiliência mostrou os processos morrendo quando o PostgreSQL reiniciava (evento `error` não tratado) e entrando em loop de reinício na partida. Clientes ficavam sem resposta em vez de receber um 503 para tentar de novo.

**Consequência:** o teste de resiliência falha se api ou relay reiniciarem, ou se algum pedido ficar sem resposta HTTP.

## ADR-012 — Troca da chave mestra por chaveiro com tentativa em ordem

**Decisão:** `TENANT_SECRETS_KEY` (atual) mais `TENANT_SECRETS_KEY_PREVIOUS` (só durante a troca). A decifragem tenta a atual e depois as anteriores; um comando recifra as linhas com a atual.

**Motivo:** no AES-GCM, a chave errada falha na autenticação, então tentar em ordem é seguro e dispensa gravar um identificador de chave no formato. O comando é idempotente e roda com a API no ar, com lock por linha e em lotes.

**Consequência:** durante a troca, a leitura de uma linha antiga custa uma decifragem a mais. Uma linha que nenhuma chave abre é ignorada com aviso: a loja perde só aquela chave, não o webhook inteiro.
