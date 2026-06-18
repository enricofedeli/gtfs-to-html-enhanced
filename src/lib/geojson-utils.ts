import { getShapesAsGeoJSON, getStopsAsGeoJSON } from 'gtfs';
import simplify from '@turf/simplify';
import { featureCollection, round } from '@turf/helpers';
import { logWarning } from './log-utils.js';
import { getBaseTripIds } from './trip-id-utils.js';
import type { NetworkComparison } from './comparison-utils.js';
import type { Config } from '../types/index.ts';

/*
 * Merge any number of geojson objects into one. Only works for `FeatureCollection`.
 */
const mergeGeojson = (...geojsons) =>
  featureCollection(geojsons.flatMap((geojson) => geojson.features));

/*
 * Truncate a geojson coordinates to a specific number of decimal places.
 */
const truncateGeoJSONDecimals = (geojson, config) => {
  for (const feature of geojson.features) {
    if (feature.geometry.coordinates) {
      if (feature.geometry.type.toLowerCase() === 'point') {
        feature.geometry.coordinates = feature.geometry.coordinates.map(
          (number) => round(number, config.coordinatePrecision),
        );
      } else if (feature.geometry.type.toLowerCase() === 'linestring') {
        feature.geometry.coordinates = feature.geometry.coordinates.map(
          (coordinate) =>
            coordinate.map((number) =>
              round(number, config.coordinatePrecision),
            ),
        );
      } else if (feature.geometry.type.toLowerCase() === 'multilinestring') {
        feature.geometry.coordinates = feature.geometry.coordinates.map(
          (linestring) =>
            linestring.map((coordinate) =>
              coordinate.map((number) =>
                round(number, config.coordinatePrecision),
              ),
            ),
        );
      }
    }
  }

  return geojson;
};

/*
 * Get the geoJSON for a timetable.
 */
export function getTimetableGeoJSON(timetable, config) {
  const tripIds = getBaseTripIds(timetable.orderedTrips);

  const shapesGeojsons = timetable.route_ids.map((routeId) =>
    getShapesAsGeoJSON({
      route_id: routeId,
      direction_id: timetable.direction_id,
      trip_id: tripIds,
    }),
  );

  const stopsGeojsons = timetable.route_ids.map((routeId) =>
    getStopsAsGeoJSON({
      route_id: routeId,
      direction_id: timetable.direction_id,
      trip_id: tripIds,
    }),
  );

  const geojson = mergeGeojson(...shapesGeojsons, ...stopsGeojsons);

  let simplifiedGeojson;
  try {
    simplifiedGeojson = simplify(geojson, {
      tolerance: 1 / 10 ** config.coordinatePrecision,
      highQuality: true,
    });
  } catch {
    timetable.warnings.push(
      `Timetable ${timetable.timetable_id} - Unable to simplify geojson`,
    );
    simplifiedGeojson = geojson;
  }

  return truncateGeoJSONDecimals(simplifiedGeojson, config);
}

/*
 * Get the geoJSON for an agency (all routes and stops).
 */
export function getAgencyGeoJSON(config) {
  const shapesGeojsons = getShapesAsGeoJSON();
  const stopsGeojsons = getStopsAsGeoJSON();

  const geojson = mergeGeojson(shapesGeojsons, stopsGeojsons);

  let simplifiedGeojson;
  try {
    simplifiedGeojson = simplify(geojson, {
      tolerance: 1 / 10 ** config.coordinatePrecision,
      highQuality: true,
    });
  } catch {
    logWarning(config)('Unable to simplify geojson');
    simplifiedGeojson = geojson;
  }

  return truncateGeoJSONDecimals(simplifiedGeojson, config);
}

/*
 * Get the GeoJSON for a comparison — proposed network stops colour-coded by diff status.
 * Stop properties include `comparisonStatus`: 'new' | 'removed' | 'unchanged'
 * Route lines include `networkType`: 'existing' | 'proposed'
 */
export function getComparisonGeoJSON(
  comparison: NetworkComparison,
  config: Config,
) {
  // Proposed network shapes + stops (from currently-open proposed DB)
  const proposedShapes = getShapesAsGeoJSON();
  const proposedStops = getStopsAsGeoJSON();

  // Tag proposed features
  for (const feature of proposedShapes.features) {
    feature.properties = { ...feature.properties, networkType: 'proposed' };
  }

  for (const feature of proposedStops.features) {
    const stopId = feature.properties?.stop_id;
    const isNew =
      stopId &&
      comparison.stopMatchTable.proposedToExisting.get(stopId) === null;
    feature.properties = {
      ...feature.properties,
      networkType: 'proposed',
      comparisonStatus: isNew ? 'new' : 'unchanged',
    };
  }

  const geojson = mergeGeojson(proposedShapes, proposedStops);

  let simplifiedGeojson;
  try {
    simplifiedGeojson = simplify(geojson, {
      tolerance: 1 / 10 ** (config.coordinatePrecision ?? 5),
      highQuality: true,
    });
  } catch {
    logWarning(config)('Unable to simplify comparison geojson');
    simplifiedGeojson = geojson;
  }

  return truncateGeoJSONDecimals(simplifiedGeojson, config);
}
