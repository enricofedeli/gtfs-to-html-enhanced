import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import {
  openDb,
  importGtfs,
  closeDb,
  isGtfsError,
  getRoutes,
  getStops,
  getTrips,
  getStoptimes,
  getAgencies,
} from 'gtfs';
import sanitize from 'sanitize-filename';

import {
  prepDirectory,
  copyStaticAssets,
  generateFolderName,
  renderPdf,
  zipFolder,
  generateCSVFileName,
  renderTemplate,
  untildify,
} from './file-utils.js';
import {
  progressBar,
  generateLogText,
  logStats,
  logError,
  log,
} from './log-utils.js';
import {
  setDefaultConfig,
  getTimetablePagesForAgency,
  getFormattedTimetablePage,
  generateTimetableHTML,
  generateTimetableCSV,
  generateOverviewHTML,
  generateStats,
} from './utils.js';
import {
  GtfsToHtmlError,
  GtfsToHtmlErrorCategory,
  GtfsToHtmlErrorCode,
  toGtfsToHtmlError,
} from './errors.js';
import {
  matchStopsAcrossNetworks,
  buildNetworkComparison,
  buildStopSequenceForRoute,
  type NetworkData,
  type NetworkComparison,
} from './comparison-utils.js';
import { getComparisonGeoJSON } from './geojson-utils.js';

import type { Config } from '../types/index.ts';
import type { Route, Stop, Trip, StopTime } from 'gtfs';

/*
 * Extract the full NetworkData needed for comparison from the currently-open DB.
 */
function extractNetworkData(): NetworkData {
  const routes = getRoutes() as Route[];
  const stops = getStops() as Stop[];
  const trips = getTrips() as Trip[];

  // Only pull the columns needed for comparison (trip_id, stop_id, stop_sequence, departure_time)
  const stoptimes = getStoptimes(
    {},
    ['trip_id', 'stop_id', 'stop_sequence', 'departure_time'],
    [
      ['trip_id', 'ASC'],
      ['stop_sequence', 'ASC'],
    ],
  ) as StopTime[];

  // Build stop sequences per route+direction
  const stopSequenceByRoute = new Map<string, string[]>();
  for (const route of routes) {
    for (const direction of [0, 1]) {
      const key = `${route.route_id}|${direction}`;
      const routeTrips = trips.filter(
        (t) =>
          t.route_id === route.route_id && (t.direction_id ?? 0) === direction,
      );
      if (routeTrips.length === 0) continue;
      const seq = buildStopSequenceForRoute(routeTrips, stoptimes);
      if (seq.length > 0) {
        stopSequenceByRoute.set(key, seq);
      }
    }
  }

  return { routes, stops, trips, stoptimes, stopSequenceByRoute };
}

/*
 * Generate the comparison overview HTML page.
 */
async function generateComparisonOverviewHTML(
  timetablePages: any[],
  comparison: NetworkComparison,
  config: Config,
): Promise<string> {
  const agencies = getAgencies() as { agency_name: string }[];
  const geojson = config.showMap
    ? getComparisonGeoJSON(comparison, config)
    : undefined;

  const templateVars = {
    agencies,
    agency: agencies[0],
    timetablePages,
    comparison,
    geojson,
    config,
    title:
      config.brandingTitle ??
      `${agencies.map((a) => a.agency_name).join(' & ')} — Network Comparison`,
  };

  return renderTemplate('overview_comparison', templateVars, config);
}

/*
 * Run the full comparison pipeline.
 *
 * 1. Import existing GTFS → extract NetworkData → close DB
 * 2. Import proposed GTFS → extract NetworkData (proposed DB remains open as singleton)
 * 3. Compute stop match table + network diff
 * 4. Generate output using proposed DB + comparison data injected into templates
 */
