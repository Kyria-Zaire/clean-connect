---
name: offline-sync-pattern
description: Implement the offline-first photo sync pattern for the Clean Connect mobile app (Expo) — UUID v4 idempotency, MMKV queue, compression (1600px JPEG 75), expo-background-fetch with exponential backoff retry, and backend signed URL upload to Cloudinary. Use when the user asks to implement offline sync, photo upload, background sync, mode hors-connexion, or anything around uploading photos from the prestataire app.
---

# Pattern sync offline — Clean Connect mobile

> Référence : cahier des charges v1.3 §4.2 (Mode Hors-Connexion).

## Principes

```
1. UUID v4 généré côté client = clé d'idempotence backend
2. Compression AVANT stockage local (1600 px max, JPEG 75)
3. File MMKV (rapide, persistante) — pas SQLite pour ce volume
4. Sync background via expo-background-fetch + expo-task-manager
5. Retry exponentiel (5 s, 30 s, 2 min, 10 min, 1 h — max 5 tentatives)
6. Upload direct mobile → Cloudinary via signed URL (le backend ne transite jamais le binaire)
7. Démarrage de mission autorisé avec photos non sync, libération séquestre conditionnée
```

## Étape 1 — Capture & compression

```typescript
// apps/mobile/src/lib/photos/capture.ts
import * as FileSystem from 'expo-file-system'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import * as Crypto from 'expo-crypto'

export interface CapturedPhoto {
  uuid: string
  localUri: string
  missionId: string
  phase: 'BEFORE' | 'AFTER'
  createdAt: number
}

export async function captureAndStore(
  sourceUri: string,
  missionId: string,
  phase: 'BEFORE' | 'AFTER',
): Promise<CapturedPhoto> {
  const compressed = await manipulateAsync(
    sourceUri,
    [{ resize: { width: 1600 } }],
    { compress: 0.75, format: SaveFormat.JPEG },
  )

  const uuid = Crypto.randomUUID()
  const dir = `${FileSystem.documentDirectory}photos/`
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true })
  const localUri = `${dir}${uuid}.jpg`
  await FileSystem.moveAsync({ from: compressed.uri, to: localUri })

  return { uuid, localUri, missionId, phase, createdAt: Date.now() }
}
```

## Étape 2 — File MMKV

```typescript
// apps/mobile/src/lib/sync/queue.ts
import { MMKV } from 'react-native-mmkv'

export interface SyncQueueItem {
  uuid: string
  localUri: string
  missionId: string
  phase: 'BEFORE' | 'AFTER'
  attempts: number
  lastAttemptAt: number | null
  status: 'PENDING' | 'UPLOADING' | 'FAILED'
  error?: string
}

const storage = new MMKV({ id: 'photo-sync-queue' })
const KEY = 'queue'

export function readQueue(): SyncQueueItem[] {
  const raw = storage.getString(KEY)
  return raw ? JSON.parse(raw) : []
}

function writeQueue(items: SyncQueueItem[]) {
  storage.set(KEY, JSON.stringify(items))
}

export function enqueue(photo: { uuid: string; localUri: string; missionId: string; phase: 'BEFORE' | 'AFTER' }) {
  const queue = readQueue()
  if (queue.some(i => i.uuid === photo.uuid)) return   // déjà en queue (idempotent)
  queue.push({ ...photo, attempts: 0, lastAttemptAt: null, status: 'PENDING' })
  writeQueue(queue)
}

export function updateItem(uuid: string, patch: Partial<SyncQueueItem>) {
  const queue = readQueue()
  const idx = queue.findIndex(i => i.uuid === uuid)
  if (idx < 0) return
  queue[idx] = { ...queue[idx], ...patch }
  writeQueue(queue)
}

export function removeItem(uuid: string) {
  writeQueue(readQueue().filter(i => i.uuid !== uuid))
}
```

## Étape 3 — Sync engine avec retry exponentiel

```typescript
// apps/mobile/src/lib/sync/engine.ts
import * as FileSystem from 'expo-file-system'
import { readQueue, updateItem, removeItem } from './queue'
import { apiClient } from '../api/client'

const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000]   // 5s, 30s, 2m, 10m, 1h
const MAX_ATTEMPTS = 5

export async function processSyncQueue(): Promise<{ uploaded: number; failed: number }> {
  const items = readQueue()
  let uploaded = 0
  let failed = 0

  for (const item of items) {
    if (item.status === 'UPLOADING') continue
    if (item.attempts >= MAX_ATTEMPTS) continue

    const backoff = BACKOFF_MS[item.attempts] ?? BACKOFF_MS.at(-1)!
    if (item.lastAttemptAt && Date.now() - item.lastAttemptAt < backoff) continue

    updateItem(item.uuid, { status: 'UPLOADING' })

    try {
      await uploadOne(item)
      await FileSystem.deleteAsync(item.localUri, { idempotent: true })
      removeItem(item.uuid)
      uploaded++
    } catch (err) {
      const attempts = item.attempts + 1
      updateItem(item.uuid, {
        status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
        attempts,
        lastAttemptAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      })
      failed++
    }
  }

  return { uploaded, failed }
}

async function uploadOne(item: SyncQueueItem) {
  // 1. Demander la signature au backend (renvoie idempotent: true si déjà connu)
  const signResp = await apiClient.photos.sign({
    uuid: item.uuid,
    missionId: item.missionId,
    phase: item.phase,
  })

  if (signResp.idempotent) return   // serveur l'a déjà reçue → OK

  // 2. Upload direct vers Cloudinary
  const formData = new FormData()
  formData.append('file', { uri: item.localUri, type: 'image/jpeg', name: `${item.uuid}.jpg` } as any)
  formData.append('public_id', signResp.publicId)
  formData.append('timestamp', String(signResp.timestamp))
  formData.append('api_key', signResp.apiKey)
  formData.append('signature', signResp.signature)
  formData.append('folder', signResp.folder)
  formData.append('type', 'private')

  const res = await fetch(`https://api.cloudinary.com/v1_1/${signResp.cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) throw new Error(`Cloudinary upload failed: HTTP ${res.status}`)
}
```

## Étape 4 — Background task

```typescript
// apps/mobile/src/lib/sync/background.ts
import * as BackgroundFetch from 'expo-background-fetch'
import * as TaskManager from 'expo-task-manager'
import { processSyncQueue } from './engine'

