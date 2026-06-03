/**
 * Gate 1 — détection des dépendances circulaires (frontend).
 *
 * Volontairement RÉDUIT à la seule règle `no-circular`. On n'ajoute aucune
 * autre règle d'architecture ici tant que le Gate 1 n'est pas validé.
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
