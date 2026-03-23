// pricing/vehicles/_TEMPLATE.js
// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE — copy this file to add a new brand, e.g. bmw.js
//
// Steps:
//   1. Copy this file:   cp _TEMPLATE.js bmw.js
//   2. Fill in the brand info and models below.
//   3. Open vehicles/index.js and:
//        import BMW from './bmw.js';
//        const BRANDS = [ KIA, BMW, ... ];
// ─────────────────────────────────────────────────────────────────────────────

const BRAND_TEMPLATE = {
  brand: 'brand_id',       // lowercase, no spaces  e.g. 'bmw'
  displayName: 'Brand',    // display name           e.g. 'BMW'

  models: [
    // ── Medium (Taille Moyenne) ──────────────────────────────────────────────
    // { name: 'model name', size: 'medium', aliases: ['alternate name'] },

    // ── Large (Grande Taille) ────────────────────────────────────────────────
    // { name: 'model name', size: 'large',  aliases: [] },
  ],
};

export default BRAND_TEMPLATE;


// ── EXAMPLE: BMW ─────────────────────────────────────────────────────────────
/*
const BMW = {
  brand: 'bmw',
  displayName: 'BMW',
  models: [
    { name: '1 series',  size: 'medium', aliases: ['116i', '118i', '120i'] },
    { name: '2 series',  size: 'medium', aliases: ['218i', '220i'] },
    { name: '3 series',  size: 'large',  aliases: ['320i', '330i', '320d'] },
    { name: '5 series',  size: 'large',  aliases: ['520i', '530i', '520d'] },
    { name: 'x1',        size: 'medium', aliases: [] },
    { name: 'x3',        size: 'large',  aliases: [] },
    { name: 'x5',        size: 'large',  aliases: [] },
    { name: 'mini',      size: 'medium', aliases: ['mini cooper', 'mini hatch'] },
  ],
};
export default BMW;
*/