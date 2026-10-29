# Audit des permissions — OpenCode / Ensemble

Date : 29 octobre 2026. Relevé natif final : **08:34:05 UTC**.

> État historique : les constats ci-dessous décrivent le code audité avant le
> correctif longrun. L'implémentation locale ultérieure ajoute les overrides de
> session V2, la reprise selon l'autonomie approuvée, l'observation persistante
> des contrôles et la catégorie ambiguë `permission_declined`. Voir
> `docs/mission-policy.md` et `docs/worker-reporting.md` pour le comportement
> corrigé. Cela ne signifie pas que ces changements ont été déployés ni que le
> défaut natif de rechargement a été corrigé.
Périmètre : quatre superviseurs, moteur OpenCode installé, Code Mode/MCP,
configurations effectives, cinq plugins locaux chargés, contrats de mission et
journal de diagnostics. Audit en lecture seule des systèmes réels.

## Verdict

**Oui, des mécanismes surclassent le prompt.** La délégation longrun est un texte
de décision, pas une modification des permissions natives.

Le problème constaté ne se résume toutefois pas à « trop de permissions ask » :

1. Le moteur réutilise `Permission.DeclinedError` pour un refus sans feedback
   **et pour un service de permissions fermé**. Cette ambiguïté est confirmée
   dans le code embarqué de la version exécutée.
2. Le rechargement global ferme ces services. Les erreurs ARTIST et OCR sont
   survenues juste après celui effectué pendant le déploiement du 28 octobre.
   Un appel imbriqué conservant un ancien service est donc une **cause probable**,
   pas une causalité historique démontrée pour chaque incident.
3. Code Mode a renvoyé ces erreurs dans un outil externe `completed`, avec
   `metadata.error=true`. Le journal Ensemble les ignore. Ce défaut est
   **reproduit sur le véritable collecteur**, en fixture isolée.
4. FF8 a également subi un arrêt de raisonnement : une preuve non acquise a été
   confondue avec l'impossibilité de continuer. Ce cas n'établit aucun refus natif.

**Renforcer le prompt seul ne corrige donc pas l'ensemble du problème.**

La vérification complémentaire du contrat fonctionnel longrun révèle aussi une
non-conformité mécanique : **la reprise peut volontairement laisser dormant un
longrun approuvé et non archivé**, sans évaluer si son blocage est réellement
insoluble de façon autonome. Voir la section suivante.

## Complément : vérification mécanique de la continuité longrun

### Le « cron » existe, mais ce n'est pas la règle fonctionnelle demandée

`SupervisorRecovery.start()` installe un `setInterval` de dix minutes, démarré
par `src/v2-setup.ts:488–502` et arrêté à la destruction du plugin. Ce n'est pas
un cron système externe et le premier contrôle n'est pas immédiat.

La reprise réelle impose des conditions supplémentaires :

- `mission_state` doit être exactement `running` : `attention` et `critical`
  sont exclus avant toute analyse des causes (`supervisor-recovery.ts:48–54,126`).
- Il faut une tâche `pending`/`in_progress` ou un rapport encore à traiter :
  les seuls `blocked`, l'absence de tâches, ou toutes les tâches `completed`
  sans rapport pending ne déclenchent aucune reprise. La clôture de l'objectif
  n'est pas vérifiée à cet endroit.
- Un `spawn_pending` quelconque interdit le contrôle, sans limite d'ancienneté
  dans ce composant. D'autres mécanismes peuvent réparer un spawn séparément.
- Une modification du brouillon après approbation bloque la reprise via
  `assertMissionAdmission`, même si une révision précédemment approuvée existe.
- Une demande native de permission pendante, ou une erreur de lecture des
  permissions, fait abandonner le contrôle sans réveiller le superviseur.
- Tout superviseur, worker ou classifieur encore dans l'ensemble natif actif
  empêche la reprise. L'adaptateur V2 réduit ces informations à `busy` : il
  n'établit pas la différence entre calcul utile et attente d'une interaction.

