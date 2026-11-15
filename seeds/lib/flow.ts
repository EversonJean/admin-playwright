import { Lot } from './lot';

/**
 * Massa de UM fluxo. `flow` é o número do fluxo (`5.3`) ou `FC-NN` (fluxo
 * completo), igual ao do spec e ao do arquivo de `docs/cenarios-de-teste/`.
 *
 * [ALERTA] `flow` e `summary` são lidos por expressão regular pelo
 * `.claude/scripts/check-scenarios.js`, que copia o `summary` para o arquivo de
 * cenário: os dois ficam em linhas seguidas, nesta ordem, cada um como UMA
 * string de aspas simples numa linha só, sem concatenar e sem template.
 */
export interface FlowSeed {
  flow: string;
  /** O que a carga cria, em linguagem de quem testa. Vai para o arquivo de cenário e para o relatório do lote. */
  summary: string;
  run(lot: Lot): Promise<void>;
}