export const gtfsToHtmlComparison = async (
  initialConfig: Config,
): Promise<string> => {
  const config = setDefaultConfig(initialConfig);

  if (!config.comparisonAgency) {
    throw new GtfsToHtmlError(
      'comparisonMode requires `comparisonAgency` to be set in config',
      {
        code: GtfsToHtmlErrorCode.CONFIG_MISSING_AGENCIES,
        category: GtfsToHtmlErrorCategory.CONFIG,
        details: { field: 'comparisonAgency' },
      },
    );
  }

  const startTime = process.hrtime.bigint();

  const agencyKey = config.agencies
    .map((agency: any) => agency.agencyKey ?? agency.agency_key ?? 'unknown')
    .join('-');

  const outputPath = config.outputPath
    ? untildify(config.outputPath)
    : path.join(process.cwd(), 'html', sanitize(agencyKey));

  await prepDirectory(outputPath, config);

  // -----------------------------------------------------------------------
  // Phase 1: Import and extract existing network
  // -----------------------------------------------------------------------

  const existingSqlitePath = config.sqlitePath
    ? config.sqlitePath.replace('.sqlite', '-existing.sqlite')
    : '/tmp/gtfs-existing.sqlite';

  log(config)(`Importing existing network from ${agencyKey}...`);

  try {
    openDb({ sqlitePath: existingSqlitePath });
  } catch (error: any) {
    throw toGtfsToHtmlError(error, {
      message: 'Unable to open existing network database',
      code: GtfsToHtmlErrorCode.DATABASE_OPEN_FAILED,
      category: GtfsToHtmlErrorCategory.DATABASE,
      details: { sqlitePath: existingSqlitePath },
    });
  }

  if (!config.skipImport) {
    try {
      await importGtfs({
        ...config,
        agencies: config.agencies,
        sqlitePath: existingSqlitePath,
      });
    } catch (error: unknown) {
      if (isGtfsError(error)) throw error;
      throw toGtfsToHtmlError(error, {
        message: 'Existing GTFS import failed',
        code: GtfsToHtmlErrorCode.GTFS_IMPORT_FAILED,
        category: GtfsToHtmlErrorCategory.GTFS,
      });
    }
  }

  const existingData = extractNetworkData();
  log(config)(
    `Existing network: ${existingData.routes.length} routes, ${existingData.stops.length} stops, ${existingData.trips.length} trips`,
  );

  // Close existing DB so the proposed DB can be the singleton
  const existingDb = openDb({ sqlitePath: existingSqlitePath });
  closeDb(existingDb);

  // -----------------------------------------------------------------------
  // Phase 2: Import and extract proposed network
  // -----------------------------------------------------------------------

  const proposedSqlitePath =
    config.comparisonAgency.sqlitePath ??
    (config.sqlitePath
      ? config.sqlitePath.replace('.sqlite', '-proposed.sqlite')
      : '/tmp/gtfs-proposed.sqlite');

  const proposedAgencyConfig = {
    ...config,
    agencies: [config.comparisonAgency],
    sqlitePath: proposedSqlitePath,
  };

  log(config)('Importing proposed network...');

  try {
    openDb({ sqlitePath: proposedSqlitePath });
  } catch (error: any) {
    throw toGtfsToHtmlError(error, {
      message: 'Unable to open proposed network database',
      code: GtfsToHtmlErrorCode.DATABASE_OPEN_FAILED,
      category: GtfsToHtmlErrorCategory.DATABASE,
      details: { sqlitePath: proposedSqlitePath },
    });
  }

  if (!config.skipImport) {
    try {
      await importGtfs(proposedAgencyConfig);
    } catch (error: unknown) {
      if (isGtfsError(error)) throw error;
      throw toGtfsToHtmlError(error, {
        message: 'Proposed GTFS import failed',
        code: GtfsToHtmlErrorCode.GTFS_IMPORT_FAILED,
        category: GtfsToHtmlErrorCategory.GTFS,
      });
    }
  }

  const proposedData = extractNetworkData();
  log(config)(
    `Proposed network: ${proposedData.routes.length} routes, ${proposedData.stops.length} stops, ${proposedData.trips.length} trips`,
  );

  // -----------------------------------------------------------------------
  // Phase 3: Compute comparison
  // -----------------------------------------------------------------------

  const thresholdMeters = config.stopMatchingDistanceMeters ?? 5;
  log(config)(
    `Matching stops across networks (threshold: ${thresholdMeters} m)...`,
  );

  const stopMatchTable = matchStopsAcrossNetworks(
    existingData.stops,
    proposedData.stops,
    thresholdMeters,
  );

  log(config)(`Matched ${stopMatchTable.matches.length} stops across networks`);

  const comparison = buildNetworkComparison(
    existingData,
    proposedData,
    stopMatchTable,
    config,
  );

  log(config)(
    `Network diff: ${comparison.summary.newRoutes} new, ${comparison.summary.removedRoutes} removed, ${comparison.summary.modifiedRoutes} modified routes`,
  );

  // -----------------------------------------------------------------------
  // Phase 4: Generate output (proposed DB is now the singleton)
  // -----------------------------------------------------------------------

  const stats: {
    timetables: number;
    timetablePages: number;
    calendars: number;
    routes: number;
    trips: number;
    stops: number;
    warnings: string[];
    [key: string]: number | string[];
  } = {
    timetables: 0,
    timetablePages: 0,
    calendars: 0,
    routes: 0,
    trips: 0,
    stops: 0,
    warnings: [],
  };

  if (
    config.noHead !== true &&
    ['html', 'pdf'].includes(config.outputFormat ?? 'html')
  ) {
    await copyStaticAssets(config, outputPath);

    // Copy comparison-specific JS/CSS assets
    await copyComparisonAssets(outputPath);
  }

  const timetablePages = [];
  const timetablePageIds = getTimetablePagesForAgency(proposedAgencyConfig).map(
    (p) => p.timetable_page_id,
  );

  const bar = progressBar(
    `${agencyKey}: Generating comparison timetables {bar} {value}/{total}`,
    timetablePageIds.length,
    config,
  );

  for (const timetablePageId of timetablePageIds) {
    try {
      const timetablePage = await getFormattedTimetablePage(
        timetablePageId as string,
        proposedAgencyConfig,
      );

      for (const timetable of timetablePage.consolidatedTimetables) {
        if (timetable.warnings) {
          for (const warning of timetable.warnings) {
            stats.warnings.push(warning);
            bar?.interrupt(warning);
          }
        }
      }

      if (timetablePage.consolidatedTimetables.length === 0) {
        throw new GtfsToHtmlError(
          `No timetables found for timetable_page_id=${timetablePage.timetable_page_id}`,
          {
            code: GtfsToHtmlErrorCode.TIMETABLE_GENERATION_FAILED,
            category: GtfsToHtmlErrorCategory.QUERY,
            details: { timetablePageId: timetablePage.timetable_page_id },
          },
        );
      }

      stats.timetables += timetablePage.consolidatedTimetables.length;
      stats.timetablePages += 1;

      const datePath = generateFolderName(timetablePage);
      await mkdir(path.join(outputPath, datePath), { recursive: true });
      proposedAgencyConfig.assetPath = '../';

      timetablePage.relativePath = path.join(
        datePath,
        sanitize(timetablePage.filename),
      );

      // Find the comparison diff for this timetable's routes
      const routeDiff = findRouteDiffForTimetablePage(
        timetablePage,
        comparison,
      );

      if (proposedAgencyConfig.outputFormat === 'csv') {
        for (const timetable of timetablePage.consolidatedTimetables) {
          const csv = await generateTimetableCSV(timetable);
          const csvPath = path.join(
            outputPath,
            datePath,
            generateCSVFileName(timetable, proposedAgencyConfig),
          );
          await writeFile(csvPath, csv);
        }
      } else {
        // Inject comparison data into the template render
        const html = await generateTimetableHTMLWithComparison(
          timetablePage,
          comparison,
          routeDiff,
          proposedAgencyConfig,
        );
        const htmlPath = path.join(
          outputPath,
          datePath,
          sanitize(timetablePage.filename),
        );
        await writeFile(htmlPath, html);

        if (proposedAgencyConfig.outputFormat === 'pdf') {
          await renderPdf(htmlPath);
        }
      }

      timetablePages.push(timetablePage);
      const timetableStats = generateStats(timetablePage);
      stats.stops += timetableStats.stops;
      stats.routes += timetableStats.routes;
      stats.trips += timetableStats.trips;
      stats.calendars += timetableStats.calendars;
    } catch (error: any) {
      stats.warnings.push(error?.message);
      bar?.interrupt(error.message);
    }

    bar?.increment();
  }

  if ((proposedAgencyConfig.outputFormat ?? 'html') === 'html') {
    proposedAgencyConfig.assetPath = '';
    const html = await generateComparisonOverviewHTML(
      timetablePages,
      comparison,
      proposedAgencyConfig,
    );
    await writeFile(path.join(outputPath, 'index.html'), html);

    // Generate per-stop pages if requested
    if (config.generateStopPages) {
      await generateStopComparisonPages(
        comparison,
        outputPath,
        proposedAgencyConfig,
      );
    }
  }

  const logText = generateLogText(stats, proposedAgencyConfig);
  await writeFile(path.join(outputPath, 'log.txt'), logText);

  if (config.zipOutput) {
    await zipFolder(outputPath);
  }

  const fullOutputPath = path.join(
    outputPath,
    config.zipOutput ? '/timetables.zip' : '',
  );

  log(config)(`Comparison output created at ${fullOutputPath}`);
  logStats(config)(stats);

  const endTime = process.hrtime.bigint();
  const elapsedSeconds = Number(endTime - startTime) / 1_000_000_000;
  log(config)(
    `Comparison generation took ${elapsedSeconds.toFixed(1)} seconds`,
  );

  return fullOutputPath;
};

