
import KIA from './kia.js';

// ── Register brands here ──────────────────────────────────────────────────────
const BRANDS = [
  KIA,
  // BMW,        ← uncomment after creating bmw.js
  // RENAULT,    ← uncomment after creating renault.js
  // MITSUBISHI, ← etc.
];

// ── Internal lookup index (built once at load time) ───────────────────────────
// Maps every lowercase model name + alias → { brand, size }
const _INDEX = new Map();

for (const brand of BRANDS) {
  for (const model of brand.models) {
    const entry = { brand: brand.displayName, size: model.size, labourTier: model.labourTier ?? "standard" };

    _INDEX.set(model.name.toLowerCase(), entry);

    for (const alias of model.aliases) {
      _INDEX.set(alias.toLowerCase(), entry);
    }
  }
}

/**
 * Resolve a free-text vehicle model string to { brand, size }.
 * Tries exact match first, then substring scan.
 *
 * @param {string} input  e.g. "Kia Sportage", "sportage", "EV6"
 * @returns {{ brand: string, size: 'medium'|'large', labourTier: 'standard'|'ev' }|null}
 */
export function resolveVehicle(input) {
  if (!input || typeof input !== 'string') return null;

  const lower = input.toLowerCase().trim();

  // 1. Exact match
  if (_INDEX.has(lower)) return _INDEX.get(lower);

  // 2. Substring match (handles "Kia Sportage 2023", "my ev6", etc.)
  for (const [key, entry] of _INDEX) {
    if (lower.includes(key)) return entry;
  }

  return null; // unknown model
}

/**
 * List all registered models (for autocomplete / UI dropdowns).
 * @returns {Array<{ brand: string, name: string, size: string }>}
 */
export function listAllModels() {
  return BRANDS.flatMap(brand =>
    brand.models.map(m => ({
      brand: brand.displayName,
      name: m.name,
      size: m.size,
      labourTier: m.labourTier ?? 'standard',
    }))
  );
}

export { BRANDS };