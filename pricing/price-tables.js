export const VAT_RATE = 0.15;


// ── Labour rates ──────────────────────────────────────────────────────────────

export const LABOUR_RATES = {
  // Standard Kia / Mitsubishi / GWM / Haval
  standard: { lev1: 175, lev2: 225 },
  // EV / Hybrid / Luxury — Kia EV5, EV6, EV9
  ev:       { lev1: 225, lev2: 255 },
};

/**
 * Resolve labour rates for a vehicle.
 * @param {'standard'|'ev'} labourTier
 * @returns {{ lev1: number, lev2: number }}
 */
export function getLabourRates(labourTier = 'standard') {
  return LABOUR_RATES[labourTier] ?? LABOUR_RATES.standard;
}


// ── FRU tables ────────────────────────────────────────────────────────────────
// Structure: FRU_TABLES[size][damageLevel][partKey] = { dp, r, p }
//
// size        : 'medium' (Taille Moyenne) | 'large' (Grande Taille)
// damageLevel : 'leger' | 'moyen'
// dp, r, p    : FRU values (Flat Rate Units, 12 FRU = 1 hour)

export const FRU_TABLES = {
  medium: {
    leger: {
      front_bumper:  { dp: 12, r:  3, p: 27 },
      bonnet:        { dp:  6, r:  3, p: 36 },
      front_fender:  { dp:  9, r:  3, p: 24 },
      front_door:    { dp: 12, r:  3, p: 30 },
      rear_door:     { dp: 12, r:  3, p: 30 },
      rear_fender:   { dp:  6, r:  3, p: 30 },
      rear_bumper:   { dp:  9, r:  3, p: 27 },
      trunk:         { dp:  9, r:  3, p: 30 },
      roof:          { dp:  9, r:  3, p: 42 },
      sill:          { dp:  0, r:  3, p: 15 },
      mirror:        { dp:  3, r:  3, p:  6 },
      wheel_rim:     { dp:  4, r:  6, p: 15 },
      spot_repair:   { dp:  2, r:  3, p: 20 },
      paint_touchup: { dp:  2, r:  0, p:  9 },
    },
    moyen: {
      front_bumper:  { dp: 15, r: 24, p: 33 },
      bonnet:        { dp:  6, r: 24, p: 42 },
      front_fender:  { dp:  9, r: 24, p: 30 },
      front_door:    { dp: 12, r: 24, p: 36 },
      rear_door:     { dp: 12, r: 24, p: 36 },
      rear_fender:   { dp:  6, r: 24, p: 36 },
      rear_bumper:   { dp: 12, r: 24, p: 30 },
      trunk:         { dp:  9, r: 24, p: 36 },
      roof:          { dp: 18, r: 24, p: 42 },
      sill:          { dp:  0, r: 24, p: 18 },
      mirror:        { dp:  3, r: 24, p:  6 },   // mirror moyen = same FRU, higher labour cost
      wheel_rim:     { dp:  4, r:  6, p: 15 },
      spot_repair:   { dp:  2, r:  3, p: 20 },
      paint_touchup: { dp:  2, r:  0, p:  9 },
    },
  },

  large: {
    leger: {
      front_bumper:  { dp: 18, r:  3, p: 33 },
      bonnet:        { dp:  9, r:  3, p: 42 },
      front_fender:  { dp:  9, r:  3, p: 30 },
      front_door:    { dp: 15, r:  3, p: 36 },
      rear_door:     { dp: 15, r:  3, p: 36 },
      rear_fender:   { dp:  9, r:  3, p: 36 },
      rear_bumper:   { dp: 12, r:  3, p: 30 },
      trunk:         { dp: 12, r:  3, p: 36 },
      roof:          { dp:  9, r:  3, p: 54 },
      sill:          { dp:  0, r:  3, p: 18 },
      mirror:        { dp:  3, r:  3, p:  6 },
      wheel_rim:     { dp:  4, r:  6, p: 15 },
      spot_repair:   { dp:  2, r:  3, p: 20 },
      paint_touchup: { dp:  2, r:  0, p: 12 },
    },
    moyen: {
      front_bumper:  { dp: 21, r: 24, p: 36 },
      bonnet:        { dp: 12, r: 24, p: 48 },
      front_fender:  { dp: 12, r: 24, p: 36 },
      front_door:    { dp: 18, r: 24, p: 42 },
      rear_door:     { dp: 18, r: 24, p: 42 },
      rear_fender:   { dp: 12, r: 24, p: 39 },
      rear_bumper:   { dp: 15, r: 24, p: 36 },
      trunk:         { dp: 15, r: 24, p: 39 },
      roof:          { dp: 18, r: 24, p: 48 },
      sill:          { dp:  0, r: 24, p: 24 },
      mirror:        { dp:  3, r: 24, p:  6 },
      wheel_rim:     { dp:  4, r:  6, p: 15 },
      spot_repair:   { dp:  2, r:  3, p: 20 },
      paint_touchup: { dp:  2, r:  0, p: 12 },
    },
  },
};


