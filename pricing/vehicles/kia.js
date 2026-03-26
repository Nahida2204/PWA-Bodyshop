// pricing/vehicles/kia.js
// ─────────────────────────────────────────────────────────────────────────────
// Kia model definitions.
// labourTier: 'standard' → LEV1 Rs175 / LEV2 Rs225
//             'ev'       → LEV1 Rs225 / LEV2 Rs255  (EV5, EV6, EV9)
// ─────────────────────────────────────────────────────────────────────────────

const KIA = {
  brand:       'kia',
  displayName: 'Kia',

  models: [
    // ── Medium (Taille Moyenne) ──────────────────────────────────────────────
    { name: 'picanto',   size: 'medium', labourTier: 'standard', aliases: ['morning'] },
    { name: 'rio',       size: 'medium', labourTier: 'standard', aliases: ['pride'] },
    { name: 'stonic',    size: 'medium', labourTier: 'standard', aliases: [] },
    { name: 'soul',      size: 'medium', labourTier: 'standard', aliases: [] },
    { name: 'ceed',      size: 'medium', labourTier: 'standard', aliases: ["cee'd", 'proceed'] },
    { name: 'xceed',     size: 'medium', labourTier: 'standard', aliases: [] },
    { name: 'niro',      size: 'medium', labourTier: 'standard', aliases: ['niro hybrid', 'niro phev'] },
    { name: 'sportage',  size: 'medium', labourTier: 'standard', aliases: [] },
    { name: 'seltos',    size: 'medium', labourTier: 'standard', aliases: [] },

    // ── Large (Grande Taille) ────────────────────────────────────────────────
    { name: 'sorento',   size: 'large',  labourTier: 'standard', aliases: [] },
    { name: 'telluride', size: 'large',  labourTier: 'standard', aliases: [] },
    { name: 'carnival',  size: 'large',  labourTier: 'standard', aliases: ['sedona'] },
    { name: 'stinger',   size: 'large',  labourTier: 'standard', aliases: [] },
    { name: 'carens',    size: 'large',  labourTier: 'standard', aliases: [] },
    { name: 'k5',        size: 'large',  labourTier: 'standard', aliases: ['optima'] },
    { name: 'k8',        size: 'large',  labourTier: 'standard', aliases: ['cadenza'] },

    // ── EV / Hybrid — higher labour rate ─────────────────────────────────────
    { name: 'ev5',       size: 'medium', labourTier: 'ev', aliases: ['ev 5'] },
    { name: 'ev6',       size: 'large',  labourTier: 'ev', aliases: ['ev 6'] },
    { name: 'ev9',       size: 'large',  labourTier: 'ev', aliases: ['ev 9'] },
    { name: 'niro ev',   size: 'medium', labourTier: 'ev', aliases: ['niro electric'] },
  ],
};

export default KIA;