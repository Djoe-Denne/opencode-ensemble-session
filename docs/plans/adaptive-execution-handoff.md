# Handoff — mode adaptatif Ensemble

Date : 2026-10-21. Clôture demandée par l'utilisateur pour reprise dans une
nouvelle session. Ce document transmet le travail ; il ne vaut pas approbation
du contrat d'architecture ni autorisation de contourner le cycle de mission.

## État à reprendre

- Dépôt : `C:\Users\djden\source\repos\opencode-ensemble-session`.
- Branche du lead : `main`, HEAD observé `a40a97d`.
- Ancienne mission : `mission-4a6ab63572113d73`, ID
  `team_mvibsoj0_0000_icjf6a`.
- Seul livrable intégré : `docs/plans/adaptive-execution.md`, statut **proposed**.
- Aucune implémentation applicative, aucun changement de test ou de configuration
  globale. Le contrat reste non validé par une revue indépendante.
- Le document intégré est **non suivi par Git**, pas commité sur `main`.
  Le présent handoff est également un nouveau fichier non commité. Les conserver.

## Décisions utilisateur

1. Conserver la classification actuelle et ses comportements historiques.
2. Ajouter un mode optionnel, sélectionnable et révisable par mission, sans
   score de difficulté ni appel JEV/général/x86 préalable en mode adaptatif.
3. Réutiliser le catalogue `ensemble.json` : intelligence et coût par tâche sont
   déjà associés au **couple modèle/reasoning**, pas au modèle seul.
4. Afficher les couples disponibles avec leurs métriques. Deux plages
   d'intelligence, planification et exécution initiale, proposent les pools à
   faire approuver. Ne pas demander un reasoning global redondant pour ces pools.
5. L'utilisateur considère les candidats d'un pool comme suffisamment proches
   en capacité. Introduire du hasard pour diversifier les biais et répartir
   l'utilisation des fournisseurs, avec préférence de coût modérée optionnelle.
6. Tirer à une frontière tâche/phase et persister l'affectation ; pas de rotation
   par tour ni de nouveau tirage après reprise. Planification et exécution peuvent
   utiliser des modèles différents.
7. L'exécutant peut demander une montée du reasoning de son modèle, dans les
   paliers autorisés. Pas de désescalade automatique pendant l'exécution ; la
   baisse prévue entre planification et exécution est une transition distincte.
8. Les révisions s'appliquent aux nouvelles admissions ; conserver les
   affectations/révisions et résultats du travail déjà admis.
9. Priorités : fonctionnement et qualité du code (lisibilité, élégance,
   structure et décisions justifiables). Le coût et le temps sont secondaires.
10. Première version simple et générique : pas de superviseur supplémentaire,
    équipes imbriquées, familles de profils obligatoires ou moteur de milestones.
    TDD et reviewers habituels restent définis par les projets.

## Politique de développement approuvée pour l'ancienne mission

Révision 1, hash
`508c6119d93a75708880c0f6fc2bd2e2cc3b8d5305f5e817909130ca80b88b12`.
Fichier : `.opencode/missions/team_mvibsoj0_0000_icjf6a/model-policy.json`.

- Classification **manuelle**, sans JEV, explicitement demandée par l'utilisateur.
  L'override temporaire `classification: { mode: "off" }` a été appliqué et retiré
  du JSON par `config` ; son absence actuelle n'implique pas une classification JEV.
- `light` et `standard` : `openai/gpt-6.1-sol`, variante `low`.
- `strong` : `openai/gpt-6.1-sol`, variante `high`.
- Providers autorisés : `cursor`, `openai`, `opencode`, `opencode-go`,
  `zai-coding-plan`.
- Bandes complexité/risque : `[0, 34, 67, 101]` ; matrice
  `[[light, standard, strong], [standard, standard, strong],
  [strong, strong, strong]]`.

Cette politique sert au développement de la fonctionnalité ; ce n'est pas encore
le nouveau mode adaptatif. Une nouvelle mission doit suivre prepare/config/start,
sans réutiliser implicitement l'approbation ni les tâches archivées.

## Travail réalisé

### Lot A — architecture

- Profil `architect`, membre `adaptive-architect`, tâche
  `task_mvic0y65_0002_gt0nbe`, complexité 85 / risque 80.
- Livrable : `docs/plans/adaptive-execution.md`.
- Commits de l'auteur : `6f5a93e`, puis `11015f2`.
- Branche auteur : `ensemble-3c37c47e-a5e4-44f5-b8d0-a6ffb9876827`.
- Arrêt confirmé et intégration via `team_merge` réalisés. Worktree déclaré
  propre par l'auteur ; le fichier intégré reste non commité chez le lead.
- La seconde révision corrige le premier contrat : aucune classification ni
  helper obligatoire en adaptatif, sans fabriquer un statut de classification
  réussi pour contourner les gardes historiques.

### Revue indépendante — non aboutie

- Profil `code-reviewer`, membre `adaptive-contract-review`, lecture seule,
  `worktree: false`, `report_mode: final_response`.
