# Handover — révisions locales sûres des tâches Ensemble

Date : 2026-10-24. Projet : `C:/Users/djden/source/repos/opencode-ensemble-session`.
**Document de reprise autonome, pas une approbation d'exécution.**

## 1. Décision de clôture et niveau de confiance

L'utilisateur demande d'abandonner cette mission/session considérée comme
corrompue opérationnellement et de repartir proprement. Aucune corruption de
SQLite ou perte de travail n'a été démontrée. Ne pas tenter une réparation de
base, purger les historiques ou réutiliser l'import initial comme plan accepté.

La clôture technique est consignée en section 12 après retour de l'outil natif.
Ce document et les modifications locales doivent être conservés. Aucun commit,
push, publication, suppression de branche ou de session n'est demandé.

## 2. Besoin fonctionnel et incident de référence

Le superviseur doit pouvoir réviser localement le plan pendant l'exécution :
ajouter une tâche, modifier une tâche, annuler/remplacer une tâche. Il garde la
décision ; un PM propose un delta documenté ; le plugin valide/applique les
transitions autorisées. Pas de pouvoir général de réécriture de la base.

Incident utilisateur : une modification demandée à un agent s'est bien passée,
puis, après son résultat, la tâche initiale a été de nouveau dépilée et renvoyée
à l'agent. Cette cause exacte n'a pas été reproduite. Hypothèse à tester : le
prompt a évolué sans mise à jour cohérente de la tâche et de son affectation,
ou un ancien chemin de libération/réessai l'a remise en attente.

## 3. Décisions fonctionnelles retenues

### Suspension confirmée, jamais arrêt implicite

- Distinguer suspension demandée, suspension confirmée et état incertain.
- Dès la demande, bloquer admission, dépilage, réaffectation et réenfilage
  automatiques de la tâche concernée ; ne pas interrompre toute la mission.
- Le patch et la reprise exigent une confirmation de quiescence de l'exécution
  concernée. Un acquittement textuel seul, ou un événement idle isolé, ne suffit pas.
- Identifier ce que le SDK/hôte permet réellement de vérifier, y compris les
  opérations/outils/processus encore actifs. Ne pas promettre le gel de processus
  externes non maîtrisés. L'absence de preuve maintient le blocage.
- Timeout de suspension : alerter le superviseur ; jamais confirmer, aborter,
  clôturer ou reprendre automatiquement pour débloquer le workflow.
- Watchdog, recovery, shutdown et événements tardifs doivent respecter la barrière.

### Le superviseur choisit la continuité

Après suspension confirmée, le superviseur choisit explicitement :
1. conserver l'agent, sa session et son travail ; ou
2. préserver son travail, le clôturer puis affecter un nouvel agent.

Sauvegarder aussi les fichiers non commitées : une copie de branche seule ne
protège pas les changements non commitées. Le handover doit rendre explicite ce
qui est conservé, intégré, abandonné ou encore incertain. Toute voie d'abort
respecte l'invariant preserveBranch avant session.abort.

Après application du patch à l'état persistant, envoyer le prompt de reprise à
l'agent choisi. Pas de retour intermédiaire de la tâche dans la file générale.
L'autorisation de reprise et la livraison réelle sont des étapes distinctes.

### Pas de replanification globale

L'utilisateur a explicitement rejeté cette option. Si une correction locale
ne suffit plus, le superviseur doit recommander fortement à l'utilisateur
d'annuler la mission et fournir un handover correct. Il n'annule pas la mission
ou n'en crée pas une nouvelle automatiquement.

### Supprimer sans effacer la preuve

Préférer annulation/remplacement avec historique à suppression physique. Vérifier
les dépendances : annuler un prérequis ne prouve pas son résultat disponible.
Ne pas débloquer implicitement les consommateurs d'un résultat devenu absent.

## 4. Représentation mémorielle du plan et anti-redépilage

Le « task thread » demandé est une projection de l'état SQLite faisant autorité,
pas un second plan mutable en contexte LLM. Aucun symbole TaskThread/taskThread/
task_thread n'a été trouvé dans src lors de la recherche exacte effectuée.

