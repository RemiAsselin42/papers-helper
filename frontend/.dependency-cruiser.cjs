/**
 * Gates d'architecture (frontend) — dependency-cruiser.
 *
 * Gate 1 : `no-circular` — aucun cycle d'imports.
 * Gate 2 : contrats de COUCHES — une couche basse ne doit pas importer une
 *          couche plus haute. Couches (bas -> haut) :
 *            L0 types/constants/prompts < L1 utils < L2 api < L3 hooks
 *            < L4 components < L5 racine (App.tsx / main.tsx).
 * Les deux partagent le meme baseline (--ignore-known) : cliquet (les violations
 * existantes sont tolerees, seules les NOUVELLES bloquent). Semantique RUNTIME
 * des deux gates (tsPreCompilationDeps:false ci-dessous), alignee sur le backend.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      // Nom affiché quand la règle est violée. Sert aussi de clé dans le
      // fichier de baseline (.dependency-cruiser-known-violations.json).
      name: 'no-circular',
      // `error` => dependency-cruiser sort avec un code != 0 quand la règle est
      // violée. C'est ce qui rend le gate BLOQUANT en CI.
      severity: 'error',
      comment:
        "Un cycle d'imports (A -> B -> ... -> A) rend les modules impossibles a " +
        'charger/raisonner isolement : c est la definition meme du spaghetti.',
      // `from: {}` = on part de N IMPORTE quel module du graphe...
      from: {},
      // ... et on interdit qu'il participe a une dependance CIRCULAIRE.
      // `circular: true` est la primitive native de dependency-cruiser : elle
      // est vraie pour toute arete qui boucle (peu importe la longueur du cycle).
      to: {
        circular: true,
      },
    },

    // --- Gate 2 : contrats de couches (une regle par frontiere) -------------
    // Chaque regle interdit a une couche d'importer une couche PLUS HAUTE.
    // `from.path` = la couche basse ; `to.path` = les couches plus hautes.
    // Descente et meme-couche ne matchent aucune regle => autorisees.
    {
      name: 'layer-leaves',
      severity: 'error',
      comment: 'Les feuilles (types/constants/prompts) ne doivent rien importer de plus haut.',
      from: { path: '^src/(types|constants|prompts)/' },
      to: { path: '^src/(utils|api|hooks|components)/' },
    },
    {
      name: 'layer-utils',
      severity: 'error',
      comment: 'utils (L1) ne doit pas importer api/hooks/components (plus haut).',
      from: { path: '^src/utils/' },
      to: { path: '^src/(api|hooks|components)/' },
    },
    {
      name: 'layer-api',
      severity: 'error',
      comment: 'api (L2) ne doit pas importer hooks/components (plus haut).',
      from: { path: '^src/api/' },
      to: { path: '^src/(hooks|components)/' },
    },
    {
      name: 'layer-hooks',
      severity: 'error',
      comment: 'hooks (L3) ne doit pas importer components (plus haut).',
      from: { path: '^src/hooks/' },
      to: { path: '^src/components/' },
    },
    {
      name: 'layer-root',
      severity: 'error',
      comment: 'La racine de composition (App.tsx/main.tsx) ne doit etre importee par personne.',
      from: { path: '^src/(types|constants|prompts|utils|api|hooks|components)/' },
      to: { path: '^src/(App|main)\\.tsx$' },
    },
  ],
  options: {
    // On n'analyse QUE notre code : on ne descend jamais dans node_modules.
    // (Sans ca, un cycle interne a une lib tierce nous bloquerait pour rien.)
    doNotFollow: {
      path: 'node_modules',
    },
    // Resolution des imports calquee sur la vraie config TS de l'app
    // (moduleResolution: "bundler", JSX, etc.). Sans ce tsConfig,
    // dependency-cruiser resoudrait mal certains imports et RATERAIT des aretes,
    // donc des cycles.
    tsConfig: {
      fileName: 'tsconfig.app.json',
    },
    // false = on ne regarde que le graphe d'imports qui SURVIT a la compilation
    // (les vrais imports d'execution). Les `import type {...}` purement de types
    // sont effaces par TypeScript et ne peuvent PAS provoquer de cycle de
    // chargement reel : on les ignore pour eviter des faux positifs.
    tsPreCompilationDeps: false,
    enhancedResolveOptions: {
      // Ordre des extensions essayees a la resolution, aligne sur le bundler.
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};
