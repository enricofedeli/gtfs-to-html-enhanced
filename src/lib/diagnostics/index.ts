/**
 * Diagnostics module entry point.
 *
 * runDiagnostics() is the single public function.  It:
 *   1. Validates that diagnosticsSampleDate is set in config.
 *   2. Resolves active service_ids for that date against the currently-open DB.
 *   3. Runs each enabled diagnostic sequentially, writing CSV/JSON/summary text.
 *   4. Generates a single diagnostics/index.html visual report.
 *
 * The diagnostics assume that the GTFS database has already been imported and that
 * openDb() returns the active singleton.  Run this AFTER the normal import pipeline.
 *
 * Config keys (all optional with defaults):
 *   diagnosticsSampleDate                 "YYYY-MM-DD"  REQUIRED
 *   diagnosticsOutputPath                 string        default: outputPath + "/diagnostics"
 *   diagnosticsHiddenTrunkMinTripsPerHour number        default: 6  (every 10 min)
 *   diagnosticsBranchDilutionRatioThreshold number      default: 1.5
 *   diagnosticsBranchDilutionMinTrunkTph  number        default: 1.0
 *   diagnosticsCircuityFlagThreshold      number        default: 2.0
 *   diagnosticsCircuityMinStraightLineKm  number        default: 0.2
 *   diagnosticsRailFeedSqlitePath         string        enables rail-bus matrix
 *   diagnosticsMaxTransferWaitMinutes     number        default: 20
 *   diagnosticsZone                       object        { routeIds?, stopIds?, boundingBox? }
 *   timePeriods                           TimePeriod[]  custom time bands
 */

import path from 'node:path';
import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';

import { getAgencies } from 'gtfs';

import type { Config } from '../../types/index.js';
import type { SegmentResult as HiddenTrunkResult } from './hidden-trunk.js';
import type { BranchDilutionResult } from './branch-dilution.js';
import type { SpanLegibilityResult } from './span-legibility.js';
import type { CircuityResult } from './circuity.js';
import type { ConsolidationResult } from './stop-consolidation.js';
import {
  resolveServiceIds,
  parseTimeBands,
  resolveZoneFilter,
  getDb,
  ensureTimeCols,
} from './db-utils.js';
import { makeOutputDir } from './output-utils.js';
import { renderTemplate } from '../file-utils.js';
import { runHiddenTrunkDiagnostic } from './hidden-trunk.js';
import { runBranchDilutionDiagnostic } from './branch-dilution.js';
import { runRailBusMatrix } from './rail-bus-matrix.js';
import { runSpanLegibility } from './span-legibility.js';
import { runCircuity } from './circuity.js';
import { runStopConsolidation } from './stop-consolidation.js';

/**
 * Run all enabled diagnostics for the provided config.
 *
 * @param config - full Config object; must include diagnosticsSampleDate
 * @returns path to the diagnostics output directory
 */
