# Diagnostic du circuit de préparation PM

Date : 2026-10-24. Diagnostic préalable ; **aucun correctif de sources approuvé ou appliqué**.

## Périmètre et preuves

Lecture d'AGENTS.md, du handover, du rapport historique 09, des modules de
préparation, de leur adaptation V2 et des tests pertinents. Serena confirme la
racine `C:/Users/djden/source/repos/opencode-ensemble-session` ; les corps et
références ont été consultés sur cette racine, sans worktree intermédiaire.

Consultations publiques en lecture seule : OpenAPI du serveur actif,
`session.get` du PM historique, `agent.get` de pm et `mcp.list` avec la location
explicite du projet. Aucun nouveau prompt, PM, worker, équipe, rechargement ou
changement de permissions. Aucune écriture directe dans la base ou l'ancien import.

Les modifications préexistantes `.opencode/ensemble.json`,
`.opencode/agents/pm.md` et le handover sont conservées.

## 1. Transmission du mandat : défaut confirmé

- `src/preparation-runtime.ts`, `resolveMandate` : un texte explicite est
  retourné immédiatement. L'objectif stocké n'est utilisé qu'en son absence.
- `openingPrompt` reçoit cette seule chaîne, pas un dossier objectif + décisions
  + préplan. `attachSession` crée un enfant natif frais ; `parentID` ne déclenche
  aucun fork de contexte.
- `src/mission-commands.ts`, `parsePrepareRequest` : seules les options `--pm`
  et `--accept` sont reconnues. La branche `--pm` reconstruit le mandat par
  découpage des espaces, ce qui perd notamment sa mise en forme multiligne.
- Le test « deepens an existing draft without replacing its objective » vérifie
  l'objectif en base, pas sa présence dans le prompt PM avec le mandat explicite.

Cela explique comment l'objectif peut rester correctement persisté sans être
transmis au PM. Le rapport 09 établit que le mandat historique était générique.

## 2. Outillage : autorisation insuffisante confirmée, filtrage à établir

La session historique `ses_e91c6baf2ffe2Vo10saggGy1Mo` existe toujours : agent pm,
bonne location du projet, parent natif, résultat technique succeeded.
Ses règles persistées contiennent `deny *`, puis des exceptions read/glob/grep/
skill/execute et quelques outils de communication ; aucune exception MCP pour
GrepAI, Serena ou Context Mode. Le profil natif courant présente la même absence.

La documentation V2 des permissions distingue `execute` des actions des outils
MCP imbriqués : autoriser execute n'autorise pas ces actions. C'est une lacune
d'autorisation établie, pas simplement une permission hypothétique sur disque.

`mcp.list` confirme **aujourd'hui** context-mode, grepai et serena connectés dans
cette location. Cela ne prouve ni leur état à l'instant historique, ni leur
exposition effective au PM. Le rapport 09 montre les recherches de catalogue
vides, sans appel MCP refusé ensuite. Le mécanisme exact qui a produit ce
catalogue vide reste non démontré : ne pas annoncer que des règles allow seules
le corrigeront.

`src/v2-preparation.ts`, `createPreparationPort` : assertCapabilities vérifie les
API de session ; describeAgent inspecte les règles ; replacePermissions copie
celles du profil. Aucun contrôle du catalogue MCP propre au PM n'est effectué.
Le SDK public installé expose `ctx.tool.list()` sans sessionID : liste globale
des outils enregistrés après transforms, pas preuve du catalogue Code Mode
filtré d'une session. L'OpenAPI consultée n'expose pas de GET du catalogue
effectif des outils par session. Ne pas inventer cette capacité.

Vérification proposée : comparer outils enregistrés, état MCP, règles natives
et règles de session ; observer ensuite le catalogue dans le contexte PM réel
avant la découverte métier. Si la preuve effective manque, afficher « non
vérifié », pas « disponible ». Tester séparément catalogue absent, action
refusée, connexion indisponible et appel réussi. Pas de smoke modèle lancé ici.

## 3. Import d'une préparation partielle : défaut confirmé

- `PreparationDocument` n'a aucun état ready/blocked/incomplete.
- `parsePreparationDocument` valide structure, limites et graphe. Les questions
  sont permises ; aucune distinction bloquante/non bloquante n'est représentée.
- `importReply` importe immédiatement le premier document valide.
- `importPreparationDocument` contrôle transaction, politique et idempotence,
  mais pas un état de préparation exploitable.
- `formatPreparation` annonce l'import et liste les questions après coup.

L'import ne démarre pas de worker et start reste explicite. Le défaut n'est donc
pas un démarrage automatique démontré, mais l'absence de frontière déterministe
entre livrable bloqué et plan importable. Aucun validateur ne peut garantir à
lui seul la qualité sémantique d'un plan ou la véracité des preuves du PM.

## 4. Associations métier : snapshot de setup confirmé

`src/v2-setup.ts:123` appelle loadConfig une fois ; l'objet est transmis à deps.
`admitNativePm` lit ensuite `deps.config.businessProfiles`. loadConfig sait relire
les fichiers, mais ce chemin d'admission ne le rappelle pas et n'utilise aucun
fournisseur rafraîchi. La recherche exacte des accès config.businessProfiles
dans src trouve cette consommation d'admission.

La lecture fraîche réussie et la reconstruction ciblée relatées dans le handover
sont cohérentes avec ce défaut. Le watcher de configuration native OpenCode ne
prouve pas que le JSON privé `.opencode/ensemble.json` réinitialise le plugin.
La racine historique PM est maintenant confirmée ; l'objet config exact détenu
par l'ancienne instance du plugin n'est pas récupérable par cette lecture.