**Aucune branche spécifique au longrun dans ce contrôleur ne subordonne ces
exclusions à la preuve d'une impossibilité autonome.** Les conditions ne sont
pas des suggestions au modèle : ce sont des retours anticipés et des filtres SQL.

Le test existant `skips ... missions` attend explicitement zéro réveil pour
`blocked`, `attention` et `critical` (`test/supervisor-recovery.test.ts:78–90`).
La documentation décrit elle aussi cette exclusion
(`docs/worker-reporting.md:109–119`). Ce n'est donc pas uniquement un soupçon de
minuteur en panne : **le comportement actuel, volontaire et testé, ne correspond
pas au nouveau contrat fonctionnel exprimé par l'utilisateur**.

### Reproduction sur le vrai contrôleur, sans toucher aux missions

La fixture `.tmp/audit-longrun-recovery.ts` crée des bases en mémoire et des
dossiers temporaires possédés, approuve réellement une politique de fixture avec
`autonomy.mode=long_run`, puis appelle `SupervisorRecovery.check()` avec un client
mock. Le temps simulé rend les métadonnées suffisamment anciennes ; aucune
session native n'est créée, réveillée ou arrêtée.

Résultats :

- Cas témoin `running` + tâche `pending` + tout le monde inactif : **1 réveil**.
- Tâches uniquement `blocked`, sans justification structurante : **0**.
- État `attention` : **0** ; état `critical` : **0**.
- Toutes tâches `completed`, mission pourtant encore active : **0**.
- Aucun item au board, mission approuvée encore active : **0**.
- Permission native pendante : **0** ; consultation des permissions en erreur : **0**.
- Ancien `spawn_pending` avec worker natif inactif : **0**.
- Brouillon modifié, ancienne délégation toujours approuvée : **0**.

Ce sont dix scénarios, pas dix bugs indépendants. Certains protègent des frontières
légitimes. Le défaut par rapport au contrat demandé est de **coupler interdiction
d'exécuter une opération et interdiction de réveiller le superviseur pour décider,
diagnostiquer ou poursuivre autre chose**.

Les 44 tests ciblés existants de reprise et d'adaptation V2 passent. Ils confirment
le comportement actuel ; ils ne prouvent pas la conformité au contrat souhaité.
Résultats détaillés : `.tmp/longrun-recovery-audit-results.json`.
La vérification finale complète passe également : typecheck, 1839 tests sans échec
et build. Les fichiers mécaniques inspectés n'ont pas de diff par rapport au
commit déployé ; les gardes `running` et `hasPendingPermission` sont également
présentes dans le bundle installé. Aucun correctif de ces gardes n'a été appliqué.

### Admission, classification et reprise sont couplées

`assertMissionAdmission` exige de refaire `config/start` si le hash du brouillon
diffère de l'approbation (`src/mission-policy.ts:288–295`). Cette protection de
l'enveloppe modèles/QA peut être légitime pour **admettre une nouvelle exécution**.
Elle bloque également le **réveil de diagnostic** dans le contrôleur actuel.

La classification peut placer une mission en `critical` pour épuisement d'un
budget dur ou incertitude de nettoyage (`src/classification-runtime.ts:51,71,80`).
`pumpTeam`, le claim et le spawn ont également leurs barrières d'admission.
Le contrôleur de reprise ignore ensuite `critical`, au lieu de distinguer une
opération interdite d'une investigation encore possible. Cela ne justifie pas
de dépasser un budget ou de relancer un helper dont le nettoyage est incertain ;
cela justifie de séparer **admission d'exécution** et **continuité de supervision**.

### Cadence, état natif et limites d'observation

Le contrôleur réclame dix minutes sans mise à jour puis attend son tick de dix
minutes : selon l'alignement, une reprise peut intervenir presque vingt minutes
après la dernière mise à jour, hors latence d'inspection. Une reconstruction du
plugin recrée le timer ; il n'y a pas de contrôle immédiat dans `start()`.

Les lignes `supervisor_recovery` ne sont écrites que lorsqu'un réveil est tenté.
Il n'existe ici ni dernier tick persistant, ni raison détaillée de non-relance.
Une ligne absente ne distingue donc pas « timer arrêté » et « contrôles actifs
qui ont tous décidé de ne rien faire ».

