// pricing/estimate.js
// ─────────────────────────────────────────────────────────────────────────────
// Estimate builder — FRU-based pricing with legacy forfait comparison.
//
// PRIMARY: FRU calculation
//   cost = (dp × LEV1) + (r × LEV2) + (p × LEV1)
//   Labour tier: 'standard' (Kia) or 'ev' (EV5/EV6/EV9)
//
// COMPARISON: Legacy flat forfait prices shown alongside FRU total
//
// SEVERITY → DAMAGE LEVEL:
//   minor              → léger
//   moderate / severe  → moyen
// ─────────────────────────────────────────────────────────────────────────────

import {
  FRU_TABLES, FORFAIT, PART_LABELS, VAT_RATE,
  calcFruPrice,
} from './price-tables.js';
import {
  resolveMainClass,
  resolvePartRegion,
  getVehideSeverityHint,
  MAIN_DETECTION_MAP,
} from './parts-map.js';


// ── Class sets ────────────────────────────────────────────────────────────────
const LOCALISED_CLASSES = new Set(
  Object.entries(MAIN_DETECTION_MAP)
    .filter(([, v]) => v.partKey !== null)
    .map(([k]) => k)
);
const GENERIC_CLASSES = new Set(
  Object.entries(MAIN_DETECTION_MAP)
    .filter(([, v]) => v.partKey === null)
    .map(([k]) => k)
);
const EXTRA_VEHIDE_TYPES = new Set([
  'scratch', 'tear', 'hole', 'broken_glass', 'broken_light',
]);


// ── Helpers ───────────────────────────────────────────────────────────────────

export function severityToDamageLevel(sev) {
  return sev === 'minor' ? 'leger' : 'moyen';
}

function resolveDamageLevel(mainHint, vehideType, regionSeverity) {
  return mainHint
    ?? getVehideSeverityHint(vehideType)
    ?? severityToDamageLevel(regionSeverity);
}

function classifyMainClass(cls) {
  if (!cls) return 'unknown';
  const lower = cls.toLowerCase().trim();
  if (LOCALISED_CLASSES.has(lower)) return 'localised';
  if (GENERIC_CLASSES.has(lower))   return 'generic';
  return 'unknown';
}

function iod(a, b) {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  return (iw * ih) / Math.max(1, (ax2 - ax1) * (ay2 - ay1));
}

function boxesOverlap(a, b, threshold = 0.10) {
  return iod(a, b) > threshold || iod(b, a) > threshold;
}


// ── Price lookup (FRU + forfait) ──────────────────────────────────────────────

/**
 * Look up both FRU price and forfait price for one part.
 *
 * @param {string} partKey
 * @param {'leger'|'moyen'} damageLevel
 * @param {'medium'|'large'} size
 * @param {'client'|'interne'} listType
 * @param {'standard'|'ev'} labourTier
 *
 * @returns {{
 *   partKey:     string,
 *   partLabel:   string,
 *   damageLevel: string,
 *   fru: {
 *     dp: number, r: number, p: number,
 *     dp_cost: number, r_cost: number, p_cost: number,
 *     total: number,
 *     lev1: number, lev2: number,
 *   } | null,
 *   forfait: number | null,
 * } | null}
 */
export function lookupPrices(partKey, damageLevel, size, listType, labourTier = 'standard') {
  const fruResult  = calcFruPrice(partKey, damageLevel, size, labourTier);
  const forfaitVal = FORFAIT[listType]?.[partKey]?.[size]?.[damageLevel] ?? null;

  if (!fruResult && forfaitVal == null) return null;

  return {
    partKey,
    partLabel:   PART_LABELS[partKey] ?? partKey,
    damageLevel,
    fru: fruResult ? {
      dp:      fruResult.fru.dp,
      r:       fruResult.fru.r,
      p:       fruResult.fru.p,
      dp_cost: fruResult.dp_cost,
      r_cost:  fruResult.r_cost,
      p_cost:  fruResult.p_cost,
      total:   fruResult.total,
      lev1:    fruResult.rates.lev1,
      lev2:    fruResult.rates.lev2,
    } : null,
    forfait: forfaitVal,
  };
}

