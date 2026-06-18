import type { Route, Stop, StopTime, Trip } from 'gtfs';
import type { Config, TimePeriod } from '../types/index.ts';

export interface StopMatch {
  existingStopId: string;
  proposedStopId: string;
  distanceMeters: number;
}

export interface StopMatchTable {
  // existingStopId → proposedStopId (null if no match)
  existingToProposed: Map<string, string | null>;
  // proposedStopId → existingStopId (null if no match)
  proposedToExisting: Map<string, string | null>;
  matches: StopMatch[];
}

export interface NetworkData {
  routes: Route[];
  stops: Stop[];
  trips: Trip[];
  stoptimes: StopTime[];
  stopSequenceByRoute: Map<string, string[]>; // routeId|directionId → ordered stop_ids
}

export interface RouteDiff {
  routeId: string;
  label: string;
  status: 'new' | 'removed' | 'modified' | 'unchanged';
  existingRouteIds: string[];
  proposedRouteIds: string[];
  addedStopIds: string[];
  removedStopIds: string[];
  existingTripCount: number;
  proposedTripCount: number;
}

export interface BranchFrequency {
  stops: string[]; // ordered list of stop_ids (using proposed stop_ids when matched)
  label: string;
  existingPerPeriod: Record<string, number>; // label → trips per hour
  proposedPerPeriod: Record<string, number>;
}

export interface StopDeparture {
  routeShortName: string;
  routeColor: string;
  routeTextColor: string;
  headsign: string;
  departureTime: string; // HH:MM
  departureSeconds: number;
}

export interface StopComparisonData {
  stopId: string; // canonical (proposed) stop_id
  stopName: string;
  existingDepartures: StopDeparture[];
  proposedDepartures: StopDeparture[];
  existingTripsPerHour: Record<string, number>;
  proposedTripsPerHour: Record<string, number>;
}

export interface NetworkComparison {
  routeDiffs: RouteDiff[];
  stopMatchTable: StopMatchTable;
  branchFrequencies: BranchFrequency[];
  stopComparisons: Map<string, StopComparisonData>;
  summary: {
    existingRouteCount: number;
    proposedRouteCount: number;
    existingStopCount: number;
    proposedStopCount: number;
    existingTripCount: number;
    proposedTripCount: number;
    newRoutes: number;
    removedRoutes: number;
    modifiedRoutes: number;
    newStops: number;
    removedStops: number;
  };
}

/*
 * Compute the Haversine distance in meters between two lat/lon points.
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/*
 * Match stops across two networks by spatial proximity.
 * A stop is matched to its nearest counterpart within `thresholdMeters`.
 */
export function matchStopsAcrossNetworks(
  existingStops: Stop[],
  proposedStops: Stop[],
  thresholdMeters: number,
): StopMatchTable {
  const existingToProposed = new Map<string, string | null>();
  const proposedToExisting = new Map<string, string | null>();
  const matches: StopMatch[] = [];

  // Build spatial index: for each proposed stop, record its coords
  const proposedCoords = proposedStops.map((s) => ({
    stop_id: s.stop_id,
    lat: Number(s.stop_lat),
    lon: Number(s.stop_lon),
  }));

  for (const existing of existingStops) {
    const eLat = Number(existing.stop_lat);
    const eLon = Number(existing.stop_lon);

    let bestId: string | null = null;
    let bestDist = Infinity;

    for (const proposed of proposedCoords) {
      const dist = haversineDistanceMeters(
        eLat,
        eLon,
        proposed.lat,
        proposed.lon,
      );
      if (dist < bestDist) {
        bestDist = dist;
        bestId = proposed.stop_id;
      }
    }

    if (bestDist <= thresholdMeters && bestId !== null) {
      existingToProposed.set(existing.stop_id, bestId);
      matches.push({
        existingStopId: existing.stop_id,
        proposedStopId: bestId,
        distanceMeters: bestDist,
      });
    } else {
      existingToProposed.set(existing.stop_id, null);
    }
  }

  // Build reverse map
  for (const proposed of proposedStops) {
    proposedToExisting.set(proposed.stop_id, null);
  }
  for (const match of matches) {
    proposedToExisting.set(match.proposedStopId, match.existingStopId);
  }

  return { existingToProposed, proposedToExisting, matches };
}