Le relevé réel complémentaire a trouvé les quatre missions en `running/long_run`,
leurs brouillons logiquement identiques aux politiques approuvées, et aucune
tentative enregistrée dans `supervisor_recovery`. L'API native montrait alors les
superviseurs AIForAll, ARTIST et OCR actifs. FF8 était absent de l'ensemble actif,
mais ses dernières métadonnées étaient encore à moins de dix minutes.
**Ce relevé ne démontre donc pas une panne du timer lors des arrêts historiques.**

### Conséquence pour la méthode de correction

Le mécanisme cible doit partir de la mission longrun approuvée, non terminée,
dont superviseur et workers sont réellement inactifs. Un statut `blocked`,
`attention` ou `critical` ne doit pas à lui seul invalider la surveillance.

Il faut ensuite distinguer :

1. réveiller pour arbitrer, réparer, rechercher ou finaliser ;
2. autoriser une nouvelle opération soumise à une vraie frontière technique ;
3. reconnaître un arrêt légitime documenté : fin acquise, arrêt opérateur ou
   impossibilité autonome effectivement établie.

Un échec d'admission peut interdire une opération sans interdire le point 1.
Une demande de permission pendante ne prouve pas à elle seule le point 3.
La justification d'un arrêt doit être vérifiable et réévaluable, pas un simple
statut écrit par le superviseur. La surveillance doit exposer son dernier contrôle
et son motif de non-relance pour rendre ce contrat observable.

Il ne faut ni contourner un vrai refus, ni modifier silencieusement un budget,
ni remplacer la validation d'un blocage par une boucle de répétitions aveugles.
La vérification présente ne modifie aucun de ces mécanismes.

## Environnement observé

- Serveur OpenCode **2.1.4**, PID **38776**.
- Binaire : `C:/Users/djden/AppData/Roaming/ai.opencode.desktop/cli/2.1.4-x64/opencode-cli.exe`.
- SHA-256 : `404110f618d557de383044de86aafb1126bd69fdc312c5a3e6e7aba137568e3c`.
- Plugin Ensemble actif : `20261028-longrun-no-pm-timeout-ae4ed85a4709`,
  source commit `054e5abc4153d992df3ad121c38bdeed57de0dab`.
- Superviseurs : AIForAll `ses_e7cd58424ffeqZrWRWzJWh763f`,
  ARTIST `ses_e7d39d927ffe5gVlxpcbtOm50k`,
  FF8 actuel `ses_e7c170bbbffdlebC0VhBkumUUF`,
  OCR `ses_e7d3c5b63ffdBLEGTTtwhDs2Hg`.
- Le précédent superviseur documentaire FF8 est archivé : il ne faut pas le
  confondre avec le superviseur de réalisation actuel.
- Au relevé final : zéro demande native de permission et zéro formulaire en
  attente dans chacune de ces quatre sessions. Ce constat ne décrit pas l'historique.

## Chaîne des décisions

### 1. Le modèle décide de poser une question

Une question de mission est un appel de l'outil `question`, soumis lui-même à
l'action native `question`. Elle n'est pas nécessairement une demande du moteur.
Le modèle peut la produire après avoir interprété une erreur comme un manque
d'autorité. Les contraintes textuelles des profils et mandats peuvent également
imposer une ratification, une pause ou une interdiction explicite.

Une consigne « ne demande pas de GO » agit ici, pas sur le moteur d'autorisation.
Interdire globalement `question` ne rendrait pas les opérations autorisées et
supprimerait aussi les questions réellement importantes.

### 2. Les règles natives décident si l'outil peut agir

Le moteur combine les règles du profil résolu et les overrides de session.
La dernière règle correspondante s'applique à chaque ressource. Un `deny` effectif
bloque l'action ; sinon les approbations enregistrées peuvent satisfaire un `ask`.
Une approbation enregistrée ne surclasse pas un `deny` configuré.

