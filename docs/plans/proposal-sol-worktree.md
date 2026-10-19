# Proposition — garde-fou worktree au premier tour

- Statut : **proposed** (devient accepted seulement après approbation humaine explicite)
- Mission : mission-76ab4373cd1070e1
- Tâche : task_mvfbehpz_000k_dfjiw9
- Auteur : sol-worktree-2 (architecte)
- Date : 2026-10-19
- Périmètre : constat n°6 de `findings-synthesis.md` (worktrees incohérents)
- Nature : conception seule. Aucun correctif n'est appliqué par ce document.
- Emplacement : repli. L'écriture vers `C:/Users/djden/AppData/Local/Temp/opencode/mission-audit/proposal-sol-worktree.md` a été refusée (`permission.rejected: edit`). Ce fichier est le livrable.

## Problème

Le registre `team_member.worktree_dir` / `worktree_branch` et le cwd réel du worker divergent. Un agent d'écriture peut modifier le dépôt canonique, compiler hors toolchain, ou perdre des commits faits après une copie de branche. Les contournements (cd demandé dans le prompt, `subst` manuel, `bun install` autorisé au cas par cas) sont arbitrés par le lead.

Le garde-fou demandé : avant le premier tour utile du worker, prouver que le cwd est le worktree attendu, que HEAD est la branche attendue, et que la toolchain minimale est présente ; réparer ce que le plugin peut réparer sans deviner ; sinon échouer tout de suite avec une erreur actionnable. Fiabiliser le registre. Intégrer le contournement de chemin long Windows déjà pratiqué, sans le confondre avec le protocole de build du dépôt ARTIST.

## Diagnostic sourcé

### 1. Cwd hors worktree et HEAD fausse

Preuves d'audit :

- AIForAll R1 — 2 équipes, ≥7 occurrences. `team_mvf5gxng_002m_dwio4v`, msg `msg_mvf5u0n9_0030_s8djc3` : Get-Location = `C:\Users\djden\source\repos\AIForAll`, HEAD `dfaf99b`, pas le worktree annoncé. `team_mvexg9pj_0000_sotvoj`, msg `msg_mvf1gmdn_001s_u8vu97` : outils dans le dépôt principal `master` `3aee24b`, worktree listé sous `.local/share/opencode` en HEAD détachée sur le mauvais commit.
- re-ff8 R6 — msg `msg_mv6w8c7m_0001_t2b6zr` : divergence de contenu entre worktrees, contournée par contrat.

Mécanisme dans le plugin :

