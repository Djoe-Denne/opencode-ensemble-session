# Précédence de l'effort de raisonnement et normalisation des libellés de variant

Statut : **proposed** (devient accepted seulement après approbation humaine explicite).

Auteur : sol-reasoning, équipe mission-76ab4373cd1070e1.
Date : 2026-10-19.
Lot : constat 3 de `findings-synthesis.md` — précédence frontmatter de profil contre policy par bandes, et normalisation des libellés `max` / `xhigh` / `Extra High`.
Périmètre : proposition uniquement. Aucun fichier de `src/` n'est modifié par ce document.

## Problème

Sur une mission gouvernée, deux textes prétendent décrire l'effort de raisonnement d'un même rôle : le frontmatter `model:` des profils (`.opencode/agents/*.md`) et la cellule de la grille approuvée (`.opencode/missions/<team>/model-policy.json`). À l'exécution, la cellule gagne dès qu'elle nomme un variant, mais ce fait n'est ni visible pour le coéquipier, ni comparable d'un provider à l'autre, parce que le champ `variant` est une chaîne opaque. Les missions comparent donc `max`, `xhigh` et `Grok 4.7 Extra High` comme s'il s'agissait d'une même échelle.

## Diagnostic sourcé

### Preuves d'audit

Synthèse, constat 3 et lecture causale 2 (`findings-synthesis.md`) : la grille applique un effort par bandes ; le frontmatter est traité comme mort à l'exécution ; le même rôle change d'effort selon la mission. Preuves croisées :

