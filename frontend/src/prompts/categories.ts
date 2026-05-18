/**
 * Prompt for /categorize: derive category labels from a document's abstract
 * (not the full text). Categories are high-level, so the already-generated
 * summary is enough context — and one cheap call beats a full map-reduce.
 */
export const CATEGORIES_FROM_ABSTRACT_PROMPT =
  'À partir du résumé de document fourni ci-dessous, identifie 3 à 5 catégories ' +
  'thématiques courtes (1 à 3 mots chacune) qui le décrivent. ' +
  'Chaque catégorie doit IMPÉRATIVEMENT être rédigée en français, même si le ' +
  'document est en anglais : traduis tout terme anglais en français (par ex. ' +
  '« Machine learning » → « Apprentissage automatique », « Workarounds » → ' +
  '« Contournements »). N\'emploie aucun mot anglais. ' +
  'Réponds STRICTEMENT par un tableau JSON de chaînes, sans aucun texte avant ' +
  'ou après, sans markdown, sans préambule. Exemple exact du format attendu : ' +
  '["Sociologie", "Méthodes qualitatives", "Éducation"]. Aucune autre forme ' +
  "n'est acceptée."