/*
 * Convert a GTFS time string (HH:MM:SS, possibly past midnight) to seconds after midnight.
 */
function gtfsTimeToSeconds(time: string): number {
  const [h, m, s] = time.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

/*
 * Convert a time string "HH:MM" to seconds after midnight.
 */
function periodTimeToSeconds(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

/*
 * Count trips departing from the first stop of each trip within the given time period.
 */
function countTripsInPeriod(
  stoptimes: StopTime[],
  trips: Trip[],
  periodStartSec: number,
  periodEndSec: number,
): number {
  const tripIds = new Set(trips.map((t) => t.trip_id));
  // Find the minimum stop_sequence stoptime for each trip (the "first" departure)
  const firstDepartureByTrip = new Map<string, number>();

  for (const st of stoptimes) {
    if (!tripIds.has(st.trip_id)) continue;
    if (!st.departure_time) continue;
    const existing = firstDepartureByTrip.get(st.trip_id);
    const seq = st.stop_sequence ?? 999999;
    if (
      existing === undefined ||
      seq < (firstDepartureByTrip.get(st.trip_id + '_seq') ?? 999999)
    ) {
      firstDepartureByTrip.set(st.trip_id + '_seq', seq);
      firstDepartureByTrip.set(
        st.trip_id,
        gtfsTimeToSeconds(st.departure_time),
      );
    }
  }

  let count = 0;
  for (const [key, depSec] of firstDepartureByTrip) {
    if (key.endsWith('_seq')) continue;
    if (depSec >= periodStartSec && depSec < periodEndSec) {
      count++;
    }
  }
  return count;
}

/*
 * Compute trips-per-hour for each time period.
 */
export function computeTripsPerHour(
  trips: Trip[],
  stoptimes: StopTime[],
  timePeriods: TimePeriod[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const period of timePeriods) {
    const startSec = periodTimeToSeconds(period.start);
    const endSec = periodTimeToSeconds(period.end);
    const durationHours = (endSec - startSec) / 3600;
    const count = countTripsInPeriod(stoptimes, trips, startSec, endSec);
    result[period.label] = durationHours > 0 ? count / durationHours : 0;
  }
  return result;
}

/*
 * Build a canonical stop sequence for a route+direction from stoptimes.
 * Returns ordered stop_ids using the most common (modal) sequence.
 */
export function buildStopSequenceForRoute(
  trips: Trip[],
  stoptimes: StopTime[],
): string[] {
  const tripIds = new Set(trips.map((t) => t.trip_id));
  const stopsByTrip = new Map<string, string[]>();

  for (const st of stoptimes) {
    if (!tripIds.has(st.trip_id)) continue;
    if (!stopsByTrip.has(st.trip_id)) stopsByTrip.set(st.trip_id, []);
    stopsByTrip.get(st.trip_id)!.push(`${st.stop_sequence ?? 0}:${st.stop_id}`);
  }

  // Sort each trip's stoptimes by stop_sequence and extract stop_ids
  const sequences: string[][] = [];
  for (const [, stops] of stopsByTrip) {
    stops.sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]));
    sequences.push(stops.map((s) => s.split(':').slice(1).join(':')));
  }

  if (sequences.length === 0) return [];

  // Return the longest sequence (representative)
  return sequences.reduce(
    (best, seq) => (seq.length > best.length ? seq : best),
    sequences[0],
  );
}

/*
 * Compute the overlap fraction between two stop sequences using the fuzzy match table.
 * Returns a value 0–1 where 1 means identical sequences.
 */
export function computeRouteOverlap(
  existingStops: string[],
  proposedStops: string[],
  stopMatchTable: StopMatchTable,
): number {
  if (existingStops.length === 0 || proposedStops.length === 0) return 0;

  const proposedSet = new Set(proposedStops);
  let matchedCount = 0;

  for (const existingStopId of existingStops) {
    const proposedStopId =
      stopMatchTable.existingToProposed.get(existingStopId);
    if (proposedStopId && proposedSet.has(proposedStopId)) {
      matchedCount++;
    }
  }

  const union = new Set([
    ...existingStops,
    ...proposedStops.map(
      (pid) => stopMatchTable.proposedToExisting.get(pid) ?? pid,
    ),
  ]);

  return union.size > 0 ? matchedCount / union.size : 0;
}

