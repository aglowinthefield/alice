// Bakery is becoming Alice. This browser may hold settings under the old `bakery-*` keys. Before anything reads them,
// each one fills its `alice-*` name when that is unset, so the UI reads and writes only `alice-*` and nobody loses a
// setting. The old keys stay put for one release; dropping them later is this file plus its import in entry.tsx.

/**
 * Copies every `bakery-*` key in `storage` to its `alice-*` name, unless that name already has a value. It runs once
 * per storage: after that a missing `alice-*` key means the setting was cleared, not that it was never copied.
 */
export function adoptLegacyStorage(storage: Storage): void {
  if (storage.getItem("alice-adopted-bakery-keys") !== null) return;
  storage.setItem("alice-adopted-bakery-keys", "1");
  const legacy: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith("bakery-")) legacy.push(key);
  }
  for (const key of legacy) {
    const name = `alice-${key.slice("bakery-".length)}`;
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(name) === null)
      storage.setItem(name, value);
  }
}

for (const storage of ["localStorage", "sessionStorage"] as const) {
  try {
    adoptLegacyStorage(globalThis[storage]);
  } catch {
    // Storage can be disabled or full; the UI then starts from its defaults.
  }
}