Informations attendues : tâches/dépendances, étapes en attente/en cours/
suspendues/résultat à valider/terminées/annulées, révision courante, affectation,
résultats, points de reprise, modifications et décisions motivées.
« Modifiée » est un attribut d'historique ; une tâche peut être terminée après
plusieurs modifications. Ne pas réouvrir une tâche terminée par accident.

Proposition technique à préciser et tester : identité stable de tâche + révision
de tâche + identifiant de tentative d'exécution. Porter ces références dans les
affectations, prompts, résultats, retries, callbacks et événements pertinents.
Un ancien résultat reste consultable mais ne valide ni ne réenfile la révision
courante. Une erreur de livraison ancienne ne libère pas la nouvelle affectation.

## 5. PM et patchs locaux

- Constituer un snapshot fiable : objectif/contraintes, plan actuel versionné,
  tâches finies/en cours, résultats, problème rencontré, raison de modification.
  Éviter de faire reconstruire l'état de mémoire par le superviseur.
- Le PM retourne une ou plusieurs propositions locales : ajouts, modifications,
  annulations et dépendances, avec justifications/impacts et questions éventuelles.
  Il peut constater qu'aucun changement n'est nécessaire ou qu'il est bloqué.
- Le superviseur accepte/refuse/corrige ; le PM n'applique pas le patch.
- Valider préconditions, provenance/droits, portée d'équipe, existence des IDs,
  absence de cycle, cohérence des résultats/dépendances et politique approuvée.
- Appliquer atomiquement le delta ; refuser une proposition devenue périmée.
  Ne pas réécrire les admissions passées ou changer les modèles pour contourner
  le catalogue. Les règles de la nouvelle admission doivent être explicites.
- Une transaction SQLite ne rend pas atomiques un changement d'état et un prompt
  distant. Prévoir l'intention de livraison durable, doublons, échecs et état
  incertain sans promettre un exactly-once réseau.

La préparation PM initiale actuelle est un import à usage unique ; elle n'est
pas déjà le mécanisme de révision locale. Ne pas réutiliser cet import comme
un remplacement global du plan, ni prétendre la fonctionnalité implémentée.

## 6. Philosophie et récupération exceptionnelle

Le développeur fixe le parcours admissible ; le superviseur choisit parmi les
transitions sûres, sans devenir administrateur arbitraire de l'état.

Priorité à la prévention déterministe : source unique, transactions versionnées,
barrières de suspension, écritures conditionnées par révision/tentative,
livraisons idempotentes, historique et réconciliation après incident.

Des opérations de secours bornées ont été proposées, pas encore spécifiées :
inspection/reconstruction de projection, invalidation d'affectation dont l'arrêt
est établi, rattachement justifié d'un résultat, abandon d'une transition sans
effet incertain, quarantaine. Toute réparation exige motif, préconditions,
aperçu, journal et contrôle de cohérence. Aucune reprise automatique.
Si la sûreté n'est pas démontrable, rester suspendu et solliciter l'utilisateur.
Un validateur structurel ne prouve jamais la justesse métier d'un plan.
Ne pas construire un framework général de réparation spéculatif.

## 7. Ancrages code et tests déjà localisés

- `src/tasks.ts`, releaseMemberTasks : remet les tâches in_progress d'un membre
  en pending et enlève l'assignee. Références observées : recovery, hooks,
  session-continuity, team-spawn, team-shutdown, watchdog.
- `src/dispatch.ts`, pickNextTask et dispatchNextTask : sélection pending,
  claim, envoi promptAsync et remise en attente dans le catch de livraison.
- `src/tools/team-tasks-add.ts` : ajout et décisions d'exécution uniquement
  avant admission, pending/blocked non attribuées, sans model_routing.
- `src/tools/team-tasks-complete.ts` : gardes d'état et propriété, validation
  lead de certains résultats ; transitions natives en cours empêchent completion.
- `src/tools/team-claim.ts`, `src/hooks.ts`, `src/recovery.ts`, `src/watchdog.ts`,
  `src/task-execution.ts`, `src/tools/team-shutdown.ts`, `src/team-archive.ts` :
  chemins à vérifier pour toute nouvelle machine d'état.
