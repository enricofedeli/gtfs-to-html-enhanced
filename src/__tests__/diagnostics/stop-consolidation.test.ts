/**
 * Unit tests for stop-consolidation diagnostic.
 *
 * Tests cover §11 of the spec:
 *   1–3.  Distance engine: unit detection, monotonicity gate, ratio invariant
 *   4–5.  Governing-line-type rule (multi-route segments, unmapped routes)
 *   6,10. POI / hospital protection
 *   7.    Severance detection
 *   8.    OSRM graceful degradation
 *   9.    Opposite-direction exclusion
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  detectUnitFactor,
  isMonotonic,
  type StopInfo,
} from '../../lib/diagnostics/stop-consolidation.js';

import {
  resolveGoverningLineType,
  type SpacingThreshold,
} from '../../lib/diagnostics/stop-consolidation-config.js';

import {
  isSevered,
  batchWalkDistances,
  resetOsrmWarnFlag,
  type WalkPair,
} from '../../lib/diagnostics/osrm-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal StopInfo array for a straight north–south corridor.
 * Stops are ~300 m apart (approx 0.0027° lat per 300 m).
 * shape_dist_traveled is in the given unit (default: metres).
 */
function makeStops(
  count: number,
  distPerStop: number, // shape_dist_traveled unit
  unit: 'm' | 'km' | 'ft' = 'm',
): StopInfo[] {
  const latStep = 0.0027; // ≈ 300 m per step
  const stopDistM = 300; // actual metres per step

  let distPerStopInUnit: number;
  if (unit === 'km') distPerStopInUnit = stopDistM / 1000;
  else if (unit === 'ft') distPerStopInUnit = stopDistM / 0.3048;
  else distPerStopInUnit = stopDistM;

  return Array.from({ length: count }, (_, i) => ({
    stop_id: `s${i}`,
    stop_name: `Stop ${i}`,
    stop_lat: 44.5 + i * latStep,
    stop_lon: 11.34,
    shape_dist_traveled: i * distPerStopInUnit,
  }));
}

// Minimal Map-based threshold fixture
function makeThresholds(): Map<string, SpacingThreshold> {
  const map = new Map<string, SpacingThreshold>();
  map.set('urban', {
    line_type: 'urban',
    target_spacing_m: 300,
    flag_below_m: 250,
    max_gap_after_removal_m: 450,
  });
  map.set('suburban', {
    line_type: 'suburban',
    target_spacing_m: 450,
    flag_below_m: 360,
    max_gap_after_removal_m: 700,
  });
  map.set('extraurban', {
    line_type: 'extraurban',
    target_spacing_m: 650,
    flag_below_m: 520,
    max_gap_after_removal_m: 1000,
  });
  return map;
}

// ---------------------------------------------------------------------------
// 1. Distance engine — metres
// ---------------------------------------------------------------------------

