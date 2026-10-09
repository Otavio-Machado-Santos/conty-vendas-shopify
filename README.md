# Vendas atribuídas ao criador

API local para o desafio Conty. Recebe pedidos e estornos, atribui cada pedido a no máximo um criador e conserva os eventos recebidos e aplicados. Não depende de Shopify, rede externa ou bibliotecas de terceiros.

## Executar

Node.js 22, sem dependências a instalar:

```sh
npm test
npm start
```

API em `http://127.0.0.1:3005`. `PORT` e `DATA_FILE` são opcionais; o arquivo padrão é `data/state.json`. `npm run demo` executa requisições HTTP reais em uma API já iniciada. Use um arquivo novo para observar a primeira chegada; repetir a demonstração comprova a idempotência. `API_URL` altera o destino do script.

Comece por [política de atribuição](src/attribution.js), [serviço e histórico](src/sales-service.js), [testes do contrato](test/sales.test.js) e [testes HTTP](test/http.test.js). O [enunciado preservado](docs/enunciado.txt) é a fonte do escopo.

## Regra de atribuição

Cupom reconhecido prevalece sobre UTM, inclusive quando apontam para criadores diferentes. Sem cupom reconhecido, `utm_content` conhecido vence. Sem ambos, o pedido é orgânico. O resultado registra a regra, os dois candidatos e o motivo. A regra inteira está em `AttributionPolicy.decide`; nenhum handler HTTP decide atribuição.

Mappings fictícios: `ANA10` → `creator-ana`, `BRUNO10` → `creator-bruno`; `utm_content` aceita `ana`/`creator-ana` e `bruno`/`creator-bruno`. Cupom ignora caixa e espaços nas bordas; UTM de atribuição ignora caixa. Os mappings são injetáveis pela classe da política, sem espalhar condicionais pela API.

## Contrato HTTP

Todas as respostas são JSON; POST exige `Content-Type: application/json` e até 64 KiB. IDs têm 1–128 caracteres, começam com letra/número e aceitam letras, números, ponto, hífen, sublinhado e dois-pontos. Campos desconhecidos são rejeitados para detectar erros de integração.

| Rota | Comportamento |
| --- | --- |
| `GET /health` | Disponibilidade do processo |
| `POST /orders` | Recebe pedido; `201` na primeira chegada, `200` no replay equivalente |
| `GET /orders/:id` | Pedido, criador/motivo, saldo, estornos e histórico |
| `POST /refunds` | Recebe estorno; `201` novo, `200` replay equivalente |
| `GET /refunds/:id` | Estorno, inclusive pendente antes do pedido |
| `GET /creators/:id/sales` | Totais atribuídos a um criador e pedidos contribuintes |

Erros retornam `{ "error": { "code": "...", "message": "..." } }`: `400` entrada inválida, `404` recurso/rota inexistente, `405` método inválido, `409` mesmo ID com payload diferente, `413` corpo grande, `415` media type inválido, `500` falha de persistência. Nenhum conflito altera a venda original.

### Pedido, cupom contra UTM

```sh
curl -s http://127.0.0.1:3005/orders \
  -H 'Content-Type: application/json' \
  -d '{"id":"order-1","total":"150.00","currency":"BRL","status":"paid","coupon":"ANA10","utms":{"utm_content":"bruno"}}'
```

Trecho da resposta `201`:

```json
{
  "duplicate": false,
  "order": {
    "id": "order-1",
    "total_cents": 15000,
    "attribution": {
      "creator_id": "creator-ana",
      "rule": "coupon",
      "coupon_candidate": "creator-ana",
      "utm_candidate": "creator-bruno",
      "reason": "Cupom reconhecido prevalece sobre UTM de outro criador."
    },
    "refunded_cents": 0,
    "net_attributed_cents": 15000
  }
}
```

`total` aceita decimal string ou número JSON com até duas casas; a alternativa `total_cents` recebe inteiro seguro. Informe exatamente um deles. Strings decimais aceitam até `"90071992547409.91"`, e centavos até `9007199254740991` (`Number.MAX_SAFE_INTEGER`). **Número decimal JSON deve ser menor que `2^45 = 35184372088832` reais**; a partir disso retorna `400 unsafe_numeric_amount` e exige string ou inteiro em centavos. A mesma regra vale para `amount` nos estornos.

O limite numérico é conservador e deriva de IEEE-754 binary64: abaixo de `2^45`, o maior espaçamento entre números adjacentes (ULP) é `2^(44−52) = 1/256` de real, menor que meio centavo. No limite, ele dobra para `1/128`. Como `JSON.parse` já converte o número, tentar recuperar depois o lexema de um decimal grande perderia centavos. Para os números admitidos e strings, a conversão usa representação decimal e `BigInt`, sem multiplicar float por 100. Valores comuns como `0.29` permanecem aceitos e exatos; o literal numérico `90071992547409.91` é rejeitado, e a string equivalente preserva os `9007199254740991` centavos.

