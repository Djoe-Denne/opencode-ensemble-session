# Choix du modèle par tâche — exploration et contrat proposé

**Statut : implémentation autorisée le 2026-10-23, réalisée en TDD.**
Le corps ci-dessous conserve l'exploration initiale. Décisions utilisateur :
OQ-1 confirmée ; OQ-2 maximum facultatif ; OQ-3 le superviseur décide aussi du
direct code/mixed, avec un kind qualifié (pas unspecified) ; OQ-4 confirmée ;
OQ-5 nouvelles missions version 3 opt-in, l'utilisateur interrompra/recréera
ses missions actives. Aucune mission active n'a été interrompue par l'agent.

Implémentation : configuration/range et politique v3, décision planifiée avec
motif, direct code/mixed supervisé en v3, classification dans la plage,
validation native et révision après await, schémas V1/V2 et provenance de
livraison. Stockage JSON existant, sans migration SQL ni nouveau tool.

### Cycles TDD observés

- Politique pure : RED (12 échecs de validation/sélection), puis GREEN
  (18 tests). Aucun module manquant utilisé comme échec RED.
- Configuration et intégration : RED (22 échecs fonctionnels), puis GREEN.
- Schéma V2 et présentation de commande v3 : chacun exécuté en RED avant édition.
- Motif visible et refus de provenance v3 corrompue : RED puis correction.
- Tests supplémentaires : révocation pendant découverte native, course avec
  admission, échec du switch, réutilisation du worker et effort d'implémentation
  sous la plage. Ces vérifications étendent la baseline décrite en section 5.

Validation finale de l'implémentation : `bun run typecheck`, `bun test`
(1573 pass, 0 fail, 94 fichiers) et `bun run build` réussis. Biome lint réussit
sur les dix fichiers source modifiés. Le lint global échoue sur des fichiers
non modifiés (dont dashboard.ts) ; pas de correction hors périmètre. Aucune
preuve native sur un serveur réel revendiquée ; aucune ressource Docker créée.

Les recommandations ci-dessous sont historiques lorsqu'elles contredisent les
arbitrages ci-dessus, notamment le maintien du direct à documentation/recherche.

Date : 2026-10-23. Périmètre : exploration du checkout courant, pas modification
des sources, des missions actives ou du catalogue utilisateur.

## 1. Besoin et recommandation

Permettre au superviseur de suivre « utilise Luna pour cette tâche » sans
abaisser le démarrage automatique de toutes les autres tâches. Le nom commercial
ne constitue pas une identité native : utiliser le couple réel `provider/model`
et variante du catalogue approuvé, sans supposer ici son score ou sa disponibilité.

Recommandation : conserver `startingIntelligence` pour le choix automatique et
ajouter une plage approuvée pour les choix explicites de planification. Étendre
`team_tasks_add.execution_decisions`, pas `team_spawn.model`, pas le handoff.
Conserver une session, un worktree et un modèle par tâche. Une variante peut
changer pendant l'implémentation, comme aujourd'hui.

Pour le mode direct, le libre choix dans le catalogue approuvé existe déjà.
Ne pas confondre ce choix avec l'autorisation d'éviter la planification pour du
code : celle-ci reste interdite dans la tranche proposée.

## 2. Faits vérifiés : localisation et flux

- `AGENTS.md`, Architecture / Settled Decisions / Branch Preservation : logique
  métier partagée entre les deux hôtes ; 15 outils distincts ; SQLite via
  `src/db.ts` ; promptAsync non attendu ; isolation et préservation avant abort.
- `src/config.ts:51,88,128,196`, `EnsembleConfig`, `DEFAULT_CONFIG`,
  `readConfigFile`, `loadConfig` : `startingIntelligence` vaut 50 par défaut ;
  validation finie et positive ou nulle. Ce score n'est pas nécessairement sur
  une échelle 0–100 : `docs/model-routing.md:13` décrit l'échelle du catalogue.
- `src/execution-policy.ts`, `ExecutionPolicy`, `createExecutionPolicy`,
  `executionStarts` : politique catalogue version 2 ; tous les couples activés
  restent présents, mais le démarrage planifié sans classification exige
  `intelligenceScore >= startingIntelligence`. Aucun candidat : erreur.
- `src/execution-policy.ts:53`, `routeExecution` : tri des couples puis hash
  tâche/révision pour un choix reproductible. La validation finale vérifie le
  catalogue complet, pas le seuil, lorsqu'un choix est fourni par classification.
