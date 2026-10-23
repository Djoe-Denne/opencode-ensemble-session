# Exécution adaptative par mission — contrat minimal

**Statut : proposed.** Aucune approbation humaine de cette proposition n'est acquise.
Lot A : `task_mvic0y65_0002_gt0nbe`. Auteur : `adaptive-architect`.
Date : 2026-10-21. Conception seulement ; aucune modification de source, test,
configuration de mission, catalogue utilisateur ou configuration globale.
Clarification du lead intégrée : **aucune classification n'est requise dans
le nouveau mode** ; préserver la classification historique ne signifie pas
la rendre obligatoire pour l'adaptatif.

## 1. Résultat recommandé et limites

Ajouter un mode **optionnel par révision de mission**, à côté de la grille
historique, avec deux sélections persistées par tâche : planification puis
exécution. L'utilisateur choisit deux plages d'intelligence, voit les couples
modèle/variante réellement admissibles et leurs coûts, puis approuve cette
présentation par `config` / `start`. Aucun pool n'est élargi implicitement.

La première tranche utilise un seul worker collaborateur par tâche, une seule
session et le worktree existant. Changer de phase peut changer de modèle ;
l'escalade **pendant l'exécution** ne peut changer que la variante du modèle
d'exécution déjà tiré. Les deux choix initiaux restent attachés à la révision
admise, même si une autre révision est approuvée entre les phases.

**Barrière avant implémentation :** approbation humaine du contrat et revue
indépendante. **Barrière avant activation :** preuve native du changement sur
le prochain tour, y compris continuation après outil. Les tests de mocks,
le nom d'un profil, un effort canonique ou un POST réussi ne franchissent pas
cette seconde barrière. Une compatibilité V2 limitée et un refus explicite
sont préférables à une prétendue adaptation sur le mauvais modèle.

Ne pas ajouter de superviseur, de profil/famille obligatoire, d'équipe imbriquée,
de moteur JSON de milestones, de classifieur ou de seizième outil. Le lead garde
son modèle natif et ses responsabilités actuelles. Les workers restent feuilles.
Les providers et pools de développement de **cette mission de conception**
restent ceux de sa politique approuvée ; ce document n'accorde aucun override.

## 2. Faits vérifiés et niveaux de preuve

### 2.1 Recherche et périmètre

GrepAI a localisé les contrats de politique et de variantes ; ses traces de
`getMemberPromptModel` ont identifié claims, dispatch, messages, recovery,
watchdog et événements. Certaines étiquettes d'appelant de la trace sont
imprécises (`if` attribué à un autre fichier) : les corps Serena font foi.
Serena est attaché au checkout canonique
`C:/Users/djden/source/repos/opencode-ensemble-session`, racine Git commune du
worktree de ce lot. Aucune réactivation du projet partagé n'a été effectuée.
Comparaison textuelle effectuée : `mission-policy`, `mission-model-policy`,
`mission-commands`, `model-router`, `variant-effort`, `dispatch`, `member-model`,
`v2-client`, `schema`, `types` sont identiques entre checkout et worktree au
moment de la recherche. Les lectures complémentaires concernent ce worktree.

### 2.2 Catalogue et politique actuels

- `src/model-router.ts`, `RoutingModel` et `validateModelRoutingConfig` :
  `intelligenceScore` **et** `averageCostPerTask` appartiennent à chaque entrée
  `(id, reasoningEffort)`, pas au seul nom de modèle. Valeurs finies,
  non négatives ; doublons refusés. Le validateur historique assimile effort
  omis et chaîne `default` pour l'identité du catalogue.
- `src/config.ts`, `readConfigFile` / `loadConfig` : catalogue `ensemble.json`,
  fusion globale/projet ; une section invalide peut conserver la configuration
  héritée avec avertissement. La présentation doit donc indiquer le catalogue
  effectivement chargé, pas déduire son contenu du seul fichier édité.
- `src/model-router.ts`, `routeModel` : sélection historique déterministe au
  moindre coût suffisant ; `docs/model-routing.md` et
  `test/model-router.test.ts` en fixent le comportement. Ce n'est ni un tirage
  équilibré par provider, ni une politique de réessai.
- `src/mission-model-policy.ts`, `MissionModelPolicy` / `routeMissionModel` :
  schéma strict version 1, grille risque × complexité, groupes ordonnés.
  `MissionPolicyModel.effort` est une annotation seulement.
- `src/mission-policy.ts`, `seedPolicy` : les métriques du catalogue amorcent
  un brouillon visible ; la grille approuvée ne relit pas ces métriques.
  `approveMission` vérifie providers, disponibilité native exacte, variantes,
  désactivation opérateur et disponibilité des helpers explicitement choisis.
- `src/mission-native-models.ts`, `nativeMissionModels` : modèles activés et
  `variant.id` exacts, avec une identité distincte à variante omise.
  La présence au catalogue n'est pas une preuve d'authentification ou de quota.
- `src/mission-policy.ts`, `openMissionConfiguration`, `markMissionPresented`,
  `approveMission` : config suspend les nouvelles admissions ; hash présenté,
  jeton temporel et révision protègent contre les approbations périmées.
  `mission_policy_revision` conserve le JSON approuvé. Une propriété JSON
  `approved` n'accorde aucun droit.
- `src/mission-commands.ts`, `registerMissionCommands` : commande V2 native,
  découverte asynchrone des modèles et relance idempotente. Il n'existe pas
  aujourd'hui de sous-commande `preview` ; **`config` présente l'aperçu**.
  La route publique ne prouve pas l'origine humaine authentifiée de la commande
  (`docs/mission-policy.md`, « Approval and enforcement »).

### 2.3 Affectation, livraison, SDK