En l'absence de correspondance, le fallback est `ask`. La politique de base
commence néanmoins par `* / * / allow`, suivie d'exceptions pour les fichiers
`.env`. Les quatre profils de superviseur examinés n'imposent actuellement aucun
`ask` sur les lectures ordinaires, `execute` ou `context-mode_ctx_execute`.
Les overrides de session exposés contiennent ici seulement un `browser=allow`.

Les documents de configuration exposés, y compris les parents de FF8 et la
configuration propre au worktree OCR, ne contiennent pas de règle `permissions`
ou `policies` supplémentaire expliquant ces lectures locales refusées.
Ce relevé actuel n'est pas une photographie garantie des règles au moment des incidents.

Observation annexe de priorité des règles : le profil courant
`emergency-thinker` d'AIForAll ajoute un second `* / * / allow` après les
exceptions `.env`, ce qui en annule l'effet `ask` pour ce profil. L'override
`browser=allow` des sessions peut aussi surclasser le `browser=deny` du profil.
Ces observations n'expliquent pas les refus étudiés, mais montrent pourquoi il
faut lire l'ordre effectif plutôt que conclure à partir d'une règle isolée.
Aucun secret n'a été lu et aucune de ces règles n'a été modifiée.

### 3. Les politiques et hooks peuvent surclasser un allow

Les politiques natives peuvent hard-deny une action. Le plugin natif
`opencode.config.policy` est chargé ; aucune restriction correspondante n'a été
trouvée dans les documents de configuration exposés pour les cas étudiés.

Les hooks `permission.evaluate` peuvent transformer `allow`/`ask` en `ask` ou
`deny`. Un `deny` configuré est final avant ces hooks.

Les cinq plugins locaux effectivement chargés ont été examinés :

- **RTK**, chargé implicitement depuis
  `~/.config/opencode/plugins/rtk-hook/index.ts`, peut réécrire ou bloquer une
  commande `shell`/`bash` avant exécution (lignes 39–79). Il n'intercepte pas les
  appels `execute` qui portent les deux `DeclinedError` étudiés.
- **project-one-mcp** route les serveurs vers les racines canoniques et configure
  Code Mode ; son entrypoint ne décide pas des permissions.
- **opencode-voice** : aucun hook d'évaluation de permission trouvé dans les
  sources inspectées. Pas de preuve qu'il ait forcé les questions étudiées.
- **Ensemble** : l'isolation de descendants ne concerne que les outils `team_*`.
  Les hooks restrictifs des classifieurs sont filtrés par leur propre sessionID.
  Le hook général de membre accorde certains outils de coordination ; il ne
  refuse pas les lectures des superviseurs. Les permissions de préparation et
  de workers restent un mécanisme distinct, légitime, de leurs profils.
- **Jev Router** possède bien un hook susceptible de demander une clarification
  ou de modifier une décision. Dans la configuration observée,
  `autoPermission=false`, `clarify="off"`, `automation=false` : la branche de
  gating correspondante n'est pas activée. Ce n'est pas une preuve d'une
  configuration historique identique, mais cela exclut cette branche aujourd'hui.

### 4. Code Mode n'est pas une permission universelle

`execute=allow` permet le dispatcher. Chaque outil MCP imbriqué passe ensuite par
son propre `Permission.assert`, par exemple `context-mode_ctx_execute / *`.
Le nom descriptif du travail — « lire les profils locaux » — n'est donc pas
nécessairement l'action native contrôlée : ici, c'est le droit d'appeler le MCP.

Le code MCP embarqué capture son service Permission lors de sa construction et
fait l'assertion avant l'appel du serveur MCP. Un service périmé peut donc échouer
avant que le travail de lecture ou de test ne commence.

### 5. Le cycle de vie peut produire un faux signal de veto humain

Dans le binaire réellement installé :

- `Permission.close` marque le service fermé et rejette les demandes en attente
  avec `Permission.DeclinedError`, tout en publiant des réponses `reject`.
- Un `Permission.assert` ultérieur sur ce service fermé échoue avec le même type
  **avant de réévaluer les règles**, même si elles auraient permis l'action.
