
export const MAIN_DETECTION_MAP = {

  // Bumpers
  'damaged-front-bumper':    { partKey: 'front_bumper', severityHint: null    },
  'front-bumper-dent':       { partKey: 'front_bumper', severityHint: null    },
  'damaged-rear-bumper':     { partKey: 'rear_bumper',  severityHint: null    },
  'rear-bumper-dent':        { partKey: 'rear_bumper',  severityHint: null    },
  'major-rear-bumper-dent':  { partKey: 'rear_bumper',  severityHint: 'moyen' },

  // Hood / Bonnet
  'damaged-hood':            { partKey: 'bonnet',       severityHint: null    },
  'bonnet-dent':             { partKey: 'bonnet',       severityHint: null    },

  // Trunk
  'damaged-trunk':           { partKey: 'trunk',        severityHint: null    },

  // Doors
  'damaged-door':            { partKey: 'door',   severityHint: null    },
  'doorouter-dent':          { partKey: 'door',   severityHint: null    },

  // Fender / Quarter
  'fender-dent':             { partKey: 'front_fender', severityHint: null    },
  'quaterpanel-dent':        { partKey: 'rear_fender',  severityHint: null    },

  // Roof
  'roof-dent':               { partKey: 'roof',         severityHint: null    },

  // Sill / Running board
  'runningboard-dent':       { partKey: 'sill',         severityHint: null    },

  // Mirror
  'sidemirror-damage':       { partKey: 'mirror',       severityHint: null    },

  // Lights & Glass → spot repair
  'damaged-head-light':      { partKey: 'spot_repair',  severityHint: null    },
  'damaged-tail-light':      { partKey: 'spot_repair',  severityHint: null    },
  'damaged-window':          { partKey: 'spot_repair',  severityHint: null    },
  'damaged-windscreen':      { partKey: 'spot_repair',  severityHint: null    },
  'damaged-rear-window':     { partKey: 'spot_repair',  severityHint: null    },
  'front-windscreen-damage': { partKey: 'windshield_repair',  severityHint: null    },
  'rear-windscreen-damage':  { partKey: 'windshield_repair',  severityHint: null    },
  'headlight-damage':        { partKey: 'light_repair',  severityHint: null    },
  'taillight-damage':        { partKey: 'light_repair',  severityHint: null    },
  'signlight-damage':        { partKey: 'light_repair',  severityHint: null    },

  // Generic — no part info, fall back to car_part.pt
  'damaged':                 { partKey: null,            severityHint: null    },
  'scratchdent':             { partKey: null,            severityHint: null    },
  'dent-or-scratch':         { partKey: null,            severityHint: null    },
  'medium-bodypanel-dent':   { partKey: null,            severityHint: 'leger' },
  'pillar-dent':             { partKey: null,            severityHint: null    },
};


// ── 2. car_part.pt classes (EXACT model output) ───────────────────────────────
//
// Model classes:
//   0: back_bumper        1: back_door          2: back_glass
//   3: back_left_door     4: back_left_light    5: back_light
//   6: back_right_door    7: back_right_light   8: front_bumper
//   9: front_door        10: front_glass       11: front_left_door
//  12: front_left_light  13: front_light       14: front_right_door
//  15: front_right_light 16: hood              17: left_mirror
//  18: object            19: right_mirror      20: tailgate
//  21: trunk             22: wheel
//
export const PART_REGION_MAP = {

  // ── Bumpers ────────────────────────────────────────────────
  'front_bumper':       'front_bumper',
  'back_bumper':        'rear_bumper',

  // ── Hood ───────────────────────────────────────────────────
  'hood':               'bonnet',

  // ── Trunk / Tailgate ───────────────────────────────────────
  'trunk':              'trunk',
  'tailgate':           'trunk',       // tailgate and trunk → same price line

  // ── Doors ──────────────────────────────────────────────────
  'front_door':         'door',
  'front_left_door':    'door',
  'front_right_door':   'door',
  'back_door':          'door',
  'back_left_door':     'door',
  'back_right_door':    'door',

  // ── Mirrors ────────────────────────────────────────────────
  'left_mirror':        'mirror',
  'right_mirror':       'mirror',

  // ── Wheels ─────────────────────────────────────────────────
  'wheel':              'wheel_rim',

  // ── Glass (→ spot repair) ──────────────────────────────────
  'front_glass':        'windshield_repair',
  'back_glass':         'windshield_repair',

  // ── Lights (→ spot repair) ─────────────────────────────────
  'front_light':        'light_repair',
  'front_left_light':   'light_repair',
  'front_right_light':  'light_repair',
  'back_light':         'light_repair',
  'back_left_light':    'light_repair',
  'back_right_light':   'light_repair',

  // ── Generic / unknown ──────────────────────────────────────
  'object':             null,           // detector catch-all → skip pricing
};


// ── 3. vehide.pt damage classes ───────────────────────────────────────────────
// No part info. Only contribute a severity hint.
// Part resolution still depends on car_part.pt region.
export const VEHIDE_DAMAGE_MAP = {
  'dent':         { severityHint: null    },
  'scratch':      { severityHint: null    },
  'tear':         { severityHint: 'moyen' },
  'broken_light': { partKey: 'light_repair',  severityHint: 'moyen' },  
  'broken_glass': { partKey: 'windshield_repair', severityHint: 'moyen' },
  'hole':         { severityHint: 'moyen' },
};


// ── Resolver functions ────────────────────────────────────────────────────────

/**
 * Resolve a main.pt class → { partKey, severityHint } | null
 */
export function resolveMainClass(cls) {
  if (!cls) return null;
  return MAIN_DETECTION_MAP[cls.toLowerCase().trim()] ?? null;
}

/**
 * Resolve a car_part.pt class → price key string | null
 */
export function resolvePartRegion(partName) {
  if (!partName) return null;
  const key = partName.toLowerCase().trim();
  // Explicit null means "known but unpriceable" (e.g. 'object')
  if (key in PART_REGION_MAP) return PART_REGION_MAP[key];
  return null;
}

/**
 * Get severity hint from a vehide.pt damage class → 'leger'|'moyen'|null
 */
export function getVehideSeverityHint(cls) {
  if (!cls) return null;
  return VEHIDE_DAMAGE_MAP[cls.toLowerCase().trim()]?.severityHint ?? null;
}