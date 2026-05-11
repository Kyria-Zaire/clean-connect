# CLEAN CONNECT — Cahier des Charges v1.3

**Plateforme de mise en relation pour nettoyage spécialisé à domicile**

- **Porteur** : Arisnova Solution
- **Date** : 11 mai 2026
- **Version** : 1.3 — Validée pour développement MVP
- **Statut** : Prêt pour Phase 0 (boilerplate + spec technique)

---

## Changelog v1.2 → v1.3

| # | Sujet | Résolution |
|---|---|---|
| 1 | Auto-release séquestre | T+24h → **T+48h ouvrées** + prolongation 48h possible jusqu'à T+24h |
| 2 | Stripe Connect | Custom → **Express** (réduction time-to-market ~5 semaines) |
| 3 | RGPD photos | Politique de rétention + droit à l'effacement explicitement définis |
| 4 | Conflits upload | **UUID v4 côté client** = clé d'idempotence sur tous les uploads |
| 5 | Matching géographique | **PostGIS** + `ST_DWithin` sur `GEOGRAPHY` |
| 6 | Photos AVANT bloquantes | Démarrage autorisé avec photos en local, libération séquestre conditionnée à la sync |
| 7 | DLQ webhooks Stripe | SLA détection 15 min / résolution 4h ouvrées + dashboard admin |
| + | Process litige | 3 étapes : négociation → médiation admin → décision finale sous 5 j ouvrés |
| + | Stack | NestJS + Prisma + Zod + Turborepo + BullMQ + Cloudinary + Expo |

---

## 1. Vision & Positionnement

### Problème adressé
Manque de confiance dans les prestations de nettoyage spécialisé à domicile → litiges qualité, état initial non documenté, paiements risqués.

### Solution
Plateforme premium avec :
- **Preuve photo obligatoire** (AVANT / APRÈS)
- **Séquestre Stripe** avec auto-release contrôlé
- **Workflow terrain strict** avec mode hors-connexion résilient

### Identité visuelle

| Élément | Valeur |
|---|---|
| Couleurs | Blanc `#FFFFFF` + Vert principal `#22c55e` |
| Style | Épuré, minimaliste, premium, beaucoup d'espace blanc |
| Cartes | `border-radius: 16-20px`, **sans dégradés** |
| Typographie | Inter (fallback : system font) |
| Icônes | Sobres (Lucide ou Heroicons), monoligne |

### Objectifs business (6 premiers mois)

| Métrique | Cible |
|---|---|
| Panier moyen | 160 – 220 € |
| Panier minimum | 99 € (avec upsell) |
| Commission Clean Connect | 18 % HT |
| Zone de lancement | **Soissons + 30-50 km** |

---

## 2. Personas (inchangé v1.1)

> *À détailler dans le doc dédié `docs/personas.md`.*

---

## 3. Parcours Utilisateurs (inchangé v1.1)

> *À détailler dans `docs/user-journeys.md`.*

---

## 4. Fonctionnalités MVP

### 4.1 Client App (mobile + web)

> Inchangé v1.1 — paiement Stripe, choix créneau, validation post-mission, notation.

### 4.2 Prestataire App (mobile)

#### Mode Hors-Connexion (critique)

**Stockage local des photos AVANT (3 à 5 photos)** :
- `expo-file-system` pour les fichiers binaires
- **MMKV** pour la file d'attente de sync (plus rapide que SQLite pour ce volume, ~1 KB par item)
- Compression côté mobile **avant** stockage : max 1600 px, JPEG qualité 75 → ~150-300 KB/photo (vs 5 MB brut)

**Identification des uploads** :
- Chaque photo a un **UUID v4 généré côté client** (via `react-native-uuid` ou `crypto.randomUUID()`)
- Cet UUID est la clé d'idempotence côté backend : un upload avec un UUID déjà connu est **ignoré** (HTTP 200 avec ressource existante retournée).

**Sync background** :
- `expo-background-fetch` + `expo-task-manager`
- Retry avec backoff exponentiel : 5 s, 30 s, 2 min, 10 min, 1 h (max 5 tentatives, puis manuel)
- Indicateur visuel "En attente de synchronisation" sur chaque photo non synchronisée
- Compteur global "X photos en attente" visible depuis l'écran principal

