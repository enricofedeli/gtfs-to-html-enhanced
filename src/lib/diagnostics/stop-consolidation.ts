/**
 * Diagnostic 6: Stop consolidation
 *
 * Identifies stops spaced too tightly along a corridor and classifies them as
 * candidates for removal or fusion, with walking-distance feasibility and
 * severance checks.
 *
 * Per candidate (A → B → C), answers:
 *   Over-stopping?  corridor_dist_AB and corridor_dist_BC both < effective_flag_below
 *   Feasible?       walk distance from B to retained stop (A or C) is short and unsevered
 *   Worth it?       spacing_deficit × service_weight vs access_penalty
 *
 * Primary distance signal: stop_times.shape_dist_traveled delta.
 * Fallback: project stops onto shape LineString (turf).
 * QA: haversine geographic distance must be ≤ corridor distance.
 *
 * All thresholds and line-type mappings are read from config/; see
 * stop-consolidation-config.ts for file formats.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import nearestPointOnLine from '@turf/nearest-point-on-line';
import length from '@turf/length';
import lineSlice from '@turf/line-slice';
import { lineString, point, featureCollection } from '@turf/helpers';

import type { Config } from '../../types/index.js';
import type { TimeBand, ZoneFilter } from './db-utils.js';
import {
  hasFrequencies,
  loadFrequencyRowsByTrip,
  getFrequencyMultiplier,
  buildInClause,
  checkTableExists,
} from './db-utils.js';
import {
  writeGeoJSON,
  writeStandardOutputs,
  formatTable,
  summaryHeader,
  makeOutputDir,
} from './output-utils.js';
import { haversineDistanceMeters } from '../comparison-utils.js';
import {
  loadLineTypes,
  loadSpacingThresholds,
  loadProtectedPoiCategories,
  resolveGoverningLineType,
  type SpacingThreshold,
} from './stop-consolidation-config.js';
import { batchWalkDistances, isSevered } from './osrm-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConsolidationCandidate {
  route_ids: string; // pipe-separated
  governing_line_type: string;
  serving_line_types: string; // pipe-separated
  direction_id: number;
  stop_a_id: string;
  stop_a_name: string;
  stop_b_id: string; // candidate to remove / fuse
  stop_b_name: string;
  stop_c_id: string;
  stop_c_name: string;
  corridor_dist_ab_m: number;
  corridor_dist_bc_m: number;
  corridor_dist_ac_m: number; // ab + bc after removal
  geographic_dist_ab_m: number;
  geographic_dist_bc_m: number;
  ratio_ab: number; // corridor/geo; < 1 = data error; > 1.6 = detour/excluded
  ratio_bc: number;
  effective_flag_below_m: number;
  effective_target_spacing_m: number;
  effective_max_gap_m: number;
  service_weight: number;
  peak_headway_min: number;
  walk_dist_m: number; // -1 if OSRM not available
  walk_time_s: number;
  severance: boolean;
  trunk_flag: boolean;
  protected: boolean;
  protected_reason: string;
  classification: 'removal' | 'fusion' | 'excluded';
  score: number;
  recommended_action: string;
  distance_source: 'shape_dist_traveled' | 'projected' | 'geographic_fallback';
}

export interface ConsolidationResult {
  candidates: ConsolidationCandidate[];
  flaggedCount: number;
  totalSegments: number;
  uniqueRouteIds: string[];
  geojson: object | undefined;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface StopInfo {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  shape_dist_traveled: number | null;
}

interface Pattern {
  patternKey: string; // join of stop_ids
  direction_id: number;
  shape_id: string | null;
  routeIds: Set<string>;
  tripCount: number;
  stops: StopInfo[];
  distanceSource: 'shape_dist_traveled' | 'projected' | 'geographic_fallback';
  unitFactor: number; // multiply shape_dist_traveled by this to get metres
}

// Key for segment registry: "from_stop_id|to_stop_id|direction_id"
interface SegmentData {
  corridor_dist_m: number;
  geo_dist_m: number;
  ratio: number;
  distance_source: 'shape_dist_traveled' | 'projected' | 'geographic_fallback';
  routeIds: Set<string>;
  tripCount: number;
}

// POI point from GeoJSON
interface PoiPoint {
  lat: number;
  lon: number;
  category: string;
}

// Trunk flag set (from hidden-trunk results)
type TrunkSegmentSet = Set<string>; // "from_stop_id|to_stop_id"

// ---------------------------------------------------------------------------
// Unit auto-detection
// ---------------------------------------------------------------------------

export function detectUnitFactor(stops: StopInfo[]): {
  factor: number;
  reliable: boolean;
} {
  // Compare shape_dist_traveled deltas against haversine for the same pairs.
  // Ratio ≈ 1 → already metres; ≈ 0.001 → km input; ≈ 0.3048 → feet input.
  const samples: number[] = [];
  for (let i = 1; i < Math.min(stops.length, 22); i++) {
    const prev = stops[i - 1];
    const curr = stops[i];
    if (prev.shape_dist_traveled == null || curr.shape_dist_traveled == null)
      continue;
    const delta = curr.shape_dist_traveled - prev.shape_dist_traveled;
    if (delta <= 0) continue;
    const geo = haversineDistanceMeters(
      prev.stop_lat,
      prev.stop_lon,
      curr.stop_lat,
      curr.stop_lon,
    );
    if (geo < 10) continue; // too short to be reliable
    samples.push(delta / geo);
  }

  if (samples.length === 0) return { factor: 1, reliable: false };

  // Median ratio
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Classify
  if (median > 0.8 && median < 2.5) return { factor: 1, reliable: true }; // metres
  if (median > 0.0008 && median < 0.002)
    return { factor: 1000, reliable: true }; // km → m
  // Feet: 1 ft ≈ 0.3048 m → delta/geo ≈ 1/0.3048 ≈ 3.28; convert ft→m by multiplying by 0.3048
  if (median > 2.8 && median < 3.6) return { factor: 0.3048, reliable: true }; // ft → m

  // Inconsistent — treat as metres but mark unreliable
  return { factor: 1, reliable: false };
}

// ---------------------------------------------------------------------------
// Monotonicity gate
// ---------------------------------------------------------------------------

export function isMonotonic(stops: StopInfo[]): boolean {
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1].shape_dist_traveled;
    const curr = stops[i].shape_dist_traveled;
    if (prev == null || curr == null) return false;
    if (curr < prev - 0.001) return false; // allow tiny floating-point noise
  }
  return true;
}

// ---------------------------------------------------------------------------
// Projection fallback (turf)
// ---------------------------------------------------------------------------

async function projectStopsOntoShape(
  stops: StopInfo[],
  shapeId: string,
  db: any,
): Promise<number[] | null> {
  // Load shape geometry
  if (!checkTableExists(db, 'shapes')) return null;
  const shapeRows = db
    .prepare(
      `SELECT shape_pt_lat, shape_pt_lon
       FROM shapes
       WHERE shape_id = ?
       ORDER BY shape_pt_sequence`,
    )
    .all(shapeId) as { shape_pt_lat: number; shape_pt_lon: number }[];

  if (shapeRows.length < 2) return null;

  const coords = shapeRows.map((r) => [r.shape_pt_lon, r.shape_pt_lat]);
  const shapeLine = lineString(coords);
  const totalLen = length(shapeLine, { units: 'meters' });
  if (totalLen < 1) return null;

  // Project each stop with monotonic constraint
  const projectedDists: number[] = [];
  let prevDistM = 0;

  for (const stop of stops) {
    const pt = point([stop.stop_lon, stop.stop_lat]);

    // Candidate: snap to nearest point beyond previous position (with 30 m back-tolerance)
    const snapped = nearestPointOnLine(shapeLine, pt, { units: 'meters' });
    const snapDist = snapped.properties?.location ?? 0;

    // Monotonic constraint: don't go backwards more than 30 m
    const distM = Math.max(snapDist, prevDistM - 30);
    projectedDists.push(distM);
    prevDistM = distM;
  }

  return projectedDists;
}

// ---------------------------------------------------------------------------
// Main diagnostic function
// ---------------------------------------------------------------------------

export async function runStopConsolidation(
  db: any,
  config: Config,
  outputDir: string,
  sampleDate: string,
  serviceIds: Set<string>,
  timeBands: TimeBand[],
  zone: ZoneFilter,
  hiddenTrunkSegments?: TrunkSegmentSet,
): Promise<ConsolidationResult> {
  await makeOutputDir(outputDir);

  const defaultLineType = config.diagnosticsDefaultLineType ?? 'urban';
  const osrmUrl = config.diagnosticsOsrmFootUrl ?? 'http://localhost:5000';

  // ─── Load config files ─────────────────────────────────────────────────────
  const [lineTypeMap, spacingThresholds, poiCategories] = await Promise.all([
    loadLineTypes(config),
    loadSpacingThresholds(config),
    loadProtectedPoiCategories(config),
  ]);

  // ─── Load POI GeoJSON (optional) ──────────────────────────────────────────
  const poiPoints: PoiPoint[] = await loadPoiGeoJson(config, poiCategories);

  // ─── Load frequency data ───────────────────────────────────────────────────
  const useFrequencies = hasFrequencies(db);
  const freqRowsByTrip = useFrequencies
    ? loadFrequencyRowsByTrip(db)
    : new Map();

  // Find the AM Peak band (or second band) for peak headway calculation
  const peakBand =
    timeBands.find((b) => b.label === 'AM Peak') ??
    timeBands[1] ??
    timeBands[0];

  // ─── Load all active trips ─────────────────────────────────────────────────
  const { placeholders: svcPh, values: svcVals } = buildInClause([
    ...serviceIds,
  ]);

  let tripQuery =
    `SELECT t.trip_id, t.route_id, t.direction_id, t.shape_id ` +
    `FROM trips t ` +
    `WHERE t.service_id IN (${svcPh})`;

  const queryValues: string[] = [...svcVals];

  if (zone.routeIds !== null && zone.routeIds.length > 0) {
    const { placeholders: rPh, values: rVals } = buildInClause(zone.routeIds);
    tripQuery += ` AND t.route_id IN (${rPh})`;
    queryValues.push(...rVals);
  }

  const allTrips = db.prepare(tripQuery).all(...queryValues) as {
    trip_id: string;
    route_id: string;
    direction_id: number;
    shape_id: string | null;
  }[];

  if (allTrips.length === 0) {
    process.stdout.write(
      '     [stop-consolidation] No active trips for this date/zone.\n',
    );
    const empty: ConsolidationResult = {
      candidates: [],
      flaggedCount: 0,
      totalSegments: 0,
      uniqueRouteIds: [],
      geojson: undefined,
    };
    await writeOutputs(outputDir, sampleDate, empty);
    return empty;
  }

  // ─── Build patterns ────────────────────────────────────────────────────────
  process.stdout.write(
    `     [stop-consolidation] ${allTrips.length} active trips → building patterns…\n`,
  );

  // Group trips by (direction_id, route_id, shape_id) and then by stop sequence
  const patterns = await buildPatterns(
    db,
    allTrips,
    freqRowsByTrip,
    useFrequencies,
    timeBands,
  );

  process.stdout.write(
    `     [stop-consolidation] ${patterns.length} unique patterns\n`,
  );

  // ─── Build segment registry ────────────────────────────────────────────────
  // segment key = "from_stop_id|to_stop_id|direction_id"
  const segmentMap = new Map<string, SegmentData>();

  for (const pat of patterns) {
    const { factor, reliable } = detectUnitFactor(pat.stops);
    const useShapeDist =
      reliable &&
      pat.stops.every((s) => s.shape_dist_traveled != null) &&
      isMonotonic(pat.stops);

    let projectedDists: number[] | null = null;

    if (!useShapeDist && pat.shape_id) {
      projectedDists = await projectStopsOntoShape(pat.stops, pat.shape_id, db);
    }

    for (let i = 1; i < pat.stops.length; i++) {
      const a = pat.stops[i - 1];
      const b = pat.stops[i];

      const geoM = haversineDistanceMeters(
        a.stop_lat,
        a.stop_lon,
        b.stop_lat,
        b.stop_lon,
      );

      let corridorM: number;
      let source: 'shape_dist_traveled' | 'projected' | 'geographic_fallback';

      if (
        useShapeDist &&
        a.shape_dist_traveled != null &&
        b.shape_dist_traveled != null
      ) {
        const raw = (b.shape_dist_traveled - a.shape_dist_traveled) * factor;
        // Invariant: corridor_dist ≥ geo_dist (within 10% tolerance)
        if (raw < geoM * 0.9 && raw > 0) {
          // Violation — fallback to geographic
          corridorM = geoM;
          source = 'geographic_fallback';
        } else {
          corridorM = Math.max(raw, geoM * 0.9); // never less than geo (with tolerance)
          source = 'shape_dist_traveled';
        }
      } else if (projectedDists) {
        const raw = projectedDists[i] - projectedDists[i - 1];
        corridorM = Math.max(raw > 0 ? raw : geoM, geoM * 0.9);
        source = 'projected';
      } else {
        corridorM = geoM;
        source = 'geographic_fallback';
      }

      const ratio = geoM > 0 ? corridorM / geoM : 1;
      const segKey = `${a.stop_id}|${b.stop_id}|${pat.direction_id}`;

      const existing = segmentMap.get(segKey);
      if (!existing) {
        const routeIds = new Set(pat.routeIds);
        segmentMap.set(segKey, {
          corridor_dist_m: corridorM,
          geo_dist_m: geoM,
          ratio,
          distance_source: source,
          routeIds,
          tripCount: pat.tripCount,
        });
      } else {
        // Merge: prefer shape_dist_traveled over projected over geographic
        const srcRank = (s: string) =>
          s === 'shape_dist_traveled' ? 2 : s === 'projected' ? 1 : 0;
        if (srcRank(source) > srcRank(existing.distance_source)) {
          existing.corridor_dist_m = corridorM;
          existing.distance_source = source;
          existing.ratio = ratio;
        }
        for (const r of pat.routeIds) existing.routeIds.add(r);
        existing.tripCount = Math.max(existing.tripCount, pat.tripCount);
      }
    }
  }

  const totalSegments = segmentMap.size;
  process.stdout.write(
    `     [stop-consolidation] ${totalSegments} unique directed segments\n`,
  );

  // ─── Build protect set (network anchors) ──────────────────────────────────
  const anchorStopIds = await buildNetworkAnchors(db);

  // ─── Detect candidates ────────────────────────────────────────────────────
  // Walk each pattern's stop sequence triple-wise
  const candidateMap = new Map<string, ConsolidationCandidate>();

  for (const pat of patterns) {
    for (let i = 1; i < pat.stops.length - 1; i++) {
      const a = pat.stops[i - 1];
      const b = pat.stops[i];
      const c = pat.stops[i + 1];

      const keyAB = `${a.stop_id}|${b.stop_id}|${pat.direction_id}`;
      const keyBC = `${b.stop_id}|${c.stop_id}|${pat.direction_id}`;

      const segAB = segmentMap.get(keyAB);
      const segBC = segmentMap.get(keyBC);
      if (!segAB || !segBC) continue;

      // Combine route IDs for governing-line-type rule
      const allRouteIds = [...segAB.routeIds, ...segBC.routeIds];
      const { governingType, effectiveThreshold, servingTypes } =
        resolveGoverningLineType(
          allRouteIds,
          lineTypeMap,
          spacingThresholds,
          defaultLineType,
        );

      // Detour guard: ratio > 1.6 on either segment = excluded
      if (segAB.ratio > 1.6 || segBC.ratio > 1.6) continue;

      // Fusion candidate: physically duplicated or nearly touching stop
      const isFusion = segAB.corridor_dist_m < 30 || segBC.corridor_dist_m < 30;

      // Removal candidate check
      const isRemovalCandidate =
        segAB.corridor_dist_m < effectiveThreshold.flag_below_m &&
        segBC.corridor_dist_m < effectiveThreshold.flag_below_m &&
        segAB.corridor_dist_m + segBC.corridor_dist_m <=
          effectiveThreshold.max_gap_after_removal_m;

      if (!isFusion && !isRemovalCandidate) continue;

      const candidateKey = `${a.stop_id}|${b.stop_id}|${c.stop_id}|${pat.direction_id}`;
      if (candidateMap.has(candidateKey)) {
        // Already seen via another pattern — merge routes
        const existing = candidateMap.get(candidateKey)!;
        const mergedIds = [
          ...new Set([...existing.route_ids.split(' | '), ...allRouteIds]),
        ];
        existing.route_ids = mergedIds.join(' | ');
        existing.service_weight = Math.max(
          existing.service_weight,
          computeServiceWeight(
            Math.max(segAB.tripCount, segBC.tripCount),
            peakBand,
            freqRowsByTrip,
          ),
        );
        continue;
      }

      // Protected check: network anchors + POI proximity
      const { isProtected, reason } = checkProtection(
        b,
        anchorStopIds,
        poiPoints,
        poiCategories,
      );

      // Trunk flag: check if AB or BC segment is a known latent trunk
      const trunkFlag =
        hiddenTrunkSegments !== undefined &&
        (hiddenTrunkSegments.has(`${a.stop_id}|${b.stop_id}`) ||
          hiddenTrunkSegments.has(`${b.stop_id}|${c.stop_id}`));

      const serviceWeight = computeServiceWeight(
        Math.max(segAB.tripCount, segBC.tripCount),
        peakBand,
        freqRowsByTrip,
      );

      const classification: 'removal' | 'fusion' | 'excluded' = isFusion
        ? 'fusion'
        : isRemovalCandidate
          ? 'removal'
          : 'excluded';

      const uniqueRouteIds = [...new Set(allRouteIds)];

      candidateMap.set(candidateKey, {
        route_ids: uniqueRouteIds.join(' | '),
        governing_line_type: governingType,
        serving_line_types: servingTypes.join(' | '),
        direction_id: pat.direction_id,
        stop_a_id: a.stop_id,
        stop_a_name: a.stop_name,
        stop_b_id: b.stop_id,
        stop_b_name: b.stop_name,
        stop_c_id: c.stop_id,
        stop_c_name: c.stop_name,
        corridor_dist_ab_m: Math.round(segAB.corridor_dist_m),
        corridor_dist_bc_m: Math.round(segBC.corridor_dist_m),
        corridor_dist_ac_m: Math.round(
          segAB.corridor_dist_m + segBC.corridor_dist_m,
        ),
        geographic_dist_ab_m: Math.round(segAB.geo_dist_m),
        geographic_dist_bc_m: Math.round(segBC.geo_dist_m),
        ratio_ab: Math.round(segAB.ratio * 100) / 100,
        ratio_bc: Math.round(segBC.ratio * 100) / 100,
        effective_flag_below_m: effectiveThreshold.flag_below_m,
        effective_target_spacing_m: effectiveThreshold.target_spacing_m,
        effective_max_gap_m: effectiveThreshold.max_gap_after_removal_m,
        service_weight: Math.round(serviceWeight * 10) / 10,
        peak_headway_min: -1,
        walk_dist_m: -1,
        walk_time_s: -1,
        severance: false,
        trunk_flag: trunkFlag,
        protected: isProtected,
        protected_reason: reason,
        classification,
        score: 0,
        recommended_action: '',
        distance_source:
          segAB.distance_source === 'shape_dist_traveled' ||
          segBC.distance_source === 'shape_dist_traveled'
            ? 'shape_dist_traveled'
            : segAB.distance_source === 'projected' ||
                segBC.distance_source === 'projected'
              ? 'projected'
              : 'geographic_fallback',
      });
    }
  }

  const candidates = [...candidateMap.values()];
  process.stdout.write(
    `     [stop-consolidation] ${candidates.length} raw candidates detected\n`,
  );

  // ─── Enrich with OSRM walk distances ──────────────────────────────────────
  // Only query for non-excluded, non-protected candidates (to save OSRM calls)
  const needsOsrm = candidates.filter((c) => c.classification !== 'excluded');

  if (needsOsrm.length > 0) {
    await enrichWithWalkDistances(needsOsrm, candidates, db, osrmUrl);
  }

  // ─── Score candidates ──────────────────────────────────────────────────────
  for (const c of candidates) {
    c.score = computeScore(c);
    c.recommended_action = buildRecommendedAction(c);
  }

  // Sort: removal first, by score desc; fusion next; excluded last
  candidates.sort((a, b) => {
    const classOrder = { removal: 0, fusion: 1, excluded: 2 };
    const co = classOrder[a.classification] - classOrder[b.classification];
    if (co !== 0) return co;
    return b.score - a.score;
  });

  // ─── Outputs ───────────────────────────────────────────────────────────────
  const uniqueRouteIds = [
    ...new Set(
      candidates.flatMap((c) => c.route_ids.split(' | ').filter(Boolean)),
    ),
  ].sort();

  const flaggedCount = candidates.filter(
    (c) => c.classification === 'removal' && !c.protected && !c.severance,
  ).length;

  const geojson = buildGeoJSON(candidates, db);

  const result: ConsolidationResult = {
    candidates,
    flaggedCount,
    totalSegments,
    uniqueRouteIds,
    geojson,
  };

  await writeOutputs(outputDir, sampleDate, result);

  return result;
}

// ---------------------------------------------------------------------------
// Pattern builder
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

async function buildPatterns(
  db: any,
  allTrips: {
    trip_id: string;
    route_id: string;
    direction_id: number;
    shape_id: string | null;
  }[],
  freqRowsByTrip: Map<string, any[]>,
  useFrequencies: boolean,
  timeBands: TimeBand[],
): Promise<Pattern[]> {
  // Map of patternSig+direction+shape → Pattern
  const patMap = new Map<string, Pattern>();

  for (let start = 0; start < allTrips.length; start += BATCH_SIZE) {
    const batch = allTrips.slice(start, start + BATCH_SIZE);
    const tripIds = batch.map((t) => t.trip_id);
    const { placeholders, values } = buildInClause(tripIds);

    const rows = db
      .prepare(
        `SELECT st.trip_id, st.stop_id, st.stop_sequence, st.shape_dist_traveled,
                s.stop_lat, s.stop_lon, s.stop_name
         FROM stop_times st
         JOIN stops s ON s.stop_id = st.stop_id
         WHERE st.trip_id IN (${placeholders})
         ORDER BY st.trip_id, st.stop_sequence`,
      )
      .all(...values) as {
      trip_id: string;
      stop_id: string;
      stop_sequence: number;
      shape_dist_traveled: number | null;
      stop_lat: number;
      stop_lon: number;
      stop_name: string;
    }[];

    // Group rows by trip_id
    const byTrip = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!byTrip.has(row.trip_id)) byTrip.set(row.trip_id, []);
      byTrip.get(row.trip_id)!.push(row);
    }

    for (const trip of batch) {
      const stopRows = byTrip.get(trip.trip_id) ?? [];
      if (stopRows.length < 2) continue;

      const stops: StopInfo[] = stopRows.map((r) => ({
        stop_id: r.stop_id,
        stop_name: r.stop_name,
        stop_lat: r.stop_lat,
        stop_lon: r.stop_lon,
        shape_dist_traveled: r.shape_dist_traveled,
      }));

      // Pattern signature: ordered stop_ids
      const sig = stops.map((s) => s.stop_id).join('|');
      const patKey = `${trip.direction_id}||${sig}||${trip.shape_id ?? ''}`;

      // Frequency-weighted trip count within all bands combined
      let tripCount = 1;
      if (useFrequencies && freqRowsByTrip.has(trip.trip_id)) {
        tripCount = 0;
        for (const band of timeBands) {
          tripCount += getFrequencyMultiplier(
            trip.trip_id,
            band.startSec,
            band.endSec,
            freqRowsByTrip,
          );
        }
      }

      const existing = patMap.get(patKey);
      if (existing) {
        existing.routeIds.add(trip.route_id);
        existing.tripCount += tripCount;
      } else {
        patMap.set(patKey, {
          patternKey: sig,
          direction_id: trip.direction_id,
          shape_id: trip.shape_id,
          routeIds: new Set([trip.route_id]),
          tripCount,
          stops,
          distanceSource: 'shape_dist_traveled',
          unitFactor: 1,
        });
      }
    }
  }

  return [...patMap.values()];
}

// ---------------------------------------------------------------------------
// Network anchors (always-protected stops)
// ---------------------------------------------------------------------------

async function buildNetworkAnchors(db: any): Promise<Set<string>> {
  const anchors = new Set<string>();

  // Rail/SFM interchange stops (stop_type column is optional in GTFS)
  try {
    const railRows = db
      .prepare(
        `SELECT stop_id FROM stops
         WHERE stop_name LIKE 'SFM%'
            OR LOWER(stop_name) LIKE '%stazione%'
            OR stop_type = 1`,
      )
      .all() as { stop_id: string }[];
    for (const r of railRows) anchors.add(r.stop_id);
  } catch {
    // stop_type column may not exist — fall back without it
    const railRows = db
      .prepare(
        `SELECT stop_id FROM stops
         WHERE stop_name LIKE 'SFM%'
            OR LOWER(stop_name) LIKE '%stazione%'`,
      )
      .all() as { stop_id: string }[];
    for (const r of railRows) anchors.add(r.stop_id);
  }

  // Route terminals: for each route, find the longest trip and protect its first/last stop.
  // Strategy: count stops per trip grouped by route, pick the trip with the most stops.
  const tripCountRows = db
    .prepare(
      `SELECT t.trip_id, t.route_id, COUNT(*) AS stop_count
       FROM trips t
       JOIN stop_times st ON st.trip_id = t.trip_id
       GROUP BY t.trip_id, t.route_id`,
    )
    .all() as { trip_id: string; route_id: string; stop_count: number }[];

  // Group by route_id → pick trip with max stop_count
  const longestTripPerRoute = new Map<string, string>();
  for (const row of tripCountRows) {
    const existing = longestTripPerRoute.get(row.route_id);
    if (!existing) {
      longestTripPerRoute.set(row.route_id, row.trip_id);
    } else {
      const exCount =
        tripCountRows.find((r) => r.trip_id === existing)?.stop_count ?? 0;
      if (row.stop_count > exCount) {
        longestTripPerRoute.set(row.route_id, row.trip_id);
      }
    }
  }

  const terminalStmt = db.prepare(
    `SELECT stop_id FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence`,
  );

  for (const tripId of longestTripPerRoute.values()) {
    const stopsForTrip = terminalStmt.all(tripId) as { stop_id: string }[];
    if (stopsForTrip.length > 0) {
      anchors.add(stopsForTrip[0].stop_id);
      anchors.add(stopsForTrip[stopsForTrip.length - 1].stop_id);
    }
  }

  return anchors;
}

// ---------------------------------------------------------------------------
// POI loading
// ---------------------------------------------------------------------------

async function loadPoiGeoJson(
  config: Config,
  poiCategories: { category: string; radius_m: number }[],
): Promise<PoiPoint[]> {
  if (!config.diagnosticsPoiGeoJsonPath || poiCategories.length === 0) {
    return [];
  }
  try {
    const raw = await readFile(config.diagnosticsPoiGeoJsonPath, 'utf8');
    const geojson = JSON.parse(raw) as {
      features: {
        type: string;
        geometry: { type: string; coordinates: number[] };
        properties: Record<string, string>;
      }[];
    };
    const categoryField = config.diagnosticsPoiCategoryField ?? 'fclass';
    const protectedCats = new Set(poiCategories.map((c) => c.category));
    const points: PoiPoint[] = [];
    for (const feat of geojson.features ?? []) {
      if (feat.geometry?.type !== 'Point') continue;
      const cat = (feat.properties?.[categoryField] ?? '').toLowerCase();
      if (!protectedCats.has(cat)) continue;
      const [lon, lat] = feat.geometry.coordinates;
      points.push({ lat, lon, category: cat });
    }
    return points;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Protection check
// ---------------------------------------------------------------------------

function checkProtection(
  stop: StopInfo,
  anchorStopIds: Set<string>,
  poiPoints: PoiPoint[],
  poiCategories: { category: string; radius_m: number }[],
): { isProtected: boolean; reason: string } {
  // Network anchor
  if (anchorStopIds.has(stop.stop_id)) {
    return { isProtected: true, reason: 'network_anchor' };
  }

  // POI proximity
  for (const poi of poiPoints) {
    const dist = haversineDistanceMeters(
      stop.stop_lat,
      stop.stop_lon,
      poi.lat,
      poi.lon,
    );
    const cat = poiCategories.find((c) => c.category === poi.category);
    if (cat && dist <= cat.radius_m) {
      return { isProtected: true, reason: poi.category };
    }
  }

  return { isProtected: false, reason: '' };
}

// ---------------------------------------------------------------------------
// OSRM enrichment
// ---------------------------------------------------------------------------

async function enrichWithWalkDistances(
  needsOsrm: ConsolidationCandidate[],
  allCandidates: ConsolidationCandidate[],
  db: any,
  osrmUrl: string,
): Promise<void> {
  // Load lat/lon for all stop_b
  const stopIds = [...new Set(needsOsrm.map((c) => c.stop_b_id))];
  const { placeholders, values } = buildInClause(stopIds);
  const stopCoords = db
    .prepare(
      `SELECT stop_id, stop_lat, stop_lon FROM stops WHERE stop_id IN (${placeholders})`,
    )
    .all(...values) as {
    stop_id: string;
    stop_lat: number;
    stop_lon: number;
  }[];
  const coordsByStopId = new Map(stopCoords.map((s) => [s.stop_id, s]));

  // Also load stop_c lat/lon
  const cIds = [...new Set(needsOsrm.map((c) => c.stop_c_id))];
  const { placeholders: cPh, values: cVals } = buildInClause(cIds);
  const cCoords = db
    .prepare(
      `SELECT stop_id, stop_lat, stop_lon FROM stops WHERE stop_id IN (${cPh})`,
    )
    .all(...cVals) as { stop_id: string; stop_lat: number; stop_lon: number }[];
  for (const s of cCoords) coordsByStopId.set(s.stop_id, s);

  // Build pairs: walk from stop_b to stop_c (the retained stop after removal)
  const pairs = needsOsrm.map((c) => {
    const fromStop = coordsByStopId.get(c.stop_b_id);
    const toStop = coordsByStopId.get(c.stop_c_id);
    return fromStop && toStop
      ? {
          fromLat: fromStop.stop_lat,
          fromLon: fromStop.stop_lon,
          toLat: toStop.stop_lat,
          toLon: toStop.stop_lon,
        }
      : null;
  });

  const validPairs = pairs
    .map((p, i) => (p ? { idx: i, pair: p } : null))
    .filter(
      (
        x,
      ): x is {
        idx: number;
        pair: {
          fromLat: number;
          fromLon: number;
          toLat: number;
          toLon: number;
        };
      } => x !== null,
    );

  if (validPairs.length === 0) return;

  // Batch into chunks of 100; use a Map keyed by needsOsrm index
  const CHUNK = 100;
  const walkResultMap = new Map<
    number,
    { distM: number; durationS: number } | null
  >();

  for (let start = 0; start < validPairs.length; start += CHUNK) {
    const chunk = validPairs.slice(start, start + CHUNK);
    const results = await batchWalkDistances(
      chunk.map((x) => x.pair),
      osrmUrl,
    );
    for (let j = 0; j < chunk.length; j++) {
      walkResultMap.set(chunk[j].idx, results[j] ?? null);
    }
  }

  // Apply results back to candidates
  for (let i = 0; i < needsOsrm.length; i++) {
    const walkRes = walkResultMap.get(i) ?? null;
    if (walkRes) {
      const c = needsOsrm[i];
      c.walk_dist_m = Math.round(walkRes.distM);
      c.walk_time_s = Math.round(walkRes.durationS);
      c.severance = isSevered(walkRes.distM, c.geographic_dist_bc_m);
    }
  }
}

// ---------------------------------------------------------------------------
// Service weight
// ---------------------------------------------------------------------------

function computeServiceWeight(
  tripCount: number,
  peakBand: TimeBand,
  freqRowsByTrip: Map<string, any[]>,
): number {
  // log scale on daily trip count, boosted slightly for high-frequency
  const base = Math.log1p(tripCount);
  return Math.round(base * 10) / 10;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeScore(c: ConsolidationCandidate): number {
  if (c.protected || c.severance || c.classification === 'excluded') return 0;

  const spacingDeficit =
    Math.max(0, c.effective_target_spacing_m - c.corridor_dist_ab_m) +
    Math.max(0, c.effective_target_spacing_m - c.corridor_dist_bc_m);

  const accessPenalty =
    c.walk_dist_m > 0 ? c.walk_dist_m / c.effective_target_spacing_m : 0;

  const trunkBoost = c.trunk_flag ? 1.5 : 1.0;

  return (
    Math.round(
      (spacingDeficit * c.service_weight * trunkBoost - accessPenalty * 50) *
        10,
    ) / 10
  );
}

// ---------------------------------------------------------------------------
// Recommended action text
// ---------------------------------------------------------------------------

function buildRecommendedAction(c: ConsolidationCandidate): string {
  if (c.protected) return `Protected (${c.protected_reason}) — retain`;
  if (c.classification === 'excluded') return 'Excluded (detour/loop)';
  if (c.severance)
    return 'Walk path severed — do not remove without bridge/tunnel access';
  if (c.classification === 'fusion') {
    return `Fuse with adjacent stop — combine platforms at ${c.stop_c_name}`;
  }
  if (c.classification === 'removal') {
    const walkNote =
      c.walk_dist_m > 0 ? ` (${c.walk_dist_m} m walk to ${c.stop_c_name})` : '';
    return `Consider removing${walkNote}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// GeoJSON builder
// ---------------------------------------------------------------------------

function buildGeoJSON(
  candidates: ConsolidationCandidate[],
  db: any,
): object | undefined {
  if (candidates.length === 0) return undefined;

  // Load all unique stop coordinates needed
  const allStopIds = [
    ...new Set(
      candidates.flatMap((c) => [c.stop_a_id, c.stop_b_id, c.stop_c_id]),
    ),
  ];
  if (allStopIds.length === 0) return undefined;

  const { placeholders, values } = buildInClause(allStopIds);
  const stopCoords = db
    .prepare(
      `SELECT stop_id, stop_lat, stop_lon FROM stops WHERE stop_id IN (${placeholders})`,
    )
    .all(...values) as {
    stop_id: string;
    stop_lat: number;
    stop_lon: number;
  }[];
  const coordsMap = new Map(stopCoords.map((s) => [s.stop_id, s]));

  const features: any[] = [];

  for (const c of candidates) {
    const bStop = coordsMap.get(c.stop_b_id);
    const aStop = coordsMap.get(c.stop_a_id);
    const cStop = coordsMap.get(c.stop_c_id);
    if (!bStop || !aStop || !cStop) continue;

    // LineString A→B→C representing the consolidation corridor
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [aStop.stop_lon, aStop.stop_lat],
          [bStop.stop_lon, bStop.stop_lat],
          [cStop.stop_lon, cStop.stop_lat],
        ],
      },
      properties: {
        stop_b_id: c.stop_b_id,
        stop_b_name: c.stop_b_name,
        classification: c.classification,
        score: c.score,
        route_ids: c.route_ids,
        corridor_dist_ab_m: c.corridor_dist_ab_m,
        corridor_dist_bc_m: c.corridor_dist_bc_m,
        walk_dist_m: c.walk_dist_m,
        severance: c.severance,
        protected: c.protected,
        protected_reason: c.protected_reason,
        trunk_flag: c.trunk_flag,
        direction_id: c.direction_id,
      },
    });

    // Point for the candidate stop B
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [bStop.stop_lon, bStop.stop_lat],
      },
      properties: {
        stop_id: c.stop_b_id,
        stop_name: c.stop_b_name,
        classification: c.classification,
        score: c.score,
        protected: c.protected,
        severance: c.severance,
      },
    });
  }

  if (features.length === 0) return undefined;
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Output writer
// ---------------------------------------------------------------------------

async function writeOutputs(
  outputDir: string,
  sampleDate: string,
  result: ConsolidationResult,
): Promise<void> {
  const runAt = new Date();
  const rows = result.candidates.map((c) => ({ ...c }));

  const summaryText =
    summaryHeader('Stop Consolidation Diagnostic', sampleDate, runAt) +
    `Total directed segments analysed : ${result.totalSegments}\n` +
    `Candidates detected              : ${result.candidates.length}\n` +
    `  - Removal candidates           : ${result.candidates.filter((c) => c.classification === 'removal').length}\n` +
    `  - Fusion candidates            : ${result.candidates.filter((c) => c.classification === 'fusion').length}\n` +
    `  - Excluded (detour/protected)  : ${result.candidates.filter((c) => c.classification === 'excluded' || c.protected).length}\n` +
    `Actionable (unsevered, unprotected): ${result.flaggedCount}\n\n` +
    'Top 20 removal candidates by score:\n' +
    formatTable(
      result.candidates
        .filter(
          (c) => c.classification === 'removal' && !c.protected && !c.severance,
        )
        .slice(0, 20)
        .map((c) => ({
          stop_b: c.stop_b_name,
          route_ids: c.route_ids.slice(0, 40),
          corr_ab: c.corridor_dist_ab_m,
          corr_bc: c.corridor_dist_bc_m,
          walk_m: c.walk_dist_m,
          score: c.score,
          action: c.recommended_action.slice(0, 50),
        })),
      20,
    );

  const promises: Promise<void>[] = [
    writeStandardOutputs(
      outputDir,
      'stop_consolidation_candidates',
      rows,
      summaryText,
    ),
  ];

  if (result.geojson) {
    promises.push(
      writeGeoJSON(
        path.join(outputDir, 'stop_consolidation_candidates.geojson'),
        result.geojson,
      ),
    );
  }

  await Promise.all(promises);
}
