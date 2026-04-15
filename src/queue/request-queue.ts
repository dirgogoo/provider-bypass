import PQueue from 'p-queue';

export function createRequestQueue(concurrency: number): InstanceType<typeof PQueue> {
  return new PQueue({ concurrency });
}

export function getQueueStats(queue: InstanceType<typeof PQueue>, concurrency: number) {
  return {
    concurrency,
    pending: queue.pending,
    active: queue.size,
    idle: queue.pending === 0 && queue.size === 0,
  };
}