**Démarrage de mission avec photos non sync (nouveau v1.3)** :
- Le prestataire **peut** démarrer la mission avec des photos AVANT en local non synchronisées
- L'app marque la mission avec le statut `photos_avant_pending_sync`
- **Règle métier** : le séquestre **ne se libère pas** tant que toutes les photos AVANT ne sont pas synchronisées côté serveur
- Alerte admin automatique si une mission est en statut `photos_avant_pending_sync` depuis > 30 min

#### Workflow mission

```
1. Acceptation mission
2. Check-in géolocalisé (lat/lng + timestamp)
3. Photos AVANT (3-5) — obligatoire
4. Réalisation
5. Photos APRÈS (5-10) — obligatoire
6. Check-out géolocalisé
7. Soumission au client
```

### 4.3 Paiement & Séquestre (critique)

#### Stripe Connect Express (changement v1.3)

| Aspect | Connect Custom (v1.2) | **Connect Express (v1.3)** |
|---|---|---|
| KYC prestataire | À notre charge | **Stripe** prend en charge |
| Conformité PSD2 | À notre charge | **Stripe** |
| UX onboarding | 100% intégrée | Redirection Stripe (5-10 min) |
| Disputes / chargebacks | À notre charge | **Stripe** assiste |
| Time-to-market MVP | T0 + 12-14 sem | **T0 + 7-9 sem** |

#### Webhooks Stripe (renforcés)

Événements écoutés :
- `account.updated` (onboarding prestataire)
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.succeeded`
- `charge.refunded`
- `transfer.created`
- `transfer.paid`
- `payout.created`
- `payout.failed`
- `radar.early_fraud_warning.created`
- `charge.dispute.created`

**Sécurité webhook** :
- Vérification signature obligatoire (`stripe.webhooks.constructEvent(rawBody, sig, secret)`)
- Body brut (raw) requis (ne pas parser en JSON avant la vérif)
- **Idempotency check** : `stripe_event_id` stocké en DB, retour 200 si déjà traité
- Endpoints distincts par environnement (`/api/webhooks/stripe/dev`, `/staging`, `/prod`) — clés différentes

#### Règles de libération du séquestre (v1.3)

```
État initial après paiement : SEQUESTRE_BLOQUÉ
   │
   ├─→ Mission soumise au client
   │     │
   │     ├─→ Client valide manuellement  → LIBÉRÉ → Transfer prestataire
   │     │
   │     ├─→ Pas de réponse à T+48h ouvrées → LIBÉRÉ_AUTO → Transfer prestataire
   │     │     (rappels push + email à T+24h, T+36h, T+47h)
   │     │
   │     ├─→ Client demande prolongation (bouton "+48h") avant T+24h
   │     │     → SEQUESTRE_PROLONGÉ → nouvel auto-release à T+96h ouvrées
   │     │
   │     └─→ Client conteste avant auto-release
   │           → LITIGE_OUVERT → process litige (cf §4.5)
   │
   └─→ Photos AVANT non synchronisées → LIBÉRATION BLOQUÉE jusqu'à sync
