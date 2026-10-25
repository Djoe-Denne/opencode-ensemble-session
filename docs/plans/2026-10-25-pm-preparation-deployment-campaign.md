# Déploiement et campagne native de préparation PM

Date : 2026-10-25. Suite au
[correctif local](2026-10-24-pm-preparation-fix.md), déploiement et tests autorisés
par l'utilisateur. **Aucune reprise de l'ancienne mission fonctionnelle.**

## Déploiement final vérifié

Paquet local actif :
`C:/Users/djden/.config/opencode/local-plugins/ensemble/20261025-pm-preparation-fdbbe025cbf1`.

SHA-256 du bundle installé et du build source, identiques :
`fdbbe025cbf120679c56f48538f93deed4f085baefefe1608bad49a6d9f7e151`.

- `/api/plugin` confirme ce chemin et l'état active dans le projet source et
  dans le dépôt de campagne.
- Activation par surveillance native de configuration : aucun redémarrage de
  service, aucune éviction de location ni réinitialisation de MCP demandés.
- La configuration globale n'a changé que pour les deux pointeurs paquet/skills.
  Après substitution inverse de ces chemins, comparaison structurée identique
  à la configuration sauvegardée avant le premier déploiement.
- Base migrée par le plugin de 25 à 26 ; intégrité finale `ok`.
- Trois imports préexistants ont été comparés intégralement à la sauvegarde
  initiale : tous inchangés après campagne et nettoyage.
- Aucun commit, push ou publication npm. Le paquet local contient les changements
  non commitées autorisés, sans prétendre que HEAD seul les représente.

Sauvegardes cohérentes de la configuration et de SQLite, intégrité vérifiée :

- état initial, schéma 25 :
  `C:/Users/djden/.config/opencode/local-plugins/ensemble/backups/20261025-pm-preparation-cc39d70f8733` ;
- avant activation finale, schéma 26 :
  `C:/Users/djden/.config/opencode/local-plugins/ensemble/backups/20261025-pm-preparation-fdbbe025cbf1`.

Le prédécesseur immédiat d6263141083e utilise aussi le schéma 26. Ne pas revenir
automatiquement à un ancien paquet limité au schéma 25 ni remplacer la base
active par une ancienne sauvegarde après de nouveaux travaux.

## Projet choisi et limites de permission

Dépôt Git jetable :
`C:/Users/djden/AppData/Local/Temp/opencode/ensemble-pm-campaign-20261025-cc39d70`.

Petit consommateur TypeScript : `src/slug.ts`, deux tests existants et un préplan
marqué. Objectif des PM : produire un plan TDD pour la mise en minuscules des
slugs, sans réaliser cette fonctionnalité. Les MCP Serena/GrepAI restent attachés
à la racine source canonique du plugin, consultée comme dépendance amont ; les
fichiers locaux de la fixture sont lus directement. Aucun index ni projet partagé
Serena n'a été reconfiguré.

Seul GPT-6.1 Sol a été appelé : high pour les PM, low pour les observateurs et
les nettoyages. Les identités des réponses natives ont été vérifiées. Aucun
modèle extérieur aux familles autorisées, aucun classifieur, aucun worker.

Les permissions ont été ajustées **uniquement pour pm-live dans la fixture** :
deny par défaut, lecture et découverte natives, execute, puis actions exactes de
recherche GrepAI, lecture Serena et analyse Context Mode. Ni édition, ni shell,
ni délégation, ni wildcard de serveur MCP. Une exception external_directory sur
`C:/Users/djden/.agents/*` a été nécessaire pour lire la politique commune de
scripts. La capacité Context Mode d'analyse de fichier exécute du code : son
nom ne constitue pas une garantie intrinsèque de lecture seule. Les traces et
empreintes de fichiers ont été contrôlées ; aucun fichier source/test n'a changé.

Le profil PM préexistant du projet réel est préservé, sans ajout automatique de
ces permissions. Avant la prochaine mission fonctionnelle, ses exceptions
nécessaires doivent donc être choisies explicitement dans ce projet.

## Résultats natifs

Cinq sessions PM réelles ont abouti à cinq plans v2 ready, chacun avec une seule
tâche d'implémentation bornée. Chaque tâche est restée non affectée/non exécutée.

### Fresh, blocage, reprise et import idempotent

- Profil natif présent mais mapping initial absent : admission refusée, sans PM.
- Ajout de pm-live → pm après chargement : admission réussie, sans commande de
  reload ni invalidation explicite. Les tests unitaires isolent également le
  cas où l'objet de configuration de setup reste inchangé.
- Avec execute autorisé mais les actions MCP refusées : le PM constate les
  capacités non exposées et retourne blocked. Zéro tâche, zéro import, zéro
  tentative de correction de schéma consommée. Un prepare répété ne le relance pas.
- Après exceptions ciblées et reprise explicite : mêmes session PM et hash de
  dossier ; Serena et GrepAI deviennent réellement appelables.
- Une mauvaise hypothèse sur le nom d'action Context Mode maintient un blocage
  explicite. Dans cet hôte, l'action observée est
  `context-mode_ctx_execute_file`, avec trait d'union. L'exception corrigée rend
  l'outil visible et son analyse retourne les deux noms de tests réels.
- Après accès effectif aux trois MCP et lecture des sources : ready et un import.
- Rejeu de cet import pendant qu'un mapping invalide bloque une nouvelle
  admission : résultat existant conservé, pas de nouveau PM ni de second import.

