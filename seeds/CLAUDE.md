# seeds/

## Papel desta pasta

Carga de **massa de teste manual**: cria, na aplicação que já está no ar, uma empresa nova (o lote) com os registros de que cada fluxo precisa para ser testado na mão. Não é teste; roda pelo Playwright (`playwright.seed.config.ts`) só para reaproveitar os `helpers/` do e2e. Os roteiros que usam a massa ficam em `docs/cenarios-de-teste/` (raiz do workspace), com o mesmo número.

| Arquivo | Papel |
|---|---|
| `../scripts/seed.js` | linha de comando (`npm run seed -- <fluxos> [--runs N] [--lot id] [--up] [--back --front --db] [--list]`); confere o `/health`, recusa alvo fora de `localhost`; `--up` sobe o back e os fakes do e2e só durante a carga (`webServer` do `playwright.config.ts`, sem os dois fronts), e `--db <nome>` troca o banco da carga E o do back que o `--up` sobe |
| `run.seed.ts` | abre o lote, roda o `run` de cada fluxo pedido, grava `output/lote-<id>.md` (ignorado pelo git) |
| `lib/lot.ts` | o lote: empresa nova, API do dono, `note`, `addLogin`, `once` |
| `lib/random.ts` | sorteio com semente (id do lote): nomes, CPF/CNPJ válidos, celular, endereço, datas |
| `lib/builders.ts` | construtores: cadastro (um por lote, `lot.once`) e movimento (novo a cada chamada) |
| `lib/notes.ts` | anotações do relatório do lote, no nome que a pessoa vê na tela |
| `flows/<NN>-<area>.ts` | uma entrada `FlowSeed` por fluxo da área; `flows/full-flows.ts` para os `FC-NN`; `flows/index.ts` junta tudo |

## Forma de um seed novo

No arquivo da área (`flows/05-budgets.ts`), uma entrada por fluxo, com o **mesmo id do spec e do cenário**:

```ts
{
  flow: '5.9',
  summary: '3 orçamentos enviados com link público, para <o que o fluxo faz com eles>.',
  run: async (lot) => noteBudgets(lot, 'enviado', await sentBudgets(lot)),
},
```

- **Pelo menos 3 registros** (`RECORDS_PER_FLOW`), no estado em que o fluxo COMEÇA. Fluxo de cadastro leva também 3 fichas para digitar (`notePeopleSheets`, `noteCompanySheets`).
- `summary` em linguagem de quem testa, dizendo só o que a carga cria de fato. O `.claude/scripts/check-scenarios.js` o copia para o arquivo de cenário.
- Todo registro criado é anotado (`lot.note` ou um `note*`): o que não está no arquivo do lote a pessoa não acha na tela.
- Cadastro compartilhado (cliente, atividade, colaborador) vem de `lib/builders.ts` com `lot.once`; movimento (orçamento, festa, locação, contrato) é criado de novo a cada fluxo, porque o teste manual o consome.
- Dado sorteado sai de `lot.rng` e de `lib/random.ts`; e-mail leva o id do lote. Nada de `Date.now()` no nome que aparece na tela.
- Pré-condição pelos `helpers/` do e2e (`api-entities`, `api-event-flow`, `setup-flows`, ...). Falta helper: criar lá, no padrão `apiCreate{X}`, e usar aqui.
- Área nova: arquivo `flows/<NN>-<area>.ts` e a linha em `flows/index.ts`.

## Checklist ao criar

1. `flow` e `summary` em linhas seguidas, nessa ordem, cada um numa string de aspas simples de UMA linha (são lidos por expressão regular).
2. `node ../../.claude/scripts/run-tests.js e2e --types` (o Playwright transpila sem checar tipo).
3. `npm run seed -- <fluxo>` com a aplicação no ar: sem `[FALHOU]` no lote, e os registros aparecem na tela com o login do lote. Agente roda pela fila da máquina, com a aplicação parada e num banco à parte: `node ../../.claude/scripts/limit-resources.js -- node scripts/seed.js <fluxo> --up --db massa-validacao` (da pasta `admin-playwright`, em segundo plano).
4. `node ../../.claude/scripts/check-scenarios.js --write` na raiz: regrava o bloco "Massa de teste" do cenário.

## O que NÃO vai aqui

- Asserção (`expect`): isso é spec, em `tests/`.
- Dado fixo de demonstração ou carga em ambiente que não seja `localhost`.
- Limpeza do banco: o lote novo é outra empresa; apagar tudo é `npm run db:reset`.

## Armadilhas

- Add-on ligado por `feature(lot, ...)` vale para a empresa do lote inteira: quem carrega vários fluxos juntos não tem mais a "empresa sem o add-on" para a exceção de plano. Para ela, carregue um lote só do fluxo que não liga o add-on (`npm run seed -- 1.1`).
- Usuário de perfil, de Portal e Super Admin nascem por SQL com a senha `Dev12345!`, copiando o hash do `superadmin@dev.local`: banco sem o seed de desenvolvimento não tem de onde copiar.
- O back e o banco têm de ser o mesmo par: carga confirmando e-mail num banco e back lendo outro morre em `Auth.EmailNotVerified` (o `lot.ts` diz isso no erro). Para a aplicação de dev, `--db` com o banco dela.
- Festa de hoje ou de amanhã não nasce por orçamento (a validade vai até a véspera): o `setupAcceptedEvent` cria no futuro e move a data. Datas da massa saem de `dayPlus`, sempre à frente.

## Veja também

Pai: `../CLAUDE.md`. `docs/cenarios-de-teste/README.md` (guia de quem testa) e `_MODELO.md` (forma do arquivo de cenário).
