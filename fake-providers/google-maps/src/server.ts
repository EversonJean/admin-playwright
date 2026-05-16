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
 *   GET /maps/api/distancematrix/json?origins=lat,lng&destinations=lat,lng
 *     -> { status:"OK", rows: [{ elements: [{ status:"OK",
 *           distance: { value: <m>, text }, duration: { value: <s>, text } }] }] }
 *
 * Auth: query string `key`. Aceita qualquer chave; em E2E o back manda dummy.
 *
 * Determinismo: predictions/details/distance derivam HASH do input —
 * mesma entrada -> mesma resposta entre runs.
 */

const PORT = Number(process.env.FAKE_GOOGLE_MAPS_PORT ?? 1516);

function hashish(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
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

    app.get<{ Querystring: { origins?: string; destinations?: string; key?: string } }>(
      '/maps/api/distancematrix/json',
      async (req, reply) => {
        const o = (req.query.origins ?? '').trim();
        const d = (req.query.destinations ?? '').trim();
        if (!o || !d) {
          reply.status(200);
          return {
            status: 'OK',
            rows: [{ elements: [{ status: 'NOT_FOUND' }] }],
          };
        }
        // Distancia "fake" derivada da diferenca entre origin/dest. Mesma
        // entrada -> mesma resposta (determinismo pra cache + specs).
        const seed = hashish(o + '|' + d);
        const meters = 1000 + (seed % 50000); // 1km .. 51km
        const seconds = Math.round(meters / 8); // ~8 m/s
        reply.status(200);
        return {
          status: 'OK',
          origin_addresses: [o],
          destination_addresses: [d],
          rows: [
            {
              elements: [
                {
                  status: 'OK',
                  distance: {
                    value: meters,
                    text: `${(meters / 1000).toFixed(1)} km`,
                  },
                  duration: {
                    value: seconds,
                    text: `${Math.round(seconds / 60)} min`,
                  },
                },
              ],
            },
          ],
        };
      },
    );
  },
});
