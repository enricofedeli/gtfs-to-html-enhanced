/**
 * Scaffold: Circuity metric
 *
 * For each route, computes the ratio of:
 *   in-vehicle path length (accumulated great-circle distance between consecutive
 *   stops, using stop_lat/stop_lon — shapes.txt is used if present but stop
 *   coordinates are the fallback)
 *   divided by
 *   straight-line distance (first stop → last stop of the representative trip)
 *
 * A circuity ratio of 1.0 = perfectly straight route.
 * Ratios > 2.0 are typically flagged as "wandering" alignments worth reviewing.
 *
 * Note: this diagnostic is direction-agnostic — it uses one representative trip
 * per route (the longest by stop count) since circuity is symmetric in most
 * cases.  If directional asymmetry is suspected, run this diagnostic on both
 * directions separately by subclassing or modifying the zone filter.
 */

import type { Config } from '../../types/index.js';
import type { ZoneFilter } from './db-utils.js';
import { buildInClause } from './db-utils.js';
import {
  writeStandardOutputs,
  formatTable,
  summaryHeader,
} from './output-utils.js';

export interface CircuityResult {
  route_id: string;
  route_short_name: string;
  stop_count: number;
  path_length_km: number;
  straight_line_km: number;
  circuity_ratio: number;
  flagged: boolean; // ratio > 2.0
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const CIRCUITY_FLAG_THRESHOLD = 2.0;

export async function runCircuity(
  db: any,
  config: Config,
  outputDir: string,
  sampleDate: string,
  serviceIds: Set<string>,
  zone: ZoneFilter,
): Promise<CircuityResult[]> {
  if (serviceIds.size === 0) {
    await writeStandardOutputs(
      outputDir,
      'circuity',
      [],
      `Circuity: no active service_ids for ${sampleDate}.\n`,
    );
    return [];
  }

  const { placeholders: svcPh, values: svcVals } = buildInClause([
    ...serviceIds,
  ]);
  let routeFilter = '';
  const extraVals: string[] = [];
  if (zone.routeIds && zone.routeIds.length > 0) {
    const { placeholders, values } = buildInClause(zone.routeIds);
    routeFilter = `AND t.route_id IN (${placeholders})`;
    extraVals.push(...values);
  }

  // Get the longest trip (by stop count) per route as a representative
  const repTrips = db
    .prepare(
      `
    -- Find the longest trip (most stops) for each route on the active service day.
    -- This is the "representative trip" for circuity measurement.
    SELECT
      t.route_id,
      COALESCE(r.route_short_name, r.route_long_name, t.route_id) AS route_short_name,
      t.trip_id,
      COUNT(st.stop_id) AS stop_count
    FROM trips t
    JOIN routes    r  ON r.route_id = t.route_id
    JOIN stop_times st ON st.trip_id = t.trip_id
    WHERE t.service_id IN (${svcPh})
      ${routeFilter}
    GROUP BY t.route_id, t.trip_id
    HAVING COUNT(st.stop_id) = (
      SELECT MAX(sub_cnt)
      FROM (
        SELECT COUNT(st2.stop_id) AS sub_cnt
        FROM trips t2
        JOIN stop_times st2 ON st2.trip_id = t2.trip_id
        WHERE t2.route_id  = t.route_id
          AND t2.service_id IN (${svcPh})
        GROUP BY t2.trip_id
      )
    )
  `,
    )
    .all(...svcVals, ...svcVals, ...extraVals) as {
    route_id: string;
    route_short_name: string;
    trip_id: string;
    stop_count: number;
  }[];

  // Deduplicate: one representative trip per route
  const repTripByRoute = new Map<string, (typeof repTrips)[0]>();
  for (const r of repTrips) {
    if (!repTripByRoute.has(r.route_id)) repTripByRoute.set(r.route_id, r);
  }

  const results: CircuityResult[] = [];

  for (const [, rep] of repTripByRoute) {
    // Get ordered stop coordinates for this trip
    const stopCoords = db
      .prepare(
        `
      -- Get stop coordinates in stop_sequence order for the representative trip.
      SELECT s.stop_lat, s.stop_lon
      FROM stop_times st
      JOIN stops s ON s.stop_id = st.stop_id
      WHERE st.trip_id = ?
      ORDER BY st.stop_sequence
    `,
      )
      .all(rep.trip_id) as { stop_lat: number; stop_lon: number }[];

    if (stopCoords.length < 2) continue;

    // Accumulate path length
    let pathKm = 0;
    for (let i = 0; i < stopCoords.length - 1; i++) {
      pathKm += haversineKm(
        stopCoords[i].stop_lat,
        stopCoords[i].stop_lon,
        stopCoords[i + 1].stop_lat,
        stopCoords[i + 1].stop_lon,
      );
    }

    // Straight-line: first → last stop
    const first = stopCoords[0];
    const last = stopCoords.at(-1)!;
    const straightKm = haversineKm(
      first.stop_lat,
      first.stop_lon,
      last.stop_lat,
      last.stop_lon,
    );

    const ratio = straightKm > 0 ? pathKm / straightKm : 9999;

    results.push({
      route_id: rep.route_id,
      route_short_name: rep.route_short_name,
      stop_count: stopCoords.length,
      path_length_km: Math.round(pathKm * 10) / 10,
      straight_line_km: Math.round(straightKm * 10) / 10,
      circuity_ratio: Math.round(ratio * 100) / 100,
      flagged: ratio > CIRCUITY_FLAG_THRESHOLD,
    });
  }

  results.sort((a, b) => b.circuity_ratio - a.circuity_ratio);

  const flagged = results.filter((r) => r.flagged);
  const summaryRows = flagged.slice(0, 20).map((r) => ({
    Route: r.route_short_name,
    Stops: r.stop_count,
    'Path (km)': r.path_length_km,
    'Straight (km)': r.straight_line_km,
    Circuity: r.circuity_ratio,
  }));

  const summaryText = [
    summaryHeader('Scaffold: Circuity Metric', sampleDate, new Date()),
    `Flag threshold  : circuity ratio > ${CIRCUITY_FLAG_THRESHOLD}`,
    `Routes analysed : ${results.length}`,
    `Flagged         : ${flagged.length}`,
    '',
    'Most circuitous routes:',
    '',
    formatTable(summaryRows, 20),
    '',
    'Full results written to: circuity.csv  circuity.json',
  ].join('\n');

  await writeStandardOutputs(outputDir, 'circuity', results, summaryText);
  return results;
}