export const SYNC_TASK_NAME = 'cleanconnect-photo-sync'

TaskManager.defineTask(SYNC_TASK_NAME, async () => {
  try {
    const { uploaded } = await processSyncQueue()
    return uploaded > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed
  }
})

export async function registerBackgroundSync() {
  await BackgroundFetch.registerTaskAsync(SYNC_TASK_NAME, {
    minimumInterval: 60,        // 1 min minimum entre exécutions
    stopOnTerminate: false,
    startOnBoot: true,
  })
}
```

## Étape 5 — Sync au foreground (quand l'app est active)

```typescript
// apps/mobile/src/lib/sync/foreground.ts
import NetInfo from '@react-native-community/netinfo'
import { processSyncQueue } from './engine'

let timer: ReturnType<typeof setInterval> | null = null
let unsub: (() => void) | null = null

export function startForegroundSync() {
  // Trigger immédiat dès qu'on récupère la connectivité
  unsub = NetInfo.addEventListener(state => {
    if (state.isConnected) processSyncQueue().catch(() => {})
  })

  // Tick périodique 30 s tant que l'app est au premier plan
  timer = setInterval(() => processSyncQueue().catch(() => {}), 30_000)
}

export function stopForegroundSync() {
  if (timer) clearInterval(timer)
  if (unsub) unsub()
  timer = null
  unsub = null
}
```

## Étape 6 — UI : indicateurs visuels

```typescript
// Hook qui expose l'état de la file
export function useSyncQueue() {
  const [queue, setQueue] = useState(readQueue())
  useEffect(() => {
    const id = setInterval(() => setQueue(readQueue()), 2_000)
    return () => clearInterval(id)
  }, [])
  return queue
}
```

Composants UI :
- Badge sur chaque vignette photo : `🟢 synced` / `🟡 pending` / `🔴 failed`
- Header global : « 3 photos en attente de synchronisation »
- Si > 5 min en pending : pictogramme WiFi barré + tooltip explicatif

## Étape 7 — Démarrage de mission avec photos non sync

```typescript
async function startMission(missionId: string) {
  const photosBefore = readQueue().filter(p => p.missionId === missionId && p.phase === 'BEFORE')
  const synced = photosBefore.length === 0   // toutes uploaded

  if (photosBefore.length < 3) {
    throw new Error('Au moins 3 photos AVANT requises')
  }

  if (!synced) {
    showWarning(
      'Photos AVANT en attente de synchronisation. Démarrage autorisé. ' +
      'Le séquestre ne se libérera qu\'après synchronisation complète.',
    )
  }

  await apiClient.missions.start(missionId)
}
```

**Règle dure backend** : le séquestre n'est pas libéré tant que les photos AVANT ne sont pas toutes en statut `UPLOADED` côté serveur (cf `stripe-escrow-flow` étape 4).

## Checklist d'implémentation

- [ ] Compression photos : 1600 px max, JPEG 75 → ~150-300 KB/photo
- [ ] UUID v4 généré côté client (`expo-crypto`)
- [ ] File MMKV (pas SQLite) pour la queue
- [ ] Stockage local des photos dans `documentDirectory/photos/`
- [ ] Photo locale supprimée **après** confirmation upload réussi
- [ ] Retry exponentiel max 5 tentatives : 5 s, 30 s, 2 min, 10 min, 1 h
- [ ] Background task `expo-background-fetch` enregistré au boot de l'app
- [ ] Foreground sync : déclenché sur reconnexion + tick 30 s
- [ ] Upload direct → Cloudinary (le backend signe seulement)
- [ ] Indicateurs UI : pending / synced / failed
- [ ] Démarrage mission autorisé avec photos non sync (UX + règle backend)
- [ ] Status global "X photos en attente" sur écran principal
- [ ] Retry manuel disponible pour les photos en statut `FAILED`

## Anti-patterns

❌ Upload synchronisé bloquant l'UI
❌ AsyncStorage pour la queue (lent, non chiffré, fragmenté)
❌ Photos non compressées en mémoire (crash sur photos 12 MP)
❌ UUID généré côté serveur (perd l'idempotence en cas de retry réseau)
❌ Upload via le backend (transit double bande passante + load)
❌ Suppression de la photo locale avant confirmation serveur (perte en cas de timeout)
❌ Retry sans backoff (charge serveur + batterie mobile)
❌ Bloquer le démarrage de mission tant que sync KO (le presta est sur le terrain)