- `src/tools/team-claim.ts`, `claimTask` : claim CAS dans une transaction,
  classification requise, dépendances, une tâche en cours par worker gouverné,
  revalidation de la révision et persistance de la route.
  `executeTeamClaim` attend le **pin natif**, pas `promptAsync`, avant de rendre
  le contrôle. Échec : claim libéré, worker en erreur et lead notifié.
- `src/dispatch.ts`, `dispatchNextTask` : claim puis livraison fire-and-forget ;
  une erreur de transport libère actuellement le claim. L'adaptatif devra
  conserver son tirage même quand cette affectation est libérée.
- `src/board-classification.ts`, `classifyBoardTasks` : chemin automatique
  actuel, avec leases et validation des tâches avant publication. En adaptatif,
  son déclenchement et les gardes de classification des claims doivent être
  conditionnés au mode ; le contrat actuel n'offre pas encore cette séparation.
- `src/member-model.ts`, `getMemberPromptModel`, appelle
  `assertMissionMemberModel`. Celui-ci recalcule la **grille** de la révision
  historique, vérifie son hash et n'admet une alternative qu'avec journal.
  Une route adaptative ne peut donc pas être injectée dans le JSON actuel en
  faisant semblant d'être une cellule de grille.
- `src/tools/team-message.ts`, `executeTeamMessage` : une mission gouvernée
  refuse `model` et `classification` ; les autres équipes gardent leur override
  historique. Les messages au lead sont synthétiques ; les livraisons aux
  workers relisent le modèle persisté.
- `src/types.ts`, `PluginClient.session.switchModel` est optionnel.
  `src/v2-client.ts`, `createV2Client` expose ce pont et envoie exactement
  `{model:{providerID,id,variant?}}`. Une livraison normale applique d'abord
  agent/modèle puis le prompt ; la branche `synthetic` retourne immédiatement
  vers `session.synthetic` et **n'applique pas** les champs modèle/variante.
  Ajouter une variante à un wake synthétique ne prouve donc aucun changement.
- `src/v2-session.ts`, `createTeammateSession` / `deliverPrompt` : façade de
  création avec agent/permissions et prompt en delivery queue ; ni modèle ni
  variante dans ces fonctions. Elles ne prouvent pas davantage un pin natif.
- Les déclarations publiques installées, `@opencode/plugin` **2.0.26**,
  `dist/promise/session.d.ts`, exposent `switchModel`, `get`, `context`,
  `compact`, `wait` et les hooks `context`, `model.request`, `http.request`.
  `SessionRequest.model` / `SessionModelRequest.model` sont **readonly** ;
  `kind` distingue `primary`, `compaction`, `title`, `generate`.
  Le type public suffit à constater une surface, pas son comportement au tour
  suivant. Déclarations consultées dans les dépendances du checkout canonique ;
  le worktree de ce lot n'a pas de `node_modules`.
- Documentation V2 consultée :
  <https://opencode.ai/v2/docs/build/plugins> et
  <https://opencode.ai/v2/docs/api>. Les options des hooks de requête ne sont
  pas une mutation persistante du modèle de session. Aucun contrat vérifié ici
  ne garantit `configuration_update`, cache conservé, continuité d'une socket
  fournisseur, ni modification d'un appel déjà parti.

### 2.4 Preuves natives déjà disponibles — ne pas les surinterpréter

`docs/plans/sp3-native-variants.md`, §§1, 7–8 : IDs longs et Unicode de Cursor
confirmés dans `variant.id`. Ne pas les traduire en `xhigh`, supprimer des
caractères invisibles, ni confondre `none`, omis et liste vide.

`docs/plans/SP-4/README.md`, §§Result, Exact bodies, Profile effort follow-up :
sur OpenCode **2.0.32**, des switches explicites `low` / `xhigh` sont relus
dans l'état natif. Une omission après `xhigh` donne le readback serveur
`default` ; une chaîne inconnue est acceptée. Le profil ne fournit pas l'effort
omis. **Aucune inférence n'a été exécutée** : ce spike partiel, non accepté,
ne prouve ni le réglage fournisseur ni la prochaine continuation après outil.
`test/native-switch-model.test.ts` teste le runner et la séparation erreurs de
POST/readback ; ce ne sont pas des inférences natives.

### 2.5 Contradictions / écarts à signaler, sans réparation silencieuse

1. `AGENTS.md`, « Architecture / Storage », décrit quatre tables ;
   `src/schema.ts` contient aussi politique/révisions/résultats/journal et
   **21 migrations**. Les slots 17–20 sont intentionnellement sans effet à
   cause d'un historique installé différent. Ne pas baser une migration sur
   le résumé « quatre tables », ni réutiliser ces numéros.
2. `AGENTS.md`, « Message Delivery », dit toutes les livraisons via
   `promptAsync`. `src/mission-commands.ts` utilise le prompt public natif
   attendu pour présenter/confirmer les commandes ; `src/v2-client.ts` adapte
   les wakes synthétiques à `session.synthetic`. Conserver la distinction
   commandes / livraisons partagées ; ne pas généraliser le résumé en promesse
   qu'un wake synthétique applique une variante.
3. `docs/model-routing.md` et `README.md` disent les variantes transmises et
   persistées aux wakes ; le code le confirme pour les livraisons normales,
   pas pour la branche synthétique seule. C'est une limite de portée de cette
   affirmation, pas une preuve native au prochain tour.
4. `docs/mission-policy.md` garantit la conservation des révisions admises ;
   `dispatchNextTask` libère un claim sur erreur de livraison et un nouveau
   claim recalcule la route courante. L'adaptatif exige une affectation durable
   séparée du claim pour empêcher un reroll ; ne pas modifier ce comportement
   de grille par accident.

## 3. Décisions proposées

Les invariants transverses de §8 s'appliquent à chaque décision.

### D1 — Versionner le mode sans remplacer la grille ni la classification

