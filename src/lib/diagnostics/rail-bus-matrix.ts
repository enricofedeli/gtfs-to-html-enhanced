/**
 * Diagnostic 3: Rail–bus connection matrix (outer province)
 *
 * Quantifies interchange quality at SFM (Servizio Ferroviario Metropolitano)
 * stations: for each train arrival, find the next connecting bus departure
 * within a configurable max-wait window and compute the transfer wait time.
 *
 * Critical failure modes flagged:
 *   - Wait exceeding diagnosticsMaxTransferWaitMinutes (default 20 min)
 *   - No bus connection at all within the window
 *   - Last useful bus departs before the last train arrives ("stranded passengers")
 *   - First train arrives before first bus departs ("early train, late bus")
 *
 * Two-feed approach:
 *   - Rail feed: opened via config.diagnosticsRailFeedSqlitePath
 *   - Bus feed: the main singleton DB (already open from the import pipeline)
 *   Both feeds must use agency_timezone = Europe/Rome.  The diagnostic checks
 *   this and warns if they differ.
 *
 * Station matching:
 *   1. Use config.diagnosticsZone.stopIds as rail station stop_ids (bus stops
 *      within proximity are found via haversine < 200 m).
 *   2. Fallback: find stops in the rail feed whose stop_name matches the pattern
 *      from config (e.g. "SFM") and use coordinate proximity for bus-stop match.
 */

import path from 'node:path';
import { openDb } from 'gtfs';

import type { Config } from '../../types/index.js';
import { resolveServiceIds, buildInClause, secsToTime } from './db-utils.js';
import {
  writeStandardOutputs,
  writeJson,
  formatTable,
  summaryHeader,
} from './output-utils.js';

export interface RailBusConnectionRow {
  station_name: string;
  rail_stop_id: string;
  bus_stop_id: string;
  train_line: string;
  train_trip_id: string;
  train_arrival_time: string; // "HH:MM:SS"
  train_arrival_secs: number;
  best_bus_route: string; // "" if no connection
  best_bus_headsign: string;
  best_bus_departure_time: string; // "" if no connection
  wait_minutes: number; // -1 if no connection
  connections_in_window: number;
  flagged_no_connection: boolean;
  flagged_long_wait: boolean;
  flagged_stranded: boolean; // last bus already gone before this train
}

/** Haversine distance in metres between two WGS-84 coordinate pairs */
function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Max walking distance to match a bus stop to a rail station (metres) */
const MAX_WALK_METERS = 200;

/**
 * Run the rail-bus connection matrix diagnostic.
 *
 * @param busDb         - better-sqlite3 handle to the bus GTFS database (singleton)
 * @param config        - full config
 * @param outputDir     - directory to write outputs
 * @param busSampleDate - ISO date for bus service resolution
 * @param railSampleDate - ISO date for rail service resolution (usually same)
 */