/*
 * Determine if a route is "modified" (vs. unchanged) by checking if stoptimes or
 * trip counts differ meaningfully.
 */
function isRouteModified(diff: Omit<RouteDiff, 'status'>): boolean {
  return (
    diff.addedStopIds.length > 0 ||
    diff.removedStopIds.length > 0 ||
    diff.existingTripCount !== diff.proposedTripCount
  );
}

/*
 * Compute route-level diff between two networks.
 *
 * Since route names may differ across networks, we match routes by their
 * stop-sequence overlap (controlled by config.routeOverlapThreshold).
 * Each existing route is matched to the proposed route with highest overlap.
 */
export function computeNetworkDiff(
  existingData: NetworkData,
  proposedData: NetworkData,
  stopMatchTable: StopMatchTable,
  config: Config,
): RouteDiff[] {
  const overlapThreshold = config.routeOverlapThreshold ?? 0.5;
  const diffs: RouteDiff[] = [];

  // Index existing trips/stoptimes by route+direction
  const existingTripsByRoute = new Map<string, Trip[]>();
  for (const trip of existingData.trips) {
    const key = `${trip.route_id}|${trip.direction_id ?? 0}`;
    if (!existingTripsByRoute.has(key)) existingTripsByRoute.set(key, []);
    existingTripsByRoute.get(key)!.push(trip);
  }

  const proposedTripsByRoute = new Map<string, Trip[]>();
  for (const trip of proposedData.trips) {
    const key = `${trip.route_id}|${trip.direction_id ?? 0}`;
    if (!proposedTripsByRoute.has(key)) proposedTripsByRoute.set(key, []);
    proposedTripsByRoute.get(key)!.push(trip);
  }

  const matchedProposedRouteIds = new Set<string>();

  for (const existingRoute of existingData.routes) {
    const existingKey0 = `${existingRoute.route_id}|0`;
    const existingKey1 = `${existingRoute.route_id}|1`;
    const existingStops0 =
      existingData.stopSequenceByRoute.get(existingKey0) ?? [];
    const existingStops1 =
      existingData.stopSequenceByRoute.get(existingKey1) ?? [];
    const existingStops = [...new Set([...existingStops0, ...existingStops1])];
    const existingTripCount =
      (existingTripsByRoute.get(existingKey0)?.length ?? 0) +
      (existingTripsByRoute.get(existingKey1)?.length ?? 0);

    let bestOverlap = 0;
    let bestProposedRoute: Route | null = null;

    for (const proposedRoute of proposedData.routes) {
      if (matchedProposedRouteIds.has(proposedRoute.route_id)) continue;
      const proposedKey0 = `${proposedRoute.route_id}|0`;
      const proposedKey1 = `${proposedRoute.route_id}|1`;
      const proposedStops0 =
        proposedData.stopSequenceByRoute.get(proposedKey0) ?? [];
      const proposedStops1 =
        proposedData.stopSequenceByRoute.get(proposedKey1) ?? [];
      const proposedStops = [
        ...new Set([...proposedStops0, ...proposedStops1]),
      ];

      const overlap = computeRouteOverlap(
        existingStops,
        proposedStops,
        stopMatchTable,
      );
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestProposedRoute = proposedRoute;
      }
    }

    if (bestProposedRoute && bestOverlap >= overlapThreshold) {
      matchedProposedRouteIds.add(bestProposedRoute.route_id);

      const proposedKey0 = `${bestProposedRoute.route_id}|0`;
      const proposedKey1 = `${bestProposedRoute.route_id}|1`;
      const proposedStops0 =
        proposedData.stopSequenceByRoute.get(proposedKey0) ?? [];
      const proposedStops1 =
        proposedData.stopSequenceByRoute.get(proposedKey1) ?? [];
      const proposedStops = [
        ...new Set([...proposedStops0, ...proposedStops1]),
      ];
      const proposedTripCount =
        (proposedTripsByRoute.get(proposedKey0)?.length ?? 0) +
        (proposedTripsByRoute.get(proposedKey1)?.length ?? 0);

      const proposedStopSet = new Set(proposedStops);
      const existingStopSet = new Set(existingStops);

      // Compute added stops (in proposed but not matched to existing)
      const addedStopIds = proposedStops.filter((pid) => {
        const existingId = stopMatchTable.proposedToExisting.get(pid);
        return !existingId || !existingStopSet.has(existingId);
      });

      // Compute removed stops (in existing but not matched to proposed)
      const removedStopIds = existingStops.filter((eid) => {
        const proposedId = stopMatchTable.existingToProposed.get(eid);
        return !proposedId || !proposedStopSet.has(proposedId);
      });

      const diffBase = {
        routeId: existingRoute.route_id,
        label:
          existingRoute.route_short_name ??
          existingRoute.route_long_name ??
          existingRoute.route_id,
        existingRouteIds: [existingRoute.route_id],
        proposedRouteIds: [bestProposedRoute.route_id],
        addedStopIds,
        removedStopIds,
        existingTripCount,
        proposedTripCount,
      };

      diffs.push({
        ...diffBase,
        status: isRouteModified(diffBase) ? 'modified' : 'unchanged',
      });
    } else {
      diffs.push({
        routeId: existingRoute.route_id,
        label:
          existingRoute.route_short_name ??
          existingRoute.route_long_name ??
          existingRoute.route_id,
        status: 'removed',
        existingRouteIds: [existingRoute.route_id],
        proposedRouteIds: [],
        addedStopIds: [],
        removedStopIds: existingStops,
        existingTripCount,
        proposedTripCount: 0,
      });
    }
  }

  // Any proposed routes not matched → new
  for (const proposedRoute of proposedData.routes) {
    if (matchedProposedRouteIds.has(proposedRoute.route_id)) continue;
    const proposedKey0 = `${proposedRoute.route_id}|0`;
    const proposedKey1 = `${proposedRoute.route_id}|1`;
    const proposedStops0 =
      proposedData.stopSequenceByRoute.get(proposedKey0) ?? [];
    const proposedStops1 =
      proposedData.stopSequenceByRoute.get(proposedKey1) ?? [];
    const proposedStops = [...new Set([...proposedStops0, ...proposedStops1])];
    const proposedTripCount =
      (proposedTripsByRoute.get(proposedKey0)?.length ?? 0) +
      (proposedTripsByRoute.get(proposedKey1)?.length ?? 0);

    diffs.push({
      routeId: proposedRoute.route_id,
      label:
        proposedRoute.route_short_name ??
        proposedRoute.route_long_name ??
        proposedRoute.route_id,
      status: 'new',
      existingRouteIds: [],
      proposedRouteIds: [proposedRoute.route_id],
      addedStopIds: proposedStops,
      removedStopIds: [],
      existingTripCount: 0,
      proposedTripCount,
    });
  }

  return diffs;
}

