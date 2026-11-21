import { APIRequestContext, expect } from '@playwright/test';

import { assertOk, readJson } from './response';

/**
 * Workers da plataforma vistos pelo Super Admin (PLANO-EXECUCAO-DOS-WORKERS §5,
 * Etapa 264): `GET /api/super-admin/workers` devolve o estado de cada um.
 *
 * O ciclo de uma fila VAZIA não grava `WorkerRun` (só manual, agendado, falha ou
 * ciclo com item) e grava o estado no máximo a cada 50 s (`RegistryPollInterval`).
 * Por isso "o worker rodou de novo depois de T" se espera pelo `lastSucceededAt`
 * passar de T, e não pelo histórico: é o que deixa o spec provar que um ciclo
 * seguinte NÃO repetiu o trabalho sem um sleep fixo.
 */

export interface WorkerState {
  name: string;
  enabled: boolean;
  lastSucceededAt: string | null;
  manualRunPending: boolean;
  manualRunAllowed: boolean;
}

/** Instante em ms de uma data do back; sem offset na string, é UTC (o banco grava UTC). */
export function backendUtcMs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`).getTime();
}

export async function apiListWorkers(api: APIRequestContext): Promise<WorkerState[]> {
  const res = await api.get('/api/super-admin/workers');
  await assertOk(res, 'GET /api/super-admin/workers');
  return readJson<WorkerState[]>(res);
}

/**
 * Espera um ciclo do worker terminar com sucesso DEPOIS de `afterMs` (epoch ms).
 * Para "um ciclo inteiro depois do que fez o trabalho", passe o instante do
 * trabalho mais um período do worker.
 */
export async function waitForWorkerCycleAfter(
  superAdminApi: APIRequestContext,
  workerName: string,
  afterMs: number,
  opts: { timeout?: number; message?: string } = {},
): Promise<void> {
  await expect
    .poll(
      async () => {
        const worker = (await apiListWorkers(superAdminApi)).find((w) => w.name === workerName);
        expect(worker, `${workerName} na lista de workers`).toBeDefined();
        return backendUtcMs(worker!.lastSucceededAt) > afterMs;
      },
      {
        message: opts.message ?? `ciclo do ${workerName} depois de ${new Date(afterMs).toISOString()}`,
        timeout: opts.timeout ?? 150_000,
        intervals: [5_000],
      },
    )
    .toBe(true);
}
