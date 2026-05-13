# PRD-005 — Product Experience (Mobile + Admin)

> **PRD** = *Product Requirements Document*
> Sprint 5 — Product Experience.
> Méthode appliquée : [BMAD-light](../method/BMAD.md) — phase **Discover clôturée** (`DISCOVER_DONE`). **Design 005A non ouvert** tant que les gates §12.2 ne sont pas remplis.
> Référence métier : [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md).

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-005` |
| **Slug** | `product-experience` |
| **Titre** | Product Experience (Mobile + Admin) |
| **Version PRD** | `0.2` |
| **Statut** | `DISCOVER_DONE` |
| **Owner produit** | **Kyria** (Product Owner — arbitrage CTO Q12) |
| **Owner technique** | `seniordev-frontend` + `mobile` (Build) ; `product-architect` (Discover) |
| **Persona pilote (Discover)** | `product-architect` + `mobile-lead` + `frontend-lead` + `ux-strategist` |
| **Créé le** | 2026-05-13 |
| **Mis à jour le** | 2026-05-13 |
| **Discover clôturé le** | 2026-05-13 (arbitrages CTO intégrés — doc-only) |
| **Cible de release** | MVP produit (post-PRD-004 `DONE` + gates §12.2) |
| **T-shirt size** | `XL` (Discover découpé en sous-PRDs 005A → 005D) |
| **Lien Cahier v1.4** | §1 (Vision), §2 (App unique mobile), §3 (Stack), §10 (Roadmap MVP), §11 (Critères MVP) |
| **Dépendances amont** | PRD-001 ✅ DONE, PRD-002 ✅ DONE, PRD-003 🟧 RC, PRD-004 ⏳ Verify opérationnel en cours (Sprint 4) |
| **Bloque** | PRD-006 (Disputes/Litiges produit), PRD-007 (Notifications avancées) |

> 🚨 **Garde-fou** : ce PRD reste **doc-only**. Aucun écran codé, aucun composant React, aucun changement API, aucune migration, aucun changement runtime. **Build frontend interdit** tant que §12.2 + §12.3 ne sont pas satisfaits (même avec `DISCOVER_DONE`).

---

## 1. Contexte & problème

### 1.1 Pourquoi cette feature ? — Vision produit

Clean Connect a fini son chantier *plateforme* :

- Auth + Missions + Géoloc PostGIS (`PRD-001`, `PRD-002`) ✅
- Photos + Stripe Connect Express + escrow + auto-release T+48h ouvrées (`PRD-003`) 🟧
- Hardening : observabilité Sentry/OTel, retry/DLQ BullMQ, RGPD avancé, **monitoring financier production-grade** (`PRD-004`) ⏳

**Tout ce qui rendait le backend "non livrable" est terminé**. Le système est désormais stable, monitoré, auditable, traçable, RGPD-conforme.

→ Le bloc suivant **change de nature** : passer d'une *plateforme technique* à un **produit utilisateur visible**.

PRD-005 est le sprint où Clean Connect devient une expérience que l'on peut **utiliser** :
- Un client peut commander un nettoyage de bout en bout avec confiance
- Un prestataire peut prendre une mission sans confusion, photographier, encaisser
- Un admin Ops peut traiter litiges / refunds / DLQ sans `psql` ni Stripe Dashboard
- L'équipe Support a une console pour assister un utilisateur sans lire les logs Pino

> **Phrase de cadrage** : *le backend a fini son sprint. Le produit commence le sien.*

### 1.2 Personas concernés

| # | Persona | Rôle |
|---|---|---|
| P1 | **Client** (particulier) | Commande un nettoyage spécialisé, paie, suit, valide, conteste |
| P2 | **Prestataire** (auto-entrepreneur / SIRET) | Reçoit propositions, accepte, exécute mission, photographie, encaisse |
| P3 | **Admin Ops** (Clean Connect interne) | Traite disputes, refunds, transfers, DLQ replay, audit |
| P4 | **Support** (Clean Connect interne) | Aide utilisateur en lecture-seule sur dossier (sans PII inutile) |
| P5 | **Finance/Admin** (Clean Connect interne) | Lit dashboards monitoring financier (PRD-004), exporte rapports |

**Note app mobile** : conformément au cahier v1.4 §2, **un seul binaire mobile** porte Client + Prestataire avec `RoleGuard` et switch UI. C'est une **décision actée**, non rediscutée ici.

### 1.3 Métriques de succès

> Toutes les métriques ci-dessous sont **propositions Discover**. Baselines à mesurer pendant Design (analytics events à instrumenter).

| Métrique | Baseline | Cible MVP | Mesure |
|---|---|---|---|
| Taux de complétion signup → 1ʳᵉ mission créée (Client) | n/a | ≥ 30 % à J+7 | event `mission.created` / `user.signed_up` |
| Taux de complétion KYC Stripe Connect (Prestataire) | n/a | ≥ 70 % en < 48 h | event `stripe.account.charges_enabled` / `user.signed_up` |
| Taux d'acceptation mission proposée | n/a | ≥ 40 % | event `mission.accepted` / `mission.proposed` |
| Taux de validation client post-mission | n/a | ≥ 85 % en < 24 h | event `mission.validated` / `mission.completed` |
| Taux de dispute | n/a | ≤ 3 % | event `mission.disputed` / `mission.completed` |
| Time-to-payout prestataire (mission → fonds reçus) | n/a | ≤ T+48h ouvrées + 1 j | event `stripe.transfer.paid` / `mission.completed` |
| Crash-free sessions mobile | n/a | ≥ 99,5 % | Sentry release health |
| Time-to-resolve dispute (admin) | manuel | ≤ 24 h ouvrées | event `dispute.resolved` / `dispute.opened` |
| NPS client à J+30 | n/a | ≥ 40 | sondage post-mission |
| NPS prestataire à J+30 | n/a | ≥ 30 | sondage in-app mensuel |

### 1.4 Out of scope (MVP PRD-005)

- ❌ **Chat realtime in-app** client ↔ prestataire (renvoyé en PRD-005C — Realtime + Notifications)
- ❌ **Matching IA / scoring intelligent** des prestataires (renvoyé en PRD-005D ou backlog V2)
- ❌ **Marketplace multi-services** (Clean Connect reste mono-vertical nettoyage spécialisé)
- ❌ **Programme de fidélité / parrainage** (V2)
- ❌ **Web app publique pour clients** (mobile-first MVP — site marketing uniquement)
- ❌ **API publique tierce** (V2 hypothétique)
- ❌ **Reporting client/prestataire avancé** (renvoyé en PRD-007 — Notifications avancées + reporting)
- ❌ **Application web prestataire** (mobile only — décision cahier v1.4 §2)
- ❌ **Multi-langue** (français uniquement MVP — zone Soissons)
- ❌ **Disputes/litiges process complet** (renvoyé en PRD-006 — un PRD dédié, trop transverse)
- ❌ **Notifications push FCM** en MVP 005A/005B (renvoyé **exclusivement** en PRD-005C — Q3 CTO)
- ❌ **SDK analytics produit** (PostHog, Mixpanel, etc.) en MVP 005A/005B (renvoyé en PRD-005D — Q9 CTO)

---

## 2. User stories & critères d'acceptance

> Stories de **niveau Discover** : intentionnelles, non instrumentées. Les AC détaillés (donné/quand/alors) sont rédigés en Design pour chaque sous-PRD (005A/B/C/D).

### 2.1 Client

#### S1 — Découvrir et créer une mission
**En tant que** client, **je veux** comprendre en < 2 min ce que Clean Connect propose et lancer une demande, **pour** obtenir un devis rapidement sans appeler.

#### S2 — Suivre l'état d'une mission
**En tant que** client, **je veux** savoir à tout moment l'état exact de ma mission (proposée / acceptée / en cours / terminée / litigieuse), **pour** ne pas appeler le support.

#### S3 — Payer en confiance
**En tant que** client, **je veux** comprendre que mon paiement est en **séquestre** jusqu'à validation, **pour** ne pas avoir peur d'être facturé sans prestation.

#### S4 — Valider la mission
**En tant que** client, **je veux** valider la mission après avoir vu les photos APRÈS, **pour** débloquer le paiement du prestataire — ou contester si insatisfait.

### 2.2 Prestataire

#### S5 — Onboarding KYC fluide
**En tant que** prestataire, **je veux** comprendre le parcours Stripe Connect Express **avant** de cliquer, **pour** ne pas abandonner à mi-chemin.

#### S6 — Recevoir et accepter une mission
**En tant que** prestataire, **je veux** recevoir une notification claire (distance, prix, durée estimée), **pour** décider en < 30 sec.

#### S7 — Exécuter la mission sans confusion
**En tant que** prestataire, **je veux** un parcours guidé (arrivée → photos AVANT → travail → photos APRÈS → clôture), **pour** ne rien oublier.

#### S8 — Suivre mes paiements
**En tant que** prestataire, **je veux** voir clairement chaque mission : *en attente / en séquestre / payé / contesté*, **pour** anticiper ma trésorerie.

### 2.3 Admin Ops

#### S9 — Traiter une dispute en < 10 min
**En tant qu'**admin Ops, **je veux** ouvrir une console qui affiche : mission, paiements, transferts, photos AVANT/APRÈS, audit timeline, **pour** prendre une décision (refund client / release prestataire / split) sans changer d'outil.

#### S10 — Replayer un job DLQ
**En tant qu'**admin Ops, **je veux** voir tous les jobs BullMQ morts (DLQ), comprendre la cause d'échec et les rejouer ou les ack, **pour** ne pas perdre de webhook Stripe.

#### S11 — Lire le tableau financier
**En tant qu'**admin Ops, **je veux** un dashboard *Finance Monitoring* (built sur PRD-004 Ticket 4.5), **pour** voir les mismatches, runs reconcile, daily reports.

### 2.4 Support

#### S12 — Assister un utilisateur en lecture seule
**En tant que** Support, **je veux** chercher un utilisateur par email, voir ses dernières missions, l'état de paiement, sans accéder aux PII (carte, IBAN, photos), **pour** répondre à un ticket sans escalade.

---

## 3. Phase DISCOVER — Surfaces produit & Architecture

### 3.1 Surfaces produit cible

| # | Surface | Technologie (cahier v1.4) | Personas | Statut actuel |
|---|---|---|---|---|
| **A** | **Mobile App** (binaire unique) | Expo SDK 51+ + expo-router + RoleGuard | Client + Prestataire | Bootstrap PRD-001/002, écrans à construire |
| **B** | **Admin Web Console** | Vite + React + TS strict + TanStack Query — **accès MVP : VPN / réseau interne uniquement** (Q4 CTO) | Admin Ops + Finance | Pas démarrée ; certaines routes API admin existent déjà (`/admin/dlq/*`, `/admin/finance/*`) |
| **C** | **Site marketing** | *Hors scope MVP* | Visiteurs | Out of scope PRD-005 |
| **D** | **Support console** | Inclus dans Admin Web (RBAC `SUPPORT`) | Support | Out of scope MVP — vue Support déléguée à Admin en lecture seule pour MVP |

### 3.2 Architecture frontend cible — Mobile

> Décisions Discover. Les contrats Zod / composants / écrans sont rédigés en Design (005A).

| Couche | Choix Discover | Justification |
|---|---|---|
| Framework | **Expo SDK 51+** | déjà acté cahier v1.4 §3 |
| Navigation | **expo-router** (file-based) | déjà acté ; cohérent avec RoleGuard racine |
| State serveur | **TanStack Query** | déjà acté ; cache + retry + invalidation propres |
| State UI local | **Zustand** (préférences rôle, modal global, draft mission) | léger, pas de Redux ; cohérent avec MMKV pour persistance |
| Persistance secrets | **expo-secure-store** | déjà utilisé pour JWT (PRD-001) |
| Persistance préférences | **MMKV** | déjà acté pour file de sync offline (PRD-003) |
| Formulaires | **react-hook-form + zod** | cohérent cahier v1.4 |
| Photos | **expo-camera + expo-image-manipulator** | pipeline 1600px JPEG q75 (skill `offline-sync-pattern`) |
| Sync offline photos | **MMKV queue + expo-background-fetch + UUID v4** | hérité PRD-003 |
| Push | **expo-notifications** (FCM côté serveur) | topics `client.<id>` / `prestataire.<id>` (cahier §2.4) |
| Design System | **NativeWind (Tailwind)** + composants maison | aligné couleurs `#22c55e`, radius 16-20 px, sobriété cahier |
| Tests E2E | **Detox** | acté cahier v1.4 §3 — happy path par feature |
| Crash reporting | **Sentry React Native** | acté PRD-004 Ticket 4.1 |
| Découpage code | **feature modules** : `features/auth`, `features/missions-client`, `features/missions-presta`, `features/payments`, `features/profile`, `features/notifications` | aligné Expo Router groups `(auth)`, `(client)`, `(presta)` |

**Module map mobile cible (Discover only, non normatif)** :

```
apps/mobile/
├── app/                      (expo-router)
│   ├── (auth)/               signup, login, mode-choice
│   ├── (client)/             tabs: search, my-missions, messages, profile
│   ├── (presta)/             tabs: dashboard, interventions, photos, profile
│   └── _layout.tsx           RoleGuard racine
├── src/
│   ├── features/
│   │   ├── auth/
│   │   ├── missions-client/
│   │   ├── missions-presta/
│   │   ├── payments/
│   │   ├── photos/           (hérité PRD-003 — sync offline)
│   │   ├── profile/
│   │   └── notifications/
│   ├── design-system/
│   ├── lib/
│   │   ├── api/              (clients TanStack Query par feature)
│   │   ├── auth/             (useCurrentRole, SecureStore wrapper)
│   │   ├── analytics/        (events typés)
│   │   └── i18n/             (FR uniquement MVP)
│   └── theme/
```

### 3.3 Architecture frontend cible — Admin Web

> **Arbitrage CTO Q4 (DISCOVER_DONE)** : l’Admin Web MVP est servi **derrière VPN / réseau interne** (pas d’exposition Internet publique en MVP). Réduction de la surface d’attaque ; friction support acceptée (accès VPN obligatoire). Passage Internet public + JWT (recommandation Discover initiale) = **hors scope MVP**, réévaluable post-005B si DPO + `reviewer-securite-code` valident.

| Couche | Choix Discover | Justification |
|---|---|---|
| Framework | **Vite + React + TS strict** | acté cahier v1.4 §3 |
| Routing | **React Router 6** | écosystème standard, pas besoin de Next côté admin interne |
| State serveur | **TanStack Query** | cohérent mobile |
| Formulaires | **react-hook-form + zod** | cohérent mobile |
| Auth | **JWT cookies HttpOnly** ou Bearer header (à trancher en Design) | RBAC `ADMIN` / `FINANCE` / `SUPPORT` |
| Exposition réseau MVP | **VPN / internal only** | Q4 CTO — moindre surface d’attaque ; doc infra (ingress, IP allowlist, ou Zero Trust) en Design 005B |
| Composants | **shadcn/ui + Tailwind** (Q7 CTO) | rapide à mettre en place, themable cohérent vert `#22c55e` |
| Tables / data grid | **TanStack Table** | mismatches, runs, transfers, payouts, users |
| Charts (finance) | **Recharts** ou **visx** | dashboards Finance Monitoring (build sur PRD-004) |
| Dashboards finance | **Grafana embed** (iframe / link-out) | dashboards Grafana existants restent source de vérité ops |
| Crash reporting | **Sentry React** | acté PRD-004 |
| Découpage | **pages/** par feature + **components/** mutualisés | aligné cahier |

**Page map admin cible (Discover only)** :

```
apps/admin/
├── src/
│   ├── pages/
│   │   ├── login/
│   │   ├── dashboard/            (overview ops du jour)
│   │   ├── users/                (search, KYC status, suspend)
│   │   ├── missions/             (detail + audit timeline)
│   │   ├── disputes/             (queue + détail + actions)
│   │   ├── payments/             (transfers / refunds / payouts)
│   │   ├── dlq/                  (BullMQ — replay / ack)
│   │   └── finance-monitoring/   (link vers Grafana + tableau mismatches PRD-004)
│   ├── features/
│   ├── components/               (Layout, Sidebar, RbacGuard)
│   ├── lib/                      (api client, auth, theme)
│   └── design-system/
```

### 3.4 Risk assessment (Discover PRD-005)

| Domaine | Score | Justification | Action si ≥ 4 |
|---|:-:|---|---|
| Sécurité | 3/5 | Surfaces front consomment APIs déjà durcies (JWT, RBAC, sanitize) ; nouveau surface admin = vecteur d'IDOR si mal géré | Audit `reviewer-securite-code` sur RBAC admin en Design |
| RGPD | 4/5 | Support a accès à des données users — *minimisation* obligatoire (pas de carte, pas d'IBAN, pas de PII en logs front) | Cadrage Support read-only + DPO sign-off avant Build admin |
| Financier | 2/5 | Aucune logique finance nouvelle ; uniquement lectures + actions admin déjà supportées par API | — |
| UX (régression) | 4/5 | C'est *l'objet* du PRD : la moindre confusion paiement = perte de confiance | Wireframes / specs écran + revue PO (Kyria) en Design — **pas de designer MVP** (Q8 CTO) ; **zero confusion finance** = principe UX dur |
| Performance | 3/5 | Listes longues admin (mismatches, missions, users) — virtualisation + pagination | EXPLAIN ANALYZE des routes admin appelées (déjà keyset paging PRD-004) |
| Disponibilité | 2/5 | Surfaces dégradent gracieusement (offline mobile partiel) | Plan d'erreur UI typé par feature |

### 3.5 Modules touchés (Discover-level)

> Aucune modification réelle en Discover. Liste prévisionnelle des modules qui seront impactés en Design/Build.

- ☐ `apps/mobile/**` — création complète features Client + Prestataire
- ☐ `apps/admin/**` — bootstrap Vite + premières pages
- ☐ `apps/api/src/modules/users/**` — quelques endpoints admin read-only à compléter (P2 search, mission filter — à confirmer en §9)
- ☐ `apps/api/src/modules/missions/**` — endpoint *audit timeline* (lecture seule, agrégation) — à confirmer en §9
- ☐ `apps/api/src/modules/notifications/**` — endpoint topic subscription FCM (existant ?) — **hors MVP 005A/005B**, cadré en PRD-005C (Q3 CTO)
- ☐ `packages/shared-types` — DTOs réutilisés mobile + admin
- ☐ `docs/api/PRD-003-openapi.yaml` ou nouveau fichier OpenAPI dédié admin

> ✅ **Aucune modification backend** dans la phase Discover. Les endpoints manquants sont **inventoriés** en §9, pas codés.

---

## 4. Flows critiques (vue Discover, à détailler en Design par sous-PRD)

> Notation : chaque flow liste les écrans clés + les **points de friction connus** identifiés en Discover.

### 4.1 Flow Client — Signup → 1ʳᵉ mission validée

```
Signup ──► Login ──► Onboarding rôle (Client / Both)
       │
       └► Tab "Recherche" ──► Adresse ──► Catégorie nettoyage ──► Date/heure
              │
              └► Récap mission ──► Stripe SetupIntent (CB) ──► Confirmation
                    │
                    └► État "Proposée" ──► Rafraîchissement / badge in-app "Acceptée" ──► État "En cours"
                          │
                          └► Photos AVANT visibles ──► État "Terminée" ──► Photos APRÈS visibles
                                │
                                └► CTA "Valider maintenant" (libère séquestre avant T+48h ouvrées si client le souhaite) OU "Contester"
                                      │
                                      └► Historique
```

> **Arbitrage CTO Q14** : le bouton **« Valider maintenant »** (validation manuelle **avant** l’auto-release T+48h ouvrées) est **confirmé** — visible sur l’écran de détail mission terminée (secondaire visuellement par rapport à l’information « séquestre / auto-validation »), libellé clair, jamais ambigu avec « payer à nouveau ».

**Points de friction Discover** :
- 🟡 *Choix d'adresse* : autocomplete (API ? Mapbox ? Adresse.gouv.fr ?) → à trancher en Design 005A
- 🟡 *Estimation prix* : affichage panier à l'écran avant CB → format `(durée × tarif horaire) + supplément urgence + 18 % commission` → décision Discover : on affiche **prix TTC client** sans détailler la commission (commission visible uniquement côté prestataire)
- 🔴 *Séquestre* : message d'éducation explicite (« Votre paiement est mis en attente et libéré uniquement après votre validation ») — à co-écrire avec un copywriter
- 🟡 *Photos visibles* : rafraîchissement via **TanStack Query** (polling / focus) — **pas de push FCM en MVP** (Q3 CTO) ; push en PRD-005C
- 🟡 *Bouton "Contester"* : doit être moins visible que "Valider" pour ne pas inciter (UX principle §5)

### 4.2 Flow Prestataire — Signup → 1ʳᵉ mission encaissée

```
Signup ──► Login ──► Onboarding rôle (Prestataire / Both)
       │
       └► KYC : Stripe Connect Express link ──► Redirection externe ──► Callback succès/échec
              │
              └► Statut "En attente justificatifs" / "Actif"
                    │
                    └► Tab "Tableau de bord" ──► Toggle disponibilité (sans GPS continu — Q15 CTO) ──► Rafraîchissement liste « missions proches »
                          │
                          └► Détail mission (distance, prix, durée) ──► CTA "Accepter" ──► Navigation
                                │
                                └► Arrivée sur place ──► Photos AVANT (caméra guidée)
                                      │
                                      └► Bouton "Démarrer" ──► Compteur temps
                                            │
                                            └► Photos APRÈS ──► Bouton "Clôturer"
                                                  │
                                                  └► État "En séquestre" ──► (T+48h ouvrées max) ──► État "Payé"
```

**Points de friction Discover** :
- 🔴 *Stripe Connect Express link* : abandon massif possible — préparer page "Pourquoi cette étape" + recovery email (PRD-007 ?)
- 🟢 *Toggle disponibilité* : **pas de tracking GPS continu en MVP** (Q15 CTO) — toggle binaire ; géoloc capturée à l’**acceptation** de mission et pendant la **navigation** vers le lieu (flux ponctuels), pas de watchPosition en arrière-plan.
- 🟡 *Photos AVANT obligatoires* : règle dure backend (cahier §2 + PRD-003) → UI doit empêcher "Démarrer" sans photos AVANT sync ou en queue offline
- 🔴 *Mode offline* : déjà cadré par PRD-003 — l'UI doit *signaler* clairement (banner "Mode hors-ligne — votre mission peut démarrer, photos en attente d'envoi") sans bloquer le travail
- 🟡 *Suivi paiement* : différencier visuellement *En séquestre* (orange ?) vs *Payé* (vert) — terminologie utilisateur à valider

### 4.3 Flow Admin — Dispute → Résolution

```
Notification "Nouvelle dispute" ──► Page Disputes (queue) ──► Sélection dispute
       │
       └► Vue dossier complet :
            • Mission (timeline, photos AVANT/APRÈS, géoloc)
            • Paiement (PaymentIntent, transferts en attente, refunds éventuels)
            • Audit timeline (events horodatés : created → captured → transferred → ...)
            • Échanges précédents (notes admin internes)
            │
            └► Actions :
                 a) "Libérer au prestataire" (split possible : 100 % / 50 % / 0 %)
                 b) "Refund client" (intégral / partiel — formulaire montant)
                 c) "Demander info supplémentaire" (note interne + email auto)
                 d) "Ajourner" (snooze 24h)
                   │
                   └► Trace audit + notification client + notification prestataire
```

**Points de friction Discover** :
- 🔴 *Aucune action destructive sans confirmation* (double clic + tape texte "REFUND 87,50€" pour valider) — UX principle "destructive actions"
- 🔴 *Lecture seule des PII Stripe* : pas de full card / pas de full IBAN visible ; uniquement `***1234` truncated
- 🟡 *Audit timeline* : nécessite un endpoint backend agrégé — voir §9 (à confirmer Design)
- 🟡 *Notes admin* : nouvelle table `dispute_notes` ? renvoyé en PRD-006 (Disputes complet)

### 4.4 Flow Admin — DLQ replay BullMQ

```
Tab "DLQ" ──► Liste jobs morts (filtre par queue / âge / cause)
       │
       └► Détail job : payload (sanitized), stacktrace, retries précédents
              │
              └► Actions :
                   a) "Rejouer" (re-enqueue avec `attemptsMade = 0`)
                   b) "Ack" (marquer comme traité manuellement, audit)
                   c) "Voir payload brut" (RBAC `ADMIN_OPS_PLUS` uniquement, audit logged)
```

**Points de friction Discover** :
- 🔴 *Payload brut* : peut contenir des PII Stripe (event objects) — accès soumis à audit log + sign DPO
- 🟡 Backend route admin DLQ déjà partielle PRD-004 Ticket 4.2 — vérifier exhaustivité en Design

### 4.5 Flow Admin — Finance Monitoring

```
Tab "Finance Monitoring" ──► Vue d'ensemble
       │
       ├► Cartes :
       │    • Open mismatches P1 / P2 (count + lien)
       │    • Dernier reconcile run (état + heure)
       │    • Daily report J-1 (balance, healthy?)
       │
       ├► Bouton "Lancer reconcile manuel" (rate-limited côté API — FIN-MANUAL-RATELIMIT)
       │
       └► Liens out vers Grafana (dashboards officiels) + Stripe Dashboard read-only
```

**Points de friction Discover** :
- 🟢 Backend déjà prêt PRD-004 Ticket 4.5 (`FF=true` post-Verify)
- 🟡 La console admin ne *duplique* pas Grafana — elle expose un **résumé + actions** ; les graphes restent dans Grafana

---

## 5. UX Principles — règles dures Sprint 5

> Ces principes sont *non négociables*. Chaque design doit les respecter ou justifier explicitement la dérogation.

### 5.1 Mobile-first absolu
Toutes les decisions UX partent du téléphone d'un livreur sous la pluie avec une connexion 3G. Si ça marche dans ce cas, ça marche partout.

### 5.2 Boring UX > flashy UX
**Zero animation décorative**. Animations uniquement fonctionnelles (transition d'état, feedback action, skeleton loader). Pas de Lottie, pas de parallax, pas de splash flashy.

### 5.3 Zero confusion finance
Toute information monétaire respecte 4 règles :
1. **Toujours en euros TTC** côté client (la commission n'est jamais mentionnée à l'utilisateur final)
2. **Toujours en euros TTC + détail commission** côté prestataire
3. **États paiement nommés clairement** : *En attente* / *En séquestre* / *Payé* / *Remboursé* / *Contesté* — pas de jargon Stripe
4. **Jamais deux montants conflictuels** sur le même écran ; ne pas afficher "À recevoir" et "Reçu" pour la même mission

### 5.4 Explicit statuses
Chaque mission a **un** statut visible à tout moment (badge + texte). Les statuts utilisateur sont **simplifiés** par rapport aux états techniques DB :

| État DB technique | Libellé utilisateur Client | Libellé utilisateur Prestataire |
|---|---|---|
| `PROPOSED` | "Recherche prestataire" | "Nouvelle mission" |
| `ACCEPTED` | "Prestataire trouvé" | "Mission acceptée" |
| `IN_PROGRESS` | "En cours" | "En cours" |
| `COMPLETED_PENDING_VALIDATION` | "À valider" | "Terminée — en attente client" |
| `VALIDATED` | "Validée — paiement envoyé" | "Validée — paiement en chemin" |
| `AUTO_RELEASED` | "Validée auto (T+48h)" | "Payée (auto-validation)" |
| `DISPUTED` | "En litige" | "En litige" |
| `CANCELLED` | "Annulée" | "Annulée" |

### 5.5 Optimistic UI limitée
- ✅ Optimistic OK pour : toggle disponibilité prestataire, note interne admin, ack DLQ
- ❌ Optimistic INTERDIT pour : création de mission, validation, contestation, refund, lancement reconcile manuel

Toute action finance / création / modification d'état mission = **attendre confirmation serveur** avec spinner + feedback explicite.

### 5.6 Skeleton loaders > spinners
Pour toute liste / détail / écran avec données serveur : afficher un **skeleton** qui respecte la structure finale (pas un spinner centré).

### 5.7 Offline tolerance minimale
- ✅ Mode offline supporté **uniquement** sur :
  - Photos AVANT/APRÈS (queue MMKV, sync background — hérité PRD-003)
  - Démarrage de mission acceptée
  - Lecture du détail de mission déjà cachée par TanStack Query
- ❌ Offline INTERDIT pour : signup, login, KYC Stripe, paiement, validation, contestation, toute action admin

Tout écran offline doit afficher un **banner persistant** (« Vous êtes hors-ligne — certaines actions sont indisponibles »).

### 5.8 Accessibilité (WCAG AA minimum)
- Tap targets ≥ 44 × 44 pt (iOS), 48 × 48 dp (Android)
- Contraste texte/fond ≥ 4.5:1 (AA)
- Tous les boutons ont un label `accessibilityLabel`
- Tous les inputs ont un label visible (pas de placeholder-as-label)
- Compatible VoiceOver / TalkBack happy path
- Aucune dépendance à la seule couleur pour transmettre l'information (pas "rouge = erreur" sans texte)

### 5.9 Error clarity
Chaque erreur affichée à l'utilisateur respecte :
1. **Un titre court** ("Paiement refusé")
2. **Une cause humaine** ("Votre banque a refusé la transaction.")
3. **Une action proposée** ("Essayez une autre carte ou contactez votre banque.")
4. **Un identifiant traçable** ("Code erreur : `STRIPE_DECLINED_INSUFFICIENT_FUNDS`") — en bas, gris, pour le support

Jamais : *"An unknown error has occurred"*. Jamais de stacktrace utilisateur. Jamais d'`Internal Server Error` brut.

### 5.10 Destructive actions
Toute action destructive (refund, suspendre user, ack DLQ, supprimer compte) :
- Confirmation modale obligatoire
- Texte de confirmation **dans la phrase d'action** (« Cette action remboursera **87,50 €** au client et est **irréversible**. »)
- Saisie texte de confirmation pour les montants > 200 € ou suppression de compte
- Audit log systématique côté backend

### 5.11 Principes MVP Produit

> **Synthèse exécutive** — alignement CTO Discover closure. Ces principes priment sur toute tentation de « feature creep » avant stabilisation Sprint 4.

| Principe | Signification opérationnelle |
|---|---|
| **Boring UX > fancy UX** | Pas d’animations décoratives, pas de micro-interactions « wow » ; lisibilité et prévisibilité avant tout (cf. §5.2). |
| **Stabilité > innovation** | Pas de WebSocket, pas de realtime, pas d’IA matching tant que le cœur mission/paiement n’est pas irréprochable en prod. |
| **Simplicité > exhaustivité** | Moins d’écrans bien faits que de demi-fonctionnalités ; parcours linéaires, CTA uniques par intention. |
| **Polling > realtime** | TanStack Query `refetchInterval` / focus refetch / pull-to-refresh ; pas de socket MVP (Q2 CTO). |
| **Explicit states** | Un statut mission + un statut paiement lisibles partout (cf. §5.4). |
| **Finance clarity** | Zéro jargon Stripe côté utilisateur ; TTC client ; commission visible prestataire uniquement (§5.3, Q13). |
| **Low operational complexity** | Admin derrière VPN ; pas d’infra push/analytics supplémentaire en MVP 005A/005B. |
| **Fast iteration** | Petites PRs reviewables ; feature flags si besoin ; pas de big-bang release sans rollback documenté. |
| **Observability-first** | Sentry + métriques existantes ; toute régression doit être visible avant que l’utilisateur ne tweete. |

### 5.12 Frontend Non-Goals MVP (005A / 005B)

> Liste **exhaustive des exclusions** pour les livrables Mobile Core + Admin Tooling tant que PRD-005C n’est pas ouvert.

- ❌ **Chat temps réel** in-app (client ↔ prestataire)
- ❌ **WebSocket** ou connexion longue durée quelconque
- ❌ **Live tracking** / suivi GPS continu du prestataire (Q15 CTO — capture ponctuelle à l’acceptation / navigation mission uniquement)
- ❌ **Offline complexe** au-delà de photos + lecture cache + démarrage mission (cf. §5.7)
- ❌ **Animations lourdes** (Lottie, parallax, splash cinématique)
- ❌ **Marketplace avancée** (multi-offres, enchères, scoring prestataire)
- ❌ **IA / matching intelligent** (renvoyé backlog V2 / PRD-005D)
- ❌ **Gamification** (badges, streaks, leaderboards)
- ❌ **SDK analytics tiers** (PostHog, Mixpanel, etc.) — Q9 CTO → post-MVP / PRD-005D
- ❌ **Copywriter / designer externes** — Q8/Q10 CTO : **copy et wireframes assurés en interne** (équipe + PO) pour MVP

---

## 6. Design System — fondations Discover

> Les tokens **précis** (hex codes complets, palette étendue, échelle typographique) sont rédigés en Design phase. Ci-dessous : décisions Discover.

### 6.1 Fondations actées (cahier v1.4 §1)

| Token | Valeur |
|---|---|
| Primary green | `#22c55e` (Tailwind `green-500`) |
| Background base | `#FFFFFF` |
| Surface neutral | gris très clair (`#F9FAFB` ou équivalent — à figer Design) |
| Border radius cards | 16-20 px |
| Style général | épuré, beaucoup de blanc, **sans dégradé** |
| Typographie | Inter (fallback system font) |
| Icônes | Lucide ou Heroicons, monoligne |

### 6.2 Palette sémantique cible (à figer en Design)

| Sémantique | Usage |
|---|---|
| `success` (vert primary) | mission validée, paiement reçu, KYC OK |
| `warning` (orange) | en séquestre, en attente validation, KYC en cours |
| `danger` (rouge) | litige ouvert, paiement refusé, action destructive |
| `info` (bleu) | tooltips, notes admin, messages système |
| `neutral` (gris) | actions secondaires, métadonnées |

### 6.3 Composants atomiques à figer (Design 005A/B)

- **Button** : primary / secondary / destructive / ghost — chaque variante avec état `disabled`, `loading`, `pressed`
- **Badge / Pill** : pour les statuts mission, paiement, KYC
- **Card** : container par défaut pour mission, paiement, user (radius 16-20 px, ombre légère, padding cohérent)
- **Input + Field** : avec label visible, helper text, error state explicite
- **Modal / BottomSheet** : confirmation, actions destructives, photos
- **Banner** : offline, info compte, KYC en attente
- **EmptyState** : illustration sobre + CTA (jamais vide)
- **Skeleton** : pour list / detail / card
- **Toast** : succès / erreur — non bloquant, auto-dismiss 4-5 s
- **Avatar** : initiales par défaut (pas de photo profil MVP)

### 6.4 Composition mission card

Discover-level decision : la **mission card** est le composant central de l'app. Elle apparaît :
- Liste missions client
- Liste interventions prestataire
- Liste admin disputes / payments / etc.

→ **Une seule implémentation source** avec props variant (`client | prestataire | admin`), pas trois cards différentes.

### 6.5 Design System library — décision Discover

**Recommandation Discover** :
- **Mobile** : composants **maison** sur NativeWind, pas de lib externe (React Native Paper, Tamagui, NativeBase) → contrôle total, pas de couches non maîtrisées, cohérent avec UX principle "boring"
- **Admin** : **shadcn/ui** (recopier-coller dans repo, pas npm package) → 0 lock-in, customisable, Tailwind natif

> Alternative non retenue (à argumenter en §8.2 si rouverture) : React Native Paper sur mobile — *trop opiniâtre*, design Material qui jure avec sobriété cahier.

---

## 7. Priorisation MVP — Découpage en sous-PRDs

> Priorités **proposées en Discover**, à valider par CTO avant Design.

### 7.1 Matrice de priorité

| Priorité | Sous-PRD | Périmètre | Justification |
|---|---|---|---|
| **P0** | `PRD-005A — Mobile Core UX` | Flow Client (S1-S4) + Flow Prestataire (S5-S8) end-to-end — **sans push FCM, sans WebSocket, sans analytics SDK** | Sans ça, *aucun* utilisateur réel possible. Cœur produit. |
| **P1** | `PRD-005B — Admin Tooling UX` | Disputes (lecture + actions), DLQ, Payments, Finance Monitoring (intégration PRD-004) — **accès VPN/internal** | Sans ça, l'équipe Ops ne peut pas traiter un seul incident sans `psql`. Bloquant production. |
| **P2** | `PRD-005C — Realtime + Notifications` | **Push FCM** topic-based, badges in-app, chat client↔prestataire **basique** (statuts + notes courtes), notifications email transactionnelles, **éventuellement** WebSocket si justifié post-MVP | Tout le **temps réel** et la **notification proactive** sont reportés ici (Q2 + Q3 CTO). |
| **P3** | `PRD-005D — Growth & Onboarding optimization` | **SDK analytics** typés, dashboards conversion, recovery KYC avancée, in-app messaging, A/B testing infra | Q9 CTO : analytics **post-MVP** ; optimisation après preuve de traction. |

### 7.2 P0 — `PRD-005A` (Mobile Core UX)

**Doit livrer** : un utilisateur peut s'inscrire, créer une mission, payer, suivre, valider — un prestataire peut s'inscrire, KYC, accepter, exécuter, encaisser.

**T-shirt size** : `L`
**Dépendances backend** : ✅ Toutes existantes (PRD-001/002/003)
**Dépendances UX** : **pas de designer MVP** (Q8 CTO) — wireframes légers (Whimsical / Excalidraw / Figma minimal) + specs écran + revue **Product Owner (Kyria)** avant Build ; tests utilisateurs informels possibles en recette.

### 7.3 P1 — `PRD-005B` (Admin Tooling UX)

**Doit livrer** : console admin Vite déployable **derrière VPN/internal**, pages disputes / payments / DLQ / finance-monitoring, RBAC strict.

**T-shirt size** : `M`
**Dépendances backend** : 2-3 endpoints admin à compléter (cf. §9) — **à confirmer Discover next iter**.
**Dépendances UX** : wireframes **densité forte** (tables, filtres) — **pas de designer dédié** ; pair design dev + PO (Kyria).

### 7.4 P2 — `PRD-005C` (Realtime + Notifications)

**Doit livrer** : push FCM topic-based, notifications email transactionnelles via SendGrid/Postmark, chat basique async, badges in-app — **première itération où le temps réel / push est autorisé** (Q2 + Q3 CTO).

**T-shirt size** : `M`
**Dépendances backend** : module `notifications` (exhaustivité à valider en Design 005C) + endpoints messages / topics FCM

### 7.5 P3 — `PRD-005D` (Growth & Onboarding optimization)

**Doit livrer** : **SDK analytics** (choix DPO-safe en Design), dashboards conversion, recovery KYC avancée, in-app messaging, A/B testing infra.

**T-shirt size** : `S`
**Dépendances backend** : instrumentation events (schéma à figer en Design 005D) — **post-MVP** (Q9 CTO)

### 7.6 Recommandation d'enchaînement Sprint 5+

```
Sprint 5  ───► PRD-005A (Mobile Core UX)           ←  P0  — bloquant
                  │
Sprint 6  ───► PRD-005B (Admin Tooling UX)          ←  P1  — peut chevaucher fin S5
                  │
Sprint 7  ───► PRD-005C (Realtime + Notifications)  ←  P2
                  │
Sprint 8+ ───► PRD-005D (Growth)                    ←  P3
```

> *Décision finale enchaînement = CTO, en sortie Discover.*

---

## 8. Dépendances backend (Inventaire Discover — non normatif)

> Ce §8 est l'**inventaire** de ce qui existe / manque côté API. Aucun endpoint codé en Discover. Les manques sont confirmés/affinés en Design 005A/B.

### 8.1 Endpoints **existants** réutilisables (état actuel sur `main`)

| Méthode | Route | Origine | Statut |
|---|---|---|---|
| `POST` | `/auth/signup` | PRD-001 | ✅ |
| `POST` | `/auth/login` | PRD-001 | ✅ |
| `POST` | `/auth/refresh` | PRD-001 | ✅ |
| `POST` | `/auth/logout` | PRD-001 | ✅ |
| `GET` | `/users/me` | PRD-001 | ✅ |
| `POST` | `/missions` | PRD-002 | ✅ |
| `GET` | `/missions` | PRD-002 | ✅ |
| `GET` | `/missions/:id` | PRD-002 | ✅ |
| `POST` | `/missions/:id/accept` | PRD-002 | ✅ |
| `POST` | `/missions/:id/start` | PRD-003 | ✅ |
| `POST` | `/missions/:id/complete` | PRD-003 | ✅ |
| `POST` | `/missions/:id/photos` | PRD-003 (UUID v4 client idempotency) | ✅ |
| `POST` | `/payments/intent` | PRD-003 | ✅ |
| `POST` | `/payments/:id/capture` | PRD-003 | ✅ |
| `POST` | `/payments/:id/refund` | PRD-003 (admin) | ✅ |
| `POST` | `/webhooks/stripe` | PRD-003 + PRD-004 | ✅ |
| `GET` | `/admin/dlq/*` | PRD-004 Ticket 4.2 | ✅ partiel |
| `GET` | `/admin/finance/mismatches` | PRD-004 Ticket 4.5 | ✅ |
| `POST` | `/admin/finance/reconcile/manual` | PRD-004 Ticket 4.5 (rate-limited) | ✅ |
| `GET` | `/admin/finance/daily-reports` | PRD-004 Ticket 4.5 | ✅ |

> Source : OpenAPI `docs/api/PRD-003-openapi.yaml` + modules `apps/api/src/modules/finance/**` + admin routes existantes.

### 8.2 Endpoints **manquants ou à confirmer** (à valider Design 005A/B)

| Méthode | Route proposée | Pour | Statut Discover |
|---|---|---|---|
| `GET` | `/users/me/role` (ou enrichir `/users/me`) | Mobile RoleGuard (renvoyer `CLIENT | PRESTATAIRE | BOTH` + flag KYC) | À confirmer |
| `PATCH` | `/users/me/active-role` | Bascule mode pour user `BOTH` | À confirmer (peut être uniquement client-side MMKV) |
| `POST` | `/users/me/stripe-connect-link` | Onboarding KYC prestataire (génère AccountLink Stripe) | À vérifier (probablement déjà existant côté PRD-003 — confirmer) |
| `GET` | `/users/me/stripe-connect-status` | KYC status (charges_enabled, details_submitted) | À confirmer |
| `GET` | `/missions/proposed-nearby` (prestataire) | Liste missions proches PostGIS pour prestataire actif | À confirmer (route existe ou à exposer ?) |
| `POST` | `/missions/:id/dispute` (client) | Ouvrir un litige | **Renvoyé PRD-006 Disputes** (out of scope MVP 005) |
| `POST` | `/missions/:id/validate` (client) | Validation manuelle pré-T+48h | À vérifier dans PRD-003 |
| `GET` | `/missions/:id/audit-timeline` | Vue admin agrégée events mission | **À créer** (lecture seule, agrégation events DB existants) |
| `GET` | `/admin/users` (search by email/name/phone) | Console admin / Support | À créer ou à confirmer |
| `GET` | `/admin/users/:id` (with redacted PII) | Console admin / Support | À créer |
| `POST` | `/admin/users/:id/suspend` | Action admin | À créer |
| `GET` | `/admin/transfers` (paginated) | Console payments | À confirmer (peut-être Stripe Dashboard suffit MVP) |
| `GET` | `/admin/refunds` (paginated) | Console payments | À confirmer |
| `POST` | `/notifications/push/subscribe` | FCM topic subscribe par device | **Renvoyé PRD-005C** |
| `GET` | `/admin/dispute-queue` | Queue disputes | **Renvoyé PRD-006** |

### 8.3 WebSocket / realtime

**Arbitrage CTO Q2 (DISCOVER_DONE)** : **pas de WebSocket** en MVP `PRD-005A` / `PRD-005B`. Polling TanStack Query (`refetchInterval`, focus refetch, pull-to-refresh) + invalidation explicite après mutations. **WebSocket / realtime** = périmètre **PRD-005C** uniquement, et seulement si un besoin métier le justifie après usage terrain.

### 8.4 APIs à stabiliser

- `POST /payments/intent` : confirmer que la réponse contient bien tout ce que le mobile a besoin pour Stripe SDK iOS/Android (`ephemeral_key`, `customer_id`, `client_secret`) — à valider 005A
- `POST /missions/:id/photos` : vérifier limites payload, headers `Idempotency-Key`/UUID, format réponse — déjà OK PRD-003 mais re-tester sur 4G dégradée

---

## 9. Risks

### 9.1 UX risks

| # | Risk | Sévérité | Mitigation Discover |
|---|---|:-:|---|
| UX-1 | Confusion paiement (client ne comprend pas le séquestre) | 🔴 | Copy explicit + tooltip + page éducation onboarding |
| UX-2 | Double-tap actions critiques (refund, validation) | 🔴 | Disable button on press + idempotency-key côté front + modal de confirmation |
| UX-3 | Photos AVANT non synchronisées au démarrage mission | 🟡 | UI offline banner clair + queue MMKV existante (PRD-003) + retry visible |
| UX-4 | Échec upload photo lors prestation | 🟡 | Retry transparent + fallback "Réessayer plus tard" sans bloquer clôture |
| UX-5 | Navigation profonde > 3 niveaux | 🟡 | expo-router stack rule : max 3 niveaux ; admin = 2 max |
| UX-6 | Friction onboarding KYC Stripe → abandon prestataire | 🔴 | Page « Pourquoi cette étape » + **copy interne** (Q10 CTO — pas de copywriter MVP) ; recovery avancée + push **en PRD-005C** (Q3) |

### 9.2 Tech risks

| # | Risk | Sévérité | Mitigation Discover |
|---|---|:-:|---|
| T-1 | Expo bundle size & performance sur Android low-end | 🟡 | Hermes ON, lazy-load features non critiques, perf budget en Design |
| T-2 | Sync photo offline = consommation batterie / data élevée | 🟡 | Backoff exponentiel, sync uniquement WiFi optionnel (toggle prestataire) |
| T-3 | TanStack Query cache key collision multi-rôle BOTH | 🟡 | Préfixer cache keys par rôle actif (`['mode:client', ...]` / `['mode:presta', ...]`) |
| T-4 | RBAC frontend bypassable (admin) | 🟢 | Frontend ne fait jamais autorité — backend RBAC déjà strict (PRD-004 audit) |
| T-5 | Image upload reliability sur 3G | 🟡 | Compression 1600 px JPEG q75 (existant PRD-003) + chunked upload si > 500 KB |
| T-6 | State consistency entre notification push et écran ouvert | 🟢 | **MVP sans push** (Q3) : `invalidateQueries` sur focus / polling ; push + handler natif = **005C** |
| T-7 | Memory leaks listes longues (admin) | 🟡 | TanStack Table + virtualisation (TanStack Virtual) |
| T-8 | Différence iOS/Android comportement SecureStore | 🟢 | Déjà éprouvé PRD-001 |

### 9.3 Process risks

| # | Risk | Sévérité | Mitigation Discover |
|---|---|:-:|---|
| P-1 | Sprint 5 Build démarre avant fin Verify opérationnel PRD-004 | 🔴 | Gates §12.2 : **Sprint 4 clos**, `FF=true` prod stable, observation validée, rollback testé, sign-offs DPO+CTO ; **Build interdit** tant que non cochés |
| P-2 | Design dérive en Build (composants non figés) | 🟡 | Design 005A doit livrer wireframes + spec composants + plan tests (pas d’exigence Figma lourd — Q8) |
| P-3 | Pas de designer dédié | 🟢 | **Résolu Q8 CTO** : pas de designer MVP — wireframes légers + revue PO |
| P-4 | Build commence sans copywriter | 🟢 | **Résolu Q10 CTO** : copy **interne** MVP ; affiner en PRD-005D si besoin |

---

## 10. Open Questions CTO — **toutes résolues** (clôture Discover 2026-05-13)

> **DISCOVER_DONE** : les 15 questions sont **`RESOLVED`**. Le passage en **Design 005A** reste **bloqué** par les gates §12.2 (Sprint 4 + prod + sign-offs), pas par des questions ouvertes.

| # | Question | Statut | Décision finale | Rationale | Impacts |
|---:|---|---|---|---|---|
| **Q1** | Mono-app vs apps séparées ? | ✅ **RESOLVED** | **Mono-app** (cahier v1.4 §2) | Décision structurante déjà actée | Un binaire, RoleGuard, code partagé |
| **Q2** | Realtime / WebSocket MVP ? | ✅ **RESOLVED** | **Realtime uniquement en PRD-005C** | Stabilité > innovation ; réduit complexité ops et états concurrents | 005A/005B : **polling TanStack Query** uniquement (cf. §8.3) |
| **Q3** | Push notifications MVP ? | ✅ **RESOLVED** | **Push uniquement en PRD-005C** | Aligné Q2 ; évite dépendance FCM + handlers natifs avant UX core stable | 005A : pas d’`expo-notifications` métier ; 005C : FCM + topics |
| **Q4** | Admin Web exposition ? | ✅ **RESOLVED** | **VPN / réseau interne MVP** | Surface d’attaque minimale ; acceptable pour équipe restreinte | Ingress / Zero Trust / doc accès ; friction support assumée |
| **Q5** | DS mobile ? | ✅ **RESOLVED** | **NativeWind + composants maison** | Contrôle total, alignement cahier « boring » | Pas de Paper / Tamagui |
| **Q6** | Offline ? | ✅ **RESOLVED** | **Photos + démarrage mission + cache lecture** (§5.7) | Inchangé | Pas d’élargissement offline MVP |
| **Q7** | Admin UI lib ? | ✅ **RESOLVED** | **shadcn/ui** | Déjà recommandé Discover ; arbitrage CTO confirme | Stack admin homogène |
| **Q8** | Designer MVP ? | ✅ **RESOLVED** | **Pas de designer MVP** | Coût / délai ; MVP fonctionnel avant polish | Wireframes légers + specs + revue **PO (Kyria)** |
| **Q9** | Analytics SDK ? | ✅ **RESOLVED** | **Post-MVP → PRD-005D** | Simplicité ; évite DPO/third-party avant traction | Pas d’instrumentation analytics produit en 005A/005B |
| **Q10** | Copywriter MVP ? | ✅ **RESOLVED** | **Pas de copywriter MVP** | Aligné Q8 ; itération rapide | Copy **interne** ; revue PO |
| **Q11** | Renumérotation PRD Disputes / Notif ? | ✅ **RESOLVED** | Disputes → **PRD-006**, Notif avancées → **PRD-007** | Cohérence index | Cf. `docs/prd/README.md` |
| **Q12** | Owner produit / validation Design ? | ✅ **RESOLVED** | **Product Owner = Kyria** | Gouvernance claire | Kyria valide wireframes, specs, copy MVP avant Build |
| **Q13** | Commission visible client ? | ✅ **RESOLVED** | **Prestataire seul** ; client TTC | Évite confusion tarifaire | Inchangé §5.3 |
| **Q14** | Validation manuelle avant T+48h ? | ✅ **RESOLVED** | **Confirmée** — CTA « Valider maintenant » visible (secondaire) | Contrôle utilisateur ; réduit attente perçue | Flow §4.1 ; copy à soigner en Design |
| **Q15** | GPS continu si disponible ? | ✅ **RESOLVED** | **Pas de tracking GPS continu MVP** | RGPD + batterie + complexité | Géoloc **ponctuelle** : acceptation mission, navigation vers lieu |

---

## 11. Roadmap Sprint 5+ — sous-PRDs prévus

> Découpage proposé en Discover. Chaque sous-PRD aura son **propre cycle BMAD complet**.

| Sous-PRD | Sprint cible | Périmètre | Dépendances |
|---|---|---|---|
| **`PRD-005A — Mobile Core UX`** | S5 | Flow Client (S1-S4) + Flow Prestataire (S5-S8) end-to-end, mobile uniquement — **sans push, sans designer MVP** | PRD-004 `DONE` + gates §12.2 + wireframes/specs validés PO |
| **`PRD-005B — Admin Tooling UX`** | S5 (parallèle) ou S6 | Console Vite admin **VPN/internal** : disputes (lecture), DLQ, payments, finance-monitoring | PRD-005A en cours OK (équipes différentes mobile/admin) + infra VPN documentée |
| **`PRD-005C — Realtime + Notifications`** | S6 ou S7 | Push FCM différencié, badges, chat basique, emails transactionnels | PRD-005A `DONE` |
| **`PRD-005D — Growth & Onboarding optimization`** | S7+ | Analytics fin, recovery KYC, in-app messaging, A/B testing | PRD-005A `DONE` + observability mature |
| **`PRD-006 — Disputes & Litiges`** (renumérotation ex-PRD-005) | S6 ou S7 | Process complet client / prestataire / admin / arbitrage / split paiement | PRD-005A + PRD-005B `DONE` |
| **`PRD-007 — Notifications avancées + reporting`** (renumérotation ex-PRD-006) | S8+ | Reporting client/prestataire, alertes intelligentes, hebdo email | PRD-005C + PRD-005D `DONE` |

---

## 12. Phase DESIGN — **non ouverte** (gates §12.2)

> `DISCOVER_DONE` **ne signifie pas** que le Design a commencé. Aucun livrable Design (wireframes détaillés, contrats UI, Zod, OpenAPI delta) n’est produit tant que les **gates §12.2** ne sont pas tous cochés et signés.

### 12.1 Definition of Done — Discover (**clôturé**)

- [x] PRD instancié avec ID, slug, statut `DISCOVER_DONE` (v0.2)
- [x] Lien explicite vers cahier v1.4 (§1, §2, §3, §10, §11)
- [x] ≥ 1 user story par persona (12 stories rédigées §2)
- [x] Risk assessment renseigné (§3.4 + §9)
- [x] Métriques de succès quantifiables (§1.3)
- [x] Out of scope listé (§1.4)
- [x] Open questions **toutes** `RESOLVED` (§10 — 15/15)
- [x] T-shirt size estimé (`XL` global, découpage en sous-PRDs)
- [x] **Principes MVP Produit** + **Frontend Non-Goals MVP** documentés (§5.11, §5.12)
- [x] **Gates avant Design 005A** + **Interdiction de Build prématuré** documentés (§12.2, §12.3)
- [x] **Owner produit** nommé : **Kyria** (Q12)
- [x] **Arbitrages CTO** intégrés au PRD (2026-05-13)

> ✍️ **Discover clôturé** : arbitrages CTO documentés §10 — **signature humaine CTO** attendue sur la PR de merge (trace GitHub / sign-off interne).

### 12.2 Gates avant Design 005A

> **Conditions obligatoires** — toutes doivent être **satisfaites et traçables** avant d’ouvrir officiellement le document de Design `PRD-005A` (branche `design/prd-005a-*`, maquettes légères, contrats).

| # | Gate | Preuve attendue |
|---:|---|---|
| G1 | **Sprint 4 officiellement clos** | PRD-004 en statut `DONE` (ou équivalent documenté équipe) + pas de dette Critical ouverte sans plan |
| G2 | **`FF_FINANCE_MONITORING_ENABLED=true` stable en production** | Rapport ops / Grafana / absence d’incident P0 finance sur fenêtre définie |
| G3 | **Runtime observation validée** | Rapport [`operational-72h-final-report-rec-*.md`](../security-reviews/operational-72h-final-report.md) complété — verdict **STABLE** ou **Go prod éligible** |
| G4 | **Rollback testé** | Exercice ou incident documenté : `FF=false` + redémarrage + stabilité — durée cible **< 2 min** (cf. runbooks PRD-004) |
| G5 | **DPO sign-off Sprint 4** | Trace écrite (email / outil interne) référencée dans le dossier release |
| G6 | **CTO sign-off Sprint 4** | Idem — aligné Go/No-Go prod PRD-004 |

> Tant qu’**une seule** ligne du tableau est non cochée → **Design 005A interdit** ; seule la poursuite Discover/ops (sans code front) est permise.

### 12.3 Interdiction de Build prématuré

> **Règle dure** — non négociable tant que **Design 005A** n’est pas officiellement ouvert **et** que les gates §12.2 ne sont pas remplis.

- **Interdit** : tout commit `feat(*)` (ou équivalent fonctionnel) touchant `apps/mobile/**` ou `apps/admin/**`.
- **Interdit** : tout scaffold d’écran, composant UI, route Expo, page Vite, hors branche **explicitement** `design/prd-005a-*` **après** ouverture Design constatée en réunion.
- **Toléré** sur `main` / branches hors scope 005A : docs, scripts, config **sans** impact runtime front (cf. BMAD).

**Sanction** : `revert` immédiat + post-mortem léger si violation.

---

## 13. Phase BUILD — Strictement interdite

> **Rappel** : même avec `DISCOVER_DONE`, le **Build frontend** reste **interdit** jusqu’aux gates §12.2 + ouverture Design 005A + `DESIGN_DONE` 005A. Voir **§12.3**.

Référence ops amont : PRD-004 Verify / [`finance-monitoring-go-no-go-prod.md`](../runbooks/finance-monitoring-go-no-go-prod.md).

---

## 14. Annexes

### 14.1 Refusés / alternatives non retenues

| Alternative | Pourquoi non retenue |
|---|---|
| App Client + App Prestataire séparées | Décision cahier v1.4 §2 : mono-app pour maintenance, releases, code partagé |
| React Native Paper (Material) | Design Material jure avec sobriété cahier (blanc + vert sans dégradés) — DS maison |
| Tamagui | Trop de magic compile-time + courbe d'apprentissage ; NativeWind plus simple |
| Material UI admin | Lourd, opiniâtre — shadcn/ui plus customisable |
| Next.js pour admin | Pas besoin de SSR/SSG côté outil interne — Vite plus simple |
| WebSocket / push FCM en MVP 005A/005B | **Interdits** (Q2 + Q3 CTO) — réservés **PRD-005C** ; MVP = polling TanStack Query |
| Multi-langue MVP | Zone de lancement Soissons seulement |
| Chat realtime MVP | Renvoyé PRD-005C |
| Analytics SDK (PostHog, etc.) en MVP 005A/005B | **Interdit** (Q9 CTO) — PRD-005D |
| Admin Web exposé Internet public MVP | **Non retenu** (Q4 CTO) — VPN/internal |

### 14.2 Glossaire

| Terme | Définition |
|---|---|
| **Séquestre** | Période entre capture paiement et transfert prestataire, pendant laquelle les fonds sont retenus chez Stripe |
| **T+48h ouvrées** | Délai d'auto-release après mission complétée si client ne valide pas (jours fériés Europe/Paris exclus) |
| **KYC** | Know Your Customer — vérification identité prestataire via Stripe Connect Express |
| **DLQ** | Dead Letter Queue — file BullMQ des jobs morts après échec retries |
| **RoleGuard** | Composant mobile qui filtre la navigation racine selon le rôle actif de l'utilisateur |
| **Mismatch** | Incohérence financière détectée par le job reconcile (PRD-004 Ticket 4.5) |
| **Optimistic UI** | UI qui anticipe le succès d'une action avant confirmation serveur |

### 14.3 Recherches / benchmarks à mener en Design

- Audit UX apps françaises similaires : *Yoojo*, *AlloVoisins*, *Wecasa*, *MyMoijo* — copy paiement / séquestre / litige
- Stripe Connect Express UX patterns (page d'éducation pré-onboarding)
- Apps livreurs : *Uber Driver*, *Deliveroo*, *Stuart* — onboarding KYC, toggle disponibilité, navigation mission
- Apps cleaning concurrentes : *Tiger*, *Helpling*, *Wecasa* — checklist mission, validation, photos

### 14.4 Documents liés

- [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md) — référence métier
- [BMAD-light](../method/BMAD.md) — méthode delivery
- [PRD-001](PRD-001-auth-jwt.md), [PRD-002](PRD-002-missions-geolocalisation.md), [PRD-003](PRD-003-photos-paiements.md), [PRD-004](PRD-004-hardening-ops-compliance.md) — PRDs amont
- [Index PRD](README.md) — vue d'ensemble

---

## 15. Checklist BMAD globale (à cocher au fil des phases)

- [x] **Discover** : DoD ✅ (§12.1) + arbitrages CTO intégrés — *signature CTO sur PR de merge (trace)*
- [ ] **Design** : par sous-PRD (005A/B/C/D) — **bloqué** gates §12.2
- [ ] **Build** : par sous-PRD — *strictement interdit avant §12.2 + Design 005A ouvert + `DESIGN_DONE` 005A* (§12.3)
- [ ] **Verify** : par sous-PRD
- [ ] PRD archivé, statut `DONE` global, version finale taguée

---

*PRD-005 Clean Connect — **DISCOVER_DONE** v0.2 — créé le 2026-05-13 — clôture Discover (arbitrages CTO) le 2026-05-13 — méthode [BMAD-light](../method/BMAD.md) — cahier [v1.4](../CAHIER-DES-CHARGES-v1.4.md)*