- `src/mission-policy.ts:330`, `previewMissionTask` : lit décision et scores de
  la tâche ; contrôle `authorizedBy` contre le lead ; direct vers implémentation,
  sinon classification explicite éventuelle puis `routeExecution`.
- `src/execution-policy.ts:82`, `validateTaskExecutionDecision` : direct limité
  à documentation/recherche ; `planned` interdit explicitement model/variant.
- `src/tools/team-tasks-add.ts:29`, `executeTeamTasksAdd` : propositions des
  membres séparées des décisions du lead ; contrôle catalogue/natif du direct
  avant persistance ; décisions sur tâches pending/blocked, sans assignee ni
  model_routing ; contrôle répété dans l'UPDATE transactionnel.
- `src/tools/team-spawn.ts:158` : modèle/variante explicites différents du routage
  de mission refusés avant allocation. Ce verrou doit rester en place.
- `src/tools/team-claim.ts:18`, `claimTask` : admission commune, contrôle
  dépendances/classification/sécurité, claim atomique et `saveMissionTaskRoute`.
  `src/dispatch.ts:171`, `dispatchNextTask`, utilise ce même claim.
- `src/task-execution.ts`, `assignment`, `transition`, `startTaskPlanning` :
  application native du modèle et des permissions avant exécution ; route en
  état `applying` jusqu'au succès. Le nom startTaskPlanning couvre aussi les
  tâches directes, car la phase provient de la route, pas du nom de fonction.
- `src/mission-policy.ts:376`, `assertMissionMemberModel` : vérifie révision,
  hash, modèle fixé et variante autorisée ; pas de recalcul de la sélection
  initiale version 2 à chaque message.
- `src/index.ts:68`, `taskExecutionSchema`, et `src/v2-tools.ts:72`,
  `taskExecutionProperties` : deux schémas d'entrée, un seul handler métier.
- `src/schema.ts`, migration 22 : execution_request / execution_decision ;
  `ExecutionRoute.authorization` copie déjà la décision dans l'affectation.
- `src/dashboard.ts:119` : la projection des tâches ne contient actuellement
  ni décision ni model_routing. La persistance d'un motif ne le rendrait donc
  pas automatiquement visible dans le dashboard.

Flux recommandé, sans nouveau canal :

    configuration -> catalogue/plage présentés -> approbation de révision
    -> proposition de tâche -> décision du lead -> admission commune
    -> route persistée -> application native -> premier prompt
    -> handoff de phase/variante, sans changement du modèle de la tâche

### Écarts documentaires et limites à ne pas masquer

1. `docs/mission-policy.md:141,146,181` parle de scores obligatoires, de cellule
   de grille et de création directe historique sans qualifier suffisamment la
   politique version 2. `previewMissionTask` et
   `test/autonomous-execution.test.ts:55` autorisent aujourd'hui une mission
   catalogue sans scores ; `docs/autonomous-execution.md` le décrit aussi.
   Ne pas appliquer les règles de grille à la nouvelle voie catalogue.
2. `docs/model-routing.md:59–85` donne priorité au modèle explicite et autorise
   les overrides ultérieurs, mais précise qu'il décrit la voie historique V1.
   Ce n'est pas une autorisation pour les missions gouvernées : leur voie refuse
   cet override dans `team-spawn.ts:158`. Clarifier les périmètres à terme.
3. `docs/plans/adaptive-execution.md:3,14–23` est toujours **proposed** et décrit
   deux choix de modèles par tâche. Le code courant et
   `docs/autonomous-execution.md:3–5` conservent un seul modèle. Ce plan ancien
   n'est ni une spécification acceptée ni une preuve du comportement actuel ;
   ne pas en implémenter implicitement la seconde sélection.
4. Le seuil actuel n'est pas universel : la classification explicite peut choisir
   un couple sous le seuil, tant qu'il est au catalogue. La nouvelle plage doit
   préciser ce cas ; modifier simplement le filtre du tirage serait incomplet.

GrepAI search a localisé politique, tâches et tests ; trace callers de
`routeMissionTask` a retrouvé spawn/claim, mais attribue certains appels à un
symbole `if` d'un fichier d'évaluation : graphe indicatif seulement. Serena a
confirmé la racine de ce checkout, les corps ciblés et les références de
`routeExecution` / `validateTaskExecutionDecision`. Les recherches exactes ont
complété les usages version 2 et les deux schémas. Pas de preuve native en
serveur réel ni de mesure de capacité de Luna.

