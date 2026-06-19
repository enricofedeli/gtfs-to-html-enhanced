import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Ensure a directory exists, creating it (and any parents) if necessary.
 */
export async function makeOutputDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Write rows to a CSV file.
 * Column order is taken from the keys of the first row.
 * Values containing commas, quotes, or newlines are quoted per RFC 4180.
 */
export async function writeCsv(
  filePath: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) {
    await writeFile(filePath, '');
    return;
  }
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ];
  await writeFile(filePath, lines.join('\n') + '\n');
}

/**
 * Write data as indented JSON.
 */
export async function writeJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Write a plain-text summary file.
 */
export async function writeSummary(
  filePath: string,
  text: string,
): Promise<void> {
  await writeFile(filePath, text);
}

/**
 * Write a GeoJSON FeatureCollection.
 */
export async function writeGeoJSON(
  filePath: string,
  geojson: unknown,
): Promise<void> {
  await writeFile(filePath, JSON.stringify(geojson, null, 2) + '\n');
}

/**
 * Format a table of rows as a fixed-width plain-text table.
 * Columns are derived from the first row's keys.
 * Widths are computed to fit the longest value in each column.
 *
 * @param rows      - data rows (each row is an object with the same keys)
 * @param maxRows   - cap at this many data rows (default 50)
 */
export function formatTable(
  rows: Record<string, unknown>[],
  maxRows = 50,
): string {
  if (rows.length === 0) return '(no results)\n';
  const cols = Object.keys(rows[0]);
  const display = rows.slice(0, maxRows);
  const widths = cols.map((c) =>
    Math.max(c.length, ...display.map((r) => String(r[c] ?? '').length)),
  );
  const hr = widths.map((w) => '-'.repeat(w)).join('-+-');
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const dataLines = display.map((r) =>
    cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(' | '),
  );
  const lines = [header, hr, ...dataLines];
  if (rows.length > maxRows) {
    lines.push(`... (${rows.length - maxRows} more rows not shown)`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Build a standard diagnostic summary header block.
 */
export function summaryHeader(
  title: string,
  sampleDate: string,
  runAt: Date,
): string {
  return [
    '='.repeat(70),
    title,
    `Sample date : ${sampleDate}`,
    `Generated   : ${runAt.toISOString()}`,
    '='.repeat(70),
    '',
  ].join('\n');
}

/**
 * Write all three standard outputs (CSV, JSON, summary text) for a diagnostic.
 * Follows the naming convention: <prefix>.csv, <prefix>.json, <prefix>_summary.txt
 */
export async function writeStandardOutputs(
  outputDir: string,
  prefix: string,
  rows: Record<string, unknown>[],
  summaryText: string,
): Promise<void> {
  await Promise.all([
    writeCsv(path.join(outputDir, `${prefix}.csv`), rows),
    writeJson(path.join(outputDir, `${prefix}.json`), rows),
    writeSummary(path.join(outputDir, `${prefix}_summary.txt`), summaryText),
  ]);
}