/*
 * Build all departures from a given stop (by proposed stop_id) across all routes.
 */
export function buildDeparturesForStop(
  stopId: string,
  routes: Route[],
  trips: Trip[],
  stoptimes: StopTime[],
  stopMatchTable: StopMatchTable | null,
  isProposed: boolean,
): StopDeparture[] {
  // Find the effective stop_id in the current network's data
  let effectiveStopId = stopId;
  if (!isProposed && stopMatchTable) {
    effectiveStopId = stopMatchTable.proposedToExisting.get(stopId) ?? stopId;
  }

  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  const tripById = new Map(trips.map((t) => [t.trip_id, t]));

  const departures: StopDeparture[] = [];

  for (const st of stoptimes) {
    if (st.stop_id !== effectiveStopId) continue;
    if (!st.departure_time) continue;

    const trip = tripById.get(st.trip_id);
    if (!trip) continue;

    const route = routeById.get(trip.route_id);
    if (!route) continue;

    departures.push({
      routeShortName: route.route_short_name ?? route.route_id,
      routeColor: route.route_color ? `#${route.route_color}` : '#000000',
      routeTextColor: route.route_text_color
        ? `#${route.route_text_color}`
        : '#ffffff',
      headsign: trip.trip_headsign ?? '',
      departureTime: st.departure_time.slice(0, 5), // HH:MM
      departureSeconds: gtfsTimeToSeconds(st.departure_time),
    });
  }

  departures.sort((a, b) => a.departureSeconds - b.departureSeconds);
  return departures;
}