- `src/tools/team-spawn.ts:45-47` — `isWorktreeDirectory` ne reconnaît que la sous-chaîne POSIX `/opencode/worktree/`. Un cwd Windows `C:\Users\...\opencode\worktree\...` ne matche pas.
- `src/util.ts:54-56` — second détecteur, `isWorktreeInstance`, exige `/worktree/` et `/ensemble-`. Les deux détecteurs divergent et ignorent `\`.
- `src/tools/team-spawn.ts:149` — `useWorktree` est faux pour `plan` et `explore` même si `worktree: true`. Il est aussi faux, hors héritage, quand `deps.directory` est déjà vu comme un worktree. Le worker partage alors le répertoire du lead, sans ligne de registre.
- `src/tools/team-spawn.ts:194` — seul le spawn hérité rejette un `worktree.create` sans directory ou sans branche. Le spawn frais continue.
- `src/tools/team-spawn.ts:201-206` — l'avertissement « using shared directory » n'existe que si `worktree.create` jette. Un `data` incomplet ne jette pas et ne prévient pas.
- `src/tools/team-spawn.ts:230` — `workspace.create` raté est non fatal. Le commentaire dit que l'instruction de cwd dans le prompt est le repli.
- `src/tools/team-spawn.ts:433-441` — ce repli ordonne `cd` vers le worktree. Si le workspace est lié, le prompt affirme au contraire que le serveur gère le cwd et n'ordonne aucun `cd`. Les deux cas de l'audit (cwd canonique, worker persuadé d'être isolé) sortent de ce couple.
- `src/v2-client.ts:51-58` et `src/v2-client.ts:203-204` — `worktree.create` V2 ne renvoie que le directory. La branche est `git branch --show-current`. Sur HEAD détachée la commande sort vide, et le code substitue le nom demandé. Le registre affirme une branche qui n'est pas celle du checkout. Commentaire déjà posé : OQ-V2-branch. Le worktree est créé `from: ctx.location.directory` : le commit de départ est celui du cwd du lead.
- Spawn frais : `session.create` reçoit `workspaceID`, traduit en `location.directory` par le pont `v2dir:`. Il n'y a pas de relecture du location après création.
- Spawn hérité : `src/v2-continuity.ts:125-137` appelle `session.move`. `verifyIsolatedMove` (`src/v2-continuity.ts:23-33`) compare les commits et refuse un move sale ou à commit différent. La relecture suivante rejette si `location.directory` n'est pas le directory demandé. Ce filet n'existe pas pour le spawn frais. Il compare des commits, pas le nom de branche : un HEAD détaché au même commit passe.

Le hook qui voit le cwd d'un shell n'est pas branché :

- V1, `@opencode-ai/plugin` : `shell.env` reçoit `{ cwd, sessionID?, callID? }` et ne peut écrire que `output.env`. `src/index.ts:427-442` ignore `input.cwd` et exporte `ENSEMBLE_BRANCH` / `ENSEMBLE_WORKTREE_DIR`.
- V1, `tool.execute.before` ne reçoit que `tool`, `sessionID`, `callID`. `src/index.ts:385` ne peut pas comparer un cwd. Jeter dans ce hook échoue l'appel (OQ-11, `src/hooks.ts`).
- V2, `src/v2-setup.ts:378-381` — OQ-V2-shell : `shell.create.before` porte `cwd` et `command` (`ShellCreateBefore`) et aucun `sessionID`. Le hook est un no-op. On ne peut pas attribuer un shell au worker plutôt qu'au lead.

Conséquence : un contrôle « au premier tour » qui dépendrait du modèle, ou du hook shell V2, ne voit pas le bon processus. Le contrôle qui tient est celui que le plugin exécute lui-même avant `promptAsync`, dans le directory du worktree, plus la relecture de `location.directory` déjà prouvée pour l'héritage.

### 2. Registre `worktree_dir` / `worktree_branch` désapparié

Preuve d'audit : AIForAll R10 — `55f863` pool-2 branche sans directory ; `e63dd` pool-3/15 branche sans directory et pool-4/14 directory sans branche ; `ce5af` pool-1/4 directory sans branche. ARTIST F4 — `c-failure-contracts` 6/6 NULL alors que le lead constate un commit dans un worktree créé à la main (`msg_mv9ungav_0013`) ; `f48e` 0/26 dont 16 cpp-engineers, pool-5 « le worktree isolé manque ».

Le schéma (`src/schema.ts:73-74`, migration 3) ajoute deux TEXT nullables, sans état. Les écritures suivantes les font diverger :

- `src/tools/team-shutdown.ts:57-66` — shutdown gracieux : `preserveBranch` puis `UPDATE worktree_branch` vers `ensemble/preserved/...` pendant que le worker continue. La colonne ne nomme plus la branche checkout.
- `src/tools/team-shutdown.ts:106-114` — `preserveAndAbort` ne re-copie pas si le nom commence déjà par `ensemble/preserved/`. Le second appel (force) fige le snapshot pris au moment de la demande, et ignore les commits faits pendant `shutdown_requested`.
- `src/tools/team-merge.ts:93-96` — succès : `worktree_branch = NULL`, `worktree_dir` inchangé.
- `src/tools/team-cleanup.ts:523` — merge de sécurité : branche à NULL. `src/tools/team-cleanup.ts:543` — retrait du worktree : directory à NULL, dans un autre `UPDATE`. Échec de l'un des deux = exactement les paires BR-sans-WT et WT-sans-BR de R10.
- Mêmes écrasements de `worktree_branch` seul dans `src/index.ts` (busy_while_shutdown), `src/recovery.ts`, `src/watchdog.ts`.

`worktree_branch` mélange trois rôles : branche checkout, ref préservée à merger, et « rien ». `team_merge` lit cette colonne comme source du squash. Un NULL y est déjà le signal « rien à merger ». On ne peut pas réutiliser cette colonne pour le HEAD vivant sans casser ce contrat.

### 3. Isolation absente ou non tracée pour du dev

Preuves : ARTIST F4 (dev sans worktree, worktrees manuels hors plugin) ; re-ff8 R6 — `vbge32` 55/359 avec worktree (explore 0/52, build 1/37), `4urn3c` plan 0/51 vs build 35/48, deux équipes à 0 worktree.

Lecture du code, à séparer de l'audit :

- L'absence de worktree pour `plan` et `explore` est le comportement de `team-spawn.ts:149`, cohérent avec la décision actée « opt out pour les agents read-only ». Ce n'est pas un oubli de `worktree.create`.
- Le défaut est ailleurs : un agent d'écriture (`cpp-engineer`, `build`, profil projet) dont la création échoue ou est incomplète obtient les mêmes NULL qu'un explore. Rien ne distingue `off`, `failed` et `ready`.
- Un worktree créé par le lead hors plugin (F4, c-failure) n'a aucun enregistrement. Le plugin ne doit pas adopter un directory deviné. Il doit refuser le tour d'écriture tant que l'admission n'a pas lié un worktree à lui.

### 4. Toolchain absente du worktree

Preuve : re-ff8 R6, `4urn3c`, msg `msg_mv6wfj8t_0002_hm0peh` — worktree confirmé, aucun `node_modules`, `tsc` introuvable, le lead autorise `bun install --frozen-lockfile`. AIForAll, constat ponctuel 5 — sous-module `rustycog` absent des worktrees (`ce5af`, `e0558`, `b091e`), corrigé à la main.

Recherche dans `src/` : aucune création de `node_modules`, junction, ni `submodule update`. Un git worktree n'emporte pas les fichiers ignorés. Le comportement observé est celui du code.

`bun install` automatique est hors correctif : réseau, mutation de lock éventuelle, durée. Le plugin peut créer une jonction vers le `node_modules` canonique quand il existe, et échouer avec la commande exacte sinon.

### 5. C1083, chemin long, nommage

Preuves ARTIST F4 :

- `f5-diagnostics-gl` pool-1, msg `msg_mv9pq09q_0000` — MSVC C1083, worktree ~103 caractères, « Invalid argument ».
- `mission-8fa8c8948fe64c7e` pool-1, msg `msg_mvb342yv_0002` — `subst S:` vers le worktree, lettres `T:` et `U:` pré-allouées par le lead.
- Branches `ensemble-artist-mcp-lifecycle-mission-5caa4a18f43401c7#eiyn0g-pool-7`, `...f5-diagnostics-gl#fd525h-pool-1`, `...mission-e469fd1358b48e9d#pgj93m-pool-8`.

