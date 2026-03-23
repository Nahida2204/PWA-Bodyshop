// TO ADD A NEW MODEL:
//   1. Add it to the `models` array below with correct `size`.
//   2. Add any alternate names/spellings in `aliases`.

const KIA = {
  brand: 'kia',
  displayName: 'Kia',

  // Canonical model list
  models: [
    // ── Medium (Taille Moyenne) ──────────────────────────────────────────────
    { name: 'picanto',      size: 'medium', aliases: ['morning'] },
    { name: 'rio',          size: 'medium', aliases: ['pride'] },
    { name: 'stonic',       size: 'medium', aliases: [] },
    { name: 'soul',         size: 'medium', aliases: [] },
    { name: 'niro',         size: 'medium', aliases: ['niro ev', 'niro hybrid', 'niro phev'] },
    { name: 'sportage',     size: 'medium', aliases: [] },         // compact SUV → medium

    // ── Large (Grande Taille) ────────────────────────────────────────────────
    { name: 'sorento',      size: 'large',  aliases: [] },
    { name: 'carnival',     size: 'large',  aliases: ['sedona'] },
    { name: 'EV6',          size: 'large',  aliases: ['EV 6'] },
    { name: 'EV9',          size: 'large',  aliases: ['EV 9'] },
    
  ],
};

export default KIA;