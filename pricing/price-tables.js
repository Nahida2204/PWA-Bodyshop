// pricing/price-tables.js
// ─────────────────────────────────────────────────────────────────────────────
// LEAL Group Bodyshop – FORFAITS CARROSSERIE PEINTURE 2025
// All prices in MUR, excl. VAT.
// Applicable from 01 April 2025.
//
// Structure:
//   PRICE_TABLES[listType][partKey][size][damageLevel]
//
//   listType    : 'client' | 'interne'
//   partKey     : canonical part identifier (see parts-map.js)
//   size        : 'medium' (Taille Moyenne) | 'large' (Grande Taille)
//   damageLevel : 'leger' (Dommages Léger) | 'moyen' (Dommages Moyen)
//
// TO UPDATE PRICES: edit the numbers below.
// TO ADD A NEW PART: add the same key to both 'client' and 'interne',
//   then register the detector → key mapping in parts-map.js.
// ─────────────────────────────────────────────────────────────────────────────

export const PRICE_TABLES = {

  client: {
    //                          ── MEDIUM ──────────────  ── LARGE ───────────
    //  partKey              leger      moyen              leger      moyen
    front_bumper:  { medium: { leger:  9229, moyen: 14864 }, large: { leger: 11701, moyen: 16603 } },
    bonnet:        { medium: { leger: 10569, moyen: 15813 }, large: { leger: 12564, moyen: 18343 } },
    front_fender:  { medium: { leger:  7993, moyen: 13122 }, large: { leger:  9516, moyen: 15180 } },
    front_door:    { medium: { leger:  9994, moyen: 15180 }, large: { leger: 11989, moyen: 17710 } },
    rear_door:     { medium: { leger:  9994, moyen: 15180 }, large: { leger: 11989, moyen: 17710 } },
    rear_fender:   { medium: { leger:  9039, moyen: 14231 }, large: { leger: 11040, moyen: 15974 } },
    rear_bumper:   { medium: { leger:  8763, moyen: 13599 }, large: { leger:  9994, moyen: 15663 } },
    trunk:         { medium: { leger:  9516, moyen: 14709 }, large: { leger: 11529, moyen: 16445 } },
    roof:          { medium: { leger: 12564, moyen: 17710 }, large: { leger: 15611, moyen: 19291 } },
    sill:          { medium: { leger:  4284, moyen:  8539 }, large: { leger:  5049, moyen: 10120 } },
    paint_touchup: { medium: { leger:  2208, moyen:  2208 }, large: { leger:  2829, moyen:  2829 } },
    mirror:        { medium: { leger:  2473, moyen:  2473 }, large: { leger:  2473, moyen:  2473 } },
    wheel_rim:     { medium: { leger:  5750, moyen:  5750 }, large: { leger:  5750, moyen:  5750 } },
    spot_repair:   { medium: { leger:  6325, moyen:  6325 }, large: { leger:  6325, moyen:  6325 } },
  },

  interne: {
    front_bumper:  { medium: { leger:  7533, moyen: 12018 }, large: { leger:  9528, moyen: 13403 } },
    bonnet:        { medium: { leger:  8711, moyen: 12920 }, large: { leger: 10344, moyen: 14973 } },
    front_fender:  { medium: { leger:  6532, moyen: 10626 }, large: { leger:  7803, moyen: 12317 } },
    front_door:    { medium: { leger:  8165, moyen: 12317 }, large: { leger:  9798, moyen: 14369 } },
    rear_door:     { medium: { leger:  8165, moyen: 12317 }, large: { leger:  9798, moyen: 14369 } },
    rear_fender:   { medium: { leger:  7441, moyen: 11592 }, large: { leger:  9074, moyen: 12981 } },
    rear_bumper:   { medium: { leger:  7170, moyen: 10988 }, large: { leger:  8165, moyen: 12679 } },
    trunk:         { medium: { leger:  7803, moyen: 11954 }, large: { leger:  9436, moyen: 13343 } },
    roof:          { medium: { leger: 10344, moyen: 14369 }, large: { leger: 12886, moyen: 15698 } },
    sill:          { medium: { leger:  3542, moyen:  6883 }, large: { leger:  4175, moyen:  8211 } },
    paint_touchup: { medium: { leger:  1760, moyen:  1760 }, large: { leger:  2266, moyen:  2266 } },
    mirror:        { medium: { leger:  1995, moyen:  1995 }, large: { leger:  1995, moyen:  1995 } },
    wheel_rim:     { medium: { leger:  5175, moyen:  5175 }, large: { leger:  5175, moyen:  5175 } },
    spot_repair:   { medium: { leger:  5463, moyen:  5463 }, large: { leger:  5463, moyen:  5463 } },
  },

};

/**
 * Human-readable labels for each part key.
 * Used in estimate UI and PDF reports.
 */
export const PART_LABELS = {
  front_bumper:  'Front Bumper (P/Chocs AV)',
  rear_bumper:   'Rear Bumper (P/Chocs AR)',
  bonnet:        'Bonnet / Hood (Capot Moteur)',
  front_fender:  'Front Fender (Aile AV)',
  rear_fender:   'Rear Fender (Aile AR)',
  front_door:    'Front Door (Porte AV)',
  rear_door:     'Rear Door (Porte AR)',
  trunk:         'Trunk / Boot (Coffre)',
  roof:          'Roof (Pavillon)',
  sill:          'Sill / Rocker Panel (Bas de Caisse)',
  paint_touchup: 'Paint Touch-up (Raccord Peinture)',
  mirror:        'Mirror (Coque Rétroviseur)',
  wheel_rim:     'Wheel Rim (Jante)',
  spot_repair:   'Spot Repair (sans démontage)',
};

export const LIST_LABELS = {
  client:  'CLIENT LEAL GROUP',
  interne: 'INTERNE LEAL Co Ltd',
};

export const SIZE_LABELS = {
  medium: 'Taille Moyenne',
  large:  'Grande Taille',
};

export const DAMAGE_LABELS = {
  leger: 'Dommages Léger',
  moyen: 'Dommages Moyen',
};

export const VAT_RATE = 0.15;