# ADR-001 — Stratégie Expo Managed Hybride

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-001` |
| **Titre** | Stratégie Expo Managed Hybride (Expo Go en dev → Dev Client + EAS Build en prod) |
| **Statut** | `Accepted` |
| **Date** | 2026-05-11 |
| **Auteur** | CTO Clean Connect |
| **PRD lié** | `N/A` (décision d'infra mobile, transverse) |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

Le cahier des charges v1.4 spécifie **Expo SDK 51+** pour l'application mobile unique (Client + Prestataire) et liste plusieurs dépendances **natives** :

- **MMKV** pour la file de sync offline (cité 4× dans le cahier et la rule `mobile`)
- **Detox** pour les tests E2E du Happy Path
- **Sentry RN natif** pour symbolication crash
- **Firebase SDK natif** pour FCM (topics avancés)

Or **Expo Go** (l'application qui permet de tester sur smartphone sans build natif) **ne supporte que les packages du SDK Expo standard**. Tout module natif tiers est exclu.

Le CTO veut :
- Tester l'app directement sur son iPhone via Expo Go **pendant la phase de développement** (vélocité, pas de Mac requis, OTA updates)
- Déployer sur App Store et Google Play en production

Ces deux contraintes sont compatibles avec Expo, mais nécessitent un **chemin de bascule** clairement documenté.

---

## 2. Décision

On adopte une **stratégie hybride en 3 phases** :

### Phase Dev (Sprint 0.2 → Sprint 0.4 inclus)

- Workflow **Expo managed pur** (`expo start` + Expo Go sur iPhone du CTO)
- File de sync offline : `@react-native-async-storage/async-storage` à la place de MMKV
- Tests E2E : **manuels** (Detox reporté)
- Crash reporting : `sentry-expo` (JS uniquement, pas de symbolication native complète)
- Push : `expo-notifications` (suffisant pour topics `user:<id>`)

### Phase Pré-MVP (Sprint 0.5+, dès qu'un besoin natif est confirmé)

- `expo prebuild` → génère les dossiers `ios/` et `android/` natifs versionnés
- Bascule vers **Expo dev client** custom (installé une fois sur iPhone via TestFlight ou Android via APK)
- Activation de **MMKV** (JSI, perf 10–30× supérieure à AsyncStorage)
- Activation de **Detox** pour le Happy Path Login → Photo → Validation
- Activation de **Sentry natif** + **FCM SDK natif** si besoin

### Phase Prod (Soissons + déploiement App Store / Play Store)

- **EAS Build** (cloud Expo) génère les binaires `.ipa` (iOS) et `.aab` (Android)
- **EAS Submit** envoie sur App Store Connect / Google Play Console
- **Pas de Mac requis** côté équipe : tout le build natif iOS se fait dans le cloud Expo
- OTA updates restent disponibles via EAS Update pour les correctifs JS rapides

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **A — Expo managed pur (Expo Go uniquement, jamais de prebuild)** | Casse le cahier v1.4 : pas de MMKV, pas de Detox, perf offline dégradée durablement. Acceptable pour un proto, pas pour une plateforme financière (séquestre). |
| **B — Expo prebuild + dev client dès le bootstrap** | Plus complexe au Sprint 0.2 (gestion ios/android/ versionnés, premier build dev client à installer). Pénalise la vélocité initiale alors qu'on n'a pas encore besoin des natifs. Le CTO ne peut pas tester via Expo Go (besoin d'installer un dev client custom). |
| **C — Bare React Native (sans Expo)** | Perte complète de l'écosystème Expo (expo-router, expo-image, expo-notifications, expo-file-system, EAS Build/Update). Réinvente la roue. Aucun bénéfice vs Expo prebuild. |
| **D — Capacitor / Flutter / KMP** | Hors stack v1.4. Aucune raison de dévier. |

---

## 4. Conséquences

### Positives
- **Time-to-test minimal** : le CTO scanne un QR code et l'app tourne sur son iPhone en 60 secondes
- **Aucune dépendance Mac** sur toute la chaîne (dev + build prod via EAS)
- **Roadmap claire** : on sait exactement quand basculer (premier besoin de MMKV / Detox / Sentry natif)
- **Réversibilité** : `expo prebuild` est non destructif, on peut revenir en managed si besoin

### Négatives / coûts assumés
- **Perf offline dégradée** en Phase Dev (AsyncStorage ~10-30× plus lent que MMKV). **Acceptable** car la file de sync reste petite (< 100 entrées en pratique).
- **Pas de tests Detox automatisés** avant Sprint 0.5. **Compensé** par : tests d'intégration Jest backend exhaustifs (Payment / Escrow / Matching) + manual QA en recette.
- **Sentry partiel** : crashes natifs iOS/Android non symbolicés en Phase Dev. **Acceptable** car peu de natif custom à ce stade.
- **`expo prebuild` ajoutera de la complexité** au Sprint 0.5 (versionner `ios/`, `android/`, gérer les podfiles). À documenter dans une ADR-XXX dédiée au moment de la bascule.

### Neutres (à surveiller)
- Compatibilité packages : vérifier que toutes les libs choisies au Sprint 0.2 sont compatibles **et** managed **et** dev client (cf. https://reactnative.directory/ filtre Expo Go)
- Quota EAS Build gratuit : 30 builds/mois suffisant pour MVP, à monitorer

---

## 5. Suivi

- [x] Mise à jour de `CLAUDE.md` (mention stratégie Expo Hybride) — fait Sprint 0.2
- [x] Mise à jour de la rule `mobile` pour autoriser AsyncStorage en Phase Dev — fait Sprint 0.2
- [ ] ADR-XXX à créer **quand** on basculera en dev client (date prévue : Sprint 0.5)
- [ ] Câbler EAS Build dans CI au Sprint 0.4

---

## 6. Références

- Cahier v1.4 : `docs/CAHIER-DES-CHARGES-v1.4.md` §2 (Application Unique) + §6 (Stack Mobile)
- Doc Expo : https://docs.expo.dev/develop/development-builds/introduction/
- Doc EAS Build : https://docs.expo.dev/build/introduction/
- MMKV vs AsyncStorage benchmarks : https://github.com/mrousavy/react-native-mmkv#benchmarks
- ADRs liées : ADR-002 (montants en centimes), ADR-003 (PostGIS via Unsupported)

---

*ADR Clean Connect — décidée Sprint 0.2 (11 mai 2026)*