## 3. Décisions proposées

### D1 — Autorité et surface d'entrée

**Problème.** Une instruction utilisateur ne peut aujourd'hui devenir un choix
explicite pour une tâche planifiée sans modifier le routage global de la mission.

**Options.** (1) Abaisser seulement startingIntelligence : simple, mais change
tous les choix automatiques. (2) Ouvrir team_spawn.model : rend claim/dispatch
différents du spawn et affaiblit la provenance. (3) Étendre la décision existante.

**Recommandation.** Option 3 : autoriser model/variant en `planned` uniquement
sous une nouvelle politique approuvant cette capacité. Seul le lead autorise ;
les autres membres proposent. Une directive utilisateur est traduite en décision
par le superviseur, pas prétendument authentifiée par un champ JSON. Ajouter un
`reason` court aux choix explicites planifiés pour expliquer la dérogation au
démarrage automatique ; il est conservé dans la décision et la route admise.

**Rayon d'impact.** Parmi les 15 outils, mutation dans team_tasks_add ; lecture
commune dans spawn/claim/dispatch ; inspection dans tasks_list/status si ajoutée.
Schémas V1/V2 synchronisés ; hooks existants consomment la route. Stockage JSON
existant ; dashboard sans pouvoir de décision. Les autres outils, notamment
message/broadcast/handoff, ne deviennent pas des voies de sélection initiale.

**Invariants et preuves.** Pas de nouveau tool ; pas d'auto-autorisation membre ;
pas de réécriture après admission, même après release ; rejet d'un couple hors
catalogue avant allocation. Tests lead/membre, tâche déjà admise, batch invalide,
concurrence décision/claim et parité des schémas.

### D2 — Politique, plage et compatibilité

**Problème.** Une plage unique utilisée pour le tirage abaisserait aussi la qualité
par défaut. Un nouveau champ non reconnu peut être supprimé silencieusement par
`readPolicyDraft`, ce qui rend un changement sémantique sous version 2 risqué.

**Options.** (1) Une plage remplaçant le seuil : plus simple mais perd le défaut
fort. (2) Champ optionnel sous version 2 : moins de branches, mais vieux lecteur
susceptible de retirer le champ du draft. (3) Nouvelle version de politique
catalogue, avec défaut fort et plage explicite.

**Recommandation.** Version 3 opt-in, même catalogue, mêmes révisions SQL et
startingIntelligence, plus `planningIntelligenceRange: { min, max? }`. Min/max
finis non négatifs ; bornes inclusives ; min <= startingIntelligence et, si max
existe, startingIntelligence <= max. Aucun plafond arbitraire de 100.
Min est le plancher autorisé, startingIntelligence le plancher automatique ; max
est facultatif, non un plafond de coût. Ne pas renommer le champ historique.

Ne pas migrer les révisions approuvées ni re-hasher leur contenu. Les versions
1 (grille) et 2 restent lisibles avec leur comportement actuel. Un nouveau draft
version 3 exige config/start ; l'ancienne implémentation doit refuser cette
version plutôt que la traiter comme version 2. Interdire le downgrade du plugin
tant que des affectations version 3 restent actives : tester le refus de lecture,
sans promettre qu'un ancien binaire sait reprendre une nouvelle affectation.

Une option de configuration de même nom peut amorcer version 3 lors d'une
préparation/création explicite ; absente, continuer à créer version 2. Le projet
peut ainsi rester inchangé par défaut. Les équipes V2 créées directement peuvent
figer cette même politique ; ne pas réserver arbitrairement le contrôle au seul
chemin des commandes. La capacité V2 reste requise pour l'exécution autonome.

**Rayon d'impact.** config.ts, execution-policy.ts ; branches discriminantes de
mission-policy.ts, mission-commands.ts, task-execution.ts et team-tasks-add.ts.
Pas de nouvelle table ni de migration de user_version a priori. Aucun outil
supplémentaire sur les 15 ; aucune nouvelle API dans les adaptateurs ni les
hooks ; dashboard au plus informatif.

**Invariants et preuves.** Hash approuvé couvrant la plage ; affichage des couples
réellement admissibles ; config invalide refusée ; approval révoquée ou génération
native modifiée pendant une opération => pas d'admission. Fixtures versions 1/2
inchangées, tests version 3 avec/sans max et borne inclusive ; ancien parseur
refusant version 3. Ne jamais tester contre la DB utilisateur installée.