```

**Calcul "heures ouvrées"** :
- Lun-Ven, 9h-18h Europe/Paris
- Hors jours fériés français
- Lib `date-fns-business-days` ou équivalent

**Implémentation technique** :
- BullMQ delayed job programmé à T+48h ouvrées lors de la soumission
- Cron de sécurité toutes les heures qui vérifie les missions en `EN_ATTENTE_VALIDATION_CLIENT` dépassant T+48h
- Historique complet des transitions de statut en table `escrow_status_history`

### 4.4 Process litige (nouveau v1.3)

| Étape | Délai | Acteur |
|---|---|---|
| 1. Négociation directe | 48h max | Client ↔ prestataire (in-app messaging) |
| 2. Médiation admin | 3 j ouvrés | Admin examine photos AVANT/APRÈS + messages |
| 3. Décision finale | 5 j ouvrés cumulés max | Admin tranche : libération totale, partielle, ou refund |

Pendant litige : **séquestre maintenu**, statut `LITIGE_OUVERT`. Aucune auto-release ne peut se déclencher.

### 4.5 Admin Dashboard

- Monitoring webhooks + statuts (succès / DLQ)
- Vue des photos en attente de sync (alertes > 30 min)
- File des litiges (avec timer SLA)
- Stats : taux d'auto-release, taux de litige, taux de chargeback
- Recherche missions / utilisateurs
- Export comptable (mensuel)

---

## 5. Règles Métier Critiques (v1.3)

| # | Règle | Détail |
|---|---|---|
| 1 | Photos AVANT obligatoires | 3-5, stockées localement, sync background, **non bloquantes pour démarrage** |
| 2 | Photos APRÈS obligatoires | 5-10, upload normal avec fallback offline |
| 3 | Séquestre bloqué dès paiement | Auto-release **T+48h ouvrées** sauf litige ou prolongation client |
| 4 | Idempotence uploads | UUID v4 client = clé unique en DB |
| 5 | Idempotence paiements | `idempotency_key` Stripe sur création PaymentIntent |
| 6 | État complexe | Demande supplément avec photos justificatives + validation client séparée |
| 7 | Pas de libération si photos AVANT pending | Règle dure côté backend |
| 8 | Géofencing matching | Prestataire visible si distance < `zone_intervention_km` |

---

## 6. Aspects Techniques & Non Fonctionnels

### 6.1 Résilience terrain

- Mode offline complet (photos + check-in + check-out)
- Sync intelligente en background avec retry exponentiel
- Idempotence par UUID client (zéro doublon possible)
- Indicateurs visuels clairs (sync en attente, sync KO, sync OK)

### 6.2 Paiements & webhooks

- Vérification signature Stripe sur tous les webhooks
- Idempotency check (event_id stocké)
- Retry mechanism (BullMQ) + **Dead Letter Queue** avec dashboard de retry manuel
- **SLA DLQ** : détection 15 min (alerte Slack + email admin), résolution 4h ouvrées
- Relance client à T+24h, T+36h, T+47h (push + email)
- Auto-release à T+48h ouvrées (BullMQ delayed job + cron de sécurité)

### 6.3 Performance & UX

- Compression photos côté mobile (1600 px max, JPEG 75 %)
- Upload via signed URL Cloudinary (le mobile upload directement, le backend ne transite pas le binaire)
- Temps de réponse API < 800 ms (P95)
- Interface 100 % responsive et épurée (vert `#22c55e` en accents, cards arrondies)

### 6.4 Sécurité

- Photos : stockage Cloudinary avec **dossiers privés par mission** + URLs signées à courte expiration
- RBAC strict : prestataire ne voit que ses missions, client que les siennes, admin tout
- JWT avec refresh tokens, expiration courte sur access token (15 min)
- Rate limiting toutes routes publiques
- Validation Zod sur tous les inputs (DTOs NestJS via `nestjs-zod`)
- Helmet, CORS whitelist strict par environnement
- Logs structurés sans PII / secrets / numéros de carte

### 6.5 RGPD (nouveau v1.3)

#### Bases légales

- Données client/prestataire (identité, contact) : **exécution du contrat** (art. 6.1.b)
- Photos AVANT/APRÈS : **intérêt légitime** (preuve en cas de litige) + **exécution du contrat**
- Données paiement : **obligation légale** (durée de conservation comptable)

#### Durées de rétention

| Donnée | Durée | Justification |
|---|---|---|
| Compte actif | Jusqu'à suppression demandée | — |
| Données après suppression de compte | 30 jours (purge soft delete) | Sécurité, fraude |
| Photos AVANT/APRÈS | **12 mois** après fin de mission | Litiges, responsabilité civile |
| Données paiement (factures, transactions) | **10 ans** | Obligation comptable (Code de commerce) |
| Logs applicatifs | 6 mois | Sécurité, debugging |
| Messages in-app | 12 mois après dernier échange | Litiges |

#### Droits utilisateur

- **Accès** : route `GET /api/users/me/export` (export ZIP avec données + photos)
- **Rectification** : route `PATCH /api/users/me`
- **Effacement** : route `DELETE /api/users/me` → soft delete + purge à T+30 j, sauf données soumises à obligation légale (paiements)
- **Portabilité** : export JSON structuré

