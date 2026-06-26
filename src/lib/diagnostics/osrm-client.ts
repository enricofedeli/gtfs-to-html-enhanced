/**
 * Minimal OSRM foot-routing HTTP client.
 *
 * Queries a locally-running OSRM server (docker-based, foot profile) for
 * pedestrian walk distances between candidate stop pairs.  All requests are
 * batched through the /table endpoint; individual /route calls are used only
 * when the table returns a null distance for a specific pair.
 *
 * Graceful degradation: if the server is unreachable the module logs a single
 * warning and returns null for every pair, so candidates are still written to
 * output but without walk_dist enrichment.
 *
 * OSRM coordinate format is longitude,latitude (not lat,lon).
 */

import process from 'node:process';

export interface WalkResult {
  distM: number;
  durationS: number;
}

export interface WalkPair {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
}

// Module-level flag so we log the OSRM-unavailable warning only once per run
let osrmWarnedOnce = false;

/**
 * Fetch walk distances for multiple stop pairs in one OSRM /table call.
 *
 * @param pairs     - Array of from/to coordinate pairs (lat/lon)
 * @param osrmUrl   - OSRM base URL, e.g. "http://localhost:5000"
 * @returns         - Parallel array of WalkResult | null (null = no route found)
 */
export async function batchWalkDistances(
  pairs: WalkPair[],
  osrmUrl: string,
): Promise<Array<WalkResult | null>> {
  if (pairs.length === 0) return [];

  // OSRM /table expects all coordinates as a flat semicolon-separated list.
  // We interleave from/to so the index maths are straightforward:
  //   coords[2i]   = from for pair i
  //   coords[2i+1] = to   for pair i
  const coordStrings = pairs.flatMap((p) => [
    `${p.fromLon},${p.fromLat}`,
    `${p.toLon},${p.toLat}`,
  ]);

  // sources = even indices (from), destinations = odd indices (to)
  const sources = pairs.map((_, i) => i * 2).join(';');
  const destinations = pairs.map((_, i) => i * 2 + 1).join(';');

  const url =
    `${osrmUrl}/table/v1/foot/${coordStrings.join(';')}` +
    `?sources=${sources}&destinations=${destinations}&annotations=distance,duration`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const json = (await resp.json()) as any;
    if (json.code !== 'Ok') throw new Error(`OSRM code: ${json.code}`);

    // /table returns distances[i][0] = distance from source i to destination i
    const results: Array<WalkResult | null> = pairs.map((_, i) => {
      const dist = json.distances?.[i]?.[0];
      const dur = json.durations?.[i]?.[0];
      if (dist == null || dur == null || dist < 0) return null;
      return { distM: dist, durationS: dur };
    });

    // For any null from /table, try a direct /route call as fallback
    const fallbackIdxs = results
      .map((r, i) => (r === null ? i : -1))
      .filter((i) => i >= 0);

    await Promise.all(
      fallbackIdxs.map(async (i) => {
        const p = pairs[i];
        results[i] = await singleRoute(p, osrmUrl);
      }),
    );

    return results;
  } catch (err: any) {
    if (!osrmWarnedOnce) {
      osrmWarnedOnce = true;
      process.stderr.write(
        `[stop-consolidation] OSRM unavailable at ${osrmUrl}: ${err.message}\n` +
          `Walk distances will be omitted (walk_dist_m = -1).\n` +
          `To enable: set diagnosticsOsrmFootUrl and run the OSRM Docker server.\n`,
      );
    }
    return pairs.map(() => null);
  }
}

async function singleRoute(
  pair: WalkPair,
  osrmUrl: string,
): Promise<WalkResult | null> {
  const coordStr = `${pair.fromLon},${pair.fromLat};${pair.toLon},${pair.toLat}`;
  const url =
    `${osrmUrl}/route/v1/foot/${coordStr}` +
    `?overview=false&annotations=distance,duration`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return null;
    const json = (await resp.json()) as any;
    if (json.code !== 'Ok' || !json.routes?.length) return null;
    const route = json.routes[0];
    return { distM: route.distance, durationS: route.duration };
  } catch {
    return null;
  }
}

/**
 * Determine if a stop pair is severed by an urban barrier (rail trench, ring road,
 * river, etc.) based on comparing walk distance to geographic straight-line distance.
 */
export function isSevered(walkDistM: number, geoDistM: number): boolean {
  if (geoDistM <= 0) return false;
  return walkDistM > 400 || walkDistM / geoDistM > 2.5;
}

/** Reset the warned flag (useful in tests) */
export function resetOsrmWarnFlag(): void {
  osrmWarnedOnce = false;
}
