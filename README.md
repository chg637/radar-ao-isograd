# Radar AO Isograd — Sprint 1+2 (TED + BOAMP + Profils Tier-1)

Ingestion quotidienne automatique des appels d'offres depuis trois sources :

- **TED** (Tenders Electronic Daily, UE) — `sync_ted.js`
- **BOAMP** (marchés publics France) via API Opendatasoft — `sync_boamp.js`
- **Profils acheteurs Tier-1** (universités autonomes) via Apify — `sync_profils.js`

Filtrage par codes CPV, mots-clés Isograd et descripteurs BOAMP, auto-scoring, fusion des trois sources dans un dashboard HTML qui lit les données fraîches.

Stack : Node.js (sans dépendance externe, fetch natif) + GitHub Actions (cron) + Vercel (hébergement dashboard) + repo privé GitHub + Apify (profils Tier-1). Coût : 0 €/mois (sauf si volumétrie Apify > 5 $ de crédit gratuit).

## Test rapide en local

Avant de pousser sur GitHub, vérifie que tout tourne sur ton Mac.

```bash
cd radar-ao-isograd

# Sprint 1 — TED
node sync_ted.js

# Sprint 2 — BOAMP (API Opendatasoft, gratuit, sans token)
node sync_boamp.js

# Sprint 2 — Profils Tier-1 via Apify (token requis ; sinon le script sort propre)
APIFY_TOKEN=apify_api_xxx node sync_profils.js

# Fusion des 3 sources dans data/latest.json
node merge_sources.js
```

Tu devrais voir, par script, un récap du type `89 avis récupérés / 6 AO matchés / 0 en Go ferme` (TED) et `817 avis / 3 matchés` (BOAMP). Ouvre `dashboard/index.html` dans le navigateur, le bouton "Synchroniser le radar" charge `data/latest.json` (fusionné).

Tests passés au 30 avril 2026 :
- TED : 89 avis sur 7 jours → 6 matchés (dont Université de Montpellier, certification TOEIC, 330 k€, score 70)
- BOAMP : 817 avis sur 7 jours → 3 matchés (dont VILLE de PARIS, formation CAP par VAE, score 60)
- Profils : 0 si APIFY_TOKEN absent (mode dégradé)

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
├── sync_ted.js                     # Sprint 1 — pull TED
├── sync_boamp.js                   # Sprint 2 — pull BOAMP via API Opendatasoft
├── sync_profils.js                 # Sprint 2 — pull profils Tier-1 via Apify
├── merge_sources.js                # Sprint 2 — fusion des 3 sources dans latest.json
├── config/
│   ├── filters.json                # CPV + mots-clés + règles segment (commun)
│   ├── boamp.json                  # config source BOAMP (Sprint 2)
│   └── profils_tier1.json          # liste des profils acheteurs Tier-1 (Sprint 2)
├── data/                           # JSON committés par le bot
│   ├── .gitkeep
│   ├── latest.json                 # snapshot multi-source le plus récent
│   ├── ted_YYYY-MM-DD.json         # historique daté TED
│   ├── boamp_YYYY-MM-DD.json       # historique daté BOAMP
│   └── profils_YYYY-MM-DD.json     # historique daté Profils
├── dashboard/
│   └── index.html                  # dashboard servi par Vercel
└── .github/
    └── workflows/
        └── sync-ao.yml             # cron quotidien GitHub Actions (3 sources)
```

## Sprint 2 — BOAMP

### Source 1 : API Opendatasoft (gratuite, recommandée)

L'ancien flux ATOM `/avis/recherche.atom` du BOAMP n'existe plus depuis la migration vers Huwise. À la place, on tape l'API publique `boamp-datadila.opendatasoft.com` (ODSQL, JSON natif, gratuit, sans token, dataset complet).

Configuration dans `config/boamp.json` :
- `window_days` : fenêtre temporelle en jours (7 par défaut)
- `natures_libelle` : types d'avis à conserver. On garde les avis prospectifs : `Avis de marché`, `Avis d'intention de conclure`, `Périodique`. On exclut `Résultat de marché`, `Rectificatif`, `Annulation` (bruit).
- `descripteurs_blacklist` : descripteurs métier BOAMP à rejeter (gardiennage, assurance, transport, BTP). Le BOAMP n'a pas de CPV, alors on filtre par sa propre taxonomie pour virer les faux positifs (ex: "télésurveillance" qui matche du gardiennage).
- `negative_phrases` : phrases qui annulent un match (ex: "passation de marché" pour ne pas confondre avec "passation d'épreuves").
- `page_size` / `max_pages` : pagination, 100 × 10 = 1000 max.

### Source 2 : Saved search BOAMP (optionnelle)

