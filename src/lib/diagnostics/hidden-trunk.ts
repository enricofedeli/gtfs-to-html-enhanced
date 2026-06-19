/**
 * Diagnostic 1: Hidden trunk frequency
 *
 * Finds latent high-frequency corridors where many separate routes overlap on the
 * same stop-pair segment, producing a combined service frequency that riders cannot
 * perceive because no single route is branded as a trunk.
 *
 * Key concepts:
 *   - "Segment" = an ordered pair of consecutive stops (from_stop → to_stop) as
 *     they appear in stop_times for a trip.  The order determines direction.
 *   - "Combined trips/hour" = sum of all route-departures on a segment within
 *     a time band, divided by the band's duration in hours.
 *   - Flagged segments = combined trips/hour >= threshold BUT no single route
 *     on that segment individually meets the threshold.
 *
 * Methodology note for client presentations:
 *   Trip counts use the departure_time_seconds GENERATED column in stop_times,
 *   which correctly handles GTFS times > 24:00:00 (after-midnight service).
 *   For frequency-based routes (frequencies.txt), actual departure counts are
 *   derived from headway_secs × time-band overlap rather than raw stop_times rows.
 *   Direction_id is preserved per contributing route but the segment's direction
 *   is already fixed by the from→to stop order.
 */

import path from 'node:path';

import type { Config } from '../../types/index.js';
import type { TimeBand, ZoneFilter } from './db-utils.js';
import {
  secsToTime,
  loadFrequencyRowsByTrip,
  getFrequencyMultiplier,
  buildInClause,
} from './db-utils.js';
import {
  writeGeoJSON,
  writeStandardOutputs,
  formatTable,
  summaryHeader,
} from './output-utils.js';

export interface SegmentResult {
  from_stop_id: string;
  from_stop_name: string;
  to_stop_id: string;
  to_stop_name: string;
  time_band: string;
  combined_trips_per_hour: number;
  max_single_route_trips_per_hour: number;
  contributing_routes: string; // pipe-separated "route_short_name (N.N tph)"
  contributing_route_ids: string; // pipe-separated route_id list
  flagged: boolean; // true if combined >= threshold but no single route meets it
}

interface RawStopTime {
  trip_id: string;
  stop_id: string;
  stop_sequence: number;
  departure_time_seconds: number;
  route_id: string;
  route_short_name: string;
}

interface StopInfo {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
}

/**
 * Run the hidden trunk frequency diagnostic against the currently-open GTFS database.
 *
 * @param db          - better-sqlite3 Database handle
 * @param config      - full config (reads timePeriods, diagnosticsHiddenTrunkMinTripsPerHour)
 * @param outputDir   - directory to write output files into
 * @param sampleDate  - ISO date string used for the run (for labelling output)
 * @param serviceIds  - Set of active service_ids resolved for sampleDate
 * @param timeBands   - parsed time bands (from parseTimeBands())
 * @param zone        - zone filter (routeIds/stopIds or null for whole network)
 * @returns array of SegmentResult rows (same data written to CSV)
 */
