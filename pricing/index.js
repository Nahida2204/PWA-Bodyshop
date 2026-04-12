export { buildEstimate, lookupPrice, lookupPrices, severityToDamageLevel, formatMUR } from './estimate.js';
export { resolveVehicle, listAllModels }                                               from './vehicles/index.js';
export { resolveMainClass, resolvePartRegion, getVehideSeverityHint }                 from './parts-map.js';
export { FRU_TABLES, FORFAIT, PART_LABELS, LIST_LABELS, SIZE_LABELS,
         DAMAGE_LABELS, LABOUR_RATES, LABOUR_TIER_LABELS, VAT_RATE }                  from './price-tables.js';

// ── window.Pricing shim ───────────────────────────────────────────────────────
import { buildEstimate, lookupPrice, lookupPrices, severityToDamageLevel, formatMUR } from './estimate.js';
import { resolveVehicle, listAllModels }                                               from './vehicles/index.js';
import { resolveMainClass, resolvePartRegion, getVehideSeverityHint }                 from './parts-map.js';
import { FRU_TABLES, FORFAIT, PART_LABELS, LIST_LABELS, SIZE_LABELS,
         DAMAGE_LABELS, LABOUR_RATES, LABOUR_TIER_LABELS, VAT_RATE }                  from './price-tables.js';

window.Pricing = {
  buildEstimate, lookupPrice, lookupPrices, severityToDamageLevel, formatMUR,
  resolveVehicle, listAllModels,
  resolveMainClass, resolvePartRegion, getVehideSeverityHint,
  FRU_TABLES, FORFAIT, PART_LABELS, LIST_LABELS, SIZE_LABELS,
  DAMAGE_LABELS, LABOUR_RATES, LABOUR_TIER_LABELS, VAT_RATE,
};

// Signal to app.js that pricing tables are ready
window.dispatchEvent(new Event('pricing-ready'));