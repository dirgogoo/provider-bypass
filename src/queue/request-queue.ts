import PQueue from 'p-queue';

export function createRequestQueue(concurrency: number): InstanceType<typeof PQueue> {
  return new PQueue({ concurrency });
}

export function getQueueStats(queue: InstanceType<typeof PQueue>, concurrency: number) {
  return {
    concurrency,
    pending: queue.size,      // waiting items
    active: queue.pending,    // currently executing
    idle: queue.size === 0 && queue.pending === 0,
  };
}
