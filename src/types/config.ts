import { ConfigAgency } from 'gtfs';

export interface TimePeriod {
  label: string;
  start: string; // "HH:MM" 24-hour
  end: string; // "HH:MM" 24-hour
}

export interface Config {
  agencies: ConfigAgency[];
  assetPath?: string;
  sqlitePath?: string;
  allowEmptyTimetables?: boolean;
  beautify?: boolean;
  coordinatePrecision?: number;
  dateFormat?: string;
  daysShortStrings?: string[];
  daysStrings?: string[];
  defaultOrientation?: string;
  effectiveDate?: string;
  endDate?: string;
  groupTimetablesIntoPages?: boolean;
  interpolatedStopSymbol?: string;
  interpolatedStopText?: string;
  linkStopUrls?: boolean;
  mapStyleUrl?: string;
  menuType?: 'none' | 'simple' | 'jump' | 'radio';
  noDropoffSymbol?: string;
  noDropoffText?: string;
  noHead?: boolean;
  noPickupSymbol?: string;
  noPickupText?: string;
  noRegularServiceDaysText?: string;
  noServiceSymbol?: string;
  noServiceText?: string;
  outputFormat?: 'html' | 'pdf' | 'csv';
  overwriteExistingFiles?: boolean;
  outputPath?: string;
  requestDropoffSymbol?: string;
  requestDropoffText?: string;
  requestPickupSymbol?: string;
  requestPickupText?: string;
  serviceNotProvidedOnText?: string;
  serviceProvidedOnText?: string;
  showArrivalOnDifference?: number;
  showCalendarExceptions?: boolean;
  showDuplicateTrips?: boolean;
  showMap?: boolean;
  showOnlyTimepoint?: boolean;
  showRouteTitle?: boolean;
  showStopCity?: boolean;
  showStopDescription?: boolean;
  showStoptimesForRequestStops?: boolean;
  skipImport?: boolean;
  sortingAlgorithm?: string;
  startDate?: string;
  templatePath?: string;
  timeFormat?: string;
  useParentStation?: boolean;
  verbose?: boolean;
  zipOutput?: boolean;
  logFunction?: (text: string) => void;

  // Network comparison mode
  comparisonMode?: boolean;
  comparisonAgency?: ConfigAgency & { sqlitePath?: string };
  stopMatchingDistanceMeters?: number;
  routeOverlapThreshold?: number;
  timePeriods?: TimePeriod[];
  generateStopPages?: boolean;

  // Branding
  brandingLogo?: string;
  brandingTitle?: string;
  brandingAccentColor?: string;

  // Diagnostics
  runDiagnostics?: boolean;
  diagnosticsOutputPath?: string;
  diagnosticsSampleDate?: string; // ISO "YYYY-MM-DD"; required for service-day resolution
  diagnosticsZone?: {
    routeIds?: string[];
    stopIds?: string[];
    boundingBox?: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  };
  diagnosticsHiddenTrunkMinTripsPerHour?: number; // combined tph flag threshold (default 6 = every 10 min)
  diagnosticsBranchDilutionRatioThreshold?: number; // trunk/branch tph ratio flag threshold (default 1.5)
  diagnosticsBranchDilutionMinTrunkTph?: number; // minimum trunk tph required to flag dilution (default 1.0)
  diagnosticsCircuityFlagThreshold?: number; // path/straight-line ratio above which route is flagged (default 2.0)
  diagnosticsCircuityMinStraightLineKm?: number; // routes below this are treated as circular loops (default 0.2)
  diagnosticsRailFeedSqlitePath?: string; // path to rail DB for rail-bus matrix diagnostic
  diagnosticsMaxTransferWaitMinutes?: number; // flag threshold for rail-bus waits (default 20)
}