**Problème.** La politique stricte actuelle n'a pas de mode/plages ; changer la
signification de ses groupes casserait l'historique et la provenance.

**Options.** (1) détourner les groupes V1 (simple mais ambigu, rejeté) ;
(2) schéma V2 explicite conservant les champs de grille et ajoutant un bloc
`executionPolicy` (recommandé) ; (3) second moteur indépendant et second fichier
d'approbation (complexité injustifiée).

**Contrat recommandé.** Les JSON V1 restent byte-logiquement inchangés et se
lisent en mode `grid`. V2 conserve `providers`, `assessment`, bandes, groupes et
matrice ; ajoute `executionPolicy` discriminé `mode: grid | adaptive`. Le mode
adaptatif porte `planningRange`, `executionRange` (bornes inclusives finies,
non négatives, min ≤ max), `costPreference: none | cheapest_within_model`,
`maxEscalations` entier borné et des échelles natives explicitement approuvées.
Pas de seuil d'intelligence supposé 0–100. La grille reste stockée, valide et
utilisable en revenant au mode grille ; elle ne choisit pas les candidats
adaptatifs. **Aucune classification ni score complexité/risque n'est requis en
adaptatif.** Les anciennes données de classification restent conservées ;
critères, budgets, échelles normalisées et refus d'admission restent inchangés
sur le chemin grille/legacy. Aucun classifieur de remplacement n'est ajouté.
L'admission adaptative ne lit pas les scores pour choisir son pool, n'exige pas
de helper et ne lance pas automatiquement JEV, général ou x86. Ne pas feindre
une classification réussie pour contourner les gardes actuelles : brancher ces
gardes explicitement selon le mode de la tâche/révision admise.

`config` produit un aperçu sans tirage : pools exacts, métriques par couple,
échelles, limites et exclusions motivées. `start` valide cette présentation.
Le hash de révision couvre **aussi** les pools résolus, métriques et échelles ;
éditer le catalogue, les plages ou une échelle après aperçu invalide cet aperçu.
Le JSON approuvé est autonome ; il ne dépend plus d'un catalogue mutable.

**Rayon d'impact.** Mission commands/policy/validation, SQLite révisions,
admission de spawn/claim/dispatch ; pas de nouvel outil parmi les 15. Les hooks
lisent le mode admis ; V1 refuse l'activation adaptative ; dashboard affiche le
mode/révision sans piloter de sélection. Aucun changement global/provider.

**Invariant particulier.** Aucun effet sur les missions V1/grille ou équipes
legacy ; aucune approbation par champ outil, message ou simple modification
de fichier. **Preuves.** Tests V1 existants inchangés ; test rouge d'un JSON V2
avant support, tests d'aperçu périmé/catalogue modifié, reprise après config
invalide, start répété, classification toujours requise lorsqu'elle l'était
en grille mais jamais exigée/déclenchée pour une nouvelle admission adaptative.

### D2 — Tirage hiérarchique figé, pas de vote supplémentaire par variante

**Problème.** Un tirage uniforme sur les lignes du catalogue avantage les
providers/modèles ayant beaucoup de variantes ; relire le catalogue à chaque
tour détruit l'audit et la reproductibilité.

**Options.** (1) round-robin déterministe (plus simple mais pas aléatoire) ;
(2) tirage provider → modèle → couple (recommandé) ; (3) ordonnanceur global
pondéré par charge/coût/quota (hors tranche).

**Contrat recommandé.** Résoudre chaque pool par intersection : catalogue
effectivement chargé, entrée `available`, métriques valides du **couple**,
provider autorisé, modèle natif activé et variante exacte disponible, puis
plage de la phase. Le champ provider auxiliaire ne remplace pas le préfixe de
`id` ; incohérence = exclusion motivée/erreur de validation, jamais deux votes.
Une identité n'apparaît qu'une fois. Métrique inconnue, négative, NaN, paire
non calibrée : exclue, jamais zéro, jamais métrique copiée d'une autre variante.
Pool vide = refus ; provider sans candidat = absence explicitée dans l'aperçu.

À la **première admission de tâche**, dans la transaction d'affectation :
tirer uniformément un provider non vide, puis uniformément un modèle distinct
de ce provider, puis une variante admissible de ce modèle, séparément pour
planning et exécution. Le mode `none` tire uniformément les couples restants
de ce modèle. `cheapest_within_model` retient les couples au coût minimum de
ce modèle, puis tire parmi les ex aequo. Ainsi le coût ne retire pas les votes
des autres providers/modèles. Les nombres de variantes ne changent ni la
probabilité d'un provider ni celle d'un modèle. « Équilibré » signifie ici
probabilités égales, **pas** quotas réalisés égaux sur un petit échantillon.

La fonction pure reçoit une source aléatoire injectable ; production utilise
un générateur sûr sans biais modulo. Persister gagnants, univers de tirage,
version d'algorithme et identifiant de décision, pas une graine secrète globale.
Le perdant d'un CAS réutilise les choix du gagnant. Aucune redécision par tour,
wake, réassignation après transport incertain, redémarrage ou nouvelle révision.

**Rayon d'impact.** Nouveau sélecteur pur et admission des outils existants ;
stockage d'affectation ; aucune sélection dans hooks/V1/V2/dashboard.
`model-router.ts` historique reste hors refonte. **Invariant particulier.**
Pools approuvés fermés ; pas de fallback inventé ni override de développement.
**Preuves.** Tests déterministes sur intervalles RNG, ordre d'entrée indifférent,
duplication de variantes sans vote supplémentaire, coût zéro valide, coûts
inconnus exclus, plusieurs providers avec cardinalités inégales et CAS concurrent.
Un test probabiliste flaky n'est pas la preuve principale.

### D3 — État durable séparé de l'exécution du worker

