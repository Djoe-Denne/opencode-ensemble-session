# Correctif local du circuit de préparation PM

Date : 2026-10-24. Périmètre approuvé après le
[diagnostic préalable](2026-10-24-pm-preparation-diagnostic.md).

## Résultat

- Le PM reçoit toujours l'objectif du brouillon et le mandat complémentaire.
  Les mandats multilignes ne sont plus aplatis.
- `prepare` accepte `--preplan <file>`, `--history none|fork|checkpoint` et
  `--before <messageID>` pour la borne exclusive d'un checkpoint. Les options
  précèdent le mandat ; les chemins avec espaces se citent entre guillemets.
- Le dossier persistant fige objectif, instructions, contraintes, préplan,
  session superviseur, choix d'historique, racine et empreinte des associations
  métier. Il possède une empreinte SHA-256 contrôlée à la lecture et apparaît
  avec le préflight dans le contexte durable du superviseur.
- Un préplan absent, externe au projet (realpath compris), vide ou trop grand
  est refusé sans création de session native. Pas de troncature silencieuse.
- L'historique est absent par défaut. L'option native utilise l'adaptateur de
  continuité existant ; source/location et borne sont vérifiées. Aucun fallback
  vers fresh, aucune compaction du superviseur. Le PM conserve ses règles natives,
  pas les droits du superviseur.
- Le préflight persiste séparément les outils enregistrés, leurs règles
  déclarées et l'état des connexions MCP. Le catalogue filtré de la session
  reste explicitement non vérifié par cette inspection globale.
- La réponse v2 explicite ready/blocked/incomplete, motifs, informations
  manquantes, disponibilité déclarée des outils et questions bloquantes.
  Seul ready est importable ; ce n'est pas une approbation d'exécution.
- Une préparation bloquée/incomplète conserve son candidat sans importer de
  tâches ni dépenser de corrections de schéma. `prepare --resume <clarification>`
  reprend explicitement le même PM, réapplique ses règles natives actuelles et
  réinspecte les outils. Les clarifications persistent séparément du dossier,
  y compris après une interruption de transport. Un dossier actif ne change
  pas silencieusement de mandat, d'agent ou de contexte.
- `start` refuse une préparation inachevée. Le parcours simple sans PM est
  conservé. Un nouveau document v1 est incomplet/non importable ; les imports v1
  historiques restent rejouables sans nouvelle décision ni modification de hash.
- Chaque nouvelle admission PM relit seulement les associations métier globales
  puis locales. Une configuration malformée bloque l'admission ; aucune ancienne
  association périmée n'est recyclée. Les runs déjà admis et la politique
  approuvée ne sont pas reconfigurés rétroactivement.

## Localisation / impact

- Commandes et restitution : `src/mission-commands.ts`.
- Mandat, preuves, boucle et reprise : `src/preparation-runtime.ts`.
- Contrat v2 et import : `src/preparation-document.ts`,
  `src/preparation-import.ts`, `src/preparation-instructions.ts`.
- Admission/configuration : `src/config.ts`, `src/types.ts`, `src/v2-setup.ts`.
- Préflight et histoire native : `src/v2-preparation.ts`, en réutilisant le
  bridge existant via client.continuity.
- Barrière start : `src/mission-policy.ts`, au point d'approbation partagé.
- Migration additive 26 : `src/schema.ts`, cinq colonnes de preuve/reprise,
  sans réécriture des anciens imports ou runs.
- Le contrat d'intervention borne maintenant ses instructions à 20000 caractères
  pour porter le contrat PM enrichi ; les autres limites restent validées.
- Documentation : `docs/preparation.md`, skill canonique et copie distribuée
  sous `agent/skills/`, synchronisées.

## Vérifications effectuées

Cycles RED/GREEN observés pour : transmission objectif + instructions, options
multilignes, dossier/préplan et refus d'accès, fournisseur frais d'associations,
config stricte, états bloqué/v1, checkpoint natif, préflight distinct, visibilité
du dossier, clarification durable, empreinte d'admission et rafraîchissement des
règles PM lors d'une reprise explicite.

Couverture supplémentaire : conservation/rejeu d'un import v1, conservation des
runs/imports pendant migration 26, refus de mauvais projet/source, absence de
capacité fork, questions bloquantes et outillage non vérifié, absence de double
prompt et préservation des contrôles existants d'import/politique/concurrence.

Gate final réellement exécuté :

```text
bun run typecheck : exit 0
bun test          : 1675 pass, 0 fail, 98 fichiers
bun run build     : exit 0, 357 modules
```

Serena : aucun diagnostic erreur/warning pour preparation-runtime.ts et
v2-preparation.ts. `git diff --check` : exit 0. Lint ciblé des sources modifiées :
exit 0 avec warnings ; le lint global reste exit 1 avec diagnostics hors des
sources modifiées, non corrigés hors périmètre. Aucune introduction de any,
TODO, session.abort ou await promptAsync dans les lignes de sources ajoutées.

## Limites et prochaine validation

**Pas de validation live d'une nouvelle session PM.** Aucun appel modèle,
fork live, worker, nouvelle équipe ou mission fonctionnelle lancé. Le plugin
n'a pas été redéployé/rechargé dans le service actif. Le build ne vaut pas preuve
de comportement du catalogue Code Mode d'une session native.

Le profil local PM préexistant est conservé sans élargissement. Son absence
d'exceptions pour les outils MCP reste une limitation d'accès à arbitrer : choisir
des actions de lecture/analyse précises, puis vérifier le catalogue et les appels
réels dans une nouvelle préparation autorisée. Ne pas accorder tout un serveur
ni considérer toutes les méthodes Context Mode/Serena comme non mutantes.

La cause exacte du catalogue vide historique n'est toujours pas démontrée ; le
correctif distingue et rend observables ses niveaux, sans prétendre les confondre.
Le statut et l'attestation d'outillage du PM sont des déclarations contrôlées
structurellement, pas une preuve automatique de qualité métier du plan.

Aucune écriture directe dans la base active ou l'ancien import, aucune reprise
de l'ancienne mission, aucune fonctionnalité de révision de tâches implémentée.
Les changements préexistants du profil PM, du mapping et du handover sont
préservés. Aucun commit, push ou publication. Aucune ressource Docker créée.