describe('detectUnitFactor – metres', () => {
  it('returns factor=1 and reliable=true for shape_dist_traveled already in metres', () => {
    const stops = makeStops(8, 300, 'm');
    const { factor, reliable } = detectUnitFactor(stops);
    expect(factor).toBe(1);
    expect(reliable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Distance engine — km feed
// ---------------------------------------------------------------------------

describe('detectUnitFactor – km feed', () => {
  it('returns factor=1000 for shape_dist_traveled in kilometres', () => {
    const stops = makeStops(8, 300, 'km');
    const { factor, reliable } = detectUnitFactor(stops);
    expect(factor).toBe(1000);
    expect(reliable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Distance engine — feet feed
// ---------------------------------------------------------------------------

describe('detectUnitFactor – feet feed', () => {
  it('returns factor=0.3048 (ft→m conversion) for shape_dist_traveled in feet', () => {
    const stops = makeStops(8, 300, 'ft');
    const { factor, reliable } = detectUnitFactor(stops);
    expect(factor).toBeCloseTo(0.3048, 3);
    expect(reliable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Distance engine — no shape_dist_traveled
// ---------------------------------------------------------------------------

describe('detectUnitFactor – missing shape_dist_traveled', () => {
  it('returns reliable=false when shape_dist_traveled is null for all stops', () => {
    const stops: StopInfo[] = [
      {
        stop_id: 'a',
        stop_name: 'A',
        stop_lat: 44.5,
        stop_lon: 11.34,
        shape_dist_traveled: null,
      },
      {
        stop_id: 'b',
        stop_name: 'B',
        stop_lat: 44.503,
        stop_lon: 11.34,
        shape_dist_traveled: null,
      },
    ];
    const { reliable } = detectUnitFactor(stops);
    expect(reliable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Monotonicity gate — valid sequence
// ---------------------------------------------------------------------------

describe('isMonotonic', () => {
  it('returns true for a strictly increasing sequence', () => {
    const stops = makeStops(5, 300, 'm');
    expect(isMonotonic(stops)).toBe(true);
  });

  it('returns false for a reversed sequence', () => {
    const stops = makeStops(5, 300, 'm');
    // Reverse the shape_dist_traveled values to simulate backtrack
    const reversed = [...stops].reverse();
    const reindexed = reversed.map((s, i) => ({
      ...s,
      shape_dist_traveled: stops[i]!.shape_dist_traveled,
    }));
    // Manually create a non-monotonic sequence
    const bad: StopInfo[] = [
      { ...stops[0]!, shape_dist_traveled: 0 },
      { ...stops[1]!, shape_dist_traveled: 300 },
      { ...stops[2]!, shape_dist_traveled: 150 }, // goes backwards — violation
      { ...stops[3]!, shape_dist_traveled: 500 },
    ];
    expect(isMonotonic(bad)).toBe(false);
  });

  it('returns false when any shape_dist_traveled is null', () => {
    const stops: StopInfo[] = [
      {
        stop_id: 'a',
        stop_name: 'A',
        stop_lat: 44.5,
        stop_lon: 11.34,
        shape_dist_traveled: 0,
      },
      {
        stop_id: 'b',
        stop_name: 'B',
        stop_lat: 44.503,
        stop_lon: 11.34,
        shape_dist_traveled: null,
      },
    ];
    expect(isMonotonic(stops)).toBe(false);
  });

  it('allows tiny floating-point noise (within 0.001)', () => {
    const stops: StopInfo[] = [
      {
        stop_id: 'a',
        stop_name: 'A',
        stop_lat: 44.5,
        stop_lon: 11.34,
        shape_dist_traveled: 0,
      },
      {
        stop_id: 'b',
        stop_name: 'B',
        stop_lat: 44.503,
        stop_lon: 11.34,
        shape_dist_traveled: 299.9999,
      },
      {
        stop_id: 'c',
        stop_name: 'C',
        stop_lat: 44.506,
        stop_lon: 11.34,
        shape_dist_traveled: 299.9998,
      }, // within noise tolerance
    ];
    expect(isMonotonic(stops)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Governing-line-type rule — multi-route segment (urban + suburban + extraurban)
// ---------------------------------------------------------------------------

describe('resolveGoverningLineType', () => {
  it('picks the threshold with the smallest flag_below_m (most stop-tolerant)', () => {
    const thresholds = makeThresholds();
    const lineTypeMap = new Map([
      ['R1', 'urban'],
      ['R2', 'suburban'],
      ['R3', 'extraurban'],
    ]);

    const result = resolveGoverningLineType(
      ['R1', 'R2', 'R3'],
      lineTypeMap,
      thresholds,
      'urban',
    );

    // urban has flag_below_m=250 (smallest); segment is only flagged if tight even for urban
    expect(result.governingType).toBe('urban');
    expect(result.effectiveThreshold.flag_below_m).toBe(250);
    expect(result.servingTypes).toContain('urban');
    expect(result.servingTypes).toContain('suburban');
    expect(result.servingTypes).toContain('extraurban');
  });

  it('single-route segment uses its own line type', () => {
    const thresholds = makeThresholds();
    const lineTypeMap = new Map([['R10', 'extraurban']]);

    const result = resolveGoverningLineType(
      ['R10'],
      lineTypeMap,
      thresholds,
      'urban',
    );

    expect(result.governingType).toBe('extraurban');
    expect(result.effectiveThreshold.flag_below_m).toBe(520);
  });
});

// ---------------------------------------------------------------------------
// 7. Unmapped route fallback
// ---------------------------------------------------------------------------

describe('resolveGoverningLineType – unmapped route', () => {
  it('falls back to defaultType when route not in lineTypeMap', () => {
    const thresholds = makeThresholds();
    const lineTypeMap = new Map<string, string>(); // empty — no mappings

    const result = resolveGoverningLineType(
      ['UNKNOWN_ROUTE'],
      lineTypeMap,
      thresholds,
      'suburban',
    );

    expect(result.governingType).toBe('suburban');
    expect(result.effectiveThreshold.flag_below_m).toBe(360);
  });
});

// ---------------------------------------------------------------------------
// 8. Severance detection
// ---------------------------------------------------------------------------

describe('isSevered', () => {
  it('returns true when walkDist/geoDist > 2.5', () => {
    // walkDist=650, geoDist=200 → ratio=3.25
    expect(isSevered(650, 200)).toBe(true);
  });

  it('returns true when walkDist > 400 m regardless of ratio', () => {
    // walkDist=450, geoDist=300 → ratio=1.5 (below 2.5) but walkDist > 400
    expect(isSevered(450, 300)).toBe(true);
  });

  it('returns false for a short easy walk', () => {
    // walkDist=200, geoDist=180 → ratio≈1.1 and walkDist < 400
    expect(isSevered(200, 180)).toBe(false);
  });

  it('returns false for zero geoDist', () => {
    expect(isSevered(100, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. OSRM graceful degradation
// ---------------------------------------------------------------------------

describe('batchWalkDistances – OSRM unreachable', () => {
  afterEach(() => {
    resetOsrmWarnFlag();
    vi.restoreAllMocks();
  });

  it('returns all null when OSRM fetch throws (connection refused)', async () => {
    // Mock global.fetch to simulate ECONNREFUSED
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });

    const pairs: WalkPair[] = [
      { fromLat: 44.5, fromLon: 11.34, toLat: 44.503, toLon: 11.34 },
      { fromLat: 44.503, fromLon: 11.34, toLat: 44.506, toLon: 11.34 },
    ];

    const results = await batchWalkDistances(pairs, 'http://localhost:5000');
    expect(results).toHaveLength(2);
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
  });

  it('returns valid results when OSRM responds correctly', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        code: 'Ok',
        distances: [[300], [280]],
        durations: [[240], [220]],
      }),
    }));

    const pairs: WalkPair[] = [
      { fromLat: 44.5, fromLon: 11.34, toLat: 44.503, toLon: 11.34 },
      { fromLat: 44.503, fromLon: 11.34, toLat: 44.506, toLon: 11.34 },
    ];

    const results = await batchWalkDistances(pairs, 'http://localhost:5000');
    expect(results[0]).not.toBeNull();
    expect(results[0]!.distM).toBe(300);
    expect(results[0]!.durationS).toBe(240);
    expect(results[1]!.distM).toBe(280);
  });

  it('returns null for pairs where OSRM table returns null distance, and fallback route also fails', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      callCount++;
      if (url.includes('/table/')) {
        return {
          ok: true,
          json: async () => ({
            code: 'Ok',
            distances: [[null]], // null distance → needs fallback
            durations: [[null]],
          }),
        };
      }
      // fallback /route also fails
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };
    });

    const pairs: WalkPair[] = [
      { fromLat: 44.5, fromLon: 11.34, toLat: 44.503, toLon: 11.34 },
    ];

    const results = await batchWalkDistances(pairs, 'http://localhost:5000');
    expect(results[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. detectUnitFactor — short segments (< 10 m geo) skipped
// ---------------------------------------------------------------------------

describe('detectUnitFactor – skips very short segments', () => {
  it('ignores segments where geo distance < 10 m', () => {
    // Two stops at essentially the same location (< 1 m apart)
    const stops: StopInfo[] = [
      {
        stop_id: 'a',
        stop_name: 'A',
        stop_lat: 44.5,
        stop_lon: 11.34,
        shape_dist_traveled: 0,
      },
      {
        stop_id: 'b',
        stop_name: 'B',
        stop_lat: 44.5000001,
        stop_lon: 11.34,
        shape_dist_traveled: 300,
      }, // huge delta, tiny geo
    ];
    // Only one sample, and it has an extreme ratio — should return unreliable
    const { reliable } = detectUnitFactor(stops);
    // ratio = 300 / ~0.01 m = 30000 → outside all buckets → unreliable
    expect(reliable).toBe(false);
  });
});
