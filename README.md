# Radar AO Isograd — Sprint 1 (auto-ingestion TED)

Ingestion quotidienne automatique des appels d'offres européens depuis l'API TED, filtrage par codes CPV et mots-clés Isograd, auto-scoring, dashboard HTML qui lit les données fraîches.

Stack : Node.js (sans dépendance externe, fetch natif) + GitHub Actions (cron) + Vercel (hébergement dashboard) + repo privé GitHub. Coût : 0 €/mois.

## Test rapide en local

Avant de pousser sur GitHub, vérifie que le script tourne sur ton Mac.

```bash
cd Sprint1_AutoIngestion_TED
node sync_ted.js
```

Tu devrais voir un récap du genre `89 avis récupérés / 6 AO matchés / 0 en Go ferme` et deux fichiers JSON dans `data/`. Ouvre `dashboard/index.html` dans le navigateur, le bouton "Synchroniser TED" charge les AO matchés.

Test passé sur la fenêtre du 23 au 30 avril 2026 : 6 AO réels remontés, dont Université de Montpellier (services de certification, 330 k€, score 70).

## Mise en production sur GitHub Actions

### Étape 1 — Créer le repo GitHub

1. Va sur [github.com/new](https://github.com/new)
2. Nom : `radar-ao-isograd` (ou ce que tu veux)
3. Visibilité : **Private**
4. Coche "Add a README file" (on l'écrasera de toute façon)
5. Crée

### Étape 2 — Pousser les fichiers

Depuis ton Mac, dans un Terminal :

```bash
cd ~/Downloads/Sprint1_AutoIngestion_TED
git init
git remote add origin git@github.com:TON_USER/radar-ao-isograd.git
git add .
git commit -m "Sprint 1 — auto-ingestion TED"
git branch -M main
git push -u origin main --force
```

Si tu n'as pas encore configuré une clé SSH GitHub, utilise l'URL HTTPS et tu auras une demande de Personal Access Token : [doc GitHub PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

### Étape 3 — Activer GitHub Actions

1. Sur GitHub, ouvre ton repo
2. Onglet "Actions" en haut
3. Clique "I understand my workflows, go ahead and enable them"
4. Le workflow `Sync Radar AO (TED)` apparaît dans la liste

### Étape 4 — Premier run manuel

1. Clique sur le workflow "Sync Radar AO (TED)"
2. Bouton "Run workflow" en haut à droite, branche `main`, "Run workflow"
3. Attends 30 à 60 secondes
4. Le run apparaît avec un check vert
5. Clique sur le run, vérifie les logs : tu dois voir le même récap que ton test local

Si le run se termine avec succès, un commit automatique a été créé par "Radar AO Bot" qui contient `data/latest.json`. Refresh la page `Code` du repo, tu vois le dossier `data/` peuplé.

### Étape 5 — Activer le cron quotidien

Le cron est déjà configuré dans `.github/workflows/sync-ao.yml` :

```yaml
schedule:
  - cron: '0 6 * * *'   # tous les jours à 6h UTC = 8h Paris en été
```

Il tourne automatiquement à partir du moment où le workflow est dans la branche `main`. Tu peux le déclencher manuellement à tout moment avec "Run workflow".

### Étape 6 — Déployer le dashboard sur Vercel

Vercel sert ton dashboard HTML statique en gratuit, depuis le repo privé GitHub.

1. Va sur [vercel.com/signup](https://vercel.com/signup), connecte-toi avec GitHub
2. "Add New Project" → "Import Git Repository" → sélectionne `radar-ao-isograd`
3. Configuration :
   - Framework Preset : **Other**
   - Root Directory : laisser vide (racine du repo)
   - Build Command : laisser vide (pas de build)
   - Output Directory : `dashboard`
4. Avant de cliquer "Deploy", crée un fichier `vercel.json` à la racine du repo (voir étape suivante) pour exposer `data/` au dashboard
5. "Deploy"

Crée ce fichier à la racine du repo, commit, push :

```json
{
  "rewrites": [
    { "source": "/data/:path*", "destination": "/data/:path*" }
  ],
  "outputDirectory": "dashboard",
  "cleanUrls": true
}
```

Mais Vercel ne sert pas par défaut les fichiers hors de `outputDirectory`. Solution simple : ajoute un step dans le workflow GitHub Actions qui copie `data/latest.json` dans `dashboard/data/latest.json` après le sync. Tu trouves ce step dans la branche `add-vercel-static-data` du repo template (ou je te le glisse plus loin dans la section Troubleshooting).

Vercel te donne une URL du type `https://radar-ao-isograd.vercel.app`. Tu peux la mettre en favori sur ton iPhone et ton Mac.

### Étape 7 (optionnel) — Notifications Slack

1. Sur Slack, crée un webhook entrant : [api.slack.com/apps](https://api.slack.com/apps) → "Create New App" → "From scratch" → nomme-le "Radar AO" → "Incoming Webhooks" → activé → "Add New Webhook to Workspace" → choisis le canal
2. Copie l'URL du webhook (commence par `https://hooks.slack.com/services/...`)
3. Sur GitHub : repo > Settings > Secrets and variables > Actions > "New repository secret"
4. Name : `SLACK_WEBHOOK`, Value : l'URL du webhook
5. Le workflow envoie une notif Slack dès qu'un AO Go ferme arrive (déjà configuré dans `sync-ao.yml`)

## Structure du repo

```
radar-ao-isograd/
├── README.md                       # ce fichier
├── package.json                    # métadonnées Node (pas de deps)
├── sync_ted.js                     # script principal
├── config/
│   └── filters.json                # CPV + mots-clés + règles segment
├── data/                           # JSON committés par le bot
│   ├── .gitkeep
│   ├── latest.json                 # snapshot le plus récent
│   └── ted_YYYY-MM-DD.json         # historique daté
├── dashboard/
│   └── index.html                  # dashboard servi par Vercel
└── .github/
    └── workflows/
        └── sync-ao.yml             # cron quotidien GitHub Actions
```

## Comment ajuster le radar

Tout passe par `config/filters.json`. Tu peux modifier sans toucher au code.

| Quoi ajuster | Où | Effet |
|---|---|---|
| Ajouter/retirer un CPV | `cpv_codes` | Le script appelle TED avec ces CPV |
| Ajouter un mot-clé FR | `keywords_fr` | Filtre supplémentaire après l'API |
| Ajouter un mot-clé EN | `keywords_en` | Idem côté anglais |
| Étendre le périmètre pays | `countries` | Codes ISO 3 lettres (FRA, BEL, LUX, DEU…) |
| Affiner les segments | `buyer_segment_rules` | Règles de classification automatique |
| Bonus de scoring | `scoring.fit_keywords_strong` | Mots qui boostent le fit produit |
| Période de veille | `publication_window_days` | 7 par défaut, 14 ou 30 OK aussi |

Toute modification de `config/filters.json` poussée sur `main` déclenche un nouveau run du workflow (config dans `on.push.paths`).

## Limites connues du Sprint 1

À traiter dans les sprints suivants.

- **BOAMP** : pas couvert ici, c'est le Sprint 2. Pour les AO français sous le seuil européen (140 k€ HT), le radar les rate.
- **Profils acheteurs autonomes** : Paris 8 IED, par exemple, publie sur son propre profil avant TED. Sprint 2 via Apify.
- **Auto-scoring conservateur** : 4 critères sur 6 sont auto, 2 (commercial, admin) restent à 5 et 7 par défaut. Tu finalises à la main dans le dashboard.
- **Notifications email** : non couvertes en v1 (Slack uniquement). Ajout possible en Sprint 4.
- **Multi-langues** : la veille capte FRA, BEL, LUX. Ajouter ALL, ITA, ESP demande juste un push de config.

## Troubleshooting

### "TED API HTTP 400 : Value 'XX' is not supported"
L'API TED ne reconnaît pas le code pays. Utilise les codes ISO 3 lettres : FRA, BEL, LUX, DEU, ITA, ESP, NLD, AUT, IRL.

### "TED : 0 avis récupérés"
Soit la fenêtre `publication_window_days` est trop courte, soit tes CPV ne matchent rien. Élargis à 14 jours pour vérifier.

### "Pas de fichier data/latest.json trouvé" dans le dashboard
Le worker n'a pas encore tourné, ou le rewrite Vercel n'expose pas le dossier `data/`. Solution rapide : ajouter au workflow un step qui copie `data/latest.json` vers `dashboard/data/latest.json` avant le commit.

```yaml
- name: Copie data dans dashboard pour Vercel
  run: |
    mkdir -p dashboard/data
    cp data/latest.json dashboard/data/latest.json
```

Place-le entre le step `Run sync_ted.js` et le step `Commit & push si nouveaux JSON`.

### "Le cron ne se déclenche pas la nuit"
GitHub désactive le cron des workflows si le repo n'a aucune activité pendant 60 jours. Il suffit d'un commit toutes les 8 semaines pour le maintenir actif. En pratique, le worker lui-même produit un commit quotidien, donc tu n'es jamais inactif.

## Et après le Sprint 1 ?

- **Sprint 2** : ingestion BOAMP (flux ATOM) + profils acheteurs Tier-1 via Apify
- **Sprint 3** : push automatique des AO ≥ 55 dans Salesforce comme opportunités
- **Sprint 4** : notifications email + capitalisation win/loss

Quand tu veux passer au Sprint 2, ouvre une nouvelle conversation et colle l'URL de ton repo. Je continue l'implémentation par-dessus.