### D3 — Une sélection centrale, classification comprise

**Problème.** Ajouter une exception seulement dans spawn laisserait les workers
réutilisés et la classification choisir autrement.

**Options.** (1) Traiter le modèle comme simple conseil de prompt : très simple,
mais non garanti. (2) Deux modèles et changement au handoff : complexité inutile
pour le besoin. (3) Un choix initial commun, vérifié et persisté.

**Recommandation.** Option 3, dans execution-policy / previewMissionTask.
Pour une nouvelle politique version 3, définir P = couples activés du catalogue
approuvé dont le score est dans la plage de planification.

- Planned avec décision explicite : sélectionner exactement ce couple dans P.
  La décision prime sur la sélection automatique ; les scores/classifications
  restent soumis aux barrières de sécurité existantes, sans falsification.
- Planned sans décision explicite ni classification : hash reproductible parmi
  P dont le score atteint startingIntelligence ; aucun candidat => erreur.
- Classification explicite sans décision de modèle : exécuter le routeur sur P,
  pas sur le catalogue complet puis contourner les bornes. Cela change
  volontairement la normalisation min/max pour la seule version 3 ; le figer
  dans des tests. Versions 1/2 : aucune modification de cet algorithme.
- Direct : catalogue approuvé complet, pas P ; même sélection explicite ou
  déterministe qu'aujourd'hui. Garder le contrôle documentation/recherche.

`variant` sans `model` reste invalide. Pour un modèle sans variante, conserver
la signification actuelle : identité native par défaut, pas « n'importe quelle
variante ». Si ce couple n'existe pas, erreur avec les variantes admissibles,
pas d'invention. Chaque score porte sur un couple modèle/variante précis.

**Rayon d'impact.** execution-policy, mission-policy, validation initiale de
team-tasks-add ; spawn/claim/dispatch héritent de la route commune. Sur les 15
outils, handoff conserve uniquement le changement de phase/raisonnement du même
modèle. Aucun changement de hooks/adaptateurs/SQLite/dashboard pour l'algorithme.

**Invariants et preuves.** Même décision et révision donnent même couple sur
spawn, claim, dispatch et redémarrage. Pas de fallback silencieux hors plage,
pas de classification inventée. Tester choix explicite sous le défaut mais dans
P, choix hors P, score exactement aux bornes, classification dont le résultat
ancien était hors P, couple natif disparu et refus V1 sans capacités adéquates.
Les variantes d'implémentation restent celles du même modèle dans le catalogue
approuvé : ne pas leur appliquer par erreur une plage réservée à la planification.

### D4 — Admission, application native et observabilité

**Problème.** Un choix enregistré ne prouve pas que le worker tourne dessus ; une
erreur native ou une révision changée pendant l'attente ne doit pas libérer du
travail avec le mauvais modèle.

**Options.** (1) Écrire uniquement team_member.model : simple mais faux contrat.
(2) Réutiliser affectation, phase `applying` et contrôles natifs existants.

**Recommandation.** Option 2. Enregistrer la décision validée et son motif dans
les JSON existants, copier dans la route avec révision/hash. Après découverte
native asynchrone, revérifier approbation et éligibilité avant la transaction ;
ne pas utiliser une photographie devenue obsolète. Conserver les réservations,
quarantaines et reprises existantes. Pas de provider retry ni nouvelle boucle.

**Rayon d'impact.** Contrat d'admission des outils tasks_add/spawn/claim, dispatch,
assertMissionMemberModel et application task-execution ; stockage existant.
Hooks système/compaction doivent rapporter le choix réellement admis. V1/V2
gardent leurs contrôles natifs respectifs. Premier lot : board/messages et
prévisualisation suffisent ; extension additive de la projection dashboard
possible ensuite, sans commandes de sélection ni refonte UI. Les autres outils
des 15, shutdown/cleanup/merge inclus, gardent leur contrat.

**Invariants et preuves.** Pas de prompt d'exécution avant application native ;
échec = pending/reprise ou release/quarantaine existante, jamais succès simulé.
Les tâches en cours gardent leur décision/révision. Les permissions du profil,
QA, dépendances, budgets et critical stops ne sont pas contournés. Tout abort
existant conserve preserveBranch avant abort, y compris rollback du spawn.
Tests erreur switchModel/switchAgent, révocation pendant découverte, course
admission/décision, reprise et provenance corrompue ; tests de rollback/preservation
existants toujours verts. Aucun nouveau chemin d'abort nécessaire.

