/**
 * Diagnostic 2: Branch dilution
 *
 * Exposes routes whose trips diverge into distinct branches, silently halving
 * or quartering the frequency that riders experience on each branch.
 *
 * Key concepts:
 *   - "Trunk" = the maximal sequence of stops shared by ≥50% of a route's trips
 *     for a given direction_id.  Defined as the longest common prefix across all
 *     trip stop-sequences (most bus branch points are at the end of routes).
 *   - "Branch" = a distinct tail sequence that appears on only a subset of trips.
 *   - "Dilution ratio" = trunk_tph / worst_branch_tph. A ratio of 2 means branch
 *     service is half the trunk frequency.
 *
 * Limitation: the current trunk-detection algorithm uses longest common PREFIX,
 * which finds branches that diverge at the end (the common case for radial routes
 * in Italian networks).  Routes that also vary at the beginning (e.g. extensions
 * at both ends) will have their trunk under-detected; this is flagged in the output.
 *
 * Methodology note:
 *   Trip counts use departure_time_seconds (GENERATED column) for time-band
 *   filtering.  Direction_id is always respected; the two directions of a route
 *   are analysed independently.
 */

import type { Config } from '../../types/index.js';
import type { TimeBand, ZoneFilter } from './db-utils.js';
import {
  loadFrequencyRowsByTrip,
  getFrequencyMultiplier,
  buildInClause,
  secsToTime,
} from './db-utils.js';
import {
  writeStandardOutputs,
  formatTable,
  summaryHeader,
} from './output-utils.js';

export interface BranchDilutionResult {
  route_id: string;
  route_short_name: string;
  direction_id: number;
  time_band: string;
  trunk_stop_count: number;
  branch_count: number;
  trunk_tph: number;
  min_branch_tph: number;
  max_branch_tph: number;
  dilution_ratio: number; // trunk_tph / min_branch_tph; ∞ → 9999 for display
  branch_endpoint_names: string; // pipe-separated last-stop names per branch
  flagged: boolean; // true when dilution_ratio > threshold (default 1.5)
  note: string; // e.g. "prefix-only detection; may miss start-of-route branches"
}

interface TripStopRow {
  trip_id: string;
  route_id: string;
  route_short_name: string;
  direction_id: number;
  stop_id: string;
  stop_sequence: number;
  departure_time_seconds: number;
}

/**
 * Find the longest common prefix shared by all sequences in `sequences`.
 * Returns the prefix as an array of stop_id strings.
 */
function longestCommonPrefix(sequences: string[][]): string[] {
  if (sequences.length === 0) return [];
  const minLen = Math.min(...sequences.map((s) => s.length));
  const trunk: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const stopId = sequences[0][i];
    if (sequences.every((s) => s[i] === stopId)) {
      trunk.push(stopId);
    } else {
      break;
    }
  }
  return trunk;
}

/**
 * Given a list of trip stop-sequences (each is [stop_id, ...]) and a trunk prefix,
 * group trips by their distinct "branch tail" (the portion after the trunk).
 * Returns a map from branch-key → list of trip_ids on that branch.
 */
function classifyBranches(
  tripSequences: Map<string, string[]>,
  trunk: string[],
): Map<string, string[]> {
  const branches = new Map<string, string[]>();
  for (const [tripId, seq] of tripSequences) {
    const tail = seq.slice(trunk.length);
    const key = tail.join('→') || '(trunk only)';
    if (!branches.has(key)) branches.set(key, []);
    branches.get(key)!.push(tripId);
  }
  return branches;
}

/**
 * Run the branch dilution diagnostic.
 */
