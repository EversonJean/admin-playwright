import { createFakeServer } from '@fake-providers/shared';

/**
 * Fake Google Maps server — endpoints que `GooglePlacesClient` e
 * `GoogleDistanceMatrixClient` chamam:
 *
 *   GET /maps/api/place/autocomplete/json?input=...&key=...
 *     -> { status:"OK", predictions: [{ place_id, description }] }
 *
 *   GET /maps/api/place/details/json?place_id=...&fields=...&key=...
 *     -> { status:"OK", result: { place_id, formatted_address,
 *           geometry: { location: { lat, lng } },
 *           address_components: [{ long_name, short_name, types }] } }
 *
 *   GET /maps/api/distancematrix/json?origins=lat,lng|lat,lng&destinations=lat,lng|...
 *     -> { status:"OK", rows: [{ elements: [{ status:"OK",
 *           distance: { value: <m>, text }, duration: { value: <s>, text } }] }] }
 *     (Etapa 220: matriz NxM, uma row por origem e um element por destino)
 *
 * Controle (Etapa 220):
 *   GET    /_control/distances   -> { places, pairs }  tabela fixa de minutos
 *   PUT    /_control/distances   { pairs:[{ from, to, minutes, km?, symmetric? }] }
 *   DELETE /_control/distances   volta a tabela ao padrao
 *   POST   /_control/fail-next   { count?, status?, coord? }  proximas matrizes falham
 *                                 (com `coord`, so as que contem a coordenada)
 *
 * Auth: query string `key`. Aceita qualquer chave; em E2E o back manda dummy.
 *
 * Determinismo: predictions/details derivam HASH do input; distance usa a
 * tabela fixa e, fora dela, o HASH do par — mesma entrada -> mesma resposta.
 */

const PORT = Number(process.env.FAKE_GOOGLE_MAPS_PORT ?? 1516);