`currency` padrão `BRL`; outras moedas são rejeitadas para não misturar totais. `status` aceita `paid`, `pending`, `cancelled`; somente `paid` contribui para a receita atribuída. UTM aceita as chaves padrão `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`.

### Estorno parcial e completo

```sh
curl -s http://127.0.0.1:3005/refunds \
  -H 'Content-Type: application/json' \
  -d '{"id":"refund-1","order_id":"order-1","amount":"30.10"}'

curl -s http://127.0.0.1:3005/refunds \
  -H 'Content-Type: application/json' \
  -d '{"id":"refund-2","order_id":"order-1","type":"full"}'

curl -s http://127.0.0.1:3005/orders/order-1
curl -s http://127.0.0.1:3005/creators/creator-ana/sales
```

O parcial aplica 3.010 centavos; o completo aplica os 11.990 restantes. O pedido mantém `attribution.creator_id` para auditoria, `refunded_cents: 15000`, `net_attributed_cents: 0`, dois estornos e cinco eventos de histórico. Os totais do criador são strings inteiras (`gross_cents: "15000"`, `refunded_cents: "15000"`, `net_cents: "0"`), evitando perda de precisão na soma de muitas vendas.

`type` padrão `partial`: exige exatamente `amount` ou `amount_cents`, positivo. `full` não recebe valor e reverte o saldo disponível no momento da aplicação. O ID é único globalmente por tipo de evento: um ID de estorno não pode migrar para outro pedido.

Se o estorno chegar primeiro, a resposta contém `state: "pending"`, `applied_at: null`, `applied_cents: 0`; `GET /refunds/:id` já o encontra. Ao chegar o pedido, os estornos são aplicados na ordem de recebimento, usando sequência persistida em vez de desempatar pelo relógio. O histórico mantém a chegada e adiciona a aplicação.

O excedente de um estorno é **limitado ao saldo**, com `state: "capped"`, `requested_cents`, `applied_cents` e `unapplied_cents` explícitos. Isso conserva um evento anterior ao pedido sem descartá-lo, nunca produz saldo negativo e deixa a divergência visível para reconciliação. O excedente não é automaticamente transferido nem aplicado posteriormente.

## Idempotência, persistência e limites

Pedido e estorno são snapshots imutáveis identificados pelo ID. Um replay com payload normalizado igual devolve o estado atual sem nova receita, estorno ou evento. Se o mesmo ID trouxer outro total, status, cupom, UTM, pedido de destino ou tipo/valor de estorno, retorna `409`; atualização do ciclo de pagamento seria outro contrato/evento, fora deste desafio. `pending` e `cancelled` recebidos inicialmente não creditam criadores.

O serviço calcula a próxima versão em uma cópia e só publica o estado após a persistência. O arquivo é escrito com permissões `0600`, sincronizado e renomeado atomicamente. Pendências e IDs sobrevivem a reinícios; falha de gravação não publica estado parcial. Requisições HTTP concorrentes no mesmo processo são serializadas no trecho síncrono de domínio/persistência.

Essa persistência foi escolhida para tornar a entrega executável sem infraestrutura. **Use somente um processo por arquivo**: não oferece lock entre processos, transações distribuídas nem desempenho de banco. Para produção, usar banco transacional, índices únicos por ID, assinatura/autenticação do webhook, reconciliação, fila e política explícita de atualização de pagamento. A API escuta apenas loopback e não implementa verificação de assinatura Shopify porque o provedor é simulado.

## Validação e IA

`npm test` cobre duplicação, conflitos, cupom contra UTM, orgânico, precisão monetária (incluindo os literais HTTP grandes, a alternativa string/centavos e 1.000 valores perto do limite numérico), pagamento não confirmado, parcial/full, replay de estorno, chegada antes do pedido, ordenação de pendências, limite do saldo, concorrência HTTP, restart, arquivo corrompido, erro de disco e erros HTTP. O [log real da suíte](docs/evidence/test.txt) registra o resultado; a [demonstração HTTP](docs/evidence/demo.jsonl) registra respostas reais da execução local com dados fictícios.

A [verificação de precisão por HTTP](docs/evidence/money-precision.json) preserva os corpos literais recebidos e as seis respostas: rejeição do NUMBER grande no pedido/estorno, aceitação exata da string e replay equivalente em centavos. A revisão independente identificou essa perda potencial antes do envio, e a implementação passou a exigir uma representação segura nessa faixa.

Implementação, testes, documentação e análise local foram feitos com IA Codex. Os testes foram executados em Node.js 22. A revisão por agentes independentes será registrada separadamente antes do envio; este texto não afirma revisão humana nem integração com uma loja real.
