#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import PrettyError from 'pretty-error';
import { isGtfsError } from 'gtfs';

import { getConfig } from '../lib/file-utils.js';
import { formatError } from '../lib/log-utils.js';
import gtfsToHtml, { isGtfsToHtmlError } from '../index.js';
import { runDiagnostics } from '../lib/diagnostics/index.js';

const pe = new PrettyError();

const { argv } = yargs(hideBin(process.argv))
  .usage('Usage: $0 --configPath ./config.json')
  .help()
  .option('c', {
    alias: 'configPath',
    describe: 'Path to config file',
    default: './config.json',
    type: 'string',
  })
  .option('s', {
    alias: 'skipImport',
    describe: 'Don’t import GTFS file.',
    type: 'boolean',
  })
  .default('skipImport', undefined)
  .option('t', {
    alias: 'showOnlyTimepoint',
    describe: 'Show only stops with a `timepoint` value in `stops.txt`',
    type: 'boolean',
  })
  .default('showOnlyTimepoint', undefined)
  .option('d', {
    alias: 'diagnostics',
    describe:
      'Run network diagnostics on the imported GTFS database and write results to diagnosticsOutputPath',
    type: 'boolean',
  })
  .default('diagnostics', undefined);

const handleError = (error: any) => {
  const text = error || 'Unknown Error';
  const isKnownOperationalError =
    isGtfsToHtmlError(error) || isGtfsError(error);

  process.stdout.write(
    `\n${formatError(text, { verbosity: isKnownOperationalError ? 'user' : 'developer' })}\n`,
  );

  if (!isKnownOperationalError) {
    console.error(pe.render(error));
  }

  process.exit(1);
};

const setupImport = async () => {
  const config = await getConfig(argv);

  // --diagnostics flag (or config.runDiagnostics) runs diagnostics after import.
  // The normal timetable-generation pipeline still runs first so the DB is populated.
  if ((argv as any).diagnostics || config.runDiagnostics) {
    // Run the normal pipeline first (imports GTFS, opens DB singleton)
    await gtfsToHtml(config);
    // Then run diagnostics against the now-open DB
    await runDiagnostics(config);
  } else {
    await gtfsToHtml(config);
  }

  process.exit();
};

setupImport().catch(handleError);