- `src/v2-tools.ts` et `src/index.ts` : adaptations V2/V1 et schémas des outils.
- `src/preparation-document.ts`, `src/preparation-import.ts`,
  `src/preparation-runtime.ts`, `src/preparation-admission.ts`,
  `src/intervention-contract.ts`, `src/mission-commands.ts` : PM/import/admission.
- Tests : `test/tools/team-tasks.test.ts`, `test/tasks.test.ts`,
  `test/direct-task-execution.test.ts`, `test/planning-model-selection.test.ts`,
  `test/autonomous-execution.test.ts`, `test/member-report.test.ts`,
  `test/preparation-{document,import,runtime}.test.ts`.
- Docs : `docs/preparation.md`, `docs/worker-reporting.md`, `docs/mission-policy.md`,
  skills/opencode-ensemble et skills/ensemble-project-setup avec leurs références.

Les références/index ne prouvent pas une couverture exhaustive. Les lignes
mentionnées dans les rapports peuvent dériver ; rechercher les symboles actuels.

## 8. Travail réellement effectué et état local à préserver

**Aucune fonctionnalité de révision de tâches n'a été implémentée.** Aucun worker
d'implémentation, classifieur ou worktree d'auteur lancé dans cette session.

Deux changements de configuration/profil sont présents et non commitées :
- nouveau `.opencode/agents/pm.md` ;
- `.opencode/ensemble.json` : ajout de businessProfiles.byAgent.pm = pm.

PM : mode all, modèle natif openai/gpt-6.1-sol#high ; deny par défaut puis allow
read, glob, grep, skill, execute, team_message, team_results, team_status,
subagent explore et dev-reader. Pas d'édition/shell/board/lead implicites.
La documentation déléguée est rendue en texte, pas écrite sur disque.
Le PM peut déléguer hors affectation de worker ; comme worker Ensemble il reste
une feuille. Les sous-agents doivent rester des feuilles sans coordination.
Le modèle effectif de chaque aide doit respecter Sol/Luna, sinon ne pas la lancer.

Le profil/mapping ont été vérifiés sur disque et au runtime pour le PM natif.
La disponibilité des MCP dans sa session n'a en revanche pas été résolue.
Aucun autre profil, réglage global, plugin déployé ou dépendance n'a été changé.

Le brouillon et les rapports de cette mission restent sous
`.opencode/missions/team_mvmg2ygc_0000_zgwjxt/` (peuvent être ignorés par Git).
Ce handover est placé dans docs/plans pour une reprise durable ; ne pas supposer
les rapports locaux transférables sur une autre machine.

## 9. Échec de préparation : faits, pas hypothèses

