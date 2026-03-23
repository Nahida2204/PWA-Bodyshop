// pricing/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Single entry point for the pricing module.
//
// Usage in app.js:
//   import Pricing from './pricing/index.js';
//
//   const vehicle  = Pricing.resolveVehicle('Kia Sportage');
//   // → { brand: 'Kia', size: 'medium' }
//
//   const estimate = Pricing.buildEstimate(pipelineResult, {
//     listType:    'client',
//     vehicleSize: vehicle?.size ?? 'medium',
//   });
//   // → { lineItems: [...], subtotal, vat, total, ... }
// ─────────────────────────────────────────────────────────────────────────────

export { buildEstimate, lookupPrice, severityToDamageLevel, formatMUR } from './estimate.js';
export { resolveVehicle, listAllModels }                                 from './vehicles/index.js';
export { resolveMainClass, resolvePartRegion, getVehideSeverityHint }   from './parts-map.js';
export { PRICE_TABLES, PART_LABELS, LIST_LABELS, SIZE_LABELS, DAMAGE_LABELS, VAT_RATE } from './price-tables.js';

// ── window.Pricing shim ───────────────────────────────────────────────────────
// Attaches all exports to window.Pricing so plain (non-module) scripts
// like app.js can call window.Pricing.buildEstimate(...) etc.
import { buildEstimate, lookupPrice, severityToDamageLevel, formatMUR } from './estimate.js';
import { resolveVehicle, listAllModels }                                 from './vehicles/index.js';
import { resolveMainClass, resolvePartRegion, getVehideSeverityHint }   from './parts-map.js';
import { PRICE_TABLES, PART_LABELS, LIST_LABELS, SIZE_LABELS, DAMAGE_LABELS, VAT_RATE } from './price-tables.js';

window.Pricing = {
  buildEstimate, lookupPrice, severityToDamageLevel, formatMUR,
  resolveVehicle, listAllModels,
  resolveMainClass, resolvePartRegion, getVehideSeverityHint,
  PRICE_TABLES, PART_LABELS, LIST_LABELS, SIZE_LABELS, DAMAGE_LABELS, VAT_RATE,
};