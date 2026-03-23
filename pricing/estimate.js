// pricing/estimate.js
// ─────────────────────────────────────────────────────────────────────────────
// Estimate builder. Pure logic — no DOM, no UI.
//
// PART RESOLUTION ORDER (per damage detection):
//
//   Step 1 — main.pt class name
//             "roof-dent"          → partKey: 'roof'        ✓ direct
//             "bonnet-dent"        → partKey: 'bonnet'      ✓ direct
//             "damaged"            → partKey: null          → go to step 2
//             "dent-or-scratch"    → partKey: null          → go to step 2
//
//   Step 2 — car_part.pt region (on_part field from pipeline)
//             "front_fender"       → partKey: 'front_fender' ✓ fallback
//             "unknown"            → partKey: null           → go to step 3
//
//   Step 3 — vehide.pt damage type gives severity hint only.
//             Part is still unknown → skip pricing, log to unknownParts[].
//
// SEVERITY RESOLUTION ORDER:
//   1. severityHint from main.pt class (e.g. "major-rear-bumper-dent" → moyen)
//   2. severityHint from vehide.pt damage type (e.g. "hole" → moyen)
//   3. ResNet severity model output (minor→leger, moderate/severe→moyen)
// ─────────────────────────────────────────────────────────────────────────────

import { PRICE_TABLES, PART_LABELS, VAT_RATE } from './price-tables.js';
import {
  resolveMainClass,
  resolvePartRegion,
  getVehideSeverityHint,
} from './parts-map.js';


// ── Severity → damage level ───────────────────────────────────────────────────
export function severityToDamageLevel(severityClass) {
  return severityClass === 'minor' ? 'leger' : 'moyen';
}


// ── Resolve part key from a pipeline damage object ───────────────────────────
/**
 * Given one damage entry from stage2.damages[], resolve the best price key.
 *
 * @param {object} damage  Pipeline damage object:
 *   { type, conf, box, on_part, overlap_pct }
 *   where `type` is the vehide.pt class and `on_part` is from car_part.pt.
 *
 * @param {string} mainClass  The main.pt detection class that triggered this region.
 *
 * @returns {{ partKey: string, severityHint: string|null } | null}
 */
function resolvePartFromDamage(damage, mainClass) {

  // Step 1 — try main.pt class (most informative)
  const mainResolved = resolveMainClass(mainClass);
  if (mainResolved?.partKey) {
    return {
      partKey:      mainResolved.partKey,
      severityHint: mainResolved.severityHint,
    };
  }

  // Step 2 — try car_part.pt region (on_part from pipeline)
  const partKey = resolvePartRegion(damage.on_part);
  if (partKey) {
    // Also check if main.pt had a severity hint even without a partKey
    const severityHint = mainResolved?.severityHint
      ?? getVehideSeverityHint(damage.type);
    return { partKey, severityHint };
  }

  // Step 3 — unresolvable
  return null;
}


// ── Single part price lookup ──────────────────────────────────────────────────
/**
 * Look up the MUR price for a resolved part.
 *
 * @param {string}           partKey       e.g. 'front_fender'
 * @param {'leger'|'moyen'}  damageLevel
 * @param {'medium'|'large'} size
 * @param {'client'|'interne'} listType
 * @returns {number|null}
 */
export function lookupPrice(partKey, damageLevel, size, listType) {
  return PRICE_TABLES[listType]?.[partKey]?.[size]?.[damageLevel] ?? null;
}


// ── Full estimate builder ─────────────────────────────────────────────────────
/**
 * Build a full itemised estimate from the /predict pipeline result.
 *
 * @param {object} pipelineResult   JSON from /predict endpoint
 * @param {{
 *   listType?:    'client'|'interne',
 *   vehicleSize?: 'medium'|'large',
 * }} options
 *
 * @returns {{
 *   listType:        string,
 *   vehicleSize:     string,
 *   overallSeverity: string,
 *   lineItems:       LineItem[],
 *   subtotal:        number,
 *   vat:             number,
 *   total:           number,
 *   currency:        'MUR',
 *   unknownParts:    string[],
 * }}
 *
 * @typedef {{
 *   part:        string,   human-readable label
 *   partKey:     string,   canonical key
 *   mainClass:   string,   raw main.pt class
 *   damageType:  string,   raw vehide.pt class
 *   severity:    string,   'minor'|'moderate'|'severe'
 *   damageLevel: string,   'leger'|'moyen'
 *   price:       number,
 *   conf:        number,
 * }} LineItem
 */
export function buildEstimate(pipelineResult, {
  listType    = 'client',
  vehicleSize = 'medium',
} = {}) {

  const { stage1, stage2 } = pipelineResult ?? {};
  const overallSeverity    = stage1?.severity?.class ?? 'minor';

  const lineItems    = [];
  const unknownParts = [];
  const seen         = new Set();   // deduplicate partKey + severity

  for (const region of (stage2 ?? [])) {

    const mainClass      = region.triggered_by?.type ?? '';
    const regionSeverity = region.severity?.class ?? overallSeverity;

    for (const damage of (region.damages ?? [])) {

      // ── Resolve part ──────────────────────────────────────────────────────
      const resolved = resolvePartFromDamage(damage, mainClass);

      if (!resolved) {
        // Couldn't resolve to any price key
        const label = damage.on_part || damage.type || mainClass || 'unknown';
        if (label && label !== 'unknown') unknownParts.push(label);
        continue;
      }

      const { partKey, severityHint } = resolved;

      // ── Deduplicate same part in same region ──────────────────────────────
      const dedupeKey = `${partKey}__${regionSeverity}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // ── Resolve damage level ──────────────────────────────────────────────
      // Priority: class hint > vehide hint > ResNet model
      const vehideHint   = getVehideSeverityHint(damage.type);
      const finalLevel   = severityHint                         // main.pt hint
        ?? vehideHint                                           // vehide hint
        ?? severityToDamageLevel(regionSeverity);               // ResNet

      // ── Price lookup ──────────────────────────────────────────────────────
      const price = lookupPrice(partKey, finalLevel, vehicleSize, listType);

      if (price == null) {
        unknownParts.push(`${partKey} (no price for ${vehicleSize}/${finalLevel})`);
        continue;
      }

      lineItems.push({
        part:        PART_LABELS[partKey] ?? partKey,
        partKey,
        mainClass,
        damageType:  damage.type,
        severity:    regionSeverity,
        damageLevel: finalLevel,
        price,
        conf:        damage.conf,
      });
    }
  }

  const subtotal = lineItems.reduce((s, i) => s + i.price, 0);
  const vat      = Math.round(subtotal * VAT_RATE);
  const total    = subtotal + vat;

  return {
    listType,
    vehicleSize,
    overallSeverity,
    lineItems,
    subtotal,
    vat,
    total,
    currency:     'MUR',
    unknownParts: [...new Set(unknownParts)],
  };
}


// ── Formatting helper ─────────────────────────────────────────────────────────
export function formatMUR(amount) {
  return `Rs ${Number(amount).toLocaleString('en-MU')}`;
}