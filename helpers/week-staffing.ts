import type { FakeLatLng } from './fake-providers';

/**
 * Datas e endereços dos specs da escalação da semana (`tests/7-escalacao/7.4`
 * a `7.6`, PLANO-ESCALACAO-DA-SEMANA §13): o quadro conta o horizonte no fuso
 * do tenant, e o deslocamento medido pelo fake do Google sai da coordenada do
 * endereço estruturado.
 */

/** Rota do quadro "Escalação da semana". */
export const WEEK_STAFFING_ROUTE = '/app/events/week-staffing';

// Fuso padrão do tenant novo (`Tenant.Timezone`): o horizonte do quadro e o
// fim de semana do card da Home são contados nele.
const TENANT_TZ = 'America/Sao_Paulo';
const DAY_MS = 86_400_000;

/** Hoje no fuso do tenant, como meia-noite UTC (só a data importa). */
export function tenantToday(): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TENANT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${ymd}T00:00:00Z`);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * O próximo sábado DEPOIS de hoje. Cai sempre no horizonte padrão do quadro
 * (hoje -> domingo; sex/sáb/dom -> o domingo seguinte, decisão 1 do plano).
 */
export function nextSaturday(): string {
  const today = tenantToday();
  const delta = (6 - today.getUTCDay() + 7) % 7 || 7;
  return isoDate(new Date(today.getTime() + delta * DAY_MS));
}

/**
 * Um dia do fim de semana que o card "Equipe do fim de semana" da Home conta: o
 * próximo sábado; no sábado, amanhã; no domingo, hoje
 * (`WeekendStaffingSectionProvider.ResolveWeekendDays`). A festa de hoje não
 * nasce por orçamento: o `setupAcceptedEvent` a cria no futuro e move a data.
 */
export function homeWeekendDay(): string {
  const today = tenantToday();
  const dow = today.getUTCDay();
  if (dow === 0) return isoDate(today);
  if (dow === 6) return isoDate(new Date(today.getTime() + DAY_MS));
  return isoDate(new Date(today.getTime() + (6 - dow) * DAY_MS));
}

/** Texto literal dentro de um `RegExp` (nomes com sufixo, nomes de local). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Endereço estruturado completo (o VO exige todos os campos) com a coordenada dada. */
export function addressAt(point: FakeLatLng, neighborhood: string): Record<string, unknown> {
  return {
    zipCode: '80420-000',
    street: 'Rua E2E da Escalação',
    number: '100',
    complement: null,
    neighborhood,
    city: 'Curitiba',
    state: 'PR',
    latitude: point.lat,
    longitude: point.lng,
    placeId: null,
    formattedAddress: null,
    country: 'BR',
  };
}