export async function runDiagnostics(config: Config): Promise<string> {
  const sampleDate = config.diagnosticsSampleDate;
  if (!sampleDate) {
    throw new Error(
      'runDiagnostics requires config.diagnosticsSampleDate (ISO date "YYYY-MM-DD"). ' +
        "Set it to a representative weekday within your GTFS feed's validity window.",
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(sampleDate)) {
    throw new Error(
      `config.diagnosticsSampleDate must be "YYYY-MM-DD", got: "${sampleDate}"`,
    );
  }

  const outputDir =
    config.diagnosticsOutputPath ??
    path.join(
      config.outputPath ?? path.join(process.cwd(), 'html'),
      'diagnostics',
    );

  await makeOutputDir(outputDir);

  process.stdout.write(
    `\nRunning diagnostics for ${sampleDate} → ${outputDir}\n`,
  );

  const db = getDb();
  ensureTimeCols(db);

  const serviceIds = resolveServiceIds(db, sampleDate);
  process.stdout.write(
    `Active service_ids for ${sampleDate}: ${serviceIds.size} found\n`,
  );

  if (serviceIds.size === 0) {
    process.stderr.write(
      `WARNING: No active service_ids found for ${sampleDate}.\n` +
        'Check that the feed is valid for this date (run-date must fall within ' +
        'calendar.start_date / calendar.end_date, with no exception removing all services).\n',
    );
  }

  const timeBands = parseTimeBands(config);
  process.stdout.write(
    `Time bands: ${timeBands.map((b) => b.label).join(', ')}\n`,
  );

  const zone = resolveZoneFilter(db, config);
  if (zone.routeIds !== null) {
    process.stdout.write(`Zone filter: ${zone.routeIds.length} routes\n`);
  } else {
    process.stdout.write('Zone filter: whole network (no restriction)\n');
  }

  // -------------------------------------------------------------------------
  // Diagnostic 1: Hidden trunk frequency
  // -------------------------------------------------------------------------
  process.stdout.write('\n[1/5] Hidden trunk frequency...\n');
  let hiddenTrunkResults: HiddenTrunkResult[] = [];
  try {
    hiddenTrunkResults = await runHiddenTrunkDiagnostic(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      timeBands,
      zone,
    );
    const flagged = hiddenTrunkResults.filter((r) => r.flagged).length;
    process.stdout.write(
      `     → ${hiddenTrunkResults.length} segments analysed, ${flagged} candidate trunks flagged\n`,
    );
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  // -------------------------------------------------------------------------
  // Diagnostic 2: Branch dilution
  // -------------------------------------------------------------------------
  process.stdout.write('\n[2/5] Branch dilution...\n');
  let branchDilutionResults: BranchDilutionResult[] = [];
  try {
    branchDilutionResults = await runBranchDilutionDiagnostic(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      timeBands,
      zone,
    );
    const flagged = branchDilutionResults.filter((r) => r.flagged).length;
    process.stdout.write(
      `     → ${branchDilutionResults.length} route+dir+band rows, ${flagged} dilution cases flagged\n`,
    );
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  // -------------------------------------------------------------------------
  // Diagnostic 3: Rail–bus connection matrix (only if rail DB configured)
  // -------------------------------------------------------------------------
  process.stdout.write('\n[3/5] Rail–bus connection matrix...\n');
  if (config.diagnosticsRailFeedSqlitePath) {
    try {
      const results = await runRailBusMatrix(db, config, outputDir, sampleDate);
      const noConn = results.filter((r) => r.flagged_no_connection).length;
      process.stdout.write(
        `     → ${results.length} train arrivals, ${noConn} with no bus connection\n`,
      );
    } catch (err: any) {
      process.stderr.write(`     ERROR: ${err.message}\n`);
    }
  } else {
    process.stdout.write(
      '     SKIPPED (set config.diagnosticsRailFeedSqlitePath to enable)\n',
    );
  }

  // -------------------------------------------------------------------------
  // Scaffold: Span legibility
  // -------------------------------------------------------------------------
  process.stdout.write('\n[4/5] Span legibility...\n');
  let spanResults: SpanLegibilityResult[] = [];
  try {
    spanResults = await runSpanLegibility(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      timeBands,
      zone,
    );
    process.stdout.write(`     → ${spanResults.length} route+direction rows\n`);
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  // -------------------------------------------------------------------------
  // Scaffold: Circuity
  // -------------------------------------------------------------------------
  process.stdout.write('\n[5/5] Circuity...\n');
  let circuityResults: CircuityResult[] = [];
  try {
    circuityResults = await runCircuity(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      zone,
    );
    const flagged = circuityResults.filter((r) => r.flagged).length;
    process.stdout.write(
      `     → ${circuityResults.length} routes, ${flagged} flagged\n`,
    );
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  // -------------------------------------------------------------------------
  // Diagnostic 6: Stop consolidation
  // -------------------------------------------------------------------------
  process.stdout.write('\n[6/6] Stop consolidation...\n');
  let consolidationResult: ConsolidationResult = {
    candidates: [],
    flaggedCount: 0,
    totalSegments: 0,
    uniqueRouteIds: [],
    geojson: undefined,
  };
  if (config.diagnosticsStopConsolidationEnabled !== false) {
    try {
      // Build trunk segment set for cross-link boost
      const trunkSegments = new Set<string>(
        hiddenTrunkResults
          .filter((r) => r.flagged)
          .map((r) => `${r.from_stop_id}|${r.to_stop_id}`),
      );
      consolidationResult = await runStopConsolidation(
        db,
        config,
        outputDir,
        sampleDate,
        serviceIds,
        timeBands,
        zone,
        trunkSegments,
      );
      process.stdout.write(
        `     → ${consolidationResult.candidates.length} candidates` +
          ` (${consolidationResult.flaggedCount} actionable removal)\n`,
      );
    } catch (err: any) {
      process.stderr.write(`     ERROR: ${err.message}\n`);
    }
  } else {
    process.stdout.write(
      '     SKIPPED (set diagnosticsStopConsolidationEnabled: true to enable)\n',
    );
  }

  // -------------------------------------------------------------------------
  // Generate HTML report
  // -------------------------------------------------------------------------
  process.stdout.write('\nGenerating HTML report...\n');
  try {
    const html = await generateDiagnosticsHTML({
      config,
      outputDir,
      sampleDate,
      hiddenTrunkResults,
      branchDilutionResults,
      spanResults,
      circuityResults,
      consolidationResult,
    });
    await writeFile(path.join(outputDir, 'index.html'), html);
    process.stdout.write(`     → diagnostics/index.html written\n`);
  } catch (err: any) {
    process.stderr.write(`     HTML generation ERROR: ${err.message}\n`);
  }

  process.stdout.write(`\nDiagnostics complete → ${outputDir}\n`);
  return outputDir;
}

/**
 * Generate a single-page HTML diagnostics report from collected results.
 * The page is structured as four collapsible sections (one per diagnostic)
 * with interactive route-filter checkboxes and an embedded MapLibre map
 * for the hidden trunk section.
 */
async function generateDiagnosticsHTML(opts: {
  config: Config;
  outputDir: string;
  sampleDate: string;
  hiddenTrunkResults: HiddenTrunkResult[];
  branchDilutionResults: BranchDilutionResult[];
  spanResults: SpanLegibilityResult[];
  circuityResults: CircuityResult[];
  consolidationResult: ConsolidationResult;
}): Promise<string> {
  const {
    config,
    outputDir,
    sampleDate,
    hiddenTrunkResults,
    branchDilutionResults,
    spanResults,
    circuityResults,
    consolidationResult,
  } = opts;

  // Load hidden trunk GeoJSON for the map (already written by the diagnostic)
  let hiddenTrunkGeojson: object | undefined;
  if (config.showMap) {
    try {
      const raw = await readFile(
        path.join(outputDir, 'hidden_trunk.geojson'),
        'utf8',
      );
      hiddenTrunkGeojson = JSON.parse(raw);
    } catch {
      // GeoJSON absent if 0 flagged segments — map section will be skipped
    }
  }

  const agencies = getAgencies() as { agency_name: string }[];

  // Top flagged results for each section (sorted best-first for tables)
  const topHiddenTrunk = hiddenTrunkResults
    .filter((r) => r.flagged)
    .sort((a, b) => b.combined_trips_per_hour - a.combined_trips_per_hour)
    .slice(0, 30);

  const topBranchDilution = branchDilutionResults
    .filter((r) => r.flagged)
    .sort((a, b) => b.dilution_ratio - a.dilution_ratio)
    .slice(0, 30);

  const topCircuity = circuityResults
    .filter((r) => r.flagged)
    .sort((a, b) => b.circuity_ratio - a.circuity_ratio)
    .slice(0, 30);

  // Unique route IDs per section — used to build filter checkboxes.
  // For hidden trunk: collect from contributing_route_ids field.
  const hiddenTrunkRouteIds = [
    ...new Set(
      topHiddenTrunk.flatMap((r) =>
        r.contributing_route_ids.split(' | ').filter(Boolean),
      ),
    ),
  ].sort();

  // For branch dilution: route_id per row
  const branchDilutionRouteIds = [
    ...new Set(topBranchDilution.map((r) => r.route_short_name || r.route_id)),
  ].sort();

  // For span legibility: all route short names
  const spanRouteIds = [
    ...new Set(spanResults.map((r) => r.route_short_name || r.route_id)),
  ].sort();

  // For circuity: flagged routes
  const circuityRouteIds = [
    ...new Set(topCircuity.map((r) => r.route_short_name || r.route_id)),
  ].sort();

  // assetPath must point from diagnostics/ to the parent output dir where CSS/JS live.
  // noHead must be false so renderTemplate selects diagnostics_index_full.pug.
  const diagnosticsConfig = {
    ...config,
    assetPath: config.assetPath ?? '../',
    noHead: false,
  };

  const templateVars = {
    config: diagnosticsConfig,
    title:
      config.brandingTitle ??
      `${agencies.map((a) => a.agency_name).join(' & ')} — Network Diagnostics`,
    agencies,
    sampleDate,
    hiddenTrunk: {
      results: topHiddenTrunk,
      allResults: hiddenTrunkResults,
      flaggedCount: hiddenTrunkResults.filter((r) => r.flagged).length,
      totalSegments: hiddenTrunkResults.length,
      geojson: hiddenTrunkGeojson,
      uniqueRouteIds: hiddenTrunkRouteIds,
      threshold: config.diagnosticsHiddenTrunkMinTripsPerHour ?? 6,
    },
    branchDilution: {
      results: topBranchDilution,
      flaggedCount: branchDilutionResults.filter((r) => r.flagged).length,
      totalRows: branchDilutionResults.length,
      uniqueRouteIds: branchDilutionRouteIds,
      ratioThreshold: config.diagnosticsBranchDilutionRatioThreshold ?? 1.5,
      minTrunkTph: config.diagnosticsBranchDilutionMinTrunkTph ?? 1.0,
    },
    spanLegibility: {
      results: spanResults,
      uniqueRouteIds: spanRouteIds,
    },
    circuity: {
      results: topCircuity,
      flaggedCount: circuityResults.filter((r) => r.flagged).length,
      totalRoutes: circuityResults.length,
      uniqueRouteIds: circuityRouteIds,
      threshold: config.diagnosticsCircuityFlagThreshold ?? 2.0,
    },
    stopConsolidation: {
      results: consolidationResult.candidates.slice(0, 50),
      flaggedCount: consolidationResult.flaggedCount,
      totalSegments: consolidationResult.totalSegments,
      uniqueRouteIds: consolidationResult.uniqueRouteIds,
      geojson: consolidationResult.geojson,
      enabled: config.diagnosticsStopConsolidationEnabled !== false,
    },
  };

  return renderTemplate('diagnostics_index', templateVars, diagnosticsConfig);
}

export { runHiddenTrunkDiagnostic } from './hidden-trunk.js';
export { runBranchDilutionDiagnostic } from './branch-dilution.js';
export { runRailBusMatrix } from './rail-bus-matrix.js';
export { runSpanLegibility } from './span-legibility.js';
export { runCircuity } from './circuity.js';
export { runStopConsolidation } from './stop-consolidation.js';