## Correctif minimal proposé — à approuver

1. **Dossier de mandat autonome et persistant.** Séparer objectif, instructions
   supplémentaires, préplan, contraintes et provenance. Toujours joindre
   l'objectif existant, même avec un mandat complémentaire ; exiger un objectif
   pour un nouveau brouillon. Figer le dossier et son empreinte avant l'envoi ;
   le rendre inspectable au superviseur. Refuser une modification silencieuse
   du dossier d'une préparation déjà active.
2. **Options de prepare.** Ajouter une entrée de préplan fichier et une option
   d'historique natif none/fork/checkpoint, none par défaut. Syntaxe à stabiliser,
   par exemple `--preplan <chemin>` et `--history fork`. L'objectif reste une
   entrée explicite du dossier, jamais une déduction de l'historique. Conserver
   le texte multiligne ; rejeter options inconnues, combinaisons incohérentes,
   fichier absent/hors accès et contenu excessif sans troncature silencieuse.
3. **Histoire optionnelle réelle.** Réutiliser l'adaptateur natif de continuité
   existant lorsque compatible avec la préparation ; source superviseur et
   borne exclusives vérifiées. Hériter du contexte natif projeté, pas promettre
   toutes les données historiques brutes. Ne pas compacter/modifier la source,
   copier ses permissions ou rétrograder silencieusement vers fresh. Aucun
   fork live demandé à ce stade.
4. **Préflight distinguant les niveaux.** Ajouter un résultat observable des
   vérifications catalogue/permissions/disponibilité. Si nécessaire, proposer
   séparément des exceptions natives pour les seuls outils de lecture et
   d'analyse approuvés, avec noms découverts ; jamais allow serveur entier ni
   élargissement automatique par Ensemble. Ne pas qualifier toutes les méthodes
   Serena ou Context Mode de lecture seule : certaines éditent ou exécutent.
5. **Résultat métier explicite.** Versionner l'enveloppe de réponse avec états
   ready/blocked/incomplete, motifs, informations manquantes et questions
   bloquantes. Un résultat non ready conserve le diagnostic/candidat mais ne crée
   aucune tâche importée et ne consomme pas la boucle de correction de schéma.
   Permettre une reprise explicite après résolution. Les questions non
   bloquantes restent possibles. Séparer « prêt à examiner », importé et
   approbation start ; ne pas garantir la qualité métier par le seul statut.
6. **Compatibilité et barrières.** Définir un traitement explicite des nouveaux
   documents v1 sans état : ne pas inventer ready. Ne pas migrer/réinterpréter
   l'ancien import historique. Protéger les autres entrées d'import et empêcher
   start de traiter une préparation bloquée/en cours comme un plan prêt, sans
   interdire le parcours simple sans PM. Persistance uniquement par code et
   migrations normales du plugin, jamais modification manuelle de la base.
7. **Lecture fraîche bornée des associations.** Injecter un fournisseur de
   businessProfiles relisant global → projet à chaque nouvelle admission PM,
   avec racine et empreinte diagnostiquables. Ne pas recharger aveuglément toute
   la config ni modifier une politique approuvée, un import passé ou un run déjà
   admis. Une config invalide doit bloquer la nouvelle admission, sans recycler
   silencieusement un mapping périmé. Aucun restart global ni watcher nécessaire
   pour cette correction ciblée.

Fichiers concernés : modules demandés, `src/v2-preparation.ts`, instructions PM,
persistance/migration et garde d'approbation si nécessaires ; adaptateur de
continuité existant et documentation/skills. Aucun nouvel outil Ensemble,
framework de réparation ou fonctionnalité de révision locale des tâches.

## Vérification proposée (TDD)

- RED/GREEN/REFACTOR par tranche ; rouge comportemental, pas erreur de compilation.
- Objectif stocké + mandat explicite présents ensemble ; nouveau dossier sans
  objectif refusé ; préplan multiligne exact ; provenance et reprise stables.
- Historique absent par défaut ; fork/checkpoint opt-in ; source/bornes invalides,
  capacité manquante et serveur distinct refusés ; permissions PM conservées ;
  aucun prompt exécuté avant initialisation complète.
- Catalogue absent, permission refusée, MCP déconnecté et catalogue disponible
  testés séparément ; execute seul ne vaut pas préflight réussi ; zéro
  élargissement implicite de droits. Preuve live distincte des mocks uniquement
  après accord, dans une préparation neuve, pas dans l'ancienne mission.
- blocked/incomplete : zéro tâche importée, candidat conservé, arrêt explicite ;
  reprise après correction ; ready nominal ; questions non bloquantes ; JSON
  invalide et limite de corrections toujours contrôlés.
- Import atomique/idempotent, concurrence avec start et résultats tardifs ;
  parcours simple sans PM préservé ; ancien import inchangé.
- Modifier le mapping après setup est visible à l'admission suivante ; retrait,
  config invalide, override local/global et deux admissions concurrentes ; aucun
  changement rétroactif des décisions persistées.
- Gate final : `bun run typecheck && bun test && bun run build`.

## Validations réellement exécutées avant correction

- Tests ciblés préparation/document/import/config : **111 pass, 0 fail**.
- Gate complet : typecheck réussi ; **1 658 tests / 98 fichiers, 0 fail** ;
  build réussi, 357 modules.
- Ces résultats établissent la baseline, pas la correction des défauts décrits.

Les quotas d'appels, durées minimales, permissions générales, contournements de
validation et hypothèse réfutée de simple ancien résultat rejoué sont exclus.