- AIForAll R6 : `architecte.md` déclare `#xhigh`, observé `glm-5.3-flash#max` (ce5af, `team_mvdsfk01_001c_0cfldw`) et `gpt-6.1-sol#high` (e0558). `implementer.md` `#medium` observé `#high` (8 implementers, b091e). Le routage e0558 attache `high` à la bande complexity 2 / risk 1 et `xhigh` à la bande 3/2 ; une alternative porte le libellé `Grok 4.7 Extra High`.
- AIForAll R8 : deux vocabulaires de groupes (`glm-or-grok` / `grok-xhigh` / `opus` contre `light` / `standard` / `strong` / `maximum`) et trois familles de variant (`max`, `high`/`xhigh`, libellé d'affichage Grok).
- ARTIST §3 : le groupe `standard` sélectionne `gpt-6.1-sol` LOW pour des complexités 57–64 (e52f73a) et `glm-5.3-flash` MAX pour des complexités 40–45 (5caa4a). La dérive est dans le contenu approuvé de chaque grille, pas dans un aléa du routeur.
- re-ff8 R4 : 46 combinaisons rôle::modèle::effort pour 176 membres ; le même profil `re-semantic-ensemble` reçoit medium, max, xhigh, low, high et des libellés Grok Low→Extra High. `msg_mv6unz5b_0000_7md8mq` constate `variant: not-visible-in-session-env`. Cette chaîne n'existe nulle part dans le plugin : c'est le diagnostic du worker, pas une sentinelle du code.

### Ce que le source fait déjà

La précédence d'une mission approuvée est déjà codée. Elle n'est pas documentée comme un contrat d'effort, et elle ne normalise rien.

1. `routeMissionModel` (`src/mission-model-policy.ts`, lignes 178–201) choisit `groups[matrix[riskBand][complexityBand]][0]`. Les suivants sont des alternatives enregistrées, pas des relances.
2. `executeTeamSpawn` (`src/tools/team-spawn.ts`, lignes 130–146) : si une policy est admise, `resolvedModel` et `resolvedVariant` viennent de cette cellule. Un `team_spawn.model` ou `.variant` différent est rejeté (ligne 134). `resolveModel` (lignes 20–37) ne lit aucun frontmatter : explicit > `modelsByAgent` > pool > `defaultModel`, et seulement quand il n'y a pas de policy.
3. `session.create` (ligne 294) n'envoie ni model ni variant. Le variant part dans `promptAsync` (ligne 560), appelé sans `await` (ligne 554, `.then` / `.catch`). L'adaptateur V2 applique alors `switchModel` (`src/v2-client.ts`, lignes 153–155). Sans variant, la clé est omise.
4. `approveMission` (`src/mission-policy.ts`, lignes 140–146) exige l'égalité exacte `id` + `variant` avec le catalogue natif fourni par `nativeMissionModels` (`src/mission-native-models.ts`, lignes 11–16), qui recopie `variant.id`. `validateModel` (lignes 99–109 de `mission-model-policy.ts`) n'accepte qu'un texte non vide : `max`, `xhigh` et `Grok 4.7 Extra High` sont structurellement égaux.
5. `assertMissionMemberModel` (`src/mission-policy.ts`, lignes 256–274) rejoue la cellule de la révision gelée et compare `stored.model_variant` à `expected.selected.variant` par égalité de chaîne. `getMemberPromptModel` (`src/member-model.ts`, lignes 33–40) appelle cette vérification avant chaque livraison.
6. `team_message.model` est déjà refusé quand une policy existe (`src/tools/team-message.ts`, lignes 27–28). Le claim direct épingle le couple stocké via `switchModel` (`src/tools/team-claim.ts`, lignes 63–70).
7. Visibilité : `shell.env` V1 (`src/index.ts`, lignes 429–443) exporte équipe, rôle, membre, branche et worktree, pas le modèle. Le hook shell V2 est un no-op documenté (`src/v2-setup.ts`, lignes 378–381, `OQ-V2-shell`) parce que le hook n'a pas de `sessionID`. `buildTeammateSystemPrompt` (`src/system-prompt.ts`, lignes 175–211) et le contexte de spawn ne citent ni le modèle ni le variant. Le prompt système V2 est pourtant bien injecté (`src/v2-setup.ts`, lignes 328–339).

`docs/model-routing.md` (lignes 43–45) interdit déjà de traduire ou de deviner les noms d'effort. `docs/mission-policy.md` dit que la grille possède la sélection, sans dire ce que devient le frontmatter.

### Lecture causale, plus étroite que la synthèse

La synthèse a raison : dès qu'une cellule approuvée nomme un variant, le frontmatter ne commande pas. Elle va trop loin en disant que le frontmatter est toujours mort. Deux fenêtres restent ouvertes :

- Entre `session.create` (agent du profil, donc modèle du frontmatter côté hôte) et le `switchModel` différé dans le `promptAsync` fire-and-forget.
- Quand la cellule omet `variant` : l'adaptateur n'envoie pas la clé. On ne sait pas si l'hôte efface alors le variant du profil ou s'il le conserve. C'est OQ-1.

La diversité d'effort pour un même rôle est le comportement de la grille, pas un bug du routeur. Le défaut est l'absence de contrat : les profils continuent d'afficher un effort que le plugin ne lit jamais, et les libellés natifs ne sont pas comparables. La dérive ARTIST (standard = low ici, standard = max là) est un contenu de policy approuvée. Le plugin doit la rendre visible avant `start`. Il ne doit pas la corriger en silence.

Le libellé `Grok 4.7 Extra High` présent dans `model_routing.alternatives` a été copié tel quel depuis la policy approuvée (`routeMissionModel` recopie le candidat). Il a donc passé `approveMission`. Deux explications restent ouvertes (OQ-2) : soit `variant.id` natif est vraiment cette chaîne d'affichage, soit le catalogue présenté à l'approbation n'était pas l'inventaire natif. Le correctif ne doit pas trancher cette question par une table devinée.

## Options

### Option A — documenter seulement

Écrire la précédence dans `docs/mission-policy.md` et ajouter la chaîne `model_variant` brute au prompt. Aucun changement de validation.

Plus simple. Ne distingue pas un id natif d'un libellé d'affichage, ne rend pas les missions comparables, et ne couvre pas V2 si l'on ne touche que `shell.env`.

### Option B — id natif autoritaire, effort canonique en annotation (recommandée)

La cellule approuvée reste l'unique entrée d'exécution. `variant` continue d'être l'id natif exact passé à `switchModel`. Un effort canonique (`default | low | medium | high | xhigh | max`) est calculé à côté, pour l'affichage, l'avertissement de calibration et le prompt. Une table d'alias ne sert qu'à expliquer un refus et à annoter un id déjà natif. Elle ne réécrit jamais la valeur envoyée à l'hôte.

Un libellé avec espaces n'est valide que si `nativeMissionModels` le renvoie comme `variant.id`. Sinon l'approbation échoue et le message cite les ids natifs réels plus, si l'alias est connu, l'effort canonique correspondant. Le brouillon n'est pas réécrit : le hash présenté doit rester celui que `start` approuve.

### Option C — le frontmatter comme plancher

Lire le `#effort` du profil et relever le variant de la cellule s'il est plus bas.

Rejetée. Elle contredit le contrat déjà appliqué (la grille possède la sélection ; `team_spawn` et `team_message` refusent les overrides). Elle ferait diverger la valeur épinglée de la cellule rejouée par `assertMissionMemberModel`, sauf à modifier la policy approuvée après coup. Elle couple aussi le plugin au parseur Markdown des profils, lot de sol-profiles.

## Recommandation

Option B.

Règle de précédence, à copier dans la doc et dans le prompt lead :

1. Mission avec policy approuvée : le couple `(id, variant)` de la cellule `routeMissionModel` est la seule source d'exécution. Le frontmatter `model:` n'est pas lu. `modelsByAgent`, le pool et `defaultModel` ne sont pas consultés.
2. `team_spawn.model` / `.variant` différents et `team_message.model` restent refusés.
3. Mission legacy, sans policy : l'ordre actuel de `docs/model-routing.md` reste en place (explicit, puis scores du catalogue `reasoningEffort`, puis `resolveModel`). Le frontmatter n'y est pas une entrée non plus.
4. `variant` absent signifie « défaut hôte ». Tant que OQ-1 n'est pas tranché, le présentateur doit l'écrire explicitement. On n'invente pas un id de défaut.
5. L'effort canonique n'entre pas dans la comparaison de `assertMissionMemberModel`. Seul l'id natif y entre. Le champ `effort` éventuel sur un candidat reste optionnel, pour que les révisions déjà approuvées (policy version 1, sans ce champ) continuent de valider.
6. Une inversion de calibration (bande plus haute, effort canonique plus bas) produit un avertissement dans `formatProposal`. Elle ne bloque pas `start` : les noms de groupes sont locaux à la mission, et un choix moins cher peut être volontaire (OQ-4 si le lead veut bloquer).

Rang canonique, utilisé seulement pour cet avertissement et pour l'affichage : `default < low < medium < high < xhigh < max`. Les alias d'auteur (`extra high`, `extra-high`, `Grok 4.7 Extra High`, `Grok 4.6 Extra High`) pointent vers `xhigh` dans le message d'erreur. Ils ne deviennent un `variant` envoyé à l'hôte que lorsque cette chaîne exacte figure dans l'inventaire natif.

Visibilité, sans élargir le prompt de tâche déjà borné par AGENTS.md :

- Une ligne dans `buildTeammateSystemPrompt` et une clause dans `buildTeamCompactionContext` : id provider/model, variant natif ou `default`, effort canonique ou `unmapped`. Ce canal existe en V1 et en V2.
- V1 seulement : `ENSEMBLE_MODEL`, `ENSEMBLE_VARIANT`, `ENSEMBLE_EFFORT` dans `shell.env`, lus sur la ligne `team_member` déjà persistée.
- V2 : le hook shell reste un no-op. Y poser des variables sans `sessionID` les mélangerait entre sessions.

Le linter de profils (lot sol-profiles) peut signaler un `model:` de frontmatter comme non liant pour un coéquipier de mission. Ce lot-ci ne parse pas les fichiers d'agents.

## Contrat pour l'implémenteur

### Dans le périmètre

- Module pur nouveau `src/variant-effort.ts` : type `CanonicalEffort`, `canonicalizeVariantLabel(raw: string): CanonicalEffort | undefined`, `canonicalRank(effort: CanonicalEffort): number`. Aucune I/O, aucun `any`.
- `src/mission-model-policy.ts` : `effort?` ajouté aux champs optionnels de `validateModel`. Absent, les policies actuelles restent valides. Présent, il doit être l'une des six valeurs. S'il est présent et que le variant est un libellé connu, les deux doivent désigner le même effort. Ne pas réordonner les clés JSON : le hash est `JSON.stringify` de la policy (`assertMissionMemberModel`).
- `src/mission-policy.ts` `approveMission` : après le test d'existence native, refuser un variant qui n'est pas un id natif exact. Le message d'erreur peut citer l'alias canonique. Ne pas muter le JSON approuvé.
- `src/mission-commands.ts` `formatProposal` : afficher `id (variant natif, effort canonique ou unmapped)` et l'avertissement d'inversion, non bloquant.
- `src/system-prompt.ts` : la ligne d'identité modèle, côté coéquipier et compaction.
- `src/index.ts` `shell.env` : les trois variables V1, à côté des variables existantes.
- `src/v2-setup.ts` : commentaire `OQ-V2-shell` étendu — l'effort voyage par le prompt, pas par le shell.
- `docs/mission-policy.md` : section « Reasoning effort precedence ». `docs/model-routing.md` : un paragraphe qui rappelle que le catalogue legacy ignore aussi le frontmatter et ne traduit pas les efforts. `skills/opencode-ensemble/references/mission-policy.md` : renvoi court, pas une copie de la spec.

### Hors périmètre

Classification et `helperModel`. Droits des profils et linter Markdown. Worktrees. Relances provider. Réécriture des révisions déjà approuvées. Nouvelle colonne SQLite. Seizième outil. Tableau de bord. Parse du frontmatter.

`src/v2-client.ts` et `src/tools/team-spawn.ts` ne changent pas de sémantique d'envoi : le variant persisté part tel quel. Un commentaire de précédence à la ligne 143–146 suffit. `src/member-model.ts` reste le point d'appel de l'assertion ; pas de deuxième comparaison sur l'effort.

### Critères d'acceptation

- Une policy dont le variant n'est pas un id natif est refusée à `start`, avec la liste des ids natifs.
- Une policy déjà approuvée sans champ `effort` passe encore `assertMissionMemberModel`.
- Remplacer le variant stocké par un synonyme canonique fait échouer l'assertion.
- Ajouter `effort` à côté du variant natif, dans le JSON de route, ne la fait pas échouer.
- Le payload `promptAsync` contient le variant de la cellule, pas celui d'un profil.
- Le prompt coéquipier contient le modèle et le variant stockés.
- Le hook V1 exporte les trois variables ; le hook V2 reste sans variables de session.
- `bun run typecheck`, `bun test` et `bun run build` passent. Zéro `any`. JSDoc sur chaque export nouveau.

## Risques et comportements à préserver

- `promptAsync` reste fire-and-forget aux sites d'appel (`team-spawn.ts` ligne 554, messages, broadcast, nudges). Le `await switchModel` interne de l'adaptateur V2 ne remonte pas dans l'outil.
- Transport `._client` inchangé.
- `preserveBranch` avant tout `session.abort`, y compris `rejectPolicySpawn` dans `team-spawn.ts`. Ce lot ne touche pas à ces chemins.
- Quinze outils. Pas d'outil unifié.
- SQLite seulement via `src/db.ts`. Pas de migration : l'effort se déduit à la lecture. `PRAGMA user_version` ne bouge pas.
- Les alternatives restent un enregistrement, pas un retry.
- `team_handoff` conserve le modèle de session déjà épinglé. Changer de profil ne relit pas le frontmatter.
- Les équipes legacy sans `mission_policy` gardent `routeModel` et `reasoningEffort` du catalogue. L'annotation canonique peut s'afficher ; elle ne change pas le choix.
- Rendre `effort` obligatoire casserait `assertMissionMemberModel` pour toutes les missions déjà approuvées, parce que la révision gelée est revalidée à chaque livraison. Le champ reste optionnel.
- Ne pas normaliser au moment de `switchModel`. Une traduction à la livraison désynchroniserait la valeur envoyée de la valeur comparée par l'assertion.
- Le prompt de tâche injecté par `team_spawn` reste le contrat court d'AGENTS.md. L'identité modèle va dans le prompt système, pas dans ce bloc.

Rayon : hooks V1 (`shell.env`, `experimental.chat.system.transform`) et V2 (`session.hook("context")`, `session.hook("compaction")`), validation de policy, texte de `config`. Le dashboard n'est pas alimenté. Les quinze outils, le transport et la préservation de branche restent stables.

## Stratégie de tests TDD

Cycle par fichier : test rouge pour la bonne raison (pas une erreur « module introuvable »), implémentation minimale, refactor sans changement de comportement. Bun. SQLite `:memory:`. Pas de mock de la logique de précédence.

1. `test/variant-effort.test.ts` (fichier nouveau, écrit en premier).
   - Rouge : `canonicalizeVariantLabel("xhigh")`, `"max"`, `"Grok 4.7 Extra High"` et `"high"` renvoient les efforts attendus ; `"not-a-variant"` renvoie `undefined` ; le rang de `xhigh` est strictement inférieur à celui de `max`.
   - Vert : table fermée dans `src/variant-effort.ts`.
2. `test/mission-policy.test.ts`.
   - Rouge : `approveMission` avec variant `Grok 4.7 Extra High` et inventaire natif `xhigh` lève une erreur qui cite `xhigh`. Le même appel avec variant `xhigh` passe. Une policy historique sans `effort` reste valide.
   - Vert : message dans `approveMission`, champ optionnel dans `validateModel`.
3. `test/member-model.test.ts`.
   - Rouge : variant stocké `Extra High` alors que la cellule gelée dit `xhigh` → `Mission model provenance invalid`. Un JSON de route qui ajoute `effort: "xhigh"` à côté de `variant: "xhigh"` passe.
   - Vert : l'assertion continue de comparer uniquement l'id natif, et ignore la clé supplémentaire.
4. `test/model-routing-spawn.test.ts` ou `test/mission-routing-integration.test.ts`.
   - Rouge : spawn gouverné, le `promptAsync` reçoit le variant de la cellule même si l'argument `variant` du spawn est absent ; un argument différent lève encore l'erreur de la ligne 134. Aucun champ de profil n'existe dans l'entrée de `executeTeamSpawn` : le test fixe cette absence.
   - Vert : aucun changement de précédence attendu ; le test épingle le comportement actuel.
5. `test/system-prompt.test.ts` et `test/hooks.test.ts` (`describe("shell.env logic")`).
   - Rouge : le prompt de `alice` ne contient pas encore `openai/gpt-6.1-sol` ni `xhigh` alors que `team_member.model` / `model_variant` sont remplis. L'env V1 miroir de `index.ts` n'a pas `ENSEMBLE_VARIANT`.
   - Vert : une ligne dans `buildTeammateSystemPrompt` et trois affectations dans `shell.env`.
6. Régression à ne pas casser : variant omis reste `null` en base (`test/mission-routing-integration.test.ts`, attente `model_variant: null`) ; `team_message.model` sur mission gouvernée lève encore.

Pas de test qui réécrit un hash approuvé. Pas de test réseau. Le spike OQ-1 / OQ-2, s'il est fait, vit dans un commentaire de résultat et un test qui échoue si l'hypothèse retenue est fausse.

## Questions ouvertes

- OQ-1 : `session.switchModel` sans clé `variant` efface-t-il le variant appliqué par le profil au `session.create`, ou le conserve-t-il ? Hypothèse jusqu'au spike : on ne sait pas, donc on n'envoie pas de variant synthétique et on l'affiche comme `default`. Ne pas exiger un variant sur chaque candidat avant le spike.
- OQ-2 : pour `opencode-go/grok-4.7`, `openai/gpt-6.1-sol` et `glm-5.3-flash`, quels sont les `variant.id` réels de `ctx.model.list` ? Si l'id natif est `Grok 4.7 Extra High`, l'approbation doit l'accepter et l'annoter `xhigh`. Si l'id est `xhigh`, le libellé d'affichage doit être refusé. La table d'alias ne remplace pas ce relevé.
- OQ-3 : le hook shell V2 a-t-il désormais un `sessionID` ? Le commentaire `OQ-V2-shell` dit non. Tant que c'est le cas, l'environnement de session n'est pas le canal. Le prompt système l'est.
- OQ-4 : une inversion de calibration doit-elle bloquer `start` ? Recommandation : avertissement seul.

## Contradictions relevées, non réparées

- Le schéma vivant de `team_message` dans cette session expose `model_policy`, `provider_order` et `max_running_members`. Aucune de ces chaînes n'apparaît dans le checkout `opencode-ensemble-session`. La précédence ci-dessus décrit la grille de `src/mission-policy.ts`. S'il existe un second canal « balanced model policy » dans le binaire installé, il n'est pas dans ce source et ne doit pas être inventé ici. À trancher avant implémentation : ce canal, s'il sélectionne un variant, se place sous la cellule approuvée, pas à côté.
- `docs/model-routing.md` dit de ne pas traduire les efforts. L'option B respecte cette phrase à la livraison. Une traduction silencieuse dans `switchModel` la contredirait.
- AGENTS.md limite le message de spawn à l'identité, la tâche et les outils. La ligne d'effort va dans le prompt système pour respecter cette limite.
- La synthèse dit le frontmatter toujours mort. Le source le confirme seulement lorsque la cellule porte un variant. Le cas « variant omis » dépend de OQ-1.