## 4. Contrat pour l'implémenteur et tranche verticale

Après approbation explicite uniquement :

1. Tests RED sur la nouvelle politique et ses bornes, puis implémentation minimale
   dans execution-policy/config ; conserver intégralement les fixtures v1/v2.
2. Tests RED de présentation/approbation v3 et des snapshots créés directement ;
   brancher validation, hash, affichage et amorçage sans migration SQL destructive.
3. Tests RED du choix planifié via execution_decisions ; synchroniser les deux
   schémas et ajouter motif/provenance. Réutiliser les contrôles direct existants
   pour la disponibilité, avec revérification après await.
4. Prouver un scénario de bout en bout : catalogue contenant un couple faible et
   un fort ; défaut fort ; une tâche planned explicitement faible reste en
   planning read-only ; une autre tâche automatique reste forte ; handoff garde
   le modèle faible et ne restaure que les permissions du profil ; tâche suivante
   du même worker reroutée. Répéter par spawn, claim et auto-dispatch.
5. Mettre à jour les guides concernés dans un futur lot autorisé. Le présent
   travail n'écrit que dans docs/plans et ne répare pas les écarts recensés.

**Hors périmètre :** deux modèles par tâche, changement du modèle au handoff,
nouveau superviseur/classifieur, routage par benchmark externe, extension du
direct au code, nouvelle authentification de commandes humaines, modification
du modèle natif du lead, nouveau tool/RPC, modification globale du catalogue,
refonte dashboard ou nouvelles permissions pour les profils restrictifs.

Ne pas modifier la séparation report_mode team_message / final_response de
`docs/worker-reporting.md` : les collaborateurs exécutent la voie autonome ; les
restrictions natives et la revue/clôture lead des profils restrictifs restent
en place. Pas d'élargissement implicite pour rendre les tests faciles.

Acceptation : tests heureux et erreurs pour l'entrée modifiée ; parité hôtes ;
legacy vert ; aucune exécution hors couple/plage autorisés ; pas d'affectation
réécrite ; application native prouvée avant premier prompt. Avant livraison de
code : `bun run typecheck && bun test && bun run build`. Les mocks prouvent le
contrat d'appel, pas le modèle réellement utilisé : vérifier aussi une tâche
sur un hôte V2 avec des identités réellement disponibles.

## 5. Vérification effectuée pendant l'exploration

Exécution ciblée, sans changement des tests :

    bun test test/execution-policy.test.ts test/direct-task-execution.test.ts
      test/autonomous-execution.test.ts test/mission-routing-integration.test.ts

Résultat : **78 pass, 0 fail, 222 assertions** (quatre fichiers). Les tests
existants couvrent seuil sans candidat, direct sous le seuil, interdiction du
direct au code, lead/membre, choix hors catalogue, application native, dispatch,
révisions et rollback avec préservation de branche. Ils ne prouvent pas la
fonctionnalité proposée, absente du code. Typecheck, suite complète et build
non exécutés dans cette exploration documentaire ; aucun résultat de validation
globale ou de preuve native n'est revendiqué.

## 6. Questions ouvertes à arbitrer

- **OQ-1.** Confirmer la séparation « défaut automatique fort » / « plage autorisée
  pour choix explicite », plutôt qu'un unique tirage dans une plage abaissée ?
- **OQ-2.** Souhaitez-vous un plafond max dès le premier lot ? Recommandation :
  facultatif, sans plafond par défaut ; aucun lien implicite avec le coût.
- **OQ-3.** Le mode non planifié doit-il rester documentation/recherche, ou aussi
  permettre du code trivial ? Recommandation : ne pas élargir dans ce lot ; si
  souhaité, décision de sécurité distincte avec critères et tests dédiés.
- **OQ-4.** Accepter la restriction de la classification à P pour la seule nouvelle
  version, et la priorité d'un choix explicite valide sans suppression des
  barrières de classification/sécurité ? Sinon, préciser une autre sémantique
  avant d'implémenter ; ne pas laisser une voie contourner la plage.
- **OQ-5.** Valider la nouvelle version opt-in et son coût de compatibilité plutôt
  qu'un champ ajouté sous version 2 susceptible d'être supprimé par un ancien
  lecteur ? Recommandation : version distincte et aucun changement automatique
  des missions approuvées.
