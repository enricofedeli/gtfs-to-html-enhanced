/**
 * Scaffold: Span legibility table
 *
 * For each route + direction + service day, computes:
 *   - first departure time
 *   - last departure time
 *   - number of trips
 *   - midday headway (average gap between departures in the Midday band)
 *
 * Useful for spotting routes that cut off early, start late, or have large
 * midday gaps that undermine a coherent all-day network.
 *
 * Methodology: "first departure" is the minimum departure_time_seconds at the
 * first stop of each trip (stop_sequence = min).  For frequency-based trips,
 * the effective span is extended by the frequency window end_time.
 */

import type { Config } from '../../types/index.js';
import type { TimeBand, ZoneFilter } from './db-utils.js';
import {
  loadFrequencyRowsByTrip,
  buildInClause,
  secsToTime,
} from './db-utils.js';
import {
  writeStandardOutputs,
  formatTable,
  summaryHeader,
} from './output-utils.js';

export interface SpanLegibilityResult {
  route_id: string;
  route_short_name: string;
  direction_id: number;
  first_departure: string; // "HH:MM:SS"
  last_departure: string;
  trip_count: number;
  midday_avg_headway_min: number; // -1 if no midday trips
}

export async function runSpanLegibility(
  db: any,
  config: Config,
  outputDir: string,
  sampleDate: string,
  serviceIds: Set<string>,
  timeBands: TimeBand[],
  zone: ZoneFilter,
): Promise<SpanLegibilityResult[]> {
  if (serviceIds.size === 0) {
    await writeStandardOutputs(
      outputDir,
      'span_legibility',
      [],
      `Span legibility: no active service_ids for ${sampleDate}.\n`,
    );
    return [];
  }

  const freqRows = loadFrequencyRowsByTrip(db);
  const middayBand =
    timeBands.find((b) => b.label === 'Midday') ??
    timeBands.find((b) => b.label.toLowerCase().includes('mid')) ??
    timeBands[2]; // default to third band

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

  // Get first/last departure per trip from the first stop of each trip
  const tripSpans = db
    .prepare(
      `
    -- First and last departure per trip from the first stop of that trip.
    -- We use MIN(stop_sequence) to find the first stop, then get its
    -- departure_time_seconds.  direction_id defaults to 0 when absent.
    SELECT
      t.trip_id,
      t.route_id,
      COALESCE(r.route_short_name, r.route_long_name, t.route_id) AS route_short_name,
      COALESCE(t.direction_id, 0) AS direction_id,
      CAST(st.departure_time_seconds AS INTEGER) AS dep_secs
    FROM trips t
    JOIN routes r ON r.route_id = t.route_id
    JOIN stop_times st ON st.trip_id = t.trip_id
    WHERE t.service_id IN (${svcPh})
      ${routeFilter}
      AND st.stop_sequence = (
        SELECT MIN(s2.stop_sequence)
        FROM stop_times s2
        WHERE s2.trip_id = t.trip_id
      )
    ORDER BY t.route_id, t.direction_id, st.departure_time_seconds
  `,
    )
    .all(...svcVals, ...extraVals) as {
    trip_id: string;
    route_id: string;
    route_short_name: string;
    direction_id: number;
    dep_secs: number;
  }[];

  // Group by route+direction
  const groups = new Map<
    string,
    {
      routeId: string;
      routeShortName: string;
      dirId: number;
      deps: number[];
      tripIds: string[];
    }
  >();
  for (const row of tripSpans) {
    const key = `${row.route_id}|${row.direction_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        routeId: row.route_id,
        routeShortName: row.route_short_name,
        dirId: row.direction_id,
        deps: [],
        tripIds: [],
      });
    }
    groups.get(key)!.deps.push(row.dep_secs);
    groups.get(key)!.tripIds.push(row.trip_id);
  }

  const results: SpanLegibilityResult[] = [];

  for (const [, g] of groups) {
    g.deps.sort((a, b) => a - b);
    const firstDep = g.deps[0];
    const lastDep = g.deps.at(-1)!;

    // For frequency-based trips, last departure may extend beyond the scheduled dep
    let effectiveLastDep = lastDep;
    if (freqRows.size > 0) {
      for (const tripId of g.tripIds) {
        const freqs = freqRows.get(tripId);
        if (!freqs) continue;
        for (const f of freqs) {
          if (f.end_time_seconds > effectiveLastDep) {
            effectiveLastDep = f.end_time_seconds;
          }
        }
      }
    }

    // Midday headway: average gap between consecutive midday departures
    let middayAvgHeadwayMin = -1;
    if (middayBand) {
      const middayDeps = g.deps.filter(
        (d) => d >= middayBand.startSec && d < middayBand.endSec,
      );
      if (middayDeps.length >= 2) {
        const gaps: number[] = [];
        for (let i = 1; i < middayDeps.length; i++) {
          gaps.push(middayDeps[i] - middayDeps[i - 1]);
        }
        const avgGapSecs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        middayAvgHeadwayMin = Math.round(avgGapSecs / 60);
      }
    }

    results.push({
      route_id: g.routeId,
      route_short_name: g.routeShortName,
      direction_id: g.dirId,
      first_departure: secsToTime(firstDep),
      last_departure: secsToTime(effectiveLastDep),
      trip_count: g.deps.length,
      midday_avg_headway_min: middayAvgHeadwayMin,
    });
  }

  results.sort((a, b) => a.route_short_name.localeCompare(b.route_short_name));

  const summaryRows = results.slice(0, 30).map((r) => ({
    Route: r.route_short_name,
    Dir: r.direction_id,
    First: r.first_departure,
    Last: r.last_departure,
    Trips: r.trip_count,
    'Midday hdwy (min)':
      r.midday_avg_headway_min < 0 ? '-' : r.midday_avg_headway_min,
  }));

  const summaryText = [
    summaryHeader('Scaffold: Span Legibility Table', sampleDate, new Date()),
    `Routes analysed: ${results.length / 2} (${results.length} direction rows)`,
    '',
    formatTable(summaryRows, 30),
    '',
    'Full results written to: span_legibility.csv  span_legibility.json',
  ].join('\n');

  await writeStandardOutputs(
    outputDir,
    'span_legibility',
    results,
    summaryText,
  );
  return results;
}