### Checkpoint exclusif

Le superviseur contient un marqueur A, puis un marqueur B. Le checkpoint est
pris avant le vrai message natif B :

- PM : `ses_e8ce94d6cffeYgjGbDAFftccSV` ;
- A est présent dans le contexte natif hérité ; B est absent ;
- objectif stocké et mandat complémentaire sont tous deux dans le dossier ;
- blocage initial sur la lecture externe de la politique de scripts, puis
  reprise explicite après permission ciblée ; ready et un import.

### Fork complet

- PM : `ses_e8ce93831ffecfeX9s1bPilX5F` ;
- A et B sont présents dans le contexte natif ;
- les appels requis des trois MCP ont réussi ;
- une réponse contradictoire ready avec informations encore manquantes a été
  refusée par le validateur, puis corrigée : une correction de schéma effective,
  pas un contournement ni un quota de travail ;
- ready et un import après résolution du blocage.

### Contrôle fresh depuis une source contenant de l'historique

- PM : `ses_e8ce1ad25ffef5MJVyYfUnL9cK` ;
- la source du superviseur contient réellement A et B ;
- sans option history, le contexte du nouveau PM ne contient aucun des deux ;
- le préplan est pourtant reçu et le plan ready est importé.

### Cas négatifs et récupération sur le paquet final

- Préplan absent : diagnostic transmis au superviseur.
- Préplan existant mais hors du projet : refus outside project.
- Checkpoint inexistant : refus de la borne, sans fallback fresh.
- Mapping vers une catégorie inconnue : échec explicite, pas de mapping ancien
  réutilisé pour une nouvelle admission.
- Après restauration des entrées valides, une nouvelle préparation réussit sur
  le paquet final : `ses_e8cdc9532ffemAvvCszWE9fDcC`, ready et un import.

## Défauts trouvés et corrigés pendant la campagne

1. Le préflight comparait systématiquement les règles à l'ID d'outil. Le SDK
   public permet une action distincte via `options.permission`. Un test rouge
   reproduit ce cas ; le préflight utilise maintenant cette action lorsqu'elle
   existe et restitue explicitement ID, action et règle déclarée. Pour Context
   Mode dans cet hôte précis, aucune normalisation supposée ne remplace l'action
   effectivement annoncée. Le défaut d'alias et la mauvaise exception de fixture
   sont deux constats distincts.
2. Les refus attendus de préplan et d'initialisation native ressortaient en
   HTTP 500, malgré leur refus correct. Deux nouveaux tests rouges ont précédé
   le correctif : erreurs d'admission typées et restitution au superviseur pour
   préplan/configuration métier/initialisation, sans assouplir les validations.
   Le cas absent, hors projet, borne inconnue et mapping invalide a ensuite été
   retesté nativement sur le paquet final.

Le candidat rejeté reste une preuve historique ; après succès, le document
accepté faisant autorité est celui de preparation_import. Le harness consulte
ce document, pas un ancien diagnostic candidate_json, pour juger le résultat.

## Vérifications et nettoyage

- Gate du paquet final : `bun run typecheck && bun test && bun run build` réussi ;
  **1678 tests, 0 échec, 98 fichiers**, 357 modules au build.
- 161 assertions d'observation des sessions réelles avant nettoyage, incluant
  des vérifications répétées par message : ce ne sont pas 161 scénarios distincts.
- Sorties natives contrôlées pour les appels MCP, pas seulement les affirmations
  finales du PM ; contextes exportés sans parties de raisonnement.
- Deux tests de base de la fixture réussis ; empreintes de src/slug.ts et de son
  test identiques à l'initialisation. La fonctionnalité planifiée n'est pas codée.
- Lint ciblé des deux modules concernés : exit 0, cinq avertissements ;
  `git diff --check` : exit 0. Le lint global préexistant n'est pas prétendu vert.
- Cinq appels natifs team_cleanup({}) vérifiés, un par équipe de test. Aucun
  force, purge, merge de worker ou suppression manuelle de session.
- Après nettoyage : **zéro équipe de campagne active**, intégrité SQLite ok,
  trois imports antérieurs inchangés. Les sessions natives et preuves restent
  consultables ; le dépôt jetable est conservé pour reproduction.

Preuves locales : `.tmp/pm-campaign-20261025-evidence/`, notamment assertions.json,
les contextes publics des leads/PM, les dossiers, documents acceptés et reçus de
nettoyage. Harness locaux non promus en outil stable :
`.tmp/pm-campaign-20261025.ts` et `.tmp/pm-campaign-20261025-assert.ts`.

## Incertitudes et exclusions

Les premiers appels GrepAI du superviseur ont échoué alors que le service 1MCP
était sain ; les connexions natives de la campagne ont ensuite réussi. Cela ne
prouve pas rétrospectivement une cause unique pour le catalogue vide historique.
La campagne démontre le filtrage/rétablissement par actions exactes dans son
propre contexte, pas une réparation silencieuse de toutes les connexions MCP.

Aucun start, aucune implémentation ou révision de tâches, aucune reprise de
l'ancienne mission. La barrière start reste couverte par les tests automatisés,
pas par une approbation d'exécution live dans cette campagne. Aucune écriture
directe de réparation dans la base active ; lectures d'audit en read-only,
migration/import/nettoyage seulement par les chemins normaux du plugin.
Aucune ressource Docker créée.