**Problème.** `team_member.model` n'exprime ni phase de tâche, ni affectation
figée, ni incertitude après mutation native. Une transaction SQLite ne peut
englober atomiquement un appel SDK distant.

**Options.** (1) réutiliser seulement `model_routing` JSON (plus simple, mais
aucun CAS/état d'application robuste) ; (2) deux petites tables SQLite avec
projection membre (recommandé) ; (3) event-sourcing général de tout Ensemble
(rejeté). Ne pas remplacer les machines `member` / `execution` existantes.

**Schéma proposé**, migration additive suivante après 21 (22 si encore libre
à l'intégration), via `src/schema.ts` / `src/db.ts` exclusivement :

- `task_adaptive_assignment` : clé `(team_id, task_id)`, révision/hash, snapshot
  JSON versionné des **deux** choix et de l'échelle autorisée, `phase`
  (`planning | execution | completed | stopped`), `row_version`,
  `member_name`, `session_id`, `binding_generation`, `escalation_index`,
  `apply_state` (`pending | applied | uncertain | blocked`),
  `pending_transition_id`, horodatages. Références aux tâches/révisions avec
  intégrité contrôlée ; une session peut être liée à au plus une tâche active.
- `task_adaptive_transition` : clé `id`, clé d'affectation, `request_id` unique
  par tâche, version attendue et génération de binding, opération
  (`admit | begin_execution | escalate | complete | stop`), phase/paire source
  et cible exactes, acteur/session, raison et référence de preuve bornées,
  état (`pending | applied | uncertain | rejected`), erreur/readback épuré,
  horodatages. Les cibles ne sont jamais réécrites ; seul le résultat est
  finalisé. C'est un journal de transition borné par opérations, pas un moteur
  de milestones ni une reconstruction de l'historique natif.

`team_task.model_routing` et `team_member.model_routing` reçoivent une
**provenance discriminée**, `kind: adaptive`, `schemaVersion`, référence
d'affectation/révision/hash et projection de la phase/paire appliquée. La grille
historique n'est pas recopiée sous ce discriminant. Les gardes vérifient la
révision historique, le snapshot et le journal appliqué, pas la nouvelle
politique courante ; aucun champ JSON isolé n'est une autorisation.

Ordre : (a) réserver par CAS et persister l'intention/cible ; (b) appeler le
switch public hors transaction ; (c) relire le natif, finaliser par CAS et mettre
à jour la projection membre. `phase`/index restent anciens tant que (c) n'est
pas établi ; `pending_transition_id` porte la cible. Un seul switch en vol par
session/binding. Les livraisons relisent la projection **applied**, et refusent
pending/uncertain au lieu de réappliquer l'ancien modèle ou le défaut natif.

Reprise : réconcilier un intent pending/uncertain avec le même session ID,
binding et cible. Le readback seul prouve l'état sélectionné, pas une inférence.
Cible observée : finaliser sans nouveau tirage ; source encore observée :
nouvelle tentative bornée vers **la même cible** ; état divergent/lecture
indisponible : bloquer/notifier, pas de rollback deviné. Un ancien callback
ne peut finaliser un nouveau binding. Claim libéré ≠ affectation effacée.
Une réassignation explicite réutilise phase/paire/index ; une relance supposée
« propre » exige une **nouvelle tâche**, pas un reroll caché de la précédente.

**Rayon d'impact.** SQLite, gardes de provenance, claim/spawn/dispatch,
recovery et événements V2 ; les 15 outils restent distincts. Hooks et dashboard
ne sont que consommateurs de l'état. V1 ne synthétise aucun état adaptatif.
**Invariants particuliers.** Pas de transaction ouverte pendant un await SDK,
pas de changement d'assignee/worktree par une escalade, pas d'histoire native
copiée. **Preuves.** SQLite mémoire, `Promise.all` pour claim/escalade/start,
crash à chaque frontière (avant/après POST et finalisation), callback périmé,
reconstruction des dépendances et JSON corrompu ; toutes les reprises gardent
exactement les choix initiaux et l'index maximum atteint.

### D4 — Transitions explicites dans `team_message`, escalade bornée

**Problème.** Sans signal formel, une phase ou difficulté déduite d'un texte,
d'un nombre de tours ou d'une erreur réseau devient une autorisation implicite.

**Options.** (1) seul le lead respawn à chaque phase (plus simple, perd continuité
et implique gestion de branches) ; (2) extension typée de `team_message`
(recommandé) ; (3) nouvel outil ou superviseur automatique (interdit).

**Contrat proposé**, champ optionnel `execution` sur l'outil existant :
`{ operation: begin_execution | escalate, task_id, expected_version,
request_id, reason, evidence? }`. Pas de champ modèle/variante/provider libre.
V1 et missions non adaptatives refusent ce champ, sans modifier leurs appels
existants. Le caller doit être le worker propriétaire de la tâche dans la
session/binding courants ; destination `lead` obligatoire. Les autres contrôles
(`model`, `classification`, `approve`, `reject`, `force`) sont incompatibles
dans le même appel. Le `text` facultatif est informatif et ne fait pas contrôle.
L'opération persistée fournit le message au lead ; un échec de notification
ne rejoue pas le switch. Doublon request_id + même contenu = même résultat ;
même ID avec autre contenu = refus. Version périmée = relire l'état, pas reroll.

`begin_execution` signifie « plan produit, passage à l'exécution » et demande
une raison/référence de plan ; applique le **choix d'exécution déjà persisté**.
L'approbation de plan existante reste **prompt-enforced**, conformément à
AGENTS : ce champ n'introduit pas un mécanisme de permissions ou un nouveau
gating de `plan_approval`. Le worker attend l'approbation existante lorsqu'elle
est demandée. Cette confiance déclarative est une limite documentée, pas une
barrière de sécurité inventée. Le changement planning → exécution peut être
moins coûteux/moins intense ; ce n'est pas une désescalade d'exécution.

`escalate` est l'auto-escalade **explicitement sollicitée par le worker** avec
raison/problème reproductible, autorisée à l'avance par la révision, sans vote
ni modèle juge ni nouvelle approbation à chaque cran. Seulement phase execution,
prochain cran de l'échelle du **même provider/model**, au plus `maxEscalations`.
Refuser saut libre, descente, chaîne inconnue et plafond dépassé ; retourner
« épuisé/bloqué » avec notification, pas remplacer le modèle. L'échelle est une
liste exacte présentée/approuvée, strictement ascendante en effort **validé** ;
un alias canonique seul ne permet pas d'établir cet ordre. Effort natif inconnu
ou variantes portant aussi des dimensions Fast/contexte : échelle absente tant
que leur relation n'est pas explicitement validée. Une échelle singleton est
valide, mais son absence d'escalade doit être visible et approuvée.

Les plages s'appliquent aux choix **initiaux**. Les variantes d'escalade peuvent
dépasser la plage initiale seulement si l'aperçu les autorise séparément avec
leurs métriques/plafond ; elles ne sont pas ajoutées implicitement au pool.
Pas de désescalade automatique pendant execution, même après reprise/compaction.

`team_tasks_complete` conserve sa fonction : en adaptatif, terminer en planning
ou pendant pending/uncertain est refusé ; terminer en execution finalise tâche
et phase ensemble. Le lead conserve ses droits actuels de clôture ; un abandon
explicite conserve l'historique et n'imite pas un succès. Les rapports
`<task-result>` restent des rapports, pas des transitions analysées par regex.

**Rayon d'impact.** `team_message`, `team_tasks_complete`, schémas V1/V2 de ces
outils et leurs tests ; hooks rappellent phase/cible sans timer ; stockage D3 ;
dashboard/status expose résultat, pas nouveau bouton de mutation. Les 13 autres
outils gardent leur rôle, avec les gardes d'admission communes nécessaires.
**Invariants particuliers.** Worker feuille, aucune délégation ; isolation
descendants et contrôles de rôle inchangés ; mission config seule change les
pools. **Preuves.** Happy path planning → execution → un cran → complete ;
erreurs wrong-owner/wrong-session, phase invalide, champs incompatibles,
opération concurrente, plafond et duplicate ; chemin message classique et
approbation de plan historique inchangés.

### D5 — Appliquer nativement avant de promettre le prochain tour

**Problème.** Une mise à jour SQLite ou un prompt « effort élevé » n'affecte pas
nécessairement la requête suivante ; un serveur peut accepter une variante
inconnue et une continuation peut déjà avoir capturé son modèle.

**Options.** (1) effort dans le prompt/profil (simple mais faux contrat natif) ;
(2) `switchModel` public à une frontière vérifiée (recommandé sous barrière) ;
(3) options fournisseur ad hoc, protocole `configuration_update` ou manipulation
du cache/socket (non prouvés et hors tranche).

**Contrat recommandé.** Support adaptatif initial : V2 seulement, capacités
de commande/catalogue/switch/get et frontière de continuation démontrée.
Admission fraîche applique le planning avant le premier prompt de travail.
Transition depuis l'outil du worker attend le switch/readback puis rend son
résultat : ne pas envoyer un prompt artificiel supplémentaire pour continuer.
Cet await de contrôle est distinct de `promptAsync`, qui reste toujours
fire-and-forget. Un wake synthétique n'est jamais le mécanisme de sélection.
Ne pas utiliser `team_handoff` : changer l'agent conserve le modèle et n'est pas
un réglage d'effort. Les variantes omises gardent la sémantique historique pour
la grille ; la première tranche adaptative exige des **IDs natifs explicites**
pour les couples sélectionnés/escaladables. Les modèles sans variante prouvée
sont exclus avec raison, plutôt que dotés d'un défaut inventé (voir OQ-4).

Échec/timeout après switch : état uncertain, aucun succès annoncé, pas de
nouveau prompt métier, reprise D3. Il faut aussi prouver que l'échec de l'outil
ne laisse pas partir une continuation métier sur une ancienne sélection :
si la surface publique ne permet ni frontière sûre ni arrêt pré-dispatch
vérifié, **désactiver le mode adaptatif sur cet hôte**, pas prétendre qu'un
message d'erreur l'a empêchée. Aucun abort ajouté pour masquer cette lacune.

**Spike préalable**, dans une fixture isolée autorisée, sans modifier mission,
profil utilisateur ou config globale : enregistrer version hôte/SDK/bundle,
catalogue natif, appels exacts, readbacks, hooks `model.request` et réglages
transport fournisseur non sensibles. Un provider fixture public compatible
sert d'abord à prouver l'ordre ; une inférence réelle autorisée séparément est
nécessaire pour affirmer que le provider concerné applique réellement l'effort.
Scénarios : premier tour planning, outil begin_execution, **continuation de
la même boucle**, escalation et continuation, wake normal, wake synthétique,
nouveau claim, interruption de réponse SDK, reprise du plugin et compaction.
Dans chaque cas distinguer requêtes primary et auxiliaires ; observer modèle
**et** variante et leur traduction effective par le driver. Aucun token, prompt
complet ou header sensible dans la preuve publiée.

Pas de promesse de changement rétroactif de l'appel en cours, ni de budget
raisonnement numérique portable entre providers. La compaction conserve
l'affectation en SQLite et l'identité native ; elle peut changer le contexte
utile et le cache fournisseur. Ne pas la lancer pour appliquer un effort.
Pas de garantie de cache conservé, de coût réel identique au coût moyen, ni
de support `configuration_update`. Un comportement démontré sur un transport
ne prouve pas celui d'un autre (HTTP/WebSocket).

**Rayon d'impact.** Adapter V2/types, intégration admission/transitions,
recovery et éventuellement garde publique pré-dispatch uniquement si prouvée ;
V1 garde son mode actuel et refuse adaptatif. Aucun outil supplémentaire,
aucune écriture directe dans l'état OpenCode, dashboard purement observationnel.
**Invariants particuliers.** API publiques uniquement, `._client` inchangé,
native ID exact, jamais `await promptAsync`, preserve-before-abort partout.
**Preuves.** Mocks pin/order/error + spike natif ci-dessus ; les deux niveaux
sont obligatoires et explicitement distingués dans la restitution.

### D6 — Révisions, migration, résilience et visibilité conservatrices

**Problème.** Changer de mode à chaud ou réutiliser le failover existant peut
réécrire une tâche admise et contourner l'échelle du même modèle.

**Options.** (1) interdire tout changement après start (plus simple mais ne
répond pas au besoin) ; (2) révision pour nouvelles admissions seulement
(recommandé) ; (3) remapper les tâches en cours automatiquement (rejeté).

**Contrat recommandé.** Ouvrir config suspend seulement les **nouvelles
admissions**. Planning/execution/escalades déjà admis continuent sous leur
révision historique valide, sauf arrêt de sécurité critique existant.
Une tâche sans affectation utilise la nouvelle révision après start ; une
tâche ayant déjà reçu une affectation la conserve, même si claim relâché.
Passage grid ↔ adaptive par version explicite de politique, présentation puis
start ; pas par `team_create.classification`, `team_message.model`, profil,
configuration globale ou flag caché. La classification historique garde ses
propres tokens/budgets et la réévaluation des tâches **non admises destinées à
la grille** lorsque le rubric change. Une nouvelle admission adaptative ne
demande ni classification, ni helper, ni scores ; le drain automatique doit
ignorer ces tâches. Une réponse de classifieur lancée sous une ancienne révision
ne peut publier de décision d'admission adaptative : revalider mode/révision
avec le lease avant publication. Conserver les résultats/budgets historiques,
ne pas les remettre à zéro ou marquer artificiellement les tâches « classifiées ».
Ne pas reclassifier une affectation conservée comme neuve. Un arrêt de sécurité
critique réel reste à résoudre explicitement ; l'absence de classification
adaptative ne signifie pas lever arbitrairement les arrêts de sécurité.

Nouvelle migration additive transactionnelle ; DB vierge et DB de checkout
versions 16/20/21 testées, slots 17–20 inchangés. Ne pas migrer la DB live durant
ce lot. Pour une DB issue de l'autre lignée installée, vérifier d'abord les
prérequis de schéma/compatibilité ; `user_version` égal ne prouve pas la parité.
Ne pas backfiller des tâches anciennes en adaptatif, convertir leurs JSON ou
rehacher leurs révisions. Une ancienne release ne doit pas ouvrir une DB plus
récente : garde actuelle de `applyMigrations`, pas de downgrade destructif.
Retour opérationnel au mode grille = nouvelle révision ; anciennes affectations
adaptatives restent auditables et exécutables uniquement sur hôte compatible.

Les nouvelles disponibilités natives ne rejoignent pas un pool approuvé sans
nouvel aperçu/start. Un couple disparu/désactivé à l'admission ou à une mutation
de phase fait bloquer l'opération ; ne pas retirer ce gagnant et tirer encore.
Une désactivation opérateur/sécurité est distinguée d'une simple révision de
mission et arrête les nouveaux envois concernés avec diagnostic explicite.

`src/provider-journal.ts`, `observeProviderRetry`, peut actuellement remplacer
le modèle membre par une alternative approuvée. En mode adaptatif initial,
conserver journalisation et retry borné **sur la même paire**, mais ne pas
effectuer ce failover cross-model/cross-provider. Épuisement/auth/quota :
arrêt/bloquage signalé selon politique de sécurité existante, pas escalade
d'effort ni redécision du pool. Le chemin grille garde sa résilience actuelle.

Exposer dans `team_status`, aperçu, prompt d'état et lectures dashboard :
mode/révision, tâche, phase, paire sélectionnée/appliquée, cran/plafond,
transition pending/uncertain et motif d'arrêt. La vérité est SQLite + contrôle
natif, jamais un libellé profil. Garder visibilité accessible et compacte,
sans timer de rappel ni nouvelle page décorative.

**Rayon d'impact.** Migration, mission policy/commands, classification admission,
provider-journal, recovery, statut/hooks et projection dashboard V2. Les 15
outils gardent leur identité ; shutdown/merge/cleanup ne changent pas de
sémantique, pas de nouvelle mutation native V1. **Invariant particulier.**
Historique append-only des décisions admises, aucune baisse automatique de
cran, aucun fallback non autorisé. **Preuves.** Mix de tâches grid/adaptive,
revision pendant planning, config invalide, restauration d'un hash ancien,
catalogue changé, arrêt critique, retries et migration/restart sans reroll.

## 4. Frontières de la première tranche

Inclus : mission command-prepared V2, workers collaborateurs avec outils
existants disponibles, tâche board identifiable, une tâche active par worker,
deux phases, sélection persistée et auto-escalade explicitement signalée.
Le workflow `plan_approval` existant reste une convention de prompt, pas une
nouvelle permission. Les livraisons normales, direct claims et auto-dispatch
doivent utiliser les mêmes gardes ; aucun de ces chemins ne peut contourner
l'affectation. Auto-scale passe par le même spawn ou refuse explicitement si
la capacité n'est pas prouvée.

Refus explicites initiaux : V1 adaptatif, spawn adaptatif sans `claim_task`,
worker `final_response` adaptatif (ne peut pas signaler les transitions), modèle
sans variante explicite vérifiée, échelle ambiguë, contrôle de transition par
un autre worker, substitution d'un modèle libre. `final_response` demeure
pleinement valide hors mode adaptatif selon `docs/worker-reporting.md`.
Pas de restriction nouvelle de rôle pour les outils de reporting historiques.

Le lead ne reçoit pas un modèle planning imposé. Un profil n'est pas une phase.
Le worker utilise l'effort du candidat planning, puis l'effort initial du
candidat execution, puis les seuls crans autorisés de ce dernier. L'héritage
de session/handoff n'est pas refondu ; les admissions fork qui ne peuvent
prouver cet ordre sont refusées dans cette tranche, pas rétrogradées en silence.

## 5. Contrat implementer et périmètres de fichiers ultérieurs

Ces lots sont des frontières de responsabilité proposées, **pas** un lancement
de workers ou une délégation. Le lot A ne possède que ce document.

### Lot B — Contrat pur et admission de politique

Fichiers : nouveaux `src/adaptive-policy.ts`, `src/adaptive-selector.ts` et tests
homonymes ; `src/mission-model-policy.ts`, `src/mission-policy.ts`,
`src/mission-commands.ts`, `src/mission-native-models.ts` et leurs tests.
Possède le discriminant V1/V2, snapshot/preview/hash et sélection pure D1/D2.
Ne touche pas `routeModel` historique, SDK ou migration. Si un partage de types
est requis, le déclarer avant implémentation plutôt qu'éditer en concurrence.

### Lot C — Persistance et orchestration des transitions

Fichiers : `src/schema.ts`, `src/db.ts` seulement si l'API existante l'exige,
nouveau `src/adaptive-state.ts`, `src/member-model.ts`,
`src/tools/team-claim.ts`, `src/tools/team-spawn.ts`, `src/dispatch.ts`,
`src/tools/team-message.ts`, `src/tools/team-tasks-complete.ts`,
`src/provider-journal.ts`, `src/recovery.ts`, `src/board-classification.ts`,
`src/tools/team-tasks-add.ts`, schémas communs/outils V2 et tests
correspondants. Possède D3/D4 et gardes de toutes les voies d'admission.
Possède également la séparation de déclenchement/admission de classification
par mode : aucun appel automatique ni helper obligatoire pour l'adaptatif,
aucune modification de l'algorithme de classification historique.
La garde de provenance publique de `mission-policy.ts` est un point de jointure
avec B : un seul propriétaire d'édition au moment de l'intégration.
Pas de changement aux sémantiques de shutdown/merge/cleanup.

### Lot D — Preuve SDK puis raccordement V2

Fichiers : fixture/spike d'évaluation isolé et test du runner, puis après
preuve `src/types.ts`, `src/v2-client.ts`, `src/v2-setup.ts`,
`src/v2-events.ts`, hooks V2 et tests correspondants. Possède capacités,
frontières native/readback/reconciliation et preuve transport de D5.
Les branchements de recovery sont intégrés avec C, jamais deux implémentations
de reprise indépendantes. Aucun accès aux internes OpenCode et aucune édition
de `._client` dans `src/index.ts`.

### Lot E — Observabilité, documentation et revue d'intégration

Fichiers : `src/tools/team-status.ts`, `src/hooks.ts`, projections existantes
dashboard/RPC strictement nécessaires et tests associés ; guides
`docs/mission-policy.md`, `docs/model-routing.md`, `docs/worker-reporting.md`
après acceptation du contrat. Pas de nouvelle route dashboard de mutation.
Revue indépendante vérifie les frontières et compatibilités avant activation.
Tout élargissement de ce périmètre demande une décision explicite, pas une
refonte opportuniste de l'UI/SDK/classification.

Hors périmètre de tous ces lots : modifications des configurations mission et
globales de développement, changement des providers/pools approuvés pendant
le développement, nouveaux runtime deps, supervision, agents obligatoires,
seizième outil, polling, cache protocol, refonte de classification et historique
natif stocké dans Ensemble.

## 6. Preuves TDD et critères d'acceptation

Pour chaque comportement nouveau : test compilable **rouge avec échec métier**,
minimum vert, puis refactor. Pas de red « module introuvable ». SQLite mémoire,
vraie logique métier, mocks seulement aux frontières client/RNG/horloge.

Régressions existantes à garder :

- `test/model-catalogue.test.ts` : les 17 couples coût/effort ;
  `test/model-router.test.ts` : ordre, coût, fallback et absence de hasard legacy.
- `test/mission-model-policy.test.ts`, `test/mission-policy.test.ts` : variantes
  natives versus labels, approbation présentée, révision/idempotence.
- `test/mission-commands.test.ts` : découverte en vol, preview échoué,
  configuration modifiée et continuation échouée après approbation.
- `test/mission-routing-integration.test.ts` : claim/dispatch réappliquent le
  modèle natif, corruption refusée, override impossible, pin attendu, host sans
  capacité refusé et pin échoué libérant le claim/quarantinant le worker.
- `test/v2-client.test.ts` : ordre switch-before-prompt, synthetic distinct,
  direct pin sans prompt supplémentaire ; `test/member-model.test.ts`,
  `test/variant-effort.test.ts` : IDs exacts et annotation seulement.
- `test/provider-journal.test.ts`, `test/provider-resilience.test.ts`,
  `test/schema-pending.test.ts`, `test/session-continuity.test.ts` : résilience,
  historique de migration et conservation des branches/admissions.

Nouveaux critères obligatoires, happy **et** error path par outil affecté :

1. Aperçu affiche uniquement des couples calibrés et natifs autorisés, coûts
   par variante, exclusions et chaque cran ; start périmé/refusé n'admet rien.
   Une tâche sans scores ni résultat/helper de classification est admissible
   en adaptatif ; aucun classifieur n'est appelé. La même tâche reste bloquée
   en grille lorsque sa politique historique exige la classification. Une
   réponse en vol sous ancienne révision ne réintroduit pas ce prérequis.
2. Tirages hiérarchiques corrects, coût optionnel sans biais provider, snapshots
   autonomes, aucun reroll sous concurrence/reprise/échec de transport.
3. Planning → execution utilise le choix execution **initialement** enregistré ;
   révision du mode entre phases n'y change rien ; phase/index monotones.
4. Escalade même modèle, cran suivant, plafond ; mauvaise identité/phase,
   duplication conflictuelle et variante inconnue refusées sans switch.
5. Pending/uncertain ne donnent jamais un succès anticipé ni envoi métier sur
   ancienne sélection ; crash/reconcile ne finalise jamais le mauvais binding.
6. Claim/spawn/auto-dispatch/direct claim réutilisent l'affectation unique ;
   un transport échoué peut libérer l'assignee mais ne supprime pas le tirage.
7. Tous les chemins de livraison/retry et compaction respectent la paire/phase ;
   aucun failover adaptatif cross-model. Le chemin grille reste inchangé.
8. V1, final_response et capacité manquante refusent adaptatif clairement avant
   allocation ; leurs contrats historiques continuent à fonctionner.
9. Migration depuis chaque lignée compatible, DB vierge, reprise, hash historique
   inchangé ; version future refusée, aucun accès à la DB live pour ce test.
10. Spike D5 constate effectivement le prochain tour primaire et distingue
    état natif/readback, requête driver, provider réel et auxiliaires. Sans cette
    preuve, activation adaptative refusée, même si tous les tests mock passent.

Gate d'intégration requis pour l'implémentation :
`bun run typecheck && bun test && bun run build`, puis preuve native autorisée
du chemin revendiqué, profil de transport/version explicite et revue externe.
Ne pas annoncer la compatibilité universelle à partir d'un seul driver.

**Vérification de ce lot documentaire :** recherche code/docs/tests et lecture
des surfaces SDK effectuées ; existence et diff du livrable à contrôler avant
rapport. Aucun test/build/runtime natif exécuté par ce lot : pas de changement
applicatif, dépendances absentes du worktree, et le build écrirait `dist/` hors
périmètre autorisé. Le gate d'implémentation n'est pas revendiqué comme passé.

## 7. Questions ouvertes et décisions bloquantes

- **OQ-1 — Bloquant activation.** Quel(s) hôte(s)/version(s)/transport(s) prouvent
  que `switchModel` attendu depuis l'outil affecte la continuation primaire
  suivante et que l'échec ne laisse pas partir une continuation métier ?
  Réaliser D5 ; sinon refuser le mode sur cet hôte. Aucun support supposé de
  `configuration_update` ni bricolage du cache.
- **OQ-2 — Bloquant acceptation du contrat.** Confirmer l'équilibre probabiliste
  provider → modèle → couple et `cheapest_within_model`, plutôt que quotas
  exacts ou coût global qui biaiserait les providers. Recommandation D2.
- **OQ-3 — Bloquant configuration d'une échelle.** Qui valide la relation
  d'effort entre variantes opaques/multidimensionnelles et le budget maximum
  de crans ? Recommandation : échelle exacte approuvée, preuve driver requise,
  singleton tant que l'ordre n'est pas établi ; jamais trier les noms ou copier
  automatiquement un ordre canonique à tous les providers.
- **OQ-4 — Limite explicite de la première tranche.** Faut-il supporter les
  modèles sans variante ou un ID natif littéral `default` ? Le catalogue actuel
  assimile `reasoningEffort: default` à omis ; SP-4 ne prouve aucun effort
  fournisseur implicite. Recommandation initiale : exclure ces cas de
  l'adaptatif avec diagnostic, conserver grille/legacy inchangés ; une extension
  exige un contrat d'identité non ambigu et sa preuve native.
- **OQ-5 — Bloquant acceptation du protocole.** Accepter les transitions
  auto-déclarées par le worker via `team_message.execution`, avec approbation
  de plan toujours prompt-enforced et sans nouvelle autorité humaine par
  outil ? Recommandation D4 ; ne pas présenter cela comme une sécurité
  d'origine humaine authentifiée. Un durcissement demanderait une décision
  séparée compatible avec AGENTS.
- **OQ-6 — Bloquant déploiement/migration.** Vérifier le numéro libre après 21
  et la lignée de DB installée réelle avant migration. Les slots 17–20 et la
  parité checkout/bundle existante ne doivent pas être supposés résolus par
  ce document. Ne pas lancer de migration live pour lever cette question.

## 8. Invariants transverses non négociables

- SQLite derrière `src/db.ts`, migrations `PRAGMA user_version`, aucune DB JSON
  parallèle ni nouvel accès SQLite spécifique runtime ailleurs.
- Exactement **15 outils** distincts ; pas de nouveau mécanisme de délégation.
- `._client` conservé pour extraire le transport V1 vers SDK V2.
- Appels partagés `promptAsync` **jamais attendus**, messages persistés avant
  envoi ; les awaits de contrôle public `switchModel` sont distincts.
- `preserveBranch()` avant **tout** `session.abort()`, y compris recovery,
  watchdog, force cleanup et courses busy-after-shutdown ; aucun nouveau
  chemin de destruction pour « appliquer une variante ».
- Aucune permission supplémentaire de shell/édition au nom d'une phase ;
  isolation descendants, worktree, identité, assignee et reporting conservés.
- Politique approuvée seule autorise modèle/provider/variante ; aucun profil,
  alias d'effort, fallback ou override développeur ne la contourne.
- Aucun `any`, aucun TODO sans référence `OQ-<N>`, JSDoc sur nouveaux exports.
- Ne jamais transformer un worker idle, un résultat natif candidat, un cache
  supposé conservé ou un champ d'état en preuve de succès métier/inférence.
