import { TransferRetryQueueProducer } from './transfer-retry.queue'
import { TRANSFER_RETRY_BACKOFF_MS, buildTransferRetryBullJobId } from './transfer.constants'

interface QueueAddCall {
  jobName: string
  payload: unknown
  opts: { jobId: string; delay: number; attempts: number; removeOnComplete: unknown; removeOnFail: unknown }
}

function makeProducer(): { producer: TransferRetryQueueProducer; calls: QueueAddCall[]; addImpl: jest.Mock } {
  const calls: QueueAddCall[] = []
  const addImpl = jest.fn(async (jobName: string, payload: unknown, opts: QueueAddCall['opts']) => {
    calls.push({ jobName, payload, opts })
    return { id: opts.jobId }
  })
  const queue = { add: addImpl } as unknown as ConstructorParameters<typeof TransferRetryQueueProducer>[0]
  // ProducerService takes the queue via @InjectQueue → on injecte direct via constructor.
  const producer = new TransferRetryQueueProducer(queue)
  return { producer, calls, addImpl }
}

describe('TransferRetryQueueProducer.computeDelayMs', () => {
  it('returns the 1st backoff palier (~5 min) for attempt=1, with jitter ± 10%', () => {
    const { producer } = makeProducer()
    const samples: number[] = []
    for (let i = 0; i < 100; i += 1) {
      samples.push(producer.computeDelayMs(1))
    }
    const base = TRANSFER_RETRY_BACKOFF_MS[0] as number
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(Math.round(base * 0.9))
      expect(v).toBeLessThanOrEqual(Math.round(base * 1.1))
    }
  })

  it('clamps attempt > 5 to the last backoff palier (~24h)', () => {
    const { producer } = makeProducer()
    const v = producer.computeDelayMs(10)
    const last = TRANSFER_RETRY_BACKOFF_MS[TRANSFER_RETRY_BACKOFF_MS.length - 1] as number
    expect(v).toBeGreaterThanOrEqual(Math.round(last * 0.9))
    expect(v).toBeLessThanOrEqual(Math.round(last * 1.1))
  })

  it('handles attempt=0 by floor-clamping to palier 0', () => {
    const { producer } = makeProducer()
    const v = producer.computeDelayMs(0)
    const base = TRANSFER_RETRY_BACKOFF_MS[0] as number
    expect(v).toBeGreaterThanOrEqual(Math.round(base * 0.9))
  })
})

describe('TransferRetryQueueProducer.enqueue', () => {
  it('posts a delayed job with deterministic jobId and attempts=1', async () => {
    const { producer, calls } = makeProducer()
    await producer.enqueue({ transferId: 'a'.repeat(36), attempt: 2 })
    expect(calls).toHaveLength(1)
    const expectedJobId = buildTransferRetryBullJobId('a'.repeat(36), 2)
    expect(calls[0]!.opts.jobId).toBe(expectedJobId)
    expect(calls[0]!.opts.attempts).toBe(1)
    expect(calls[0]!.opts.delay).toBeGreaterThan(0)
  })

  it('payload contains transferId + attempt only — no PII', async () => {
    const { producer, calls } = makeProducer()
    await producer.enqueue({ transferId: 'b'.repeat(36), attempt: 1 })
    const payload = calls[0]!.payload as Record<string, unknown>
    // Trace context field is added by injectTraceContext (optional, no PII).
    const allowedKeys = new Set(['transferId', 'attempt', '_otel'])
    for (const k of Object.keys(payload)) {
      expect(allowedKeys.has(k)).toBe(true)
    }
    expect(payload.transferId).toBe('b'.repeat(36))
    expect(payload.attempt).toBe(1)
  })

  it('swallows queue.add errors (never throws)', async () => {
    const { producer, addImpl } = makeProducer()
    addImpl.mockRejectedValueOnce(new Error('redis_down'))
    await expect(producer.enqueue({ transferId: 'c'.repeat(36), attempt: 1 })).resolves.toBeUndefined()
  })
})