// Keep simple lookupPrice for backward compat (returns FRU total)
export function lookupPrice(partKey, damageLevel, size, listType, labourTier = 'standard') {
  const res = lookupPrices(partKey, damageLevel, size, listType, labourTier);
  return res?.fru?.total ?? res?.forfait ?? null;
}


// ── Make a line item ──────────────────────────────────────────────────────────

function makeItem({ partKey, mainClass, damageType, severity, damageLevel,
                    size, listType, labourTier, conf, note }) {
  const prices = lookupPrices(partKey, damageLevel, size, listType, labourTier);
  if (!prices) return null;
  return {
    part:        prices.partLabel,
    partKey,
    mainClass,
    damageType,
    severity,
    damageLevel,
    fru:         prices.fru,        // full FRU breakdown
    forfait:     prices.forfait,     // legacy flat price
    price:       prices.fru?.total ?? prices.forfait ?? 0,  // primary price = FRU
    conf,
    note,
  };
}


// ── Per-region processor ──────────────────────────────────────────────────────

function processRegion(region, s1Detections, overallSeverity,
                       vehicleSize, listType, labourTier) {
  const triggerClass   = region.triggered_by?.type?.toLowerCase().trim() ?? '';
  const triggerBox     = region.triggered_by?.box ?? [0, 0, 0, 0];
  const regionSeverity = region.severity?.class ?? overallSeverity;
  const damages        = region.damages ?? [];
  const triggerKind    = classifyMainClass(triggerClass);

  const lineItems    = [];
  const unknownParts = [];
  const mainResolved = resolveMainClass(triggerClass);

  // ── Gather overlapping localised main.pt detections ───────────────────────
  const localisedSources = [];
  const seenLocalisedKeys = new Set();

  if (triggerKind === 'localised' && mainResolved?.partKey) {
    const { partKey, severityHint } = mainResolved;
    if (!seenLocalisedKeys.has(partKey)) {
      seenLocalisedKeys.add(partKey);
      localisedSources.push({
        cls: triggerClass, partKey, severityHint,
        conf: region.triggered_by?.conf ?? 1,
      });
    }
  }

  for (const det of s1Detections) {
    const cls = det.type?.toLowerCase().trim();
    if (cls === triggerClass) continue;
    if (!LOCALISED_CLASSES.has(cls)) continue;
    if (!boxesOverlap(det.box, triggerBox)) continue;
    const r = resolveMainClass(cls);
    if (r?.partKey && !seenLocalisedKeys.has(r.partKey)) {
      seenLocalisedKeys.add(r.partKey);
      localisedSources.push({ cls, ...r, conf: det.conf });
    }
  }

  // ── Localised sources → line items (Scenario A / C) ──────────────────────
  for (const src of localisedSources) {
    const damageLevel = resolveDamageLevel(src.severityHint, damages[0]?.type, regionSeverity);
    const item = makeItem({
      partKey: src.partKey, mainClass: src.cls,
      damageType: damages[0]?.type ?? '', severity: regionSeverity,
      damageLevel, size: vehicleSize, listType, labourTier,
      conf: src.conf, note: 'localised',
    });
    if (item) lineItems.push(item);
    else unknownParts.push(`${src.partKey} (no price)`);
  }

  // ── Scenario C: extra vehide types on localised parts ────────────────────
  if (localisedSources.length > 0) {
    const extraTypes = new Set(
      damages.map(d => d.type?.toLowerCase().trim())
        .filter(t => t && t !== 'dent' && EXTRA_VEHIDE_TYPES.has(t))
    );
    for (const vehideType of extraTypes) {
      const vehideHint = getVehideSeverityHint(vehideType);
      const extraLevel = vehideHint ?? severityToDamageLevel(regionSeverity);
      const item = makeItem({
        partKey: 'spot_repair', mainClass: triggerClass,
        damageType: vehideType, severity: regionSeverity,
        damageLevel: extraLevel, size: vehicleSize, listType, labourTier,
        conf: damages.find(d => d.type === vehideType)?.conf ?? 0.5,
        note: 'additional',
      });
      if (item) lineItems.push(item);
    }
  }

  // ── Scenario B: generic trigger → use car_part.pt ────────────────────────
  if (localisedSources.length === 0) {
    const seenParts = new Set();

    for (const damage of damages) {
      const partKey = resolvePartRegion(damage.on_part);
      if (!partKey) {
        const label = damage.on_part || damage.type || triggerClass;
        if (label && label !== 'unknown') unknownParts.push(label);
        continue;
      }
      if (seenParts.has(partKey)) continue;
      seenParts.add(partKey);

      const damageLevel = resolveDamageLevel(null, damage.type, regionSeverity);
      const item = makeItem({
        partKey, mainClass: triggerClass, damageType: damage.type,
        severity: regionSeverity, damageLevel,
        size: vehicleSize, listType, labourTier,
        conf: damage.conf, note: 'generic',
      });
      if (item) lineItems.push(item);
      else unknownParts.push(`${partKey} (no price)`);
    }

    // Last resort — try main class directly
    if (lineItems.length === 0 && mainResolved?.partKey) {
      const damageLevel = resolveDamageLevel(mainResolved.severityHint, '', regionSeverity);
      const item = makeItem({
        partKey: mainResolved.partKey, mainClass: triggerClass,
        damageType: '', severity: regionSeverity, damageLevel,
        size: vehicleSize, listType, labourTier,
        conf: region.triggered_by?.conf ?? 1, note: 'fallback',
      });
      if (item) lineItems.push(item);
    }
  }

  return { lineItems, unknownParts };
}


