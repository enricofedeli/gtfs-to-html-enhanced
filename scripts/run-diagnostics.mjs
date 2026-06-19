/**
 * Minimal script: import a GTFS feed into SQLite, then run diagnostics.
 * Usage: node scripts/run-diagnostics.mjs --configPath config-diagnostics-bologna.json
 *
 * This bypasses the full HTML timetable pipeline so diagnostics run quickly
 * even when the feed has no timetables.txt.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// Parse --configPath argument
const idx = process.argv.indexOf('--configPath');
const configPath = idx >= 0 ? process.argv[idx + 1] : './config.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));

// Resolve path fields relative to cwd
if (config.outputPath && !path.isAbsolute(config.outputPath)) {
  config.outputPath = path.resolve(config.outputPath);
}

const { openDb, importGtfs } = await import('gtfs');
const { runDiagnostics, copyStaticAssets } = await import('../dist/index.js');

const sqlitePath = config.sqlitePath ?? '/tmp/gtfs-diagnostics.sqlite';

console.log(`Opening DB at ${sqlitePath}`);
openDb({ sqlitePath });

if (!config.skipImport) {
  console.log('Importing GTFS…');
  await importGtfs({ ...config, sqlitePath });
  console.log('Import complete.');
} else {
  console.log('Skipping import (skipImport=true).');
}

// Resolve diagnostics output dir (mirrors logic in runDiagnostics)
const outputPath = config.outputPath ?? path.join(process.cwd(), 'html');
const diagnosticsDir = config.diagnosticsOutputPath ?? path.join(outputPath, 'diagnostics');
const assetsParentDir = path.dirname(diagnosticsDir);

// Copy CSS/JS assets to the parent of diagnostics/ so assetPath="../" works.
// Diagnostics uses CDN for MapLibre, so suppress the showMap asset copy
// (which tries to copy bundled maplibre-gl.js that may not exist in dev setups).
console.log(`Copying static assets to ${assetsParentDir}…`);
await copyStaticAssets({ ...config, showMap: false }, assetsParentDir);

await runDiagnostics(config);