/*
 * Find the RouteDiff for a timetable page's routes.
 */
function findRouteDiffForTimetablePage(
  timetablePage: any,
  comparison: NetworkComparison,
) {
  const routeIds: string[] = timetablePage.route_ids ?? [];
  return comparison.routeDiffs.filter(
    (d) =>
      d.proposedRouteIds.some((id) => routeIds.includes(id)) ||
      d.existingRouteIds.some((id) => routeIds.includes(id)),
  );
}

/*
 * Generate timetable HTML with comparison data injected.
 */
async function generateTimetableHTMLWithComparison(
  timetablePage: any,
  comparison: NetworkComparison,
  routeDiff: any[],
  config: Config,
): Promise<string> {
  const agencies = getAgencies() as { agency_name: string }[];

  const templateVars = {
    timetablePage,
    comparison,
    routeDiff,
    config,
    title: `${timetablePage.timetable_page_label} | ${agencies.map((a) => a.agency_name).join(' & ')}`,
  };

  // Try comparison template first, fall back to standard timetablepage template
  try {
    return renderTemplate('timetablepage_comparison', templateVars, config);
  } catch {
    return renderTemplate('timetablepage', templateVars, config);
  }
}

/*
 * Generate per-stop comparison pages.
 */
async function generateStopComparisonPages(
  comparison: NetworkComparison,
  outputPath: string,
  config: Config,
): Promise<void> {
  const stopsDir = path.join(outputPath, 'stops');
  await mkdir(stopsDir, { recursive: true });

  for (const [stopId, stopData] of comparison.stopComparisons) {
    const templateVars = {
      stopData,
      config,
      title: `${stopData.stopName} — Stop Comparison`,
    };

    try {
      const html = await renderTemplate(
        'stop_departures',
        templateVars,
        config,
      );
      await writeFile(path.join(stopsDir, `${sanitize(stopId)}.html`), html);
    } catch {
      // Skip if template doesn't exist yet
    }
  }
}

/*
 * Copy comparison-specific static assets to output directory.
 */
async function copyComparisonAssets(outputPath: string): Promise<void> {
  // Assets are included in the existing copyStaticAssets call via views/default/js and css.
  // If we add new comparison-specific JS/CSS files to views/default/, they get copied automatically.
}
