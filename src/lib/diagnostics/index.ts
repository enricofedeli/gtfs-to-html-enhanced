/**
 * Diagnostics module entry point.
 *
 * runDiagnostics() is the single public function.  It:
 *   1. Validates that diagnosticsSampleDate is set in config.
 *   2. Resolves active service_ids for that date against the currently-open DB.
 *   3. Runs each enabled diagnostic sequentially, writing output to diagnosticsOutputPath.
 *   4. Prints a summary to stdout.
 *
 * The diagnostics assume that the GTFS database has already been imported and that
 * openDb() returns the active singleton.  Run this AFTER the normal import pipeline.
 *
 * Usage (config additions required):
 *   {
 *     "runDiagnostics": true,
 *     "diagnosticsSampleDate": "2024-10-15",
 *     "diagnosticsOutputPath": "html/bologna/diagnostics",
 *     "diagnosticsHiddenTrunkMinTripsPerHour": 6,
 *     "diagnosticsMaxTransferWaitMinutes": 20,
 *     "diagnosticsRailFeedSqlitePath": "/tmp/gtfs-sfm.sqlite",
 *     "diagnosticsZone": {
 *       "boundingBox": [11.2, 44.4, 11.5, 44.6]
 *     },
 *     "timePeriods": [
 *       { "label": "Early",   "start": "04:00", "end": "07:00" },
 *       { "label": "AM Peak", "start": "07:00", "end": "09:00" },
 *       { "label": "Midday",  "start": "09:00", "end": "16:00" },
 *       { "label": "PM Peak", "start": "16:00", "end": "19:00" },
 *       { "label": "Evening", "start": "19:00", "end": "24:00" }
 *     ]
 *   }
 */

import path from 'node:path';
import process from 'node:process';

import { openDb } from 'gtfs';

import type { Config } from '../../types/index.js';
import {
  resolveServiceIds,
  parseTimeBands,
  resolveZoneFilter,
  getDb,
  ensureTimeCols,
} from './db-utils.js';
import { makeOutputDir } from './output-utils.js';
import { runHiddenTrunkDiagnostic } from './hidden-trunk.js';
import { runBranchDilutionDiagnostic } from './branch-dilution.js';
import { runRailBusMatrix } from './rail-bus-matrix.js';
import { runSpanLegibility } from './span-legibility.js';
import { runCircuity } from './circuity.js';

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

  // Validate ISO date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sampleDate)) {
    throw new Error(
      `config.diagnosticsSampleDate must be "YYYY-MM-DD", got: "${sampleDate}"`,
    );
  }

  // Resolve output path
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

  // Get the singleton database handle (already open from the import pipeline)
  const db = getDb();

  // Add departure_time_seconds / arrival_time_seconds GENERATED columns if
  // this version of node-gtfs did not create them during import.
  ensureTimeCols(db);

  // Resolve service_ids for the sample date
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

  // Parse time bands
  const timeBands = parseTimeBands(config);
  process.stdout.write(
    `Time bands: ${timeBands.map((b) => b.label).join(', ')}\n`,
  );

  // Resolve zone filter
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
  try {
    const results = await runHiddenTrunkDiagnostic(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      timeBands,
      zone,
    );
    const flagged = results.filter((r) => r.flagged).length;
    process.stdout.write(
      `     → ${results.length} segments analysed, ${flagged} candidate trunks flagged\n`,
    );
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  // -------------------------------------------------------------------------
  // Diagnostic 2: Branch dilution
  // -------------------------------------------------------------------------
  process.stdout.write('\n[2/5] Branch dilution...\n');
  try {
    const results = await runBranchDilutionDiagnostic(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      timeBands,
      zone,
    );
    const flagged = results.filter((r) => r.flagged).length;
    process.stdout.write(
      `     → ${results.length} route+dir+band rows, ${flagged} dilution cases flagged\n`,
    );
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  // -------------------------------------------------------------------------
  // Diagnostic 3: Rail–bus connection matrix
  // Only runs if diagnosticsRailFeedSqlitePath is configured.
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
  process.stdout.write('\n[4/5] Span legibility (scaffold)...\n');
  try {
    const results = await runSpanLegibility(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      timeBands,
      zone,
    );
    process.stdout.write(`     → ${results.length} route+direction rows\n`);
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  // -------------------------------------------------------------------------
  // Scaffold: Circuity
  // -------------------------------------------------------------------------
  process.stdout.write('\n[5/5] Circuity (scaffold)...\n');
  try {
    const results = await runCircuity(
      db,
      config,
      outputDir,
      sampleDate,
      serviceIds,
      zone,
    );
    const flagged = results.filter((r) => r.flagged).length;
    process.stdout.write(
      `     → ${results.length} routes, ${flagged} flagged (ratio > 2.0)\n`,
    );
  } catch (err: any) {
    process.stderr.write(`     ERROR: ${err.message}\n`);
  }

  process.stdout.write(`\nDiagnostics complete → ${outputDir}\n`);
  return outputDir;
}

export { runHiddenTrunkDiagnostic } from './hidden-trunk.js';
export { runBranchDilutionDiagnostic } from './branch-dilution.js';
export { runRailBusMatrix } from './rail-bus-matrix.js';
export { runSpanLegibility } from './span-legibility.js';
export { runCircuity } from './circuity.js';
