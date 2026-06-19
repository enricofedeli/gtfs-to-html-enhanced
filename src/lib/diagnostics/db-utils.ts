import { openDb } from 'gtfs';
import type { Config, TimePeriod } from '../../types/index.js';

export interface TimeBand {
  label: string;
  startSec: number;
  endSec: number;
}

export interface ZoneFilter {
  routeIds: string[] | null; // null = no restriction
  stopIds: string[] | null;
}

// Fallback time bands used when config.timePeriods is not set
const DEFAULT_TIME_PERIODS: TimePeriod[] = [
  { label: 'Early', start: '04:00', end: '07:00' },
  { label: 'AM Peak', start: '07:00', end: '09:00' },
  { label: 'Midday', start: '09:00', end: '16:00' },
  { label: 'PM Peak', start: '16:00', end: '19:00' },
  { label: 'Evening', start: '19:00', end: '24:00' },
  { label: 'Night', start: '24:00', end: '28:00' },
];

// Day-of-week column names matching GTFS calendar table columns
const DOW_COLUMNS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/**
 * Convert "HH:MM" to seconds-after-service-day.
 * Supports times >= 24:00 for after-midnight service.
 */
function hhmmToSecs(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

/**
 * Resolve the set of active service_ids for a given sample date.
 *
 * Algorithm (matches the GTFS spec exactly):
 *   1. Collect service_ids from `calendar` where start_date <= date <= end_date
 *      AND the matching day-of-week flag is 1.
 *   2. Union with service_ids from `calendar_dates` where date=sampleDate AND exception_type=1
 *      (service explicitly added for this date).
 *   3. Remove service_ids from `calendar_dates` where date=sampleDate AND exception_type=2
 *      (service explicitly cancelled for this date).
 *
 * Degrades gracefully when `calendar` table is absent (feed uses only calendar_dates).
 *
 * @param db  - better-sqlite3 Database handle (from openDb())
 * @param sampleDate - ISO date "YYYY-MM-DD"
 * @returns Set of active service_id strings for that date
 */
export function resolveServiceIds(db: any, sampleDate: string): Set<string> {
  // GTFS date fields store dates as YYYYMMDD integers/strings (no dashes)
  const gtfsDate = sampleDate.replace(/-/g, '');

  // Determine which day-of-week column to use
  const [year, month, day] = sampleDate.split('-').map(Number);
  const dayCol = DOW_COLUMNS[new Date(year, month - 1, day).getDay()];

  const activeIds = new Set<string>();

  // Step 1: weekly calendar (may not exist in all feeds)
  const hasCalendar =
    (db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='calendar'",
      )
      .get() as any) !== undefined;

  if (hasCalendar) {
    // Check whether the calendar table has any rows at all (some feeds have the
    // table but populate it empty and use calendar_dates exclusively)
    const calRows = db
      .prepare(
        `
      -- Services active on this date according to the weekly calendar schedule.
      -- start_date and end_date in calendar are YYYYMMDD integers/strings.
      SELECT service_id
      FROM   calendar
      WHERE  start_date <= ?
        AND  end_date   >= ?
        AND  ${dayCol}   = 1
    `,
      )
      .all(gtfsDate, gtfsDate) as { service_id: string }[];

    for (const row of calRows) activeIds.add(row.service_id);
  }

  // Step 2: services explicitly added for this exact date
  const addedRows = db
    .prepare(
      `
    -- Services added for this specific date via a positive exception in calendar_dates.
    SELECT service_id
    FROM   calendar_dates
    WHERE  date           = ?
      AND  exception_type = 1
  `,
    )
    .all(gtfsDate) as { service_id: string }[];

  for (const row of addedRows) activeIds.add(row.service_id);

  // Step 3: remove services cancelled for this exact date
  const removedRows = db
    .prepare(
      `
    -- Services removed for this specific date via a negative exception in calendar_dates.
    SELECT service_id
    FROM   calendar_dates
    WHERE  date           = ?
      AND  exception_type = 2
  `,
    )
    .all(gtfsDate) as { service_id: string }[];

  for (const row of removedRows) activeIds.delete(row.service_id);

  return activeIds;
}

/**
 * Convert config.timePeriods (or the built-in defaults) into numeric bands.
 * Seconds are measured from midnight of the service day, so values > 86400
 * represent after-midnight service (e.g. 24:30 = 88200 s).
 */
export function parseTimeBands(config: Config): TimeBand[] {
  const periods = config.timePeriods ?? DEFAULT_TIME_PERIODS;
  return periods.map((p) => ({
    label: p.label,
    startSec: hhmmToSecs(p.start),
    endSec: hhmmToSecs(p.end),
  }));
}

/**
 * Resolve the zone filter to concrete route_id and stop_id lists.
 *
 * Priority:
 *   - If routeIds supplied: use directly, ignore others.
 *   - If boundingBox supplied: expand to all routes that serve any stop inside the box.
 *   - If stopIds supplied: expand to all routes that serve any of those stops.
 *   - If nothing supplied: return null lists (= no restriction).
 */