Session PM native : `ses_e91c6baf2ffe2Vo10saggGy1Mo`.
Le mandat envoyé était générique (« prends connaissance de la codebase… mélange
avec l'objectif fonctionnel… plan TDD »), sans notre contrat fonctionnel détaillé.
Une session enfant fraîche n'hérite pas automatiquement de cette conversation.

Historique public audité : environ 94 secondes, huit appels : 3 skills, lecture
package.json, glob de tests, extrait de preparation-document.test.ts, 2 execute
de découverte. Aucun corps src exploré ni test exécuté. Les catalogues GrepAI,
Serena et Context Mode apparaissaient vides pour le PM. Le superviseur y accédait.
Ne pas conclure que tous les problèmes sont de simples règles de permission :
les outils n'étaient pas exposés dans ce contexte. Cause précise à diagnostiquer.

Le PM a honnêtement retourné une préparation partielle et deux questions :
objectif manquant et capacités d'exploration manquantes. Le circuit a importé
ce JSON malgré les blocages : import valide != plan d'implémentation prêt.
Le statut natif succeeded est technique, pas une acceptation métier.

Anciennes tâches génériques importées à NE PAS recycler comme plan accepté :
- cartographie-cible : task_mvmh0orl_0002_m3zdjw ;
- plan-tdd-cible : task_mvmh0orl_0003_kk0nyf.

Une hypothèse antérieure de résultat seulement rejoué a été corrigée après
lecture de l'historique : il y a bien eu une exécution PM. Le problème n'est
pas démontré comme un manque d'effort du modèle ; plus de temps/raisonnement
ne compense pas l'absence de mandat et d'outils.

Incidents d'installation PM : mapping présent sur disque, mais absent de
deps.config au moment de l'admission. loadConfig est appelé au setup ; le
runtime lit ensuite ce snapshot. L'API native confirmait pourtant le PM.
Sur accord utilisateur, services du seul projet invalidés puis reconstruits
via DELETE /api/debug/location avec location explicite. PM et plugin ensuite
confirmés actifs. Pas de redémarrage global ni de suppression de données.
Cette opération n'est pas un correctif durable du hot-reload de configuration.

API/CLI retrouvée si nécessaire :
`C:/Users/djden/AppData/Roaming/ai.opencode.desktop/cli/2.1.4-x64/opencode-cli.exe`.
Découvrir les opérations dans /openapi.json ; ne jamais deviner les mutations.
POST /api/location/reload reconstruit toutes les locations et annule les
formulaires/permissions en attente : ne pas l'appeler silencieusement.
Ne pas reproduire l'invalidation ciblée sans besoin et accord.

## 10. Politique de mission et preuves de validation

Restriction utilisateur : **uniquement GPT-6.1 Sol et GPT-6 Luna**.
Brouillon local limité à 9 couples :
- openai/gpt-6.1-sol : low, medium, high, xhigh ;
- opencode-go/gpt-6-luna : none, low, high, xhigh, max.
Identifiants/variantes exposés par le catalogue natif, pas de preuve d'appel Luna.
Métriques préexistantes copiées sans les inventer ; Luna activé dans ce brouillon
uniquement, aucune configuration globale modifiée.

Seuil initial 50 conservé : Sol high=50, xhigh=51 ; les autres Sol sont plus bas
et les Luna configurés vont de 18 à 38. Luna est autorisé mais ne démarre pas les
tâches planifiées par défaut. Ne pas baisser le seuil ni changer les scores
implicitement pour le forcer. Une tâche garde son modèle/session ; ajustement
de raisonnement permis uniquement dans son enveloppe approuvée.
Classification non demandée ; ne pas inventer de difficulté/risque.

QA proposée et conservée : proportionate, tests fondés sur les risques ; revue
indépendante ciblée sur courses/événements obsolètes/préservation. Pas de pipeline
QA obligatoire ni nouvelle infrastructure de preuve sans accord.
Gate obligatoire : `bun run typecheck && bun test && bun run build`.

Checks réellement exécutés pendant cette session :
- gate initial réussi ; 80 tests ciblés dans 3 fichiers réussis ;
- après création du PM : typecheck réussi, 1 658 tests/98 fichiers réussis,
  build réussi (357 modules) ; après une ultime reformulation textuelle du PM,
  lint seul relancé, sans prétendre un nouveau gate complet ;
- validateExecutionPolicy du brouillon : succès ; businessProfiles resolver : succès.

Lint `bun scripts/lint-agent-profiles.ts .opencode/agents` reste exit 1 :
erreur préexistante architect.md (glob relatif docs/plans/**), warnings outils
Ensemble manquants sur les profils existants. PM : warnings seulement pour
outils de mutation absents volontairement et modèle natif non contraignant en
affectation de mission. Ces diagnostics n'ont pas été réparés hors périmètre.
Les preuves précédentes ne valident PAS la fonctionnalité projetée.

## 11. Reprise propre : mandat et plan TDD proposés

Ouvrir une NOUVELLE conversation/mission, ne pas reprendre l'import de celle-ci.
Lire ce document, AGENTS.md, les profils et le diff local avant toute écriture.
Conserver le PM installé ; diagnostiquer son exposition réelle aux MCP sans
accorder un accès générique à leurs mutations. Ne pas lancer de smoke modèle
pour prétendre vérifier un catalogue et ne pas contourner Context Mode.

Le PM doit recevoir explicitement le présent document et le contrat fonctionnel.
Attendre une exploration étayée : symboles d'entrée, lecteurs/rédacteurs d'état,
tests/fixtures et scénarios négatifs, capacités SDK, contraintes de migration,
risques de races et découpage TDD. Pas seulement « explorer puis planifier ».
S'il est bloqué, présenter le blocage comme tel, pas comme un plan prêt.
Ne pas imposer une durée ou un quota d'appels : juger les preuves obtenues.

Lots proposés (à confirmer par la découverte, pas un pipeline imposé) :
1. Contrat/faisabilité : vraie confirmation de suspension, machine d'état,
   migrations, schémas des surfaces existantes, compatibilité V1/V2, risques.
2. Noyau versionné : stockage/transactions, journal et projection, validations.
3. Exécution : claim/dispatch/livraison/résultats/recovery/watchdog/shutdown,
   barrières de suspension et clôture avec préservation, reprise explicite.
4. PM/superviseur : snapshot, proposition locale, preview/acceptation et inspection.
5. Revue ciblée, corrections bornées, gate intégré, documentation et limites live.

Noyau/exécution : mutations séquencées avec même propriétaire ou contrats intégrés
avant consommation. Worktrees isolés pour les auteurs ; pas de consommation de
diff non intégré. Les sous-agents sont des feuilles ; pas de cascade de leads.

TDD obligatoire RED/GREEN/REFACTOR : cas nominal + erreurs, rouge comportemental
significatif (pas module manquant). Scénarios à couvrir : suspension non confirmée,
timeout/ack tardif, refus droits/cross-team/cycle/patch périmé atomique, événement
ancien après nouvelle révision, callback de livraison ancien, résultat reçu en
suspension, doublons de prompts, restart/recovery, annulation de prérequis,
reprise même agent/remplacement, préservation des changements non commitées,
et reproduction exacte du non-redépilage de l'ancienne tâche.

Garder les 15 outils, SDK public seulement, aucun await promptAsync, transport
v1 extrait par ._client, preserveBranch avant tout session.abort, aucune nouvelle
dépendance runtime hors contrat du projet, pas de any, JSDoc des exports.
Signaler une capacité hôte insuffisante plutôt que diminuer la garantie.

### Prompt prêt à transmettre dans une nouvelle conversation

> Reprends le projet opencode-ensemble-session depuis
> docs/plans/2026-10-24-task-revision-handover.md et AGENTS.md. L'ancienne mission
> est abandonnée ; ne réutilise ni son import PM ni son approbation. Prépare une
> nouvelle mission pour les révisions locales sûres des tâches décrites dans le
> handover : suspension confirmée, décision conserver/remplacer l'agent,
> proposition PM et application déterministe, plan persistant versionné,
> non-redépilage des anciennes versions. Aucune replanification globale ni
> réparation arbitraire. Avant de lancer un PM, vérifie ses outils réels et
> transmets-lui ce mandat complet. Je veux une découverte profonde du code et
> des tests puis un plan TDD étayé, pas seulement des tâches de découverte.
> N'utilise que GPT-6.1 Sol et GPT-6 Luna ; garde les scores/seuils existants tant
> que je ne les corrige pas. QA proportionnée et gate projet obligatoire.
> Montre le plan et la politique ; ne démarre aucun worker d'implémentation
> avant mon /ensemble-mission start. Préserve les modifications locales du PM.

## 12. Clôture technique

Au moment de la rédaction : team_status identifie la team active
`mission-41e6de70fedf10c4`, policy draft non approuvée, aucun teammate,
deux tâches (une pending, une blocked), classification calls=0.
Le libellé technique supervised/running ne signifie pas approbation.
Clôture effectuée ensuite avec `team_cleanup({})`, sans force ni purge :
`Team "mission-41e6de70fedf10c4" cleaned up.` Vérification avec team_status :
`This session is not in a team.` La session n'appartient donc plus à cette team.
Le PM natif historique et ses résultats n'ont pas été supprimés. Aucun nouveau
PM, worker ou mission n'a été lancé. La configuration locale PM est préservée.
