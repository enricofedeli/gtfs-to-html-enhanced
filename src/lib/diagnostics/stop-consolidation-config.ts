/**
 * Config loaders for the stop-consolidation diagnostic.
 *
 * All thresholds and type mappings live in three CSV files under config/:
 *   config/line_types.csv           — route_id → line_type
 *   config/spacing_thresholds.csv  — per-type target/flag/max-gap distances
 *   config/protected_poi_categories.csv — categories that shield stops from removal
 *
 * No values are hardcoded here: all defaults below are fallbacks used only when the
 * CSV file is absent or a given entry is missing.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import type { Config } from '../../types/index.js';

export interface SpacingThreshold {
  line_type: string;
  target_spacing_m: number;
  flag_below_m: number;
  max_gap_after_removal_m: number;
}

export interface PoiCategory {
  category: string;
  radius_m: number;
}

// Embedded fallbacks — used only when config/spacing_thresholds.csv is absent
const FALLBACK_THRESHOLDS: SpacingThreshold[] = [
  {
    line_type: 'urban',
    target_spacing_m: 300,
    flag_below_m: 250,
    max_gap_after_removal_m: 450,
  },
  {
    line_type: 'suburban',
    target_spacing_m: 450,
    flag_below_m: 360,
    max_gap_after_removal_m: 700,
  },
  {
    line_type: 'extraurban',
    target_spacing_m: 650,
    flag_below_m: 520,
    max_gap_after_removal_m: 1000,
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? '';
    });
    return row;
  });
}

async function tryReadCsv(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function resolveConfigPath(
  fromConfig: string | undefined,
  defaultRelative: string,
): string {
  return fromConfig ?? path.join(process.cwd(), defaultRelative);
}

// ---------------------------------------------------------------------------
// Public loaders
// ---------------------------------------------------------------------------

/**
 * Load route_id → line_type mapping from config/line_types.csv.
 * Returns an empty Map (routes fall back to default_line_type) if the file is absent.
 */
export async function loadLineTypes(
  config: Config,
): Promise<Map<string, string>> {
  const filePath = resolveConfigPath(
    config.diagnosticsLineTypesPath,
    'config/line_types.csv',
  );
  const text = await tryReadCsv(filePath);
  const map = new Map<string, string>();
  if (!text) return map;

  for (const row of parseCsvRows(text)) {
    if (row.route_id && row.line_type) {
      map.set(row.route_id, row.line_type.toLowerCase().trim());
    }
  }
  return map;
}

/**
 * Load spacing thresholds from config/spacing_thresholds.csv.
 * Falls back to embedded defaults if the file is absent.
 */
export async function loadSpacingThresholds(
  config: Config,
): Promise<Map<string, SpacingThreshold>> {
  const filePath = resolveConfigPath(
    config.diagnosticsSpacingThresholdsPath,
    'config/spacing_thresholds.csv',
  );
  const text = await tryReadCsv(filePath);
  const map = new Map<string, SpacingThreshold>();

  // Seed with embedded fallbacks first so at minimum the three defaults exist
  for (const t of FALLBACK_THRESHOLDS) map.set(t.line_type, { ...t });

  if (text) {
    for (const row of parseCsvRows(text)) {
      if (!row.line_type) continue;
      const lt = row.line_type.toLowerCase().trim();
      map.set(lt, {
        line_type: lt,
        target_spacing_m: Number(row.target_spacing_m) || 300,
        flag_below_m: Number(row.flag_below_m) || 250,
        max_gap_after_removal_m: Number(row.max_gap_after_removal_m) || 450,
      });
    }
  }
  return map;
}

/**
 * Load POI categories that should shield stops from removal.
 * Returns an empty array if the file is absent (no POI protection applied).
 */
export async function loadProtectedPoiCategories(
  config: Config,
): Promise<PoiCategory[]> {
  const filePath = resolveConfigPath(
    config.diagnosticsProtectedPoiCategoriesPath,
    'config/protected_poi_categories.csv',
  );
  const text = await tryReadCsv(filePath);
  if (!text) return [];

  return parseCsvRows(text)
    .filter((row) => row.protect?.toLowerCase() === 'yes' && row.category)
    .map((row) => ({
      category: row.category.toLowerCase().trim(),
      radius_m: Number(row.radius_m) || 100,
    }));
}

// ---------------------------------------------------------------------------
// Governing-line-type rule
// ---------------------------------------------------------------------------

/**
 * For a segment served by multiple routes of different line types, the effective
 * threshold is the one with the smallest flag_below_m (most stop-tolerant).
 *
 * A segment is only flagged if it's too tight even for the most permissive line
 * type using it. This prevents conservative urban thresholds from causing false
 * flags on corridors that are primarily an extraurban service.
 */
export function resolveGoverningLineType(
  routeIds: string[],
  lineTypeMap: Map<string, string>,
  thresholds: Map<string, SpacingThreshold>,
  defaultType: string,
): {
  governingType: string;
  effectiveThreshold: SpacingThreshold;
  servingTypes: string[];
} {
  const servingTypes = [
    ...new Set(routeIds.map((id) => lineTypeMap.get(id) ?? defaultType)),
  ];

  // Pick the threshold with the smallest flag_below_m
  let best: SpacingThreshold | undefined;
  let bestType = defaultType;

  for (const lt of servingTypes) {
    const t = thresholds.get(lt) ?? thresholds.get(defaultType);
    if (!t) continue;
    if (best === undefined || t.flag_below_m < best.flag_below_m) {
      best = t;
      bestType = lt;
    }
  }

  const fallback = thresholds.get(defaultType) ?? FALLBACK_THRESHOLDS[0];
  return {
    governingType: bestType,
    effectiveThreshold: best ?? fallback,
    servingTypes,
  };
}
