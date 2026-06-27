/**
 * Diagnostics interactive JS.
 *
 * Provides per-route checkbox filters for each diagnostic section table.
 * For the hidden trunk section, also updates the MapLibre GL layer filter
 * so only segments involving active routes are highlighted.
 *
 * Expected HTML contract (set by diagnostics_index.pug):
 *  - .route-filter-bar[data-target="<tableId>"]  — filter bar container
 *  - input[type="checkbox"][data-route="<routeId>"]  — one per route
 *  - button[data-action="all" | "none"]  — select-all / deselect-all buttons
 *  - <tr data-routes="<routeId1>|<routeId2>|...">  — table row with route IDs
 *
 * For the map (hidden trunk only):
 *  - window.__trunkMap  — MapLibre map instance set by inline script in the template
 *  - Layer id "trunk-flagged" receives a setFilter() call on checkbox change
 */

(function () {
  'use strict';

  /**
   * Return the set of route IDs currently checked in a filter bar.
   * @param {HTMLElement} bar
   * @returns {Set<string>}
   */
  function activeRoutes(bar) {
    const checked = bar.querySelectorAll('input[type="checkbox"]:checked');
    return new Set([...checked].map((cb) => cb.dataset.route));
  }

  /**
   * Filter rows in a table: show row if at least one of its data-routes values
   * is in the active set, hide otherwise.
   *
   * data-routes is either:
   *  - a single route id  (e.g. "11")
   *  - pipe-separated ids (e.g. "87 | 91 | 686")   — hidden trunk
   *  - comma-separated ids (route_ids_csv in geojson) — not used for rows
   *
   * @param {HTMLTableElement} table
   * @param {Set<string>} active
   */
  function filterTableRows(table, active) {
    if (!table) return;
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach((row) => {
      const raw = (row.dataset.routes || '').trim();
      // Routes may be separated by " | " (branch dilution, span, circuity)
      // or " | " (hidden trunk contributing_route_ids)
      const rowRoutes = raw
        .split(/\s*\|\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      const visible =
        rowRoutes.length === 0 || rowRoutes.some((id) => active.has(id));
      row.classList.toggle('hidden-row', !visible);
    });
  }

  /**
   * Update the MapLibre hidden-trunk-flagged layer filter.
   * The GeoJSON features store route_ids_csv as a comma-separated string,
   * e.g. "87,91,686".  We filter to features that contain ANY active route id.
   *
   * MapLibre filter expression used:
   *   ["any", ["in", "87,", ["concat", ["get", "route_ids_csv"], ","]], ...]
   *
   * Appending a comma to both sides ensures "87" does not match "870".
   *
   * @param {Set<string>} active
   */
  function filterMap(active) {
    const map = window.__trunkMap;
    if (!map || !map.getLayer('trunk-flagged')) return;

    if (active.size === 0) {
      // Hide all flagged segments
      map.setFilter('trunk-flagged', ['==', ['literal', true], false]);
      return;
    }

    // Build a "contains this route id" expression per active route
    const conditions = [...active].map((id) => [
      'in',
      id + ',',
      ['concat', ['get', 'route_ids_csv'], ','],
    ]);

    const filter =
      conditions.length === 1
        ? ['==', ['literal', true], true, ...conditions] // fallback for single route
        : ['any', ...conditions];

    // Also keep base filter: only flagged=true features
    map.setFilter('trunk-flagged', [
      'all',
      ['==', ['get', 'flagged'], true],
      filter,
    ]);
  }

  /**
   * Wire up a single .route-filter-bar element.
   * @param {HTMLElement} bar
   */
  function wireFilterBar(bar) {
    const targetId = bar.dataset.target;
    const table = targetId ? document.getElementById(targetId) : null;
    const isMapSection = targetId === 'hidden-trunk-table';

    function update() {
      const active = activeRoutes(bar);
      filterTableRows(table, active);
      if (isMapSection) filterMap(active);
    }

    // Checkbox changes
    bar.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'checkbox') {
        update();
      }
    });

    // All / None buttons
    bar.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const checkboxes = bar.querySelectorAll('input[type="checkbox"]');
      const shouldCheck = btn.dataset.action === 'all';
      checkboxes.forEach((cb) => {
        cb.checked = shouldCheck;
      });
      update();
    });
  }

  // Initialise all filter bars on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.route-filter-bar').forEach(wireFilterBar);
  });
})();