Contradiction à ne pas réparer en silence :

- L'audit attribue le protocole à `C:\Users\djden\source\repos\ARTIST\.opencode\missions\team_mvdpbghz_001e_pgj93m\setup-short-path-protocol.md`.
- Ce fichier (9210 octets, lu en entier) est une expérience `/Fo` MSVC. Le mandat initial écrit « Pas SUBST/junction/symlink ». Après preuve, il autorise un répertoire de build court `S/build` sous Temp, source et HEAD du worktree natif inchangés. Ce n'est pas un mapping `subst S: -> worktree`.
- Le `subst` des lettres S/T/U est un protocole de lead, attesté par les messages, absent du plugin et distinct du document.

Nommage, correction de l'inférence d'audit (« slug dérivé d'une session antérieure ») :

- `src/tools/merge-helper.ts:51-63` — `teamWorktreeName` = `ensemble-${resourcePart(project)}-${resourcePart(team)}#${shortTeamId}-${member}`.
- `shortTeamId` est le suffixe de l'équipe courante (`eiyn0g` = `team_mvcarpg8_000y_eiyn0g`). Ce n'est pas une fuite de session.
- Le fragment `mcp-lifecycle` est `project.name`. `src/tools/team-create.ts:47-55` fige ce nom au premier `INSERT INTO project` du directory (`project_id` = cwd). `ON CONFLICT(id) DO UPDATE` ne met à jour que `time_updated`. Toutes les équipes suivantes du même dossier héritent du nom d'affichage initial, y compris un nom explicite `artist-mcp-lifecycle` ou un nom tiré au hasard par `generateProjectName` (`src/util.ts`).
- Le `#` du slug est dans le chemin. Le protocole ARTIST note que `#` apparaît dans les lignes de commande ; `cmd` et les fichiers réponse MSVC le traitent mal. Le séparateur est un choix du plugin, pas une contrainte git.

Longueur : le parent `.local/share/opencode/worktree/<hash>/` plus ce slug dépasse facilement 120 caractères avant tout fichier source. L'expérience ARTIST a mesuré des objets `/Fo` au-delà de 259. Raccourcir le slug réduit la pression ; il ne garantit pas l'objet MSVC. Le plugin possède le cwd de session, pas les flags `/Fo` du projet.

`src/v2-client.ts` (list) fait `directory.split("/")`. Un chemin Windows `\` n'a pas de basename, et `branch` est renvoyé vide. `recovery.ts` filtre le préfixe `ensemble-` : un directory non reconnu est ignoré, jamais supprimé à tort (commentaire OQ-V2-wtname). Le risque est un worktree orphelin conservé, pas une suppression du canonique.

### Frontières avec les lots sœurs

- Classification, effort, profils, provider-ops : hors de ce lot.
- Les globs de profil relatifs qui ne matchent pas un worktree absolu, et la perte des permissions de session face aux règles d'agent (commentaire dans `src/v2-client.ts` : les permissions de `session.create` perdent face aux règles d'agent), appartiennent au lot profils. Ce garde-fou ne réécrit pas les profils. Il continue d'ajouter l'allow `edit` sur `${worktreeDir}/**` déjà posé dans `team-spawn.ts`.
- Le slot cargo exclusif (AIForAll R3) est une contention d'hôte, pas une identité de worktree.
- L'archivage `mission_state=running` et le journal de policy appartiennent au lot provider-ops. S'ils nettoient des colonnes worktree, ils doivent passer par la même transition que shutdown/cleanup, pas par un `UPDATE` partiel.

## Options

### Option A — Renforcer le prompt et les avertissements

Conserver le repli « shared directory » et la consigne `cd`. Ajouter une checklist HEAD / `node_modules` dans le message de spawn.

Alternative la plus simple. Elle est rejetée comme solution principale : R1 montre que la consigne `cd` n'est pas suivie, et que le prompt inverse (le serveur gère le cwd) masque l'écart. Aucune fiabilisation du registre.

### Option B — Admission fermée dans le plugin, avant `promptAsync` (recommandée)

Un module pur, `src/worktree-guard.ts`, décide. `team_spawn` applique. Les transitions de registre passent par une seule fonction. Le worker d'écriture ne démarre pas tant que le contrat n'est pas tenu. Le spawn read-only reste sans worktree, avec un état `off` explicite.

Réparations autorisées, locales, sans réseau :

- Lier la session au directory prouvé via le même `session.move` + relecture que l'héritage, y compris pour le spawn frais V2. Pas de repli prompt.
- Si `git branch --show-current` est vide et qu'une branche du nom attendu existe déjà au même commit, `git switch` vers elle. Si le commit diffère, ne pas reset : échec avec les deux SHA.
- Jonction (Windows) ou symlink (POSIX) de `node_modules` depuis le canonique vers le worktree, si la cible existe et que le lien est absent. Enregistrer le lien. Le cleanup retire le lien, jamais la cible.
- Chemin long Windows : bail `subst` sur une lettre de config, location de session = `X:\`, bail en SQLite, `subst X: /d` au shutdown/cleanup. Pas de réécriture CMake.

Réparations interdites : `bun install`, `submodule update` par défaut, `git reset`, adoption d'un worktree créé hors plugin, activation du registre LongPaths.

### Option C — Attendre que l'hôte garantisse shell cwd = location

C'est le bon contrat hôte à long terme, et il est déjà partiellement vrai pour `session.move`. Il ne répare ni la colonne écrasée pendant le shutdown gracieux, ni le `#`, ni `node_modules`, ni C1083. Ce n'est pas une alternative suffisante. C'est une dépendance, tracée en OQ-3.

## Recommandation

Retenir l'option B.

1. **Échec fermé pour tout agent qui écrit.** `plan` / `explore`, ou `worktree: false` explicite, écrivent `worktree_state='off'` et une raison (`readonly-agent` ou `flag`). Tout autre agent exige directory + branche checkout + location prouvée. `worktree.create` incomplet et `workspace.create` raté deviennent des erreurs, comme le chemin hérité l'est déjà (`team-spawn.ts:194`). Plus de « using shared directory » pour un écrivain.
2. **Séparer les rôles de la colonne branche.** Migration 17 : `worktree_state` (`off|failed|ready|preserved|released`), `checkout_branch`, `preserved_branch`, `short_path`, `toolchain_link`. `preserveBranch()` reste appelé avant chaque `session.abort()`. Le shutdown gracieux peut créer la ref de sécurité tôt, sans remplacer `checkout_branch`. `preserveAndAbort` re-copie depuis la branche checkout vivante (git dans le worktree, pas depuis la colonne déjà écrasée). `team_merge` lit `preserved_branch`. Directory et état changent dans la même transition.
3. **Contrôle avant le premier tour, pas dans le prompt.** Avant `promptAsync` (qui reste fire-and-forget) : HEAD, nom de branche, présence du lien toolchain, budget de longueur. V2 : `session.move` puis relecture de `location.directory`, y compris hors héritage. V1 : `shell.env` compare `input.cwd` au directory attendu (`worktree_dir` ou `short_path`) et jette si le membre est `ready`. On ne mute pas le cwd : le type ne l'autorise pas. V2 shell reste non attribuable tant que OQ-V2-shell n'a pas de `sessionID` ; on ne devine pas le membre par le cwd, parce que le lead shell aussi dans le canonique.
4. **Toolchain.** Jonction/symlink de `node_modules` si le canonique l'a. Sinon erreur : chemin du worktree, chemin canonique, commande `bun install --frozen-lockfile` à lancer dans le worktree par le lead. Sous-module manquant (`.gitmodules` et répertoire vide) : erreur actionnable, pas d'`update --init` sauf flag de config par défaut off.
5. **Chemin Windows.** Nouveau slug sans `#`, sans `project.name` d'affichage : `ensemble-<hash8 du project_id>-<shortTeamId>-<member>`. Les noms `ensemble-...#...` et `ensemble/preserved/...` existants restent lisibles par cleanup/recovery. Si la longueur du directory dépasse le budget (défaut 80 caractères pour la racine), bail `subst` et location = lettre. Lettres configurables, défaut observé `S,T,U`. Pool vide = échec d'admission, pas de démarrage sur le chemin long. Le plugin ne réécrit pas `/Fo` ; si le compilateur résout la lettre vers le chemin réel, l'erreur renvoie au protocole projet `setup-short-path-protocol.md`, qui reste la propriété du dépôt.
6. **Un seul détecteur de worktree.** Normaliser les séparateurs, comparer en insensible à la casse sur Windows, reconnaître `opencode/worktree` et le préfixe `ensemble-`. `isWorktreeInstance` et `isWorktreeDirectory` appellent cette fonction. But : ne plus créer un worktree imbriqué quand le lead est déjà dans un worktree Windows, et ne plus sauter l'isolation sur un faux positif de sous-chaîne.

## Plan de fichiers

Pas de code complet. Nature du changement seulement.

| Chemin | Nature |
|---|---|
| `test/worktree-guard.test.ts` | Nouveau. Spécification TDD du module pur. Écrit en premier. |
| `src/worktree-guard.ts` | Nouveau. Fonctions pures + runners injectables (`runCommand` déjà dans `src/process`). Décision d'admission, plan de jonction, budget de chemin, bail subst, transition d'état. JSDoc sur chaque export. |
| `src/schema.ts` | Migration 17 additive, après la migration 16. Colonnes ci-dessus. Backfill : préfixe `ensemble/preserved/` → `preserved_branch` ; sinon branche + directory → `checkout_branch` et `ready` ; un seul côté non null → `failed` ; les deux null et agent écrivain historique → `failed` ; `plan`/`explore` → `off`. Aucun drop de `worktree_dir` / `worktree_branch` dans cette migration : miroir écrit seulement par la transition, pour le dashboard et les lignes d'avant slice. |
| `src/tools/team-spawn.ts` | Appeler le garde avant `promptAsync`. Spawn frais V2 : `continuity.move` vers `short_path` ou `worktree_dir`, sinon échec. Supprimer le succès « shared directory » pour un écrivain. Écrire l'état atomiquement avec les colonnes. `promptAsync` inchangé : pas d'`await`. |
| `src/tools/merge-helper.ts` | Nouveau slug sans `#` ni nom d'affichage. Conserver `preserveBranch`, `preservedBranchName`, et un parseur des anciens préfixes. |
| `src/tools/team-shutdown.ts` | Copie de sécurité anticipée vers `preserved_branch` sans écraser `checkout_branch`. `preserveAndAbort` re-copie depuis la branche vivante puis abort. |
| `src/tools/team-merge.ts` | Source du squash = `preserved_branch`, repli documenté sur l'ancien `worktree_branch` préfixé `ensemble/preserved/` pour les lignes d'avant migration. |
| `src/tools/team-cleanup.ts` | Une transition `released` : directory, liens, bail subst, worktrees. Plus de NULL isolé. |
| `src/index.ts`, `src/recovery.ts`, `src/watchdog.ts` | Mêmes transitions là où `worktree_branch` est écrasé aujourd'hui. `shell.env` : comparer `input.cwd` et jeter pour un membre `ready` hors directory attendu. |
| `src/v2-client.ts` | Ne plus substituer le nom demandé quand `--show-current` est vide. Basename tolérant `\` et `/`. |
| `src/v2-continuity.ts` | Réutiliser `move` / `verifyIsolatedMove`. Étendre la vérification au nom de branche quand l'admission fournit `checkout_branch`. Ne pas copier de fichiers : le commentaire spike V2 2.0.25 interdit un champ moveChanges. |
| `src/v2-setup.ts` | Laisser le hook shell V2 incapable d'attribuer une session. Commentaire OQ-V2-shell mis à jour : le cwd y est visible, le sessionID ne l'est pas, aucun appariement heuristique. |
| `src/util.ts` | `isWorktreeInstance` délègue au détecteur normalisé. |
| `src/config.ts` | Champs optionnels : `worktreePathBudget` (défaut 80), `windowsSubstLetters` (défaut `S,T,U`), `linkNodeModules` (défaut true), `initSubmodules` (défaut false). |
| `src/dashboard.ts` | Afficher `worktree_state`, `checkout_branch`, `preserved_branch`, `short_path`. Ne pas inférer l'isolation d'un NULL. |
| `src/tools/team-status.ts` | Même lecture, une ligne d'état par membre. |
| `test/util.test.ts`, `test/integration.test.ts`, tests spawn / shutdown / merge / cleanup / v2-client | Ajuster les attentes qui figent le repli « shared directory », le détecteur slash-only, et l'écrasement de `worktree_branch`. |

Hors slice : nouveaux outils (les 15 restent), `src/db.ts` (pas de driver), transport `._client`, profils d'agents, policy modèles, scripts CMake des dépôts consommateurs.

## Risques et invariants

Invariants à ne pas casser :

- `promptAsync` n'est pas attendu. Les contrôles sont await avant l'appel. L'erreur d'admission empêche l'appel ; elle ne l'attend pas.
- Lecture du transport v1 : `._client`. Aucun changement.
- Chaque chemin vers `session.abort()` appelle encore `preserveBranch` d'abord : shutdown, cleanup forcé, recovery, watchdog, busy_while_shutdown, rollback de spawn. Le changement est le moment où la colonne checkout est remplacée, pas la copie elle-même.
- 15 outils. Pas d'outil « team_worktree_check ».
- SQLite seulement via les migrations de `src/schema.ts` et l'adaptateur `src/db.ts`.
- Le move hérité ne transfère pas de fichiers.

Risques :

- **Faux blocage.** Des spawns qui « marchaient » dans le canonique vont échouer. C'est le but pour les écrivains. Le flag `worktree: false` reste le opt-out explicite, désormais visible comme `off/flag`.
- **Snapshot gracieux.** Aujourd'hui les commits après la demande de shutdown ne sont pas dans la ref. Le nouveau second `preserveBranch` au moment de l'abort les capture. Il faut que la branche checkout existe encore. Si OpenCode a déjà supprimé la branche, la ref anticipée reste le filet ; l'erreur dit les deux noms.
- **Jonction `node_modules`.** Un `bun install` lancé dans le worktree écrit dans le canonique. L'erreur d'admission et `team_status` doivent le dire. Le cleanup ne suit pas le lien.
- **`subst`.** Lettre déjà prise, droit utilisateur, ou canonisation MSVC vers le chemin long. Échec explicite. Ne pas empiler junction + subst. Ne pas poser le registre LongPaths.
- **Slug nouveau.** Les worktrees vivants gardent leur nom. Seuls les nouveaux spawns utilisent le slug court. Cleanup doit reconnaître les deux.
- **Backfill.** Une ligne historique directory-sans-branche devient `failed`, pas `ready`. Elle n'est pas mergée implicitement.
- **Détecteur normalisé.** Un chemin qui contient par hasard `opencode/worktree` peut être classé worktree. Le test d'appartenance doit exiger le segment répertoire, pas une sous-chaîne au milieu d'un nom de fichier.
- **V2 sans sessionID sur le shell.** Un worker peut encore avoir un shell dans le canonique si l'hôte ignore `location` pour le shell. L'admission a quand même prouvé le location. Le trou restant est OQ-3, pas un succès silencieux.
- **Dashboard.** S'il lit encore `worktree_branch` comme HEAD, il ment pendant `preserved`. Le slice met l'affichage à jour dans le même changement.

## Tests TDD

Fichier d'abord : `test/worktree-guard.test.ts`. Rouge = assertion métier, pas « module introuvable ». Runners git / subst / junction injectés. Pas de git réel, pas de `subst` réel.

Rouge puis vert :

1. `worktree.create` frais qui renvoie `data` sans directory échoue. Il ne renvoie pas « spawned » ni « shared directory ».
2. `workspace.create` qui jette, pour un agent `build`, échoue l'admission. Le prompt de `cd` n'est plus un succès.
3. Le même cas pour `explore` avec `worktree: false` écrit `state=off`, `reason=readonly-agent`, et spawn quand même.
4. `C:\Users\x\.local\share\opencode\worktree\abc\ensemble-team-alice` est un worktree. `C:/Users/x/repositories/my-project` ne l'est pas. Un nom de fichier qui contient la sous-chaîne sans être le segment ne l'est pas.
5. `--show-current` vide : la branche enregistrée n'est pas le nom demandé. Admission en échec si le commit n'est pas celui de la branche attendue. `git switch` seulement si le runner de test dit que la branche existe à ce commit.
6. Shutdown gracieux : `preserved_branch` est posé, `checkout_branch` reste le nom vivant. Le force suivant appelle `preserveBranch` avec cette branche vivante, pas avec `ensemble/preserved/...`.
7. `team_merge` puis cleanup : aucun état actif ou `ready` n'a exactement une des deux colonnes directory / checkout à NULL. L'état final est `released`, les deux pointeurs de travail vides, `preserved_branch` vide après merge réussi.
8. Second `team_create` sur le même directory ne change pas le slug des nouvelles ressources via `project.name`. Le slug neuf n'a pas de `#` et ne contient pas `mcp-lifecycle` si ce texte n'est que le nom d'affichage.
9. Canonique avec `node_modules`, worktree sans : le plan contient une jonction, pas un `bun install`. Cleanup : le plan retire le lien et ne contient pas le canonique comme cible de suppression.
10. Canonique sans `node_modules` : erreur dont le texte contient le chemin du worktree et `bun install --frozen-lockfile`.
11. Racine plus longue que le budget : le plan demande un `subst` sur la première lettre libre, et le directory de session est `S:\` (ou la lettre choisie). Pool vide : erreur, pas de location longue.
12. `shell.env` V1, membre `ready`, `input.cwd` = dépôt canonique : le hook jette une erreur qui nomme le directory attendu. Cwd égal au `short_path` : pas d'erreur.
13. Chemin d'erreur déjà couvert par les tests de preserve : si `preserveBranch` renvoie false, `session.abort` n'est pas appelé.

Les tests existants de shutdown/merge/cleanup qui encodent « `worktree_branch` devient la ref préservée » sont mis à jour dans le même slice, après le rouge du nouveau fichier, pour pointer vers `preserved_branch`.

## Questions ouvertes

- OQ-1. OQ-V2-shell (`src/v2-setup.ts:378`). Le hook `create.before` a `cwd` et pas `sessionID`. Tant que l'hôte ne fournit pas le sessionID, le plugin ne filtre pas les shells V2 par membre. Hypothèse du slice : l'admission par `session.move` suffit à lier le location ; le trou shell V2 reste visible dans le message d'erreur de conception, pas masqué.
- OQ-2. Jeter dans `shell.env` annule-t-il le shell comme OQ-11 le fait pour `tool.execute.before` ? Spike sur hôte V1 avant de s'y fier. Si le throw est ignoré, le filet V1 devient un log + toast, et l'admission fermée reste le vrai garde.
- OQ-3. Après `session.create` / `session.move`, le premier shell V2 démarre-t-il dans `location.directory` ? Spike : session fraîche, sans consigne `cd`, `Get-Location`. Si non, le plugin échoue quand même l'admission côté location, et le correctif hôte est hors plugin.
- OQ-4. `subst X: <long>` puis compilation MSVC : les chemins `/Fo` restent-ils sur `X:` ou `GetFinalPathName` les rallonge-t-il ? Spike borné, sans build produit. Jusqu'au résultat, le plugin ne promet pas la disparition du C1083 ; il promet un cwd court et une erreur qui cite le protocole `/Fo` du dépôt si le compilateur canonise.
- OQ-5. `verifyIsolatedMove` exige le même commit des deux côtés. L'étendre au spawn frais qui part du canonique est correct. L'étendre à un worktree déjà avancé (re-move) refuserait un worker qui a commité. Le slice ne re-move que pendant l'admission, avant `promptAsync`.

## Points d'arbitrage

1. Échec fermé des écrivains sans worktree prouvé, contre le repli actuel dans le directory partagé.
2. Bail `subst` plugin (lettres configurables, défaut S/T/U) contre « le plugin ne touche pas aux lecteurs » et le protocole `/Fo` reste seul responsable du C1083.
3. Second `preserveBranch` au moment de l'abort, pour capturer les commits du shutdown gracieux, la première copie restant un filet.
4. Nouveau slug sans `#` et sans nom de projet figé, anciens noms conservés pour le cleanup.
5. Jonction `node_modules` automatique si le canonique l'a, jamais `bun install` automatique.