// ── Calculate FRU-based price ─────────────────────────────────────────────────

/**
 * Calculate the MUR cost for a part using FRU rates.
 *
 * @param {string}           partKey      e.g. 'front_bumper'
 * @param {'leger'|'moyen'}  damageLevel
 * @param {'medium'|'large'} size
 * @param {'standard'|'ev'}  labourTier
 *
 * @returns {{
 *   dp_cost:   number,   D/P operation cost
 *   r_cost:    number,   R  operation cost
 *   p_cost:    number,   P  operation cost
 *   total:     number,   total excl. VAT
 *   fru:       { dp, r, p }
 *   rates:     { lev1, lev2 }
 * } | null}
 */
export function calcFruPrice(partKey, damageLevel, size, labourTier = 'standard') {
  const fru = FRU_TABLES[size]?.[damageLevel]?.[partKey];
  if (!fru) return null;

  const rates   = getLabourRates(labourTier);
  const dp_cost = fru.dp * rates.lev1;
  const r_cost  = fru.r  * rates.lev2;
  const p_cost  = fru.p  * rates.lev1;
  const total   = dp_cost + r_cost + p_cost;

  return { dp_cost, r_cost, p_cost, total, fru, rates };
}


// ── Legacy forfait prices (2025 flat rates) ───────────────────────────────────
// Kept for side-by-side comparison only.
// Structure: FORFAIT[listType][partKey][size][damageLevel] = MUR excl. VAT