Si tu veux pointer une recherche sauvegardée plus précise depuis [boamp.fr](https://www.boamp.fr/), tu peux remplacer le pull API par un flux ATOM. Renseigne `atom_url` dans `config/boamp.json` (mais le code actuel est calé sur l'API Opendatasoft, qui couvre déjà ton besoin).

## Sprint 2 — Profils acheteurs Tier-1

Certains établissements (universités autonomes type Paris 8 IED, UGE, IAE Aix-Marseille) publient sur leur propre profil acheteur avant ou à la place de BOAMP. On les scrape avec Apify.

### Étape 1 — Créer un compte Apify

1. Va sur [console.apify.com](https://console.apify.com/) (compte gratuit, 5 $ de crédit/mois)
2. Settings > Integrations > API tokens > "Create new token"
3. Copie le token (commence par `apify_api_...`)

### Étape 2 — Configurer le secret GitHub

1. Sur ton repo GitHub : Settings > Secrets and variables > Actions > "New repository secret"
2. Name : `APIFY_TOKEN`
3. Value : le token copié

Si le secret n'est pas configuré, `sync_profils.js` sort propre avec un warning (le workflow continue).

### Étape 3 — Configurer la liste des profils

Tu édites `config/profils_tier1.json`. Pour chaque profil :
- `id` : identifiant court (ex: `paris8-ied`)
- `nom` : libellé affiché dans le dashboard
- `url_profil` : URL de la page de listing des AO sur le profil acheteur
- `actor_input.startUrls` : URLs que l'actor Apify va scraper
- `actif: true` pour activer le pull

Le code utilise par défaut l'actor public `apify~web-scraper`. Tu peux pointer un actor custom si tu en construis un (dans Apify Console, "Develop new actor" > template "Web Scraper") avec une `pageFunction` qui retourne des items au format :

```js
{
  titre: "Plateforme de télésurveillance des examens en ligne",
  url: "https://...",
  date_publication: "2026-04-15",
  deadline: "2026-05-30",
  montant_kEur: 180,
  description: "Texte complet...",
  reference: "AO-2026-042"
}
```

`sync_profils.js` normalise ce format au schéma sprint 1 (acheteur, objet, cpv, segment, score, …) puis applique le même filtrage mots-clés et scoring que TED/BOAMP.

### Limite Apify gratuite

Le crédit gratuit Apify (5 $/mois) suffit pour ~10 profils scrapés une fois par jour. Au-delà, soit tu passes en plan payant (39 $/mois), soit tu mets un actor custom léger (sans Puppeteer) qui consomme moins de Compute Units.

## Comment ajuster le radar

Tout passe par les 3 fichiers dans `config/`. Tu peux modifier sans toucher au code.

| Quoi ajuster | Où | Effet |
|---|---|---|
| Ajouter/retirer un CPV | `filters.json` → `cpv_codes` | Le script appelle TED avec ces CPV |
| Ajouter un mot-clé FR | `filters.json` → `keywords_fr` | Filtre TED + BOAMP + Profils |
| Ajouter un mot-clé EN | `filters.json` → `keywords_en` | Idem côté anglais |
| Étendre le périmètre pays | `filters.json` → `countries` | TED uniquement (BOAMP = FR seul) |
| Affiner les segments | `filters.json` → `buyer_segment_rules` | Classification automatique |
| Bonus de scoring | `filters.json` → `scoring.fit_keywords_strong` | Mots qui boostent le fit produit |
| Période de veille | `filters.json` → `publication_window_days` (TED) ou `boamp.json` → `window_days` (BOAMP) | 7 par défaut |
| Filtrer le bruit BOAMP | `boamp.json` → `descripteurs_blacklist` / `negative_phrases` | Vire les faux positifs |
| Activer/désactiver un profil Tier-1 | `profils_tier1.json` → `profils[].actif` | Inclut/exclut un profil dans le pull Apify |

Toute modification d'un fichier `config/*.json` poussée sur `main` déclenche un nouveau run du workflow (configuré dans `on.push.paths`).

## Limites connues après Sprint 2

- **Déduplication inter-sources** : si un AO apparaît sur TED et BOAMP avec des références différentes (ex: VILLE de PARIS / VAE Petite Enfance vu sur les deux), il sera affiché deux fois. La dédup par `id` ne suffit pas, faudrait normaliser sur titre + acheteur. À traiter en Sprint 3.
- **Faux positifs BOAMP** : "passation" matche correctement "passation d'épreuves" mais aussi "passation de marché". On filtre via `negative_phrases` mais c'est itératif — surveille les premiers runs et ajoute des phrases au besoin.
- **Profils Tier-1 sans URL profil acheteur connue** : pour Paris 8 IED, UGE, IAE Aix les URLs sont en placeholder `marches-publics.gouv.fr`. À confirmer/ajuster manuellement après les premiers tests Apify.
- **Auto-scoring conservateur** : 4 critères sur 6 sont auto, 2 (commercial, admin) restent à 5 et 7 par défaut. Tu finalises à la main dans le dashboard.
- **Notifications email** : non couvertes (Slack uniquement). Ajout possible en Sprint 4.
- **Multi-langues TED** : capte FRA, BEL, LUX. Ajouter ALL, ITA, ESP demande juste un push de config.
- **Apify Compute Units** : avec 5 $/mois gratuit, attention si tu actives plus de 10 profils. Préférence : actor léger (Cheerio Scraper > Web Scraper avec Puppeteer).

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

## Et après le Sprint 2 ?

- **Sprint 3** : push automatique des AO ≥ 55 dans Salesforce comme opportunités, dédup inter-sources sémantique (titre + acheteur normalisés), historisation des changements (modification/rectificatif).
- **Sprint 4** : notifications email + capitalisation win/loss + extension multi-langues TED (DEU, ITA, ESP).
- **Sprint 5** : enrichissement prospects Clay/Apollo, scoring acheteur (a-t-il déjà acheté du Tosa-like ?), graph des décideurs.

Quand tu veux passer au Sprint 3, ouvre une nouvelle conversation et colle l'URL du repo + le scope.
