// Builds the enriched weekly schedule the browser needs to decide eligibility
// CLIENT-SIDE. No owned list here — the builder ships every series/week with the
// track's package_id and the set of eligible car package_ids; the front-end
// intersects those with the viewer's locally-stored owned content.
//
// Kept free of any network / fs concerns so it's trivially testable.

// Build fast lookup maps from the raw API arrays.
export function buildIndexes({ cars, tracks, carClasses }) {
  const carById = new Map();
  for (const c of cars) {
    carById.set(c.car_id, { packageId: c.package_id, name: c.car_name });
  }

  const trackById = new Map();
  for (const t of tracks) {
    const label = t.config_name && t.config_name !== 'N/A'
      ? `${t.track_name} — ${t.config_name}`
      : t.track_name;
    trackById.set(t.track_id, { packageId: t.package_id, name: label });
  }

  const classCars = new Map(); // car_class_id -> [car_id]
  for (const cc of carClasses) {
    classCars.set(cc.car_class_id, (cc.cars_in_class || []).map((x) => x.car_id));
  }

  return { carById, trackById, classCars };
}

// Slim catalog for the content picker (one row per package).
export function buildCatalog({ cars, tracks }) {
  const dedupe = (rows) => {
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.packageId)) seen.set(r.packageId, r);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    cars: dedupe(
      cars.filter((c) => !c.retired).map((c) => ({
        packageId: c.package_id,
        name: c.car_name,
        free: !!c.free_with_subscription,
      })),
    ),
    tracks: dedupe(
      tracks.map((t) => ({
        packageId: t.package_id,
        name: t.track_name,
        free: !!t.free_with_subscription,
      })),
    ),
  };
}

export function buildWeeks({ seasons, indexes }) {
  const { carById, trackById, classCars } = indexes;
  const weeks = new Map(); // race_week_num -> series[]

  for (const s of seasons) {
    // Cars this season allows, as unique package ids (+ display names).
    const carIds = new Set();
    for (const ccId of s.car_class_ids || []) {
      for (const id of classCars.get(ccId) || []) carIds.add(id);
    }
    const carPkgSet = new Map(); // packageId -> name
    for (const id of carIds) {
      const c = carById.get(id);
      if (c && !carPkgSet.has(c.packageId)) carPkgSet.set(c.packageId, c.name);
    }
    const carPackageIds = [...carPkgSet.keys()];
    const carNames = [...carPkgSet.values()].sort((a, b) => a.localeCompare(b));

    const minLicense = Math.min(
      ...((s.allowed_licenses || []).map((l) => l.group_id ?? 99)),
      99,
    );

    for (const sched of s.schedules || []) {
      const wk = sched.race_week_num;
      const t = trackById.get(sched.track?.track_id) || {
        packageId: sched.track?.package_id ?? null,
        name: sched.track?.track_name || 'Unknown track',
      };
      if (!weeks.has(wk)) weeks.set(wk, []);
      weeks.get(wk).push({
        series: s.series_name || s.season_name,
        category: s.category || s.track_types?.[0]?.track_type || 'other',
        fixed: /fixed/i.test(s.season_name || s.series_name || ''),
        track: { name: t.name, packageId: t.packageId },
        carPackageIds,
        carNames,
        categoryId: s.category_id ?? null,
        minLicense: minLicense === 99 ? null : minLicense,
        startDate: sched.start_date || null,
      });
    }
  }

  return [...weeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekNum, series]) => ({
      weekNum,
      startDate: series.find((x) => x.startDate)?.startDate || null,
      series: series.sort((a, b) => a.series.localeCompare(b.series)),
    }));
}