// ── Full estimate builder ─────────────────────────────────────────────────────

/**
 * Build a full itemised estimate from the /predict pipeline result.
 *
 * @param {object} pipelineResult
 * @param {{
 *   listType?:    'client'|'interne',
 *   vehicleSize?: 'medium'|'large',
 *   labourTier?:  'standard'|'ev',
 * }} options
 */
export function buildEstimate(pipelineResult, {
  listType    = 'client',
  vehicleSize = 'medium',
  labourTier  = 'standard',
} = {}) {
  const { stage1, stage2 } = pipelineResult ?? {};
  const overallSeverity    = stage1?.severity?.class ?? 'minor';
  const s1Detections       = stage1?.detections ?? [];

  const allLineItems = [];
  const allUnknown   = [];
  const globalSeen   = new Set();

  for (const region of (stage2 ?? [])) {
    const { lineItems, unknownParts } = processRegion(
      region, s1Detections, overallSeverity,
      vehicleSize, listType, labourTier,
    );
    for (const item of lineItems) {
      // partKey + note: allows 'localised' + 'additional' for same part (Scenario C)
      // but blocks same part appearing twice as 'generic' from two photos
      const key = `${item.partKey}__${item.note === 'additional' ? 'additional' : 'main'}`;
      if (globalSeen.has(key)) continue;
      globalSeen.add(key);
      allLineItems.push(item);
    }
    allUnknown.push(...unknownParts);
  }

  // FRU-based totals (primary)
  const fruSubtotal  = allLineItems.reduce((s, i) => s + (i.fru?.total ?? 0), 0);
  const fruVat       = Math.round(fruSubtotal * VAT_RATE);
  const fruTotal     = fruSubtotal + fruVat;

  // Forfait totals (comparison)
  const forfaitSubtotal = allLineItems.reduce((s, i) => s + (i.forfait ?? 0), 0);
  const forfaitVat      = Math.round(forfaitSubtotal * VAT_RATE);
  const forfaitTotal    = forfaitSubtotal + forfaitVat;

  return {
    listType,
    vehicleSize,
    labourTier,
    overallSeverity,
    lineItems:    allLineItems,

    // FRU (primary)
    subtotal:     fruSubtotal,
    vat:          fruVat,
    total:        fruTotal,

    // Forfait (comparison)
    forfaitSubtotal,
    forfaitVat,
    forfaitTotal,

    currency:     'MUR',
    unknownParts: [...new Set(allUnknown)],
  };
}


// ── Format helpers ────────────────────────────────────────────────────────────

export function formatMUR(amount) {
  return `Rs ${Number(amount).toLocaleString('en-MU')}`;
}