- `LocationLifecycle.shutdown` ferme explicitement Permission et les formulaires.
- Le contrat de `POST /api/location/reload` dit qu'il reconstruit **toutes** les
  locations chargées et annule permissions/formulaires en attente. Les sessions
  continuent avec des services frais à la prochaine frontière de step.

Le maintien du PID prouve donc seulement l'absence de redémarrage du processus,
**pas l'absence d'interruption des autorisations ou des services en vol**.
Le déploiement du 28 octobre que j'ai effectué utilisait ce rechargement global.

## Chronologie des incidents — UTC, 28 octobre 2026

- **19:22:22.452** — paquet de déploiement préparé, selon son manifeste.
- **19:22:46.488** — modification du pointeur de configuration globale, selon
  le mtime du fichier (indice temporel, pas journal exhaustif des reloads).
- **19:22:50.286 — AIForAll** : un `patch` sur un rapport et un handoff échoue
  avec `type=permission.rejected`, `Permission denied: edit`.
  C'est un vrai refus de l'action dans cette trace, **pas** le même tag que les
  deux cas suivants. La règle ou le hook historique exact n'est pas récupéré.
- **19:23:23.312 → 19:23:45.046** — le rechargement global est explicitement
  invoqué puis terminé dans la session de maintenance, selon les temps natifs
  de l'appel. La seconde vérification aboutit à 19:24:22.883 ; le PID reste 38776.
- **19:24:22.338 — ARTIST** : l'outil extérieur `execute` termine en `completed`
  avec texte `Permission.DeclinedError`. L'appel imbriqué
  `context-mode.ctx_execute` est marqué `error`, et `metadata.error=true`.
  Le script prévu ne faisait qu'un GET local des profils QA.
- **19:24:29.379 — OCR** : même enveloppe pour le lancement d'un pytest ciblé.
  Le superviseur indiquera ensuite que ces tests ont réussi avec le même outil,
  sans modification des permissions. Cela étaye une défaillance transitoire,
  sans démontrer à lui seul sa cause exacte.

Sources natives : messages ARTIST `msg_183f41310001yiHzLYZTY1e4c9`,
OCR `msg_183f6f907001LSv6RVcbI4DO9x`,
AIForAll `msg_183f6660d001fTM1VvK0C77DK0`.
Appel de rechargement : `msg_183f777a90011pErL2ScPokKli` dans la session de
maintenance `ses_e7c4f485dffdu2UEWuntLYJSqC`.

## Défaut confirmé du journal Ensemble

`PermissionDiagnostics.observe` ne reconnaît, pour un outil `completed`, que
certaines enveloppes JSON contenant une propriété `error`.
Il n'exploite pas `metadata.error=true` / les sous-appels échoués de Code Mode.
Un simple texte `Permission.DeclinedError` n'est pas parsé en JSON ; le tag
`DeclinedError` ne correspond pas non plus aux expressions de classification.

La fixture `.tmp/audit-permission-observability.ts` appelle le véritable collecteur,
sans outil natif ni serveur externe, dans un répertoire temporaire possédé :

- enveloppe Code Mode observée : **0 incident enregistré** ;
- erreur native taguée `Permission.DeclinedError` : **0** ;
- contrôle `Permission denied: edit` : **1** ;
- contrôle JSON imbriqué `Permission denied` : **1**.

Les journaux CLI vides d'ARTIST/OCR ne prouvent donc pas l'absence de refus.
Références : `src/permission-diagnostics.ts:47–60`, `165–189`, `197–216`.

## Arrêts ne relevant pas des mêmes mécanismes

- **FF8** : le superviseur a explicitement reconnu avoir confondu une preuve
  manquante sous quinze secondes avec l'impossibilité de poursuivre les recherches.
  Il n'avait établi aucune permission indispensable manquante. Les limites de
  test restent un contrat QA, pas un contrôle natif d'accès aux fichiers.
  L'utilisateur les a depuis portées à dix minutes dans cette autre session :
  l'audit ne modifie ni ne réinterprète cette décision.
- **AIForAll, preuve navigateur** : une demande ultérieure concerne
  `browser_run_code_unsafe` et une restriction explicite de scénario. Il faut la
  distinguer du refus `patch` et des lectures locales ordinaires. Son caractère
  nécessaire n'est pas une preuve de droit natif manquant ; le mandat compte aussi.
- Les profils contiennent des contraintes textuelles de pause opérateur,
  d'admission QA et de non-répétition des refus. Elles peuvent amplifier une
  interprétation erronée d'un signal transitoire en « nouvelle permission requise ».

## Corrections recommandées, par ordre de priorité

1. **Moteur / cycle de vie** : distinguer fermeture/reconfiguration, refus humain
   et deny de règle dans les erreurs et les événements. Garantir qu'un appel en
   vol ne conserve pas un autoriseur périmé après la frontière de step.
   Une récupération de génération doit repasser par l'autorisation native fraîche,
   jamais transformer automatiquement un refus réel en allow.
2. **Transport Code Mode + diagnostics** : conserver le type/cause du sous-appel,
   reconnaître l'enveloppe réelle et les tags natifs exacts sans faux positifs
   sur de la documentation citée. Journaliser action, origine, génération et
   cause expurgées, pas les arguments, prompts ou secrets.
3. **Déploiement** : ne plus assimiler « sans restart » à « sans effet sur les
   missions ». Coordonner automatiquement une fenêtre sûre pour les reloads
   globaux tant que leur comportement en vol n'est pas corrigé ; pas de nouveau
   GO humain de routine pour cette coordination.
4. **Décision du superviseur** : lecture locale non secrète dans le mandat déjà
   déléguée ; un défaut de preuve bloque l'acceptation concernée, pas toutes les
   investigations autorisées. Ne pas fabriquer une nouvelle demande de droit à
   partir du seul mot `DeclinedError`.
5. **Tests ciblés** : couvrir fermeture en plein step, sous-appel MCP après
   reconfiguration, enveloppe Code Mode réelle, refus humain véritable,
   deny configuré, action permise et poursuite d'un travail indépendant.

Pas de recommandation de `allow *` supplémentaire ni de désactivation générale
des protections ou de l'outil `question`.

## Limites et état laissé

- Pas de reproduction par reload sur les missions réelles : elle risquerait de
  provoquer exactement les refus investigués.
- Pas de code source natif local complet identifié. Les mécanismes natifs sont
  lus dans les sources JavaScript embarquées du binaire exécuté, avec empreinte
  et offsets reproductibles ; cela ne vaut pas une revue d'un checkout natif complet.
- Le log de service disponible commence le 29 octobre à 00:57 UTC ; il ne
  contient plus la fenêtre du déploiement du 28. Les routes de demandes natives
  exposent les demandes pendantes, pas un historique causal complet des réponses.
- La causalité reload → deux `DeclinedError` est fortement étayée mais reste
  probable. Le refus `edit` AIForAll reste non attribué à une règle historique.
- Les comportements de tous les serveurs distants et la totalité de l'historique
  des profils ne sont pas audités exhaustivement. Aucun échec OS/401/403 n'a été
  établi pour les trois incidents retenus.
- Aucune permission, politique approuvée, configuration ou mission n'a été changée
  par cet audit ; aucun test produit, agent, reload, déploiement ou publication lancé.
- Les modifications de consignes préparées avant la demande d'audit restent
  locales, non commitées et non déployées. Le précédent paquet reste actif.

Preuves supplémentaires : `.tmp/permissions-audit-native-20261029.json`
(snapshots expurgés et extraits aux offsets 166681560, 173359100, 173501780,
173804990). Les scripts de collecte/fixture restent sous `.tmp/` ignoré.

## Documentation V2 consultée

- https://opencode.ai/v2/docs/permissions
- https://opencode.ai/v2/docs/policies
- https://opencode.ai/v2/docs/agents
- https://opencode.ai/v2/docs/build/plugins/server
- `/openapi.json` du service 2.1.4 : contrat de `location.reload` et routes de
  permissions ; ce contrat installé prime sur toute extrapolation documentaire.