export function resolveZoneFilter(db: any, config: Config): ZoneFilter {
  const zone = config.diagnosticsZone;
  if (!zone) return { routeIds: null, stopIds: null };

  if (zone.routeIds && zone.routeIds.length > 0) {
    return { routeIds: zone.routeIds, stopIds: null };
  }

  let stopIds: string[] | null = zone.stopIds ?? null;

  if (zone.boundingBox) {
    const [minLon, minLat, maxLon, maxLat] = zone.boundingBox;
    // Expand bounding box to stop_ids
    const rows = db
      .prepare(
        `
      -- Find all stops whose coordinates fall within the configured bounding box.
      SELECT stop_id
      FROM   stops
      WHERE  stop_lat BETWEEN ? AND ?
        AND  stop_lon BETWEEN ? AND ?
    `,
      )
      .all(minLat, maxLat, minLon, maxLon) as { stop_id: string }[];
    stopIds = rows.map((r) => r.stop_id);
  }

  if (stopIds && stopIds.length > 0) {
    const placeholders = stopIds.map(() => '?').join(', ');
    // Expand stop_ids to route_ids
    const rows = db
      .prepare(
        `
      -- Find all routes that serve at least one stop in the zone.
      SELECT DISTINCT t.route_id
      FROM   trips      t
      JOIN   stop_times st ON st.trip_id = t.trip_id
      WHERE  st.stop_id IN (${placeholders})
    `,
      )
      .all(...stopIds) as { route_id: string }[];
    return { routeIds: rows.map((r) => r.route_id), stopIds };
  }

  return { routeIds: null, stopIds: null };
}

/**
 * Check whether a given table exists in the currently-open SQLite database.
 * Useful for gracefully degrading when optional GTFS tables (frequencies, shapes,
 * transfers) are absent from the feed.
 */
export function checkTableExists(db: any, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as any;
  return row !== undefined;
}

/**
 * Return true if the feed has a `frequencies` table with at least one row.
 * When true, trip counts must account for frequency-based scheduling rather
 * than counting raw stop_times departures.
 */
export function hasFrequencies(db: any): boolean {
  if (!checkTableExists(db, 'frequencies')) return false;
  const row = db.prepare('SELECT 1 FROM frequencies LIMIT 1').get();
  return row !== undefined;
}

/**
 * For a trip that uses frequency-based scheduling, compute how many departures
 * of that trip occur during a given time band.
 *
 * Per GTFS spec, frequencies.headway_secs defines the gap between consecutive
 * departures. We compute the number of departures whose first stop departure
 * falls within [bandStart, bandEnd).
 *
 * For schedule-based trips (no frequencies row), returns 1.
 */
export function getFrequencyMultiplier(
  tripId: string,
  bandStart: number,
  bandEnd: number,
  freqRowsByTrip: Map<
    string,
    {
      start_time_seconds: number;
      end_time_seconds: number;
      headway_secs: number;
    }[]
  >,
): number {
  const freqs = freqRowsByTrip.get(tripId);
  if (!freqs || freqs.length === 0) return 1;

  let count = 0;
  for (const freq of freqs) {
    // Overlap between the frequency window and the time band
    const winStart = freq.start_time_seconds;
    const winEnd = freq.end_time_seconds;
    const overlapStart = Math.max(winStart, bandStart);
    const overlapEnd = Math.min(winEnd, bandEnd);
    if (overlapEnd <= overlapStart) continue;
    // Number of departures starting within the overlap window
    count += Math.floor((overlapEnd - overlapStart) / freq.headway_secs);
  }
  return count === 0 ? 1 : count;
}

/**
 * Load all frequency rows from the database, indexed by trip_id.
 * Returns an empty Map if the frequencies table does not exist.
 */
export function loadFrequencyRowsByTrip(
  db: any,
): Map<
  string,
  {
    start_time_seconds: number;
    end_time_seconds: number;
    headway_secs: number;
  }[]
> {
  const map = new Map<string, any[]>();
  if (!checkTableExists(db, 'frequencies')) return map;

  const rows = db
    .prepare(
      `
    -- Load all frequency-based scheduling definitions.
    -- start_time_seconds and end_time_seconds are GENERATED columns
    -- that parse the HH:MM:SS time strings into seconds-after-service-day,
    -- correctly handling values >= 86400 (after-midnight service).
    SELECT trip_id, start_time_seconds, end_time_seconds, headway_secs
    FROM   frequencies
    ORDER  BY trip_id, start_time_seconds
  `,
    )
    .all() as {
    trip_id: string;
    start_time_seconds: number;
    end_time_seconds: number;
    headway_secs: number;
  }[];

  for (const row of rows) {
    if (!map.has(row.trip_id)) map.set(row.trip_id, []);
    map.get(row.trip_id)!.push(row);
  }
  return map;
}

/**
 * Build a SQL IN-clause placeholder string and return both it and the values array.
 * Utility to avoid SQL injection when passing sets of IDs.
 */
export function buildInClause(ids: string[]): {
  placeholders: string;
  values: string[];
} {
  return {
    placeholders: ids.map(() => '?').join(', '),
    values: ids,
  };
}

/**
 * Convert seconds-after-service-day to "HH:MM:SS" display string.
 * Correctly handles times >= 86400 (after-midnight service, e.g. 25:30:00).
 */
export function secsToTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Get the currently-open singleton database handle. */
export function getDb(): any {
  return openDb();
}