- Tâche `task_mvicgtc4_0004_lebkkm`, complexité 80 / risque 85.
- Session : `ses_ea0a442f8ffe5MTazWTVURXVm2`.
- Deux notifications natives : agent inactif, aucune réponse finale complète
  récupérable, aucune tâche complétée. Une unique relance a reproduit le problème.
- Dernier diagnostic avant clôture : idle depuis 29 minutes, execution `off`,
  aucun message du reviewer. **Ce n'est ni une revue passée ni un verdict FAIL.**
- Cause inconnue. La session a été ouverte à la demande de l'utilisateur.
- Diagnostic local : CLI `opencode` absente du PATH du sandbox ; import public
  `@opencode/client/service` indisponible depuis ce checkout ; aucun événement de
  cette session dans les derniers 2 MiB du log inspecté. Aucun service installé,
  démarré ou reconfiguré pour contourner ces limites.
- Ne pas boucler sur les relances ; décider d'un canal de revue fonctionnel avec
  l'utilisateur si cette limite subsiste.

## Points du contrat à revoir AVANT implémentation

- **D2 ne constitue pas une décision approuvée.** Il propose un tirage uniforme
  provider → modèle → variante, donc équilibre probabiliste et non préférence
  pour fournisseurs moins sollicités. Il limite le coût à
  `cheapest_within_model`, ce qui ne favorise pas les modèles moins chers et
  élimine certaines variantes. Revoir la fidélité au besoin et la solution la
  plus simple ; ne pas considérer ces restrictions comme acquises.
- **OQ-1 / D5 : effet natif du reasoning.** Le contrat rapporte que
  `createV2Client` appelle `switchModel` avant un prompt normal, mais que le
  chemin synthetic ignore modèle/variante. À vérifier sur l'hôte réel avant
  d'activer l'adaptatif. DB ou changement de profil ne prouvent pas l'effet sur
  la prochaine inférence.
- SP-4 ne fournit que des readbacks, accepte même une variante inconnue, et ne
  prouve aucune inférence avec les paramètres demandés. Aucun support
  `configuration_update` ni conservation du cache n'est établi pour ce transport.
- Les refus initiaux proposés pour V1, variantes implicites et adaptatif en
  `final_response` restent des choix de conception à examiner, pas du runtime
  déjà implémenté.
- Le contrat propose deux tables et des transitions CAS/idempotentes. Vérifier
  leur nécessité et éviter un moteur de workflow disproportionné.
- Autres OQ dans le contrat : équilibre/quotas, échelles natives, variantes
  omises/default, protocole de transition, numéro et lignée de migration après 21.

## Reprise recommandée

1. Lire `AGENTS.md`, ce handoff et le contrat proposed. Vérifier le statut Git
   et préserver les deux documents non suivis.
2. Préparer la nouvelle mission, faire présenter/approuver sa politique native.
3. Faire une revue indépendante du contrat intégré, avec un canal de rapport
   fonctionnel. Pas de lot consommateur avant intégration/revue des contrats.
4. Arbitrer les écarts D2 et vérifier le chemin public SDK de changement d'effort.
5. Publier ensuite des lots bornés : configuration/pools ; sélection équilibrée
   persistée ; phases/escalade V2 ; documentation ; revue et QA.
6. Implémenter en RED/GREEN/REFACTOR, happy paths, erreurs, reprise, concurrence
   et non-régression du mode historique. Sérialiser les mutations partagées.

## Preuves et invariants

- Seules des vérifications documentaires/Git ont été effectuées, dont un contrôle
  whitespace. Aucun `typecheck`, `bun test`, `build` ou probe natif exécuté.
- Aucun résultat applicatif vert n'est revendiqué.
- Gate obligatoire sur l'arbre intégré :
  `bun run typecheck && bun test && bun run build`.
- SDK publics uniquement ; 15 outils, pas de 16e ; SQLite via `src/db.ts` ;
  transport `._client` inchangé ; `promptAsync` jamais await ; préservation des
  branches avant chaque `session.abort()` ; aucun `any` ni TODO sans OQ.
- Workers feuilles ; intégration via `team_merge`, pas de merge Git manuel.
- Ne pas publier, purger des archives ou supprimer des branches préservées.

## Clôture

Clôture confirmée : `team_cleanup({ acknowledge_uncommitted: true })` a retourné
`Team "mission-4a6ab63572113d73" cleaned up.` L'inspection suivante confirme que
la session du lead n'appartient plus à une équipe. Aucun purge/force n'a été
demandé. Aucun rapport de revue n'est accepté et aucun travail applicatif n'est
marqué accompli.

Après clôture, les deux documents existent toujours et sont les seuls fichiers
signalés par `git status --short` (non suivis). La branche auteur
`ensemble-3c37c47e-a5e4-44f5-b8d0-a6ffb9876827` contient toujours `11015f2` :
les commits du contrat restent accessibles. Aucun commit du lead n'a été créé.