export async function runBranchDilutionDiagnostic(
  db: any,
  config: Config,
  outputDir: string,
  sampleDate: string,
  serviceIds: Set<string>,
  timeBands: TimeBand[],
  zone: ZoneFilter,
): Promise<BranchDilutionResult[]> {
  const dilutionThreshold =
    config.diagnosticsBranchDilutionRatioThreshold ?? 1.5;
  const minTrunkTph = config.diagnosticsBranchDilutionMinTrunkTph ?? 1.0;

  if (serviceIds.size === 0) {
    await writeStandardOutputs(
      outputDir,
      'branch_dilution',
      [],
      `Branch dilution: no active service_ids for ${sampleDate}.\n`,
    );
    return [];
  }

  const freqRows = loadFrequencyRowsByTrip(db);
  const isFrequencyBased = freqRows.size > 0;

  // -------------------------------------------------------------------------
  // Query all stop_times for active trips in zone
  // -------------------------------------------------------------------------
  const { placeholders: svcPlaceholders, values: svcValues } = buildInClause([
    ...serviceIds,
  ]);

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
    -- All stop_times for active trips, including route and direction information.
    -- Ordered by trip_id then stop_sequence so grouping preserves sequence order.
    SELECT
      st.trip_id,
      t.route_id,
      COALESCE(r.route_short_name, r.route_long_name, t.route_id) AS route_short_name,
      COALESCE(t.direction_id, 0)                                  AS direction_id,
      st.stop_id,
      st.stop_sequence,
      CAST(st.departure_time_seconds AS INTEGER) AS departure_time_seconds
    FROM stop_times st
    JOIN trips  t ON t.trip_id  = st.trip_id
    JOIN routes r ON r.route_id = t.route_id
    WHERE t.service_id IN (${svcPlaceholders})
      ${routeFilter}
    ORDER BY st.trip_id, st.stop_sequence
  `,
    )
    .all(...svcValues, ...extraValues) as TripStopRow[];

  if (rawRows.length === 0) {
    await writeStandardOutputs(
      outputDir,
      'branch_dilution',
      [],
      `Branch dilution: no stop_times found for active service on ${sampleDate}.\n`,
    );
    return [];
  }

  // -------------------------------------------------------------------------
  // Load stop names for display
  // -------------------------------------------------------------------------
  const allStopIds = new Set<string>(rawRows.map((r) => r.stop_id));
  const stopNames = new Map<string, string>();
  if (allStopIds.size > 0) {
    const { placeholders, values } = buildInClause([...allStopIds]);
    const stops = db
      .prepare(
        `SELECT stop_id, stop_name FROM stops WHERE stop_id IN (${placeholders})`,
      )
      .all(...values) as { stop_id: string; stop_name: string }[];
    for (const s of stops) stopNames.set(s.stop_id, s.stop_name);
  }

  // -------------------------------------------------------------------------
  // Group rows by (route_id, direction_id), then by trip_id
  // -------------------------------------------------------------------------
  const routeDirGroups = new Map<
    string, // "route_id|direction_id"
    {
      routeId: string;
      routeShortName: string;
      directionId: number;
      tripRows: Map<string, { stopId: string; seq: number; depSec: number }[]>;
    }
  >();

  for (const row of rawRows) {
    const key = `${row.route_id}|${row.direction_id}`;
    if (!routeDirGroups.has(key)) {
      routeDirGroups.set(key, {
        routeId: row.route_id,
        routeShortName: row.route_short_name,
        directionId: row.direction_id,
        tripRows: new Map(),
      });
    }
    const group = routeDirGroups.get(key)!;
    if (!group.tripRows.has(row.trip_id)) group.tripRows.set(row.trip_id, []);
    group.tripRows.get(row.trip_id)!.push({
      stopId: row.stop_id,
      seq: row.stop_sequence,
      depSec: row.departure_time_seconds,
    });
  }

  // -------------------------------------------------------------------------
  // For each route+direction: detect trunk + branches, then compute tph
  // -------------------------------------------------------------------------
  const results: BranchDilutionResult[] = [];

  for (const [, group] of routeDirGroups) {
    // Sort each trip's stops by stop_sequence
    for (const stops of group.tripRows.values()) {
      stops.sort((a, b) => a.seq - b.seq);
    }

    // Build stop-id-only sequences for trunk detection
    const tripSequences = new Map<string, string[]>();
    for (const [tripId, stops] of group.tripRows) {
      tripSequences.set(
        tripId,
        stops.map((s) => s.stopId),
      );
    }

    const allSequences = [...tripSequences.values()];
    const trunk = longestCommonPrefix(allSequences);
    const trunkLength = trunk.length;

    // Check whether sequences also differ at the beginning
    // (rough heuristic: if the shortest sequence is > 2 stops shorter than the
    //  longest, and the common prefix is 100% of the shortest, there may be a
    //  start-of-route variation we're missing)
    const lengths = allSequences.map((s) => s.length);
    const hasPossibleStartBranch =
      allSequences.length > 1 &&
      Math.max(...lengths) - Math.min(...lengths) > 2 &&
      trunk.length === Math.min(...lengths);

    const branches = classifyBranches(tripSequences, trunk);
    const branchCount = branches.size;

    // If there's only one "branch" (= all trips follow the same path), skip —
    // no dilution to report.
    if (branchCount <= 1) continue;

    // Get the last stop of each branch for display
    const branchEndpoints: string[] = [];
    for (const [branchKey, tripIds] of branches) {
      if (branchKey === '(trunk only)') {
        branchEndpoints.push('(terminates at trunk end)');
      } else {
        // Last stop_id in the branch tail
        const lastStopId = branchKey.split('→').at(-1) ?? '';
        branchEndpoints.push(stopNames.get(lastStopId) ?? lastStopId);
      }
    }

    // For each time band, compute trunk tph and per-branch tph
    for (const band of timeBands) {
      const bandDurationHours = (band.endSec - band.startSec) / 3600;

      // Trunk departures: trips whose first trunk stop departs in the band
      let trunkTripCount = 0;
      const branchTripCounts = new Map<string, number>();

      for (const [branchKey, tripIds] of branches) {
        branchTripCounts.set(branchKey, 0);

        for (const tripId of tripIds) {
          const stops = group.tripRows.get(tripId)!;
          // First stop departure defines the trip's time slot
          const firstDepSec = stops[0]?.depSec ?? -1;
          if (firstDepSec < band.startSec || firstDepSec >= band.endSec)
            continue;

          const multiplier = isFrequencyBased
            ? getFrequencyMultiplier(
                tripId,
                band.startSec,
                band.endSec,
                freqRows,
              )
            : 1;

          trunkTripCount += multiplier;
          branchTripCounts.set(
            branchKey,
            (branchTripCounts.get(branchKey) ?? 0) + multiplier,
          );
        }
      }

      if (trunkTripCount === 0) continue; // no service in this band

      const trunkTph = trunkTripCount / bandDurationHours;
      const branchTphs = [...branchTripCounts.values()].map(
        (c) => c / bandDurationHours,
      );
      const minBranchTph = Math.min(...branchTphs);
      const maxBranchTph = Math.max(...branchTphs);
      const dilutionRatio = minBranchTph > 0 ? trunkTph / minBranchTph : 9999;
      // Only flag when the trunk itself is meaningful (>=1 tph = at least every hour).
      // Low-frequency rural routes with 0.3 tph trunk are not "diluted" — they just
      // have sparse service overall.  The 9999 sentinel still correctly captures
      // "trunk runs, some branch doesn't" when trunk >= 1 tph.
      const flagged =
        trunkTph >= minTrunkTph && dilutionRatio > dilutionThreshold;

      results.push({
        route_id: group.routeId,
        route_short_name: group.routeShortName,
        direction_id: group.directionId,
        time_band: band.label,
        trunk_stop_count: trunkLength,
        branch_count: branchCount,
        trunk_tph: Math.round(trunkTph * 10) / 10,
        min_branch_tph: Math.round(minBranchTph * 10) / 10,
        max_branch_tph: Math.round(maxBranchTph * 10) / 10,
        dilution_ratio:
          dilutionRatio === 9999 ? 9999 : Math.round(dilutionRatio * 10) / 10,
        branch_endpoint_names: branchEndpoints.join(' | '),
        flagged,
        note: hasPossibleStartBranch
          ? 'prefix-only trunk detection; start-of-route variation possible'
          : '',
      });
    }
  }

  // Sort: flagged first, then by dilution_ratio descending
  results.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return b.dilution_ratio - a.dilution_ratio;
  });

  // -------------------------------------------------------------------------
  // Write outputs
  // -------------------------------------------------------------------------
  const flagged = results.filter((r) => r.flagged);
  const summaryRows = flagged.slice(0, 20).map((r) => ({
    Route: r.route_short_name,
    Dir: r.direction_id,
    Band: r.time_band,
    'Trunk tph': r.trunk_tph,
    'Min branch tph': r.min_branch_tph,
    Dilution: r.dilution_ratio,
    Branches: r.branch_endpoint_names.slice(0, 50),
  }));

  const summaryText = [
    summaryHeader('Diagnostic 2: Branch Dilution', sampleDate, new Date()),
    `Dilution threshold     : ratio > ${dilutionThreshold} (trunk frequency / worst branch frequency)`,
    `Frequency-based routes : ${isFrequencyBased ? 'YES' : 'NO'}`,
    `Route+direction combos : ${routeDirGroups.size}`,
    `Combos with branches   : ${results.length > 0 ? new Set(results.map((r) => `${r.route_id}|${r.direction_id}`)).size : 0}`,
    `Flagged (diluted)      : ${flagged.length} (route+direction+band combinations)`,
    '',
    'Top 20 flagged cases (worst dilution ratio):',
    '',
    formatTable(summaryRows, 20),
    '',
    `Full results written to: branch_dilution.csv  branch_dilution.json`,
  ].join('\n');

  await writeStandardOutputs(
    outputDir,
    'branch_dilution',
    results,
    summaryText,
  );
  return results;
}
