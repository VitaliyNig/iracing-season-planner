// Shared owned-content store (browser localStorage), used by both the planner
// and the content picker. Owned content is per-browser and never leaves the
// device — iRacing has no purchases API, so you pick it yourself once.
//
// Stored as JSON arrays of package_id under these keys.
window.Owned = (() => {
  const KEYS = { cars: 'iwp.ownedCars', tracks: 'iwp.ownedTracks' };

  function read(kind) {
    try {
      const v = JSON.parse(localStorage.getItem(KEYS[kind]) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function write(kind, ids) {
    localStorage.setItem(KEYS[kind], JSON.stringify([...new Set(ids)].sort((a, b) => a - b)));
  }
  function set(kind) {
    return new Set(read(kind));
  }
  function toggle(kind, packageId, on) {
    const s = set(kind);
    if (on) s.add(packageId);
    else s.delete(packageId);
    write(kind, [...s]);
  }
  // Owned = your saved picks PLUS everything free-with-subscription.
  function effective(kind, freePackageIds = []) {
    return new Set([...read(kind), ...freePackageIds]);
  }
  function count(kind) {
    return read(kind).length;
  }
  return { read, write, set, toggle, effective, count, KEYS };
})();