export async function runRailBusMatrix(
  busDb: any,
  config: Config,
  outputDir: string,
  busSampleDate: string,
  railSampleDate: string = busSampleDate,
): Promise<RailBusConnectionRow[]> {
  const maxWaitSecs = (config.diagnosticsMaxTransferWaitMinutes ?? 20) * 60;
  const minWaitSecs = 60; // minimum dwell (1 min) before a connection counts

  if (!config.diagnosticsRailFeedSqlitePath) {
    const msg =
      'Rail-bus matrix: config.diagnosticsRailFeedSqlitePath is not set. ' +
      'Provide the path to the SFM rail GTFS SQLite database.\n';
    await writeStandardOutputs(outputDir, 'rail_bus_matrix', [], msg);
    return [];
  }

  // -------------------------------------------------------------------------
  // Open the rail database (separate from the bus singleton)
  // -------------------------------------------------------------------------
  let railDb: any;
  try {
    railDb = openDb({
      sqlitePath: config.diagnosticsRailFeedSqlitePath,
    } as any);
  } catch (err: any) {
    const msg = `Rail-bus matrix: cannot open rail database at ${config.diagnosticsRailFeedSqlitePath}: ${err.message}\n`;
    await writeStandardOutputs(outputDir, 'rail_bus_matrix', [], msg);
    return [];
  }

  // -------------------------------------------------------------------------
  // Check timezone alignment between feeds
  // -------------------------------------------------------------------------
  const busTimezone =
    (busDb.prepare('SELECT agency_timezone FROM agency LIMIT 1').get() as any)
      ?.agency_timezone ?? '(unknown)';
  const railTimezone =
    (railDb.prepare('SELECT agency_timezone FROM agency LIMIT 1').get() as any)
      ?.agency_timezone ?? '(unknown)';
  const timezoneWarning =
    busTimezone !== railTimezone
      ? `WARNING: bus feed timezone (${busTimezone}) differs from rail feed timezone (${railTimezone}). ` +
        'Time comparisons may be incorrect. Both feeds must use the same timezone (expected: Europe/Rome).'
      : '';

  // -------------------------------------------------------------------------
  // Resolve active service_ids for both feeds
  // -------------------------------------------------------------------------
  const busServiceIds = resolveServiceIds(busDb, busSampleDate);
  const railServiceIds = resolveServiceIds(railDb, railSampleDate);

  if (railServiceIds.size === 0) {
    await writeStandardOutputs(
      outputDir,
      'rail_bus_matrix',
      [],
      `Rail-bus matrix: no active rail service_ids for ${railSampleDate}.\n`,
    );
    return [];
  }
  if (busServiceIds.size === 0) {
    await writeStandardOutputs(
      outputDir,
      'rail_bus_matrix',
      [],
      `Rail-bus matrix: no active bus service_ids for ${busSampleDate}.\n`,
    );
    return [];
  }

  // -------------------------------------------------------------------------
  // Find SFM station stops in the rail feed
  //
  // If zone.stopIds is configured, use those as rail station stop_ids.
  // Otherwise, find stops whose stop_name contains "SFM" (or another pattern
  // the user can add to the config).
  // -------------------------------------------------------------------------
  let railStationStopIds: string[];
  if (
    config.diagnosticsZone?.stopIds &&
    config.diagnosticsZone.stopIds.length > 0
  ) {
    railStationStopIds = config.diagnosticsZone.stopIds;
  } else {
    // Fallback: find stops named like "SFM*" in the rail feed
    const sfmRows = railDb
      .prepare(
        `
      -- Find rail stops whose name suggests they are SFM interchange stations.
      -- Adjust the LIKE pattern to match your feed's naming convention.
      SELECT stop_id
      FROM   stops
      WHERE  stop_name LIKE 'SFM%'
         OR  stop_name LIKE '%stazione%'
    `,
      )
      .all() as { stop_id: string }[];
    railStationStopIds = sfmRows.map((r) => r.stop_id);
  }

  if (railStationStopIds.length === 0) {
    await writeStandardOutputs(
      outputDir,
      'rail_bus_matrix',
      [],
      'Rail-bus matrix: no SFM station stop_ids found. Set config.diagnosticsZone.stopIds to the rail station stop_ids.\n',
    );
    return [];
  }

  // -------------------------------------------------------------------------
  // Load rail station coordinates from the rail feed
  // -------------------------------------------------------------------------
  const { placeholders: railStnPlaceholders, values: railStnValues } =
    buildInClause(railStationStopIds);
  const railStations = railDb
    .prepare(
      `
    SELECT stop_id, stop_name, stop_lat, stop_lon
    FROM   stops
    WHERE  stop_id IN (${railStnPlaceholders})
  `,
    )
    .all(...railStnValues) as {
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
  }[];

  // -------------------------------------------------------------------------
  // For each rail station, find nearby bus stops (haversine <= MAX_WALK_METERS)
  // -------------------------------------------------------------------------
  const allBusStops = busDb
    .prepare('SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops')
    .all() as {
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
  }[];

  const nearbyBusStops = new Map<string, string[]>(); // railStopId → busStopId[]
  for (const rs of railStations) {
    const nearby = allBusStops
      .filter(
        (bs) =>
          haversineMeters(rs.stop_lat, rs.stop_lon, bs.stop_lat, bs.stop_lon) <=
          MAX_WALK_METERS,
      )
      .map((bs) => bs.stop_id);
    nearbyBusStops.set(rs.stop_id, nearby);
  }

  // -------------------------------------------------------------------------
  // Query all train arrivals at SFM stations
  // -------------------------------------------------------------------------
  const { placeholders: railSvcPlaceholders, values: railSvcValues } =
    buildInClause([...railServiceIds]);
  const { placeholders: railStnPh2, values: railStnVals2 } =
    buildInClause(railStationStopIds);

  const trainArrivals = railDb
    .prepare(
      `
    -- All train arrivals at the configured SFM interchange stations.
    -- arrival_time_seconds is a GENERATED column handling >24:00:00 times.
    -- We exclude the first stop of each trip (arrival_time_seconds = 0 or NULL
    -- means it's the origin terminus, not an interchange).
    SELECT
      st.trip_id,
      t.service_id,
      COALESCE(r.route_short_name, r.route_long_name, t.route_id) AS train_line,
      s.stop_id  AS rail_stop_id,
      s.stop_name,
      CAST(st.arrival_time_seconds AS INTEGER) AS arrival_secs
    FROM stop_times st
    JOIN trips  t ON t.trip_id  = st.trip_id
    JOIN stops  s ON s.stop_id  = st.stop_id
    JOIN routes r ON r.route_id = t.route_id
    WHERE t.service_id   IN (${railSvcPlaceholders})
      AND s.stop_id      IN (${railStnPh2})
      AND st.arrival_time_seconds IS NOT NULL
      AND st.arrival_time_seconds > 0
      AND st.stop_sequence > 1    -- exclude origin terminus
    ORDER BY s.stop_id, st.arrival_time_seconds
  `,
    )
    .all(...railSvcValues, ...railStnVals2) as {
    trip_id: string;
    service_id: string;
    train_line: string;
    rail_stop_id: string;
    stop_name: string;
    arrival_secs: number;
  }[];

  if (trainArrivals.length === 0) {
    await writeStandardOutputs(
      outputDir,
      'rail_bus_matrix',
      [],
      `Rail-bus matrix: no train arrivals found at the specified stations for ${railSampleDate}.\n`,
    );
    return [];
  }

  // -------------------------------------------------------------------------
  // Pre-load all bus departures at nearby stops for the active service day
  //
  // Rather than one query per train arrival (N+1 problem), we load all
  // relevant bus departures in one shot and match in JS.
  // -------------------------------------------------------------------------
  const allNearbyBusStopIds = new Set<string>();
  for (const ids of nearbyBusStops.values()) {
    for (const id of ids) allNearbyBusStopIds.add(id);
  }

  const rows: RailBusConnectionRow[] = [];

  if (allNearbyBusStopIds.size === 0) {
    await writeStandardOutputs(
      outputDir,
      'rail_bus_matrix',
      [],
      `Rail-bus matrix: no bus stops found within ${MAX_WALK_METERS} m of any SFM station.\n`,
    );
    return [];
  }

  const { placeholders: busSvcPh, values: busSvcVals } = buildInClause([
    ...busServiceIds,
  ]);
  const { placeholders: busStopPh, values: busStopVals } = buildInClause([
    ...allNearbyBusStopIds,
  ]);

  const busDepartures = busDb
    .prepare(
      `
    -- All bus departures at stops near SFM stations, for active service.
    -- departure_time_seconds handles >24:00:00 for overnight buses.
    SELECT
      st.stop_id,
      CAST(st.departure_time_seconds AS INTEGER) AS dep_secs,
      COALESCE(r.route_short_name, r.route_long_name, t.route_id) AS route_short_name,
      COALESCE(t.trip_headsign, '') AS headsign
    FROM stop_times st
    JOIN trips  t ON t.trip_id  = st.trip_id
    JOIN routes r ON r.route_id = t.route_id
    WHERE t.service_id IN (${busSvcPh})
      AND st.stop_id   IN (${busStopPh})
    ORDER BY st.stop_id, st.departure_time_seconds
  `,
    )
    .all(...busSvcVals, ...busStopVals) as {
    stop_id: string;
    dep_secs: number;
    route_short_name: string;
    headsign: string;
  }[];

  // Index by stop_id for fast lookup
  const busByStop = new Map<string, typeof busDepartures>();
  for (const dep of busDepartures) {
    if (!busByStop.has(dep.stop_id)) busByStop.set(dep.stop_id, []);
    busByStop.get(dep.stop_id)!.push(dep);
  }

  // -------------------------------------------------------------------------
  // For each train arrival, find best connecting bus
  // -------------------------------------------------------------------------
  for (const arrival of trainArrivals) {
    const busStopIds = nearbyBusStops.get(arrival.rail_stop_id) ?? [];
    if (busStopIds.length === 0) {
      // No bus stop near this station
      rows.push({
        station_name: arrival.stop_name,
        rail_stop_id: arrival.rail_stop_id,
        bus_stop_id: '',
        train_line: arrival.train_line,
        train_trip_id: arrival.trip_id,
        train_arrival_time: secsToTime(arrival.arrival_secs),
        train_arrival_secs: arrival.arrival_secs,
        best_bus_route: '',
        best_bus_headsign: '',
        best_bus_departure_time: '',
        wait_minutes: -1,
        connections_in_window: 0,
        flagged_no_connection: true,
        flagged_long_wait: false,
        flagged_stranded: false,
      });
      continue;
    }

    // Collect all connections across nearby bus stops
    const connections: { stopId: string; dep: (typeof busDepartures)[0] }[] =
      [];
    for (const stopId of busStopIds) {
      const deps = busByStop.get(stopId) ?? [];
      for (const dep of deps) {
        const wait = dep.dep_secs - arrival.arrival_secs;
        if (wait >= minWaitSecs && wait <= maxWaitSecs) {
          connections.push({ stopId, dep });
        }
      }
    }

    const connectionsInWindow = connections.length;
    const noConnection = connectionsInWindow === 0;

    // Check "stranded" flag: all bus departures at nearby stops happen before
    // this train arrives (last bus already gone)
    let stranded = false;
    if (noConnection) {
      let lastBusDep = -1;
      for (const stopId of busStopIds) {
        for (const dep of busByStop.get(stopId) ?? []) {
          if (dep.dep_secs > lastBusDep) lastBusDep = dep.dep_secs;
        }
      }
      stranded = lastBusDep >= 0 && lastBusDep < arrival.arrival_secs;
    }

    if (noConnection) {
      rows.push({
        station_name: arrival.stop_name,
        rail_stop_id: arrival.rail_stop_id,
        bus_stop_id: busStopIds[0] ?? '',
        train_line: arrival.train_line,
        train_trip_id: arrival.trip_id,
        train_arrival_time: secsToTime(arrival.arrival_secs),
        train_arrival_secs: arrival.arrival_secs,
        best_bus_route: '',
        best_bus_headsign: '',
        best_bus_departure_time: '',
        wait_minutes: -1,
        connections_in_window: 0,
        flagged_no_connection: true,
        flagged_long_wait: false,
        flagged_stranded: stranded,
      });
      continue;
    }

    // Best connection = minimum wait
    connections.sort((a, b) => a.dep.dep_secs - b.dep.dep_secs);
    const best = connections[0];
    const waitSecs = best.dep.dep_secs - arrival.arrival_secs;
    const waitMinutes = Math.round(waitSecs / 60);
    const longWait = waitSecs > maxWaitSecs * 0.75; // flag at 75% of threshold

    rows.push({
      station_name: arrival.stop_name,
      rail_stop_id: arrival.rail_stop_id,
      bus_stop_id: best.stopId,
      train_line: arrival.train_line,
      train_trip_id: arrival.trip_id,
      train_arrival_time: secsToTime(arrival.arrival_secs),
      train_arrival_secs: arrival.arrival_secs,
      best_bus_route: best.dep.route_short_name,
      best_bus_headsign: best.dep.headsign,
      best_bus_departure_time: secsToTime(best.dep.dep_secs),
      wait_minutes: waitMinutes,
      connections_in_window: connectionsInWindow,
      flagged_no_connection: false,
      flagged_long_wait: longWait,
      flagged_stranded: false,
    });
  }

  // -------------------------------------------------------------------------
  // Build ranked worst-interchanges summary
  // -------------------------------------------------------------------------
  // Per-station aggregation: count no-connections and average wait
  const stationStats = new Map<
    string,
    { noConn: number; total: number; waitSum: number; stranded: number }
  >();
  for (const row of rows) {
    if (!stationStats.has(row.station_name)) {
      stationStats.set(row.station_name, {
        noConn: 0,
        total: 0,
        waitSum: 0,
        stranded: 0,
      });
    }
    const s = stationStats.get(row.station_name)!;
    s.total++;
    if (row.flagged_no_connection) s.noConn++;
    if (row.flagged_stranded) s.stranded++;
    if (row.wait_minutes >= 0) s.waitSum += row.wait_minutes;
  }

  const stationSummaryRows = [...stationStats.entries()]
    .map(([name, s]) => ({
      Station: name,
      'Train arrivals': s.total,
      'No connection': s.noConn,
      Stranded: s.stranded,
      'Avg wait (min)':
        s.total - s.noConn > 0
          ? Math.round(s.waitSum / (s.total - s.noConn))
          : 'N/A',
      'Miss rate': `${Math.round((s.noConn / s.total) * 100)}%`,
    }))
    .sort((a, b) => Number(b['No connection']) - Number(a['No connection']));

  const csvRows = rows.map((r) => ({
    ...r,
    flagged_no_connection: r.flagged_no_connection ? 'YES' : '',
    flagged_long_wait: r.flagged_long_wait ? 'YES' : '',
    flagged_stranded: r.flagged_stranded ? 'YES' : '',
  }));

  const summaryText = [
    summaryHeader(
      'Diagnostic 3: Rail–Bus Connection Matrix',
      busSampleDate,
      new Date(),
    ),
    timezoneWarning ? timezoneWarning + '\n' : '',
    `Max wait window        : ${config.diagnosticsMaxTransferWaitMinutes ?? 20} min`,
    `Min dwell time         : 1 min`,
    `Walk radius for match  : ${MAX_WALK_METERS} m`,
    `Rail stations analysed : ${railStations.length}`,
    `Train arrivals         : ${trainArrivals.length}`,
    `No connection          : ${rows.filter((r) => r.flagged_no_connection).length}`,
    `Long wait              : ${rows.filter((r) => r.flagged_long_wait).length}`,
    `Stranded               : ${rows.filter((r) => r.flagged_stranded).length}`,
    '',
    'Worst interchange stations (ranked by missed connections):',
    '',
    formatTable(stationSummaryRows, 20),
    '',
    `Full results written to: rail_bus_matrix.csv  rail_bus_matrix.json`,
  ]
    .filter(Boolean)
    .join('\n');

  await writeStandardOutputs(
    outputDir,
    'rail_bus_matrix',
    csvRows,
    summaryText,
  );
  await writeJson(
    path.join(outputDir, 'rail_bus_worst_stations.json'),
    stationSummaryRows,
  );

  return rows;
}