function hashish(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// Etapa 220 (ESC-B) — tabela fixa de minutos por par de coordenadas, para os
// specs da escalacao da semana (PLANO-ESCALACAO-DA-SEMANA §13): A em Batel,
// B na Agua Verde (A->B 20 min), D em Colombo (A->D 50 min) e o local
// Principal no Centro. Par fora da tabela cai no hash de sempre.
//
// O back manda a coordenada como o decimal gravado (`-25.4405000`), entao a
// chave compara pelo valor com 5 casas, nunca pelo texto.
// ---------------------------------------------------------------------------

interface LatLng {
  lat: number;
  lng: number;
}

interface FixedPairInput {
  from: LatLng;
  to: LatLng;
  minutes: number;
  km?: number;
  symmetric?: boolean;
}

interface FixedPair {
  from: LatLng;
  to: LatLng;
  minutes: number;
  km: number;
}

const PLACES = {
  batel: { lat: -25.4405, lng: -49.2903 },
  aguaVerde: { lat: -25.4567, lng: -49.2833 },
  colombo: { lat: -25.2917, lng: -49.2242 },
  centro: { lat: -25.4284, lng: -49.2733 },
} satisfies Record<string, LatLng>;

const DEFAULT_PAIRS: Array<[keyof typeof PLACES, keyof typeof PLACES, number]> = [
  ['batel', 'aguaVerde', 20],
  ['batel', 'colombo', 50],
  ['aguaVerde', 'colombo', 55],
  ['centro', 'batel', 12],
  ['centro', 'aguaVerde', 15],
  ['centro', 'colombo', 40],
];

const fixedPairs = new Map<string, FixedPair>();

function keyOf(p: LatLng): string {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function pairKey(from: LatLng, to: LatLng): string {
  return `${keyOf(from)}|${keyOf(to)}`;
}

function addPair(from: LatLng, to: LatLng, minutes: number, km: number | undefined, symmetric: boolean): void {
  // ~30 km/h quando o spec nao diz o km: plausivel para a cidade.
  const distanceKm = km ?? Math.round(minutes * 0.5 * 10) / 10;
  fixedPairs.set(pairKey(from, to), { from, to, minutes, km: distanceKm });
  if (symmetric) fixedPairs.set(pairKey(to, from), { from: to, to: from, minutes, km: distanceKm });
}

function resetPairs(): void {
  fixedPairs.clear();
  for (const [a, b, minutes] of DEFAULT_PAIRS) addPair(PLACES[a], PLACES[b], minutes, undefined, true);
}

resetPairs();

const failNext = { remaining: 0, status: 'REQUEST_DENIED' };

// Falhas armadas para UMA coordenada: so a matriz cujos origins/destinations
// contem o ponto gasta a falha. O Playwright roda workers em paralelo contra o
// mesmo fake; a falha global seria gasta pela matriz de outro teste.
const failNextByCoord = new Map<string, { remaining: number; status: string }>();

function coordFailureFor(coords: string[]): { remaining: number; status: string } | undefined {
  for (const raw of coords) {
    const p = parseCoord(raw);
    if (!p) continue;
    const armed = failNextByCoord.get(keyOf(p));
    if (armed && armed.remaining > 0) return armed;
  }
  return undefined;
}

function parseCoord(s: string): LatLng | null {
  const [lat, lng] = s.split(',').map((v) => Number(v.trim()));
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function splitCoords(raw: string | undefined): string[] {
  return (raw ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function element(o: string, d: string) {
  const from = parseCoord(o);
  const to = parseCoord(d);
  const fixed = from && to ? fixedPairs.get(pairKey(from, to)) : undefined;

  let meters: number;
  let seconds: number;
  if (fixed) {
    meters = Math.round(fixed.km * 1000);
    seconds = fixed.minutes * 60;
  } else {
    // Distancia "fake" derivada do par. Mesma entrada -> mesma resposta
    // (determinismo pra cache + specs) — a mesma conta do 1x1 de antes.
    const seed = hashish(o + '|' + d);
    meters = 1000 + (seed % 50000); // 1km .. 51km
    seconds = Math.round(meters / 8); // ~8 m/s
  }

  return {
    status: 'OK',
    distance: { value: meters, text: `${(meters / 1000).toFixed(1)} km` },
    duration: { value: seconds, text: `${Math.round(seconds / 60)} min` },
  };
}

await createFakeServer({
  name: 'google-maps',
  port: PORT,
  registerRoutes: (app) => {
    app.get<{ Querystring: { input?: string; key?: string } }>(
      '/maps/api/place/autocomplete/json',
      async (req, reply) => {
        const input = (req.query.input ?? '').trim();
        if (!input) {
          reply.status(200);
          return { status: 'OK', predictions: [] };
        }
        const seed = hashish(input);
        const predictions = [0, 1, 2].map((i) => ({
          place_id: `fake_place_${seed.toString(36)}_${i}`,
          description: `${input} — sugestao ${i + 1} (fake)`,
        }));
        reply.status(200);
        return { status: 'OK', predictions };
      },
    );

    app.get<{ Querystring: { place_id?: string; fields?: string; key?: string } }>(
      '/maps/api/place/details/json',
      async (req, reply) => {
        const placeId = (req.query.place_id ?? '').trim();
        if (!placeId) {
          reply.status(200);
          return { status: 'INVALID_REQUEST', error_message: 'missing place_id', result: null };
        }
        const seed = hashish(placeId);
        const lat = -25.4 + ((seed % 200) - 100) / 10000;
        const lng = -49.2 + ((seed % 250) - 125) / 10000;
        reply.status(200);
        return {
          status: 'OK',
          result: {
            place_id: placeId,
            formatted_address: `Endereco fake para ${placeId}, Curitiba — PR`,
            geometry: {
              location: { lat, lng },
            },
            address_components: [
              { long_name: 'Rua das Festas', short_name: 'R das Festas', types: ['route'] },
              { long_name: '123', short_name: '123', types: ['street_number'] },
              {
                long_name: 'Curitiba',
                short_name: 'Curitiba',
                types: ['administrative_area_level_2', 'locality'],
              },
              { long_name: 'Parana', short_name: 'PR', types: ['administrative_area_level_1'] },
              { long_name: 'Brasil', short_name: 'BR', types: ['country', 'political'] },
              { long_name: '80000-000', short_name: '80000-000', types: ['postal_code'] },
            ],
          },
        };
      },
    );

    // Etapa 220 (ESC-B) — matriz NxM: o `GetMatrixAsync` do back manda
    // `origins`/`destinations` separados por `|` e le `rows[i].elements[j]`
    // posicional. Um par so (1x1) continua igual ao de antes.
    app.get<{ Querystring: { origins?: string; destinations?: string; key?: string } }>(
      '/maps/api/distancematrix/json',
      async (req, reply) => {
        const origins = splitCoords(req.query.origins);
        const destinations = splitCoords(req.query.destinations);
        reply.status(200);

        if (origins.length === 0 || destinations.length === 0) {
          return {
            status: 'OK',
            rows: [{ elements: [{ status: 'NOT_FOUND' }] }],
          };
        }

        // Falha simulada (`POST /_control/fail-next`): status global nao-OK
        // faz o back degradar para "mapas indisponiveis" sem retry.
        const byCoord = coordFailureFor([...origins, ...destinations]);
        if (byCoord) {
          byCoord.remaining -= 1;
          return { status: byCoord.status, error_message: 'falha simulada (fake, por coordenada)', rows: [] };
        }
        if (failNext.remaining > 0) {
          failNext.remaining -= 1;
          return { status: failNext.status, error_message: 'falha simulada (fake)', rows: [] };
        }

        return {
          status: 'OK',
          origin_addresses: origins,
          destination_addresses: destinations,
          rows: origins.map((o) => ({
            elements: destinations.map((d) => element(o, d)),
          })),
        };
      },
    );

    // Tabela fixa: os specs leem as coordenadas e os minutos daqui.
    app.get('/_control/distances', async () => ({
      places: PLACES,
      pairs: [...fixedPairs.values()],
    }));

    // Acrescenta (ou troca) pares da tabela. `symmetric` (default true) grava
    // tambem a volta. Corpo: { pairs: [{ from:{lat,lng}, to:{lat,lng}, minutes, km?, symmetric? }] }
    app.put<{ Body: { pairs?: FixedPairInput[] } }>('/_control/distances', async (req) => {
      const pairs = req.body?.pairs ?? [];
      for (const p of pairs) addPair(p.from, p.to, p.minutes, p.km, p.symmetric ?? true);
      return { total: fixedPairs.size };
    });

    // Volta a tabela ao padrao (so os pares embutidos).
    app.delete('/_control/distances', async () => {
      resetPairs();
      return { total: fixedPairs.size };
    });

    // As proximas `count` chamadas de matriz (default 1) respondem com status
    // global nao-OK (`REQUEST_DENIED` por default; o back nao retenta). O cache
    // de 24 h do back por par continua valendo para o que ja foi medido.
    // Com `coord` ({lat,lng}), a falha vale so para as matrizes que contem a
    // coordenada (comparada com 5 casas); sem, o comportamento global de antes.
    app.post<{ Body: { count?: number; status?: string; coord?: LatLng } }>('/_control/fail-next', async (req) => {
      const remaining = Math.max(0, Math.floor(req.body?.count ?? 1));
      const status = req.body?.status ?? 'REQUEST_DENIED';
      const coord = req.body?.coord;
      if (coord && Number.isFinite(coord.lat) && Number.isFinite(coord.lng)) {
        const key = keyOf(coord);
        if (remaining === 0) failNextByCoord.delete(key);
        else failNextByCoord.set(key, { remaining, status });
        return { remaining, status, coord: key };
      }
      failNext.remaining = remaining;
      failNext.status = status;
      return { remaining: failNext.remaining, status: failNext.status };
    });
  },
});