#### Pas de DPO obligatoire à ce stade

Justification (art. 37 RGPD) :
- < 250 employés
- Pas de traitement à grande échelle de données sensibles
- Pas de surveillance systématique à grande échelle

Néanmoins, désignation d'un **référent RGPD interne** recommandée.

#### Registre des traitements

À créer dès la mise en production (`docs/rgpd/registre-traitements.md`).

### 6.6 Matching géographique (nouveau v1.3)

- Extension PostgreSQL : **PostGIS**
- Tables `users` (prestataires) et `missions` ont une colonne `location GEOGRAPHY(Point, 4326)`
- Matching : `ST_DWithin(prestataire.location, mission.location, prestataire.zone_intervention_km * 1000)`
- Index spatial : `CREATE INDEX idx_users_location ON users USING GIST(location);`

---

## 7. Stack Technique (v1.3 — confirmée)

### Backend
- **NestJS** 10+ (TypeScript strict)
- **Prisma** 5+ (PostgreSQL 16 + PostGIS)
- **Zod** via `nestjs-zod` (DTOs, validation, OpenAPI)
- **BullMQ** + **Redis** 7 (jobs, webhooks, sync, cron, delayed jobs)
- **Pino** (logger structuré, format JSON en prod)

### Mobile
- **React Native** + **Expo** SDK 51+
- **TypeScript** strict
- **MMKV** (file d'attente sync)
- **expo-file-system**, **expo-background-fetch**, **expo-task-manager**
- **TanStack Query** (state serveur)
- **react-hook-form** + **zod**

### Web Admin
- **Vite** + **React** + **TypeScript**
- **TanStack Query** + **react-hook-form** + **zod**
- **shadcn/ui** ou Mantine (cards arrondies, vert `#22c55e`)

### Infra & DevOps
- **Monorepo** : Turborepo + pnpm workspaces
- **Docker** + **docker-compose** (dev) / Dockerfiles multi-stage (prod)
- **CI/CD** : GitHub Actions (typecheck + lint + test + audit + build + deploy)
- **VPS** : recette / preprod / prod sur 3 instances séparées
- **Monitoring** : Sentry (front + back), logs Pino → ELK ou Grafana Loki

### Services externes
- **Stripe Connect Express** (paiements + séquestre)
- **Cloudinary** (storage photos avec dossiers privés)
- **Firebase Cloud Messaging** (notifications push mobile)
- **SendGrid** ou **Postmark** (emails transactionnels)

### Auth
- **JWT** (access token 15 min + refresh token 30 j)
- **bcrypt** pour les password hashes (cost 12)

---

## 8. Structure Monorepo (nouveau v1.3)

```
clean-connect/
├── apps/
│   ├── api/                    # NestJS backend
│   ├── mobile/                 # React Native Expo (prestataire + client)
│   └── admin/                  # Vite React (dashboard admin)
├── packages/
│   ├── shared-types/           # Types TS partagés (Zod schemas)
│   ├── shared-config/          # Configs ESLint, TSConfig, Prettier
│   └── api-client/             # Client TS généré (Orval ou tRPC-like)
├── docs/
│   ├── CAHIER-DES-CHARGES-v1.3.md  (ce fichier)
│   ├── architecture.md
│   ├── rgpd/
│   └── personas.md
├── docker-compose.yml          # Postgres + Redis local
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## 9. Environnements

| Env | DB | Stripe | Cloudinary | Domaine |
|---|---|---|---|---|
| development | `cleanconnect_dev` (local) | `sk_test_*` | dossier `dev/` | localhost |
| recette | `cleanconnect_rec` | `sk_test_*` | dossier `rec/` | rec.cleanconnect.fr |
| preprod | `cleanconnect_preprod` | `sk_test_*` | dossier `preprod/` | preprod.cleanconnect.fr |
| production | `cleanconnect_prod` | `sk_live_*` | dossier `prod/` | cleanconnect.fr |

**Règle dure** : aucun webhook test ne touche la DB de prod, aucun webhook live ne touche les DB de test (vérification du préfixe de clé sur réception).

---

## 10. Roadmap MVP (v1.3)

### Phase 0 — Setup (2 semaines)

- [ ] Monorepo Turborepo + pnpm initialisé
- [ ] `apps/api` (NestJS + Prisma + Zod) avec health check
- [ ] `apps/mobile` (Expo) avec écran login factice
- [ ] `apps/admin` (Vite React) avec page login factice
- [ ] Docker Compose dev (Postgres + PostGIS + Redis)
- [ ] CI GitHub Actions (lint + typecheck + test + build)
- [ ] Schéma Prisma initial (users, missions, payments, photos)
- [ ] Comptes Stripe Connect Express sandbox configurés
- [ ] Compte Cloudinary configuré, presets sandbox
- [ ] Sentry init backend + mobile + admin
- [ ] Cahier des charges v1.3 + doc architecture + registre RGPD

### Phase 1 — MVP core (9-11 semaines)

- [ ] Auth JWT (signup, login, refresh, password reset)
- [ ] CRUD utilisateurs (client, prestataire, admin)
- [ ] Onboarding prestataire avec Stripe Connect Express (KYC redirect)
- [ ] CRUD missions (create par client, accept/reject par prestataire)
- [ ] Matching géographique PostGIS
- [ ] Flow paiement avec séquestre (PaymentIntent + transfer differé)
- [ ] Webhooks Stripe complets (sécurité + idempotence + DLQ)
- [ ] BullMQ delayed jobs (auto-release T+48h ouvrées + rappels)
- [ ] Mode offline mobile : MMKV + UUID + sync background
- [ ] Upload photos Cloudinary via signed URL
- [ ] Validation mission par client
- [ ] Process litige basique (in-app messaging + admin médiation)
- [ ] Admin dashboard (utilisateurs, missions, webhooks, DLQ)
- [ ] Notifications push FCM
- [ ] Emails transactionnels (validation, relances, factures)

### Phase 2 — Polissage & extensions

- [ ] Upsell (suggestions de prestations complémentaires)
- [ ] États complexes (demande supplément avec photos)
- [ ] Factures PDF générées (auto via service comme PDFKit)
- [ ] Stats prestataire (CA, nb missions, note moyenne)
- [ ] Programme parrainage
- [ ] Notation bidirectionnelle
- [ ] Optimisations performance (P95 < 500ms)

---

## 11. Risques identifiés

| Risque | Impact | Probabilité | Mitigation |
|---|---|---|---|
| Sync offline défaillante (4G de cave) | Élevé | Moyenne | Retry exponentiel + indicateur visuel + démarrage permis avec sync pending |
| Webhook Stripe perdu | Critique | Faible | Idempotence + DLQ + cron de réconciliation quotidien |
| Chargeback client | Élevé | Moyenne | Stripe Radar + photos AVANT/APRÈS comme preuves |
| Litige photos truquées | Moyen | Faible | Métadonnées EXIF + timestamp serveur sur upload |
| Concurrence pendant matching | Faible | Moyenne | Lock optimiste sur acceptation mission |
| RGPD non conforme | Critique | Faible si v1.3 respectée | Registre + procédure d'effacement + audit régulier |

---

## 12. Critères d'acceptation MVP

Le MVP est livrable quand :

- [ ] Un client peut s'inscrire, créer une mission, payer, et valider
- [ ] Un prestataire peut s'inscrire (KYC Stripe Express), accepter, exécuter, et toucher son virement
- [ ] Le mode offline fonctionne : photos AVANT capturées en mode avion s'uploadent au retour du réseau
- [ ] Le séquestre se libère automatiquement à T+48h ouvrées si pas de réponse client
- [ ] Un webhook Stripe rejoué N fois ne crée qu'une seule action côté DB
- [ ] L'admin peut traiter un litige de bout en bout
- [ ] Le P95 des routes API est < 800 ms
- [ ] Couverture tests : ≥ 70 % sur le backend, ≥ 50 % sur le mobile

---

## 13. Hors-scope MVP (V2+)

- Paiement en plusieurs fois
- Abonnement prestataire (récurrent)
- API publique
- Multi-pays
- Application TV / Tablet dédiée
- Mode hors-ligne pour le client (uniquement prestataire en MVP)
- Chat vidéo client ↔ prestataire

---

*Fin du document — v1.3*
