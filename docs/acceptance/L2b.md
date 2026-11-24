# Preuve L2b: vérification des sources

## Préalable: conditions d'usage de l'API MediaWiki (lues le 2026-11-24)

Pages lues: « API:Etiquette » (mediawiki.org) et la politique de User-Agent de la Fondation Wikimedia.
- Pas de limite dure en lecture; demander en série plutôt qu'en parallèle; User-Agent descriptif avec contact obligatoire sous peine de blocage; préférer GET; mettre en cache.
- **Conséquence retenue**: requêtes sérialisées par instance, espacées de 500 ms (`api/src/verify/limits.ts`), `ReservedConcurrentExecutions = 2` (total ≤ 4 requêtes/s, sous la limite de 5 du design), cache `CLAIMCACHE#` 30 jours.
- **User-Agent fixé**: `QCMonsterVerifyBot/1.0 (<contact>) node-fetch`, le contact vient de `QCM_UA_CONTACT` (défaut: adresse de l'équipe du dépôt).
- Non lu: les pages de limites propres à chaque wiki frère (Wikibooks, Wikiversité, Vikidia). Elles ne sont interrogées que si Wikipédia fr ne renvoie rien, et **leur API n'est pas vérifiée en réel** (design 4.3).

## Mesures en CI (modèle simulé, aucun appel Bedrock)

`npx vitest run api/src/verify infra/test/verify-stack.test.ts`

| Critère (design 10.3) | Test | Résultat |
|---|---|---|
| Refus d'un hôte hors liste, d'une redirection, d'une réponse > 64 Ko | `fetch.test.ts` | réussi |
| 0 URL ou extrait hors d'un passage stocké | `run.test.ts`, `verify-only.test.ts` | réussi |
| Injection (cours et passage): verdict identique au jumeau sans injection | `run.test.ts`, `verify-only.test.ts` (`passageTwin`) | réussi |
| Plafond 0,25 EUR, affirmations restantes `non_verifiable` | `run.test.ts` | réussi |
| 5 requêtes/s MediaWiki sous 3 exécutions simulées | `run.test.ts` (horloge simulée, fenêtre glissante d'une seconde) | max ≤ 5 |
| Test M2 (rôles avec `bedrock:Invoke*`) | `infra/test/verify-stack.test.ts` | réussi |

`verify-only` sur les 22 pages synthétiques de mise au point du dépôt (faux juge déterministe): 318 affirmations, 66 erreurs insérées, 61 détectées, 230 affirmations justes dont 1 jugée erreur, 290 sources. **Ces chiffres valident la plomberie, pas un modèle**: rappel ≥ 80 % et faux positifs ≤ 2 % sur un vrai modèle, et les 12 pages cachées, restent à mesurer (appels réels, hors de ce lot).