export async function runHiddenTrunkDiagnostic(
  db: any,
  config: Config,
  outputDir: string,
  sampleDate: string,
  serviceIds: Set<string>,
  timeBands: TimeBand[],
  zone: ZoneFilter,
): Promise<SegmentResult[]> {
  const threshold = config.diagnosticsHiddenTrunkMinTripsPerHour ?? 6; // ≤10 min combined headway

  if (serviceIds.size === 0) {
    const msg = `Hidden trunk: no active service_ids found for ${sampleDate}. Check that the feed covers this date.\n`;
    await writeStandardOutputs(outputDir, 'hidden_trunk', [], msg);
    return [];
  }

  // -------------------------------------------------------------------------
  // Step 1: Load frequency definitions (needed to expand frequency-based trips)
  // -------------------------------------------------------------------------
  const freqRows = loadFrequencyRowsByTrip(db);
  const isFrequencyBased = freqRows.size > 0;

  // -------------------------------------------------------------------------
  // Step 2: Query all stop_times for active trips within the zone.
  //
  // We load the raw data in one query and enumerate segments in JavaScript
  // so that the segment adjacency logic is transparent and not buried in SQL.
  // The key constraint is: stop_times are ordered by stop_sequence, but
  // stop_sequence values are not guaranteed to be consecutive integers — so we
  // cannot use stop_sequence + 1.  We use ROW_NUMBER() instead.
  // -------------------------------------------------------------------------
  const serviceIdList = [...serviceIds];
  const { placeholders: svcPlaceholders, values: svcValues } =
    buildInClause(serviceIdList);

  let routeFilter = '';
  const extraValues: string[] = [];
  if (zone.routeIds && zone.routeIds.length > 0) {
    const { placeholders, values } = buildInClause(zone.routeIds);
    routeFilter = `AND t.route_id IN (${placeholders})`;
    extraValues.push(...values);
  }

  const rawRows = db
    .prepare(
      `
    -- Retrieve all stop_times for active trips, ordered within each trip by
    -- stop_sequence.  We join routes to get route_short_name for display.
    -- departure_time_seconds is a GENERATED column that converts the GTFS
    -- "HH:MM:SS" string (which may exceed 24:00:00) into integer seconds
    -- after the start of the service day.
    SELECT
      st.trip_id,
      st.stop_id,
      st.stop_sequence,
      CAST(st.departure_time_seconds AS INTEGER) AS departure_time_seconds,
      t.route_id,
      COALESCE(r.route_short_name, r.route_long_name, t.route_id) AS route_short_name
    FROM stop_times st
    JOIN trips  t ON t.trip_id  = st.trip_id
    JOIN routes r ON r.route_id = t.route_id
    WHERE t.service_id IN (${svcPlaceholders})
      ${routeFilter}
    ORDER BY st.trip_id, st.stop_sequence
  `,
    )
    .all(...svcValues, ...extraValues) as RawStopTime[];

  if (rawRows.length === 0) {
    const msg = `Hidden trunk: no stop_times found for active service on ${sampleDate}.\n`;
    await writeStandardOutputs(outputDir, 'hidden_trunk', [], msg);
    return [];
  }

  // -------------------------------------------------------------------------
  // Step 3: Load stop coordinates and names for GeoJSON and display
  // -------------------------------------------------------------------------
  const allStopIds = new Set<string>(rawRows.map((r) => r.stop_id));
  const stopInfoMap = new Map<string, StopInfo>();
  if (allStopIds.size > 0) {
    const { placeholders, values } = buildInClause([...allStopIds]);
    const stops = db
      .prepare(
        `
      SELECT stop_id, stop_name, stop_lat, stop_lon
      FROM   stops
      WHERE  stop_id IN (${placeholders})
    `,
      )
      .all(...values) as StopInfo[];
    for (const s of stops) stopInfoMap.set(s.stop_id, s);
  }

  // -------------------------------------------------------------------------
  // Step 4: Enumerate segments from stop_times rows
  //
  // Group rows by trip_id, then walk each trip's stop list to produce
  // (from_stop, to_stop, dep_sec, route_id, route_short_name) tuples.
  // -------------------------------------------------------------------------
  const tripGroups = new Map<
    string,
    { stop_id: string; dep_sec: number; seq: number }[]
  >();

  for (const row of rawRows) {
    if (!tripGroups.has(row.trip_id)) tripGroups.set(row.trip_id, []);
    tripGroups.get(row.trip_id)!.push({
      stop_id: row.stop_id,
      dep_sec: row.departure_time_seconds,
      seq: row.stop_sequence,
    });
  }

  // Map trip_id → route_id + route_short_name (from first row of that trip)
  const tripMeta = new Map<
    string,
    { route_id: string; route_short_name: string }
  >();
  for (const row of rawRows) {
    if (!tripMeta.has(row.trip_id)) {
      tripMeta.set(row.trip_id, {
        route_id: row.route_id,
        route_short_name: row.route_short_name,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: For each time band, count segment departures per (from,to) × route
  // -------------------------------------------------------------------------
  // segmentData[bandLabel][segKey][route_id] = trip count in band
  const segmentData = new Map<string, Map<string, Map<string, number>>>();
  for (const band of timeBands) {
    segmentData.set(band.label, new Map());
  }

  for (const [tripId, stops] of tripGroups) {
    // Ensure stops are sorted by stop_sequence (query is already ordered,
    // but grouping in JS may lose order if insertion order isn't preserved)
    stops.sort((a, b) => a.seq - b.seq);

    const meta = tripMeta.get(tripId)!;

    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      const depSec = from.dep_sec;

      for (const band of timeBands) {
        if (depSec < band.startSec || depSec >= band.endSec) continue;

        // For frequency-based trips, count how many actual departures of
        // this trip start within the time band.
        const multiplier = isFrequencyBased
          ? getFrequencyMultiplier(tripId, band.startSec, band.endSec, freqRows)
          : 1;

        const segKey = `${from.stop_id}→${to.stop_id}`;
        const bandMap = segmentData.get(band.label)!;
        if (!bandMap.has(segKey)) bandMap.set(segKey, new Map());
        const routeMap = bandMap.get(segKey)!;
        routeMap.set(
          meta.route_id,
          (routeMap.get(meta.route_id) ?? 0) + multiplier,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Compute combined trips/hour and flag hidden trunks
  // -------------------------------------------------------------------------
  const results: SegmentResult[] = [];

  for (const band of timeBands) {
    const bandDurationHours = (band.endSec - band.startSec) / 3600;
    const bandMap = segmentData.get(band.label)!;

    for (const [segKey, routeMap] of bandMap) {
      const [fromStopId, toStopId] = segKey.split('→');
      const fromStop = stopInfoMap.get(fromStopId);
      const toStop = stopInfoMap.get(toStopId);

      const routeEntries: { routeId: string; tripsPerHour: number }[] = [];
      let combinedTrips = 0;

      for (const [routeId, tripCount] of routeMap) {
        const tph = tripCount / bandDurationHours;
        routeEntries.push({ routeId, tripsPerHour: tph });
        combinedTrips += tripCount;
      }

      const combinedTph = combinedTrips / bandDurationHours;
      const maxSingleTph = Math.max(...routeEntries.map((e) => e.tripsPerHour));
      const flagged = combinedTph >= threshold && maxSingleTph < threshold;

      // Build contributing-routes display string
      // Sort by descending trips/hour so the highest-frequency contributor comes first
      routeEntries.sort((a, b) => b.tripsPerHour - a.tripsPerHour);
      const contributingRoutes = routeEntries
        .map((e) => {
          const meta = [...tripMeta.values()].find(
            (m) => m.route_id === e.routeId,
          );
          const name = meta?.route_short_name ?? e.routeId;
          return `${name} (${e.tripsPerHour.toFixed(1)} tph)`;
        })
        .join(' | ');
      const contributingRouteIds = routeEntries
        .map((e) => e.routeId)
        .join(' | ');

      results.push({
        from_stop_id: fromStopId,
        from_stop_name: fromStop?.stop_name ?? fromStopId,
        to_stop_id: toStopId,
        to_stop_name: toStop?.stop_name ?? toStopId,
        time_band: band.label,
        combined_trips_per_hour: Math.round(combinedTph * 10) / 10,
        max_single_route_trips_per_hour: Math.round(maxSingleTph * 10) / 10,
        contributing_routes: contributingRoutes,
        contributing_route_ids: contributingRouteIds,
        flagged,
      });
    }
  }

  // Sort: flagged first, then by combined_trips_per_hour descending
  results.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return b.combined_trips_per_hour - a.combined_trips_per_hour;
  });

  // -------------------------------------------------------------------------
  // Step 7: Write outputs
  // -------------------------------------------------------------------------
  const csvRows = results.map((r) => ({
    from_stop_id: r.from_stop_id,
    from_stop_name: r.from_stop_name,
    to_stop_id: r.to_stop_id,
    to_stop_name: r.to_stop_name,
    time_band: r.time_band,
    combined_trips_per_hour: r.combined_trips_per_hour,
    max_single_route_trips_per_hour: r.max_single_route_trips_per_hour,
    contributing_routes: r.contributing_routes,
    contributing_route_ids: r.contributing_route_ids,
    flagged: r.flagged ? 'YES' : '',
  }));

  // Top-20 flagged summary
  const flagged = results.filter((r) => r.flagged);
  const summaryRows = flagged.slice(0, 20).map((r) => ({
    'From stop': r.from_stop_name.slice(0, 30),
    'To stop': r.to_stop_name.slice(0, 30),
    Band: r.time_band,
    'Combined tph': r.combined_trips_per_hour,
    'Max single tph': r.max_single_route_trips_per_hour,
    Routes: r.contributing_routes.slice(0, 60),
  }));

  const summaryText = [
    summaryHeader(
      'Diagnostic 1: Hidden Trunk Frequency',
      sampleDate,
      new Date(),
    ),
    `Threshold for flagging : combined >= ${threshold} tph AND no single route >= ${threshold} tph`,
    `Frequency-based routes : ${isFrequencyBased ? 'YES (frequencies.txt detected; trip counts expanded from headway)' : 'NO (schedule-based; raw stop_times used)'}`,
    `Total segments analysed: ${results.length}`,
    `Flagged segments       : ${flagged.length}`,
    '',
    'Top 20 candidate trunk segments (combined high frequency, no single frequent route):',
    '',
    formatTable(summaryRows, 20),
    '',
    `Full results written to: hidden_trunk.csv  hidden_trunk.json`,
    `GeoJSON map layer      : hidden_trunk.geojson (colour segments by combined_trips_per_hour)`,
  ].join('\n');

  await writeStandardOutputs(outputDir, 'hidden_trunk', csvRows, summaryText);

  // -------------------------------------------------------------------------
  // Step 8: GeoJSON output — one LineString feature per (segment × time_band)
  //
  // We emit one feature per (from_stop, to_stop, time_band) tuple.  The client
  // can filter features by time_band in MapLibre to toggle between time periods.
  // Geometry is a straight line between stop coordinates (shapes.txt coordinates
  // are not used because shapes are per-trip and cannot be trivially aggregated
  // to a segment level across multiple routes).
  // -------------------------------------------------------------------------
  const features = results
    .filter(
      (r) => stopInfoMap.has(r.from_stop_id) && stopInfoMap.has(r.to_stop_id),
    )
    .map((r) => {
      const from = stopInfoMap.get(r.from_stop_id)!;
      const to = stopInfoMap.get(r.to_stop_id)!;
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [from.stop_lon, from.stop_lat],
            [to.stop_lon, to.stop_lat],
          ],
        },
        properties: {
          from_stop_id: r.from_stop_id,
          from_stop_name: r.from_stop_name,
          to_stop_id: r.to_stop_id,
          to_stop_name: r.to_stop_name,
          time_band: r.time_band,
          combined_trips_per_hour: r.combined_trips_per_hour,
          max_single_route_trips_per_hour: r.max_single_route_trips_per_hour,
          contributing_routes: r.contributing_routes,
          flagged: r.flagged,
        },
      };
    });

  await writeGeoJSON(path.join(outputDir, 'hidden_trunk.geojson'), {
    type: 'FeatureCollection',
    features,
  });

  return results;
}
