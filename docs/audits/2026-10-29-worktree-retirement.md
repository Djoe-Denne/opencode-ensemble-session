# Retrait partiel des worktrees et rappels de rapports

## Périmètre

Correctif local du plugin à partir de `8b82d7f`, sans modification du moteur
OpenCode ni de sa base interne. La mission OCR `mission-e9e14f0e5f6e79c1` et
son worktree lead `ocr-linux-integration` n'ont fait l'objet d'aucun appel de
retrait, refresh ou archivage pendant cette investigation. OCR, PostgreSQL et
Docker n'ont pas été rejoués. Aucune archive n'a été purgée.

Le retrait initial reste non attribué : un verrou Windows est une hypothèse,
pas une cause démontrée.

## Contrat du correctif

Les parcours `team_cleanup` et `team_merge` demandent une retraite vérifiée sur
V2. Le retrait ordinaire reste disponible pour V1 et les parcours de rollback,
qui ne reçoivent pas implicitement ce nouveau contrat.

- La propriété est dérivée du projet, de l'équipe et du membre persistés, via
  le slug de création. Un chemin étranger, le checkout canonique et les liens
  symboliques/jonctions sont refusés. Une ancienne identité non vérifiable reste
  bloquée : un simple préfixe de dossier n'est pas une preuve suffisante.
- Git, l'inventaire natif du projet et le chemin sont inspectés séparément.
  Une erreur de lecture n'est jamais interprétée comme une absence.
- Un checkout vivant exige des refs checkout/sauvegarde distinctes et identiques
  en contenu. Une branche avancée depuis la sauvegarde est conservée.
- Le retrait normal utilise l'API publique avec `force: false`, puis vérifie
  les postconditions, même si l'appel a levé une erreur après un retrait partiel.
- Lorsque Git ne connaît plus le checkout et que le chemin est absent ou vide,
  seul le refresh public de l'inventaire de ce projet est utilisé. Le retrait Git
  terminé n'est pas rejoué. Si l'enregistrement natif subsiste, l'opération reste
  en échec explicite et demande une correction du host.
- Un dossier vide n'est retiré par `rmdir` non récursif qu'après disparition des
  deux inscriptions. Un dossier orphelin non vide reste intact.
- Les références Ensemble ne sont libérées qu'après ces vérifications. La reprise
  après échec de suppression d'une branche ne refait ni le merge, ni le retrait
  d'un worktree déjà libéré, ni le rafraîchissement d'une branche déjà libérée.
- Les erreurs retournées conservent membre, étape, type/code et message borné,
  avec expurgation des identifiants d'accès usuels et sans dump de requête/stack.
  Un échec de workspace conserve également les ressources suivantes.
- Un second cleanup d'une équipe déjà archivée ne la modifie pas et n'effectue
  aucune nouvelle suppression. Cela n'autorise pas une purge des archives.

## Limite du host reproduite isolément

Sur le serveur OpenCode 2.1.4 installé, une fixture Git possédée a été créée
uniquement sous :

`C:/Users/djden/AppData/Local/Temp/opencode/retirement-host-spike-K1ZBnZ/`

Son projet natif est `045385c2812b318e80c297174e404b8a42616a46`. Un worktree de
fixture propre a été créé via `POST /api/worktree`, puis retiré uniquement de
Git. Un dossier vide a été laissé pour reproduire le symptôme, sans recréer de
worktree ni utiliser cette technique sur OCR.

Résultats vérifiés :

1. Git ne liste plus ce checkout ; le dossier est vide, sans `.git`.
2. `POST /api/worktree/refresh` avec ce seul `projectID` ne supprime pas son
   enregistrement natif de stratégie `git`.
3. `DELETE /api/worktree` avec ce même projet, le chemin exact et `force: false`
   répond HTTP 400, `_tag=WorktreeError`, `data.message=Worktree directory unavailable`.
4. Le listing natif confirme que l'enregistrement subsiste après cet appel.

La fixture et `evidence.json` sont conservés dans ce dossier pour reproduire
le défaut côté host. Les scripts de spike restent sous `.tmp/`, ignoré par Git.
L'écart de chemin constaté au premier essai venait de la sémantique native de
création : `directory` désigne le parent auquel le host ajoute `name`. Le chemin
réel a été retrouvé dans l'inventaire du seul projet de fixture avant tout retrait.

**Le plugin seul ne peut donc pas promettre l'archivage du cas OCR existant.**
L'API publique installée ne permet pas d'oublier cet enregistrement obsolète.
Il faut que le host rende le retrait Git idempotent, ou fournisse une opération
publique ciblée de réconciliation avec les mêmes contrôles de propriété. Aucune
écriture SQLite interne, `force: true`, prune global ou faux succès ne remplace
cette correction. Le simple retour réussi d'un refresh ne prouve pas la convergence.

Contrats consultés : `/openapi.json` du serveur installé,
`DELETE /api/worktree` et `POST /api/worktree/refresh` ; documentation publique
https://opencode.ai/v2/docs/api et https://opencode.ai/v2/docs/build/plugins.

## Rappels impossibles à satisfaire

Un défaut distinct est reproduit : un message peut être **lu** par `team_results`
tout en restant marqué **non distribué** après perte de l'acquittement de réveil.
L'ancien prédicat de startup ne vérifiait que `delivered=0`. Chaque rechargement
pouvait donc rappeler ce message bien que `team_results` réponde qu'il n'existe
plus de message non lu. Cela ne démontre pas que tous les rappels historiques
aient exactement cette cause, ni un lien causal avec le retrait des worktrees.

Le réveil de startup vérifie désormais les messages réellement non lus destinés
au lead, ou les candidats non lus non supersédés. Il est limité au projet actif
(racine canonique incluse lorsque la session est dans un worktree) et à
l'équipe que `team_results` résout effectivement pour cette session. Le prédicat
est relu après installation des hooks. Les acquittements déjà lus, candidats
relus/supersédés et données d'autres projets ne justifient plus ce rappel.