/*
 * Compute trips-per-hour for a set of departures in each time period.
 */
export function computeDeparturesPerHour(
  departures: StopDeparture[],
  timePeriods: TimePeriod[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const period of timePeriods) {
    const startSec = periodTimeToSeconds(period.start);
    const endSec = periodTimeToSeconds(period.end);
    const durationHours = (endSec - startSec) / 3600;
    const count = departures.filter(
      (d) => d.departureSeconds >= startSec && d.departureSeconds < endSec,
    ).length;
    result[period.label] =
      durationHours > 0 ? Math.round((count / durationHours) * 10) / 10 : 0;
  }
  return result;
}

const DEFAULT_TIME_PERIODS: TimePeriod[] = [
  { label: 'AM Peak', start: '07:00', end: '09:00' },
  { label: 'Interpeak', start: '09:00', end: '17:00' },
  { label: 'PM Peak', start: '17:00', end: '19:00' },
  { label: 'Off-Peak', start: '19:00', end: '23:00' },
];

/*
 * Build the full network comparison object combining all diff data.
 */
export function buildNetworkComparison(
  existingData: NetworkData,
  proposedData: NetworkData,
  stopMatchTable: StopMatchTable,
  config: Config,
): NetworkComparison {
  const routeDiffs = computeNetworkDiff(
    existingData,
    proposedData,
    stopMatchTable,
    config,
  );

  const timePeriods = config.timePeriods ?? DEFAULT_TIME_PERIODS;

  // Build per-stop comparison data for all proposed stops
  const stopComparisons = new Map<string, StopComparisonData>();
  const routeById = new Map([
    ...existingData.routes.map((r) => [r.route_id, r] as [string, Route]),
    ...proposedData.routes.map((r) => [r.route_id, r] as [string, Route]),
  ]);

  for (const proposedStop of proposedData.stops) {
    const existingDepartures = buildDeparturesForStop(
      proposedStop.stop_id,
      existingData.routes,
      existingData.trips,
      existingData.stoptimes,
      stopMatchTable,
      false,
    );

    const proposedDepartures = buildDeparturesForStop(
      proposedStop.stop_id,
      proposedData.routes,
      proposedData.trips,
      proposedData.stoptimes,
      null,
      true,
    );

    if (existingDepartures.length === 0 && proposedDepartures.length === 0)
      continue;

    stopComparisons.set(proposedStop.stop_id, {
      stopId: proposedStop.stop_id,
      stopName: proposedStop.stop_name ?? proposedStop.stop_id,
      existingDepartures,
      proposedDepartures,
      existingTripsPerHour: computeDeparturesPerHour(
        existingDepartures,
        timePeriods,
      ),
      proposedTripsPerHour: computeDeparturesPerHour(
        proposedDepartures,
        timePeriods,
      ),
    });
  }

  const newRoutes = routeDiffs.filter((d) => d.status === 'new').length;
  const removedRoutes = routeDiffs.filter((d) => d.status === 'removed').length;
  const modifiedRoutes = routeDiffs.filter(
    (d) => d.status === 'modified',
  ).length;

  const existingMatchedStopIds = new Set(
    [...stopMatchTable.existingToProposed.values()].filter(Boolean),
  );
  const newStops = proposedData.stops.filter(
    (s) => stopMatchTable.proposedToExisting.get(s.stop_id) === null,
  ).length;
  const removedStops = existingData.stops.filter(
    (s) => stopMatchTable.existingToProposed.get(s.stop_id) === null,
  ).length;

  return {
    routeDiffs,
    stopMatchTable,
    branchFrequencies: [], // computed separately if needed
    stopComparisons,
    summary: {
      existingRouteCount: existingData.routes.length,
      proposedRouteCount: proposedData.routes.length,
      existingStopCount: existingData.stops.length,
      proposedStopCount: proposedData.stops.length,
      existingTripCount: existingData.trips.length,
      proposedTripCount: proposedData.trips.length,
      newRoutes,
      removedRoutes,
      modifiedRoutes,
      newStops,
      removedStops,
    },
  };
}