export const FORFAIT = {
  client: {
    front_bumper:  { medium: { leger:  9229, moyen: 14864 }, large: { leger: 11701, moyen: 16603 } },
    bonnet:        { medium: { leger: 10569, moyen: 15813 }, large: { leger: 12564, moyen: 18343 } },
    front_fender:  { medium: { leger:  7993, moyen: 13122 }, large: { leger:  9516, moyen: 15180 } },
    door:    { medium: { leger:  9994, moyen: 15180 }, large: { leger: 11989, moyen: 17710 } },
    rear_fender:   { medium: { leger:  9039, moyen: 14231 }, large: { leger: 11040, moyen: 15974 } },
    rear_bumper:   { medium: { leger:  8763, moyen: 13599 }, large: { leger:  9994, moyen: 15663 } },
    trunk:         { medium: { leger:  9516, moyen: 14709 }, large: { leger: 11529, moyen: 16445 } },
    roof:          { medium: { leger: 12564, moyen: 17710 }, large: { leger: 15611, moyen: 19291 } },
    sill:          { medium: { leger:  4284, moyen:  8539 }, large: { leger:  5049, moyen: 10120 } },
    paint_touchup: { medium: { leger:  2208, moyen:  2208 }, large: { leger:  2829, moyen:  2829 } },
    mirror:        { medium: { leger:  2473, moyen:  2473 }, large: { leger:  2473, moyen:  2473 } },
    wheel_rim:     { medium: { leger:  5750, moyen:  5750 }, large: { leger:  5750, moyen:  5750 } },
    spot_repair:   { medium: { leger:  6325, moyen:  6325 }, large: { leger:  6325, moyen:  6325 } },
    windshield_repair: { medium: { leger:  8400, moyen:  8400 }, large: { leger:  8400, moyen:  8400 } },
    light_repair:   { medium: { leger:  6325, moyen:  6325 }, large: { leger:  6325, moyen:  6325 } },

  },
  interne: {
    front_bumper:  { medium: { leger:  7533, moyen: 12018 }, large: { leger:  9528, moyen: 13403 } },
    bonnet:        { medium: { leger:  8711, moyen: 12920 }, large: { leger: 10344, moyen: 14973 } },
    front_fender:  { medium: { leger:  6532, moyen: 10626 }, large: { leger:  7803, moyen: 12317 } },
    door:    { medium: { leger:  8165, moyen: 12317 }, large: { leger:  9798, moyen: 14369 } },
    rear_fender:   { medium: { leger:  7441, moyen: 11592 }, large: { leger:  9074, moyen: 12981 } },
    rear_bumper:   { medium: { leger:  7170, moyen: 10988 }, large: { leger:  8165, moyen: 12679 } },
    trunk:         { medium: { leger:  7803, moyen: 11954 }, large: { leger:  9436, moyen: 13343 } },
    roof:          { medium: { leger: 10344, moyen: 14369 }, large: { leger: 12886, moyen: 15698 } },
    sill:          { medium: { leger:  3542, moyen:  6883 }, large: { leger:  4175, moyen:  8211 } },
    paint_touchup: { medium: { leger:  1760, moyen:  1760 }, large: { leger:  2266, moyen:  2266 } },
    mirror:        { medium: { leger:  1995, moyen:  1995 }, large: { leger:  1995, moyen:  1995 } },
    wheel_rim:     { medium: { leger:  5175, moyen:  5175 }, large: { leger:  5175, moyen:  5175 } },
    spot_repair:   { medium: { leger:  5463, moyen:  5463 }, large: { leger:  5463, moyen:  5463 } },
    windshield_repair: { medium: { leger:  6000, moyen:  6000 }, large: { leger:  6000, moyen:  6000 } },
    light_repair:   { medium: { leger:  5000, moyen:  5000 }, large: { leger:  5000, moyen:  5000} },
  },
};


// ── Labels ────────────────────────────────────────────────────────────────────

export const PART_LABELS = {
  front_bumper:  'Front Bumper (P/Chocs AV)',
  rear_bumper:   'Rear Bumper (P/Chocs AR)',
  bonnet:        'Bonnet / Hood (Capot)',
  front_fender:  'Front Fender (Aile AV)',
  rear_fender:   'Rear Fender (Aile AR)',
  front_door:    'Front Door (Porte AV)',
  rear_door:     'Rear Door (Porte AR)',
  trunk:         'Trunk / Boot (Coffre)',
  roof:          'Roof (Pavillon)',
  sill:          'Sill / Rocker (Bas de Caisse)',
  paint_touchup: 'Paint Touch-up (Raccord Peinture)',
  mirror:        'Mirror (Rétroviseur)',
  wheel_rim:     'Wheel Rim (Jante)',
  spot_repair:   'Spot Repair (sans démontage)',
};

export const SIZE_LABELS = {
  medium: 'Taille Moyenne',
  large:  'Grande Taille',
};

export const DAMAGE_LABELS = {
  leger: 'Dommage Léger',
  moyen: 'Dommage Moyen',
};

export const LIST_LABELS = {
  client:  'CLIENT LEAL GROUP',
  interne: 'INTERNE LEAL Co Ltd',
};

export const LABOUR_TIER_LABELS = {
  standard: 'Kia / Standard',
  ev:       'EV / Hybrid / Luxury',
};