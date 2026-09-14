import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindow, Semaphore, createLimiter, withRetry } from '../src/books/limiter.js';

function fakeClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

test('SlidingWindow: enforces the limit and waits exactly until the oldest call leaves the window', async () => {
  const { clock, sleep } = fakeClock();
  const sleeps = [];
  const wrappedSleep = async (ms) => {
    sleeps.push(ms);
    await sleep(ms);
  };
  const window = new SlidingWindow(2, { clock, sleep: wrappedSleep, windowMs: 1000 });

  await window.take();
  await window.take();
  assert.equal(window.count(), 2);
  assert.equal(sleeps.length, 0, 'first two calls should not wait');

  await window.take();
  assert.equal(sleeps.length, 1, 'third call must wait once for a slot');
  assert.equal(sleeps[0], 1001);
});

test('SlidingWindow: count() evicts entries older than the window', () => {
  const { clock, advance } = fakeClock();
  const window = new SlidingWindow(5, { clock, sleep: async () => {}, windowMs: 1000 });
  return (async () => {
    await window.take();
    advance(1500);
    assert.equal(window.count(), 0);
  })();
});

test('Semaphore: caps concurrency and releases waiters in order', async () => {
  const sem = new Semaphore(2);
  const release1 = await sem.acquire();
  const release2 = await sem.acquire();

  let thirdAcquired = false;
  const pending = sem.acquire().then((release) => {
    thirdAcquired = true;
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(thirdAcquired, false, 'third acquire must block while 2 are held');

  release1();
  const release3 = await pending;
  assert.equal(thirdAcquired, true);

  release2();
  release3();
});

test('createLimiter: stats() reports calls-in-window and in-flight counts', async () => {
  const { clock, sleep } = fakeClock();
  const limiter = createLimiter({ ratePerMinute: 5, maxConcurrency: 1, clock, sleep, windowMs: 60_000 });

  let statsDuringCall;
  await limiter.schedule(async () => {
    statsDuringCall = limiter.stats();
  });

  assert.equal(statsDuringCall.inFlight, 1);
  const after = limiter.stats();
  assert.equal(after.inFlight, 0);
  assert.equal(after.callsInWindow, 1);
  assert.equal(after.limit, 5);
  assert.equal(after.maxConcurrency, 1);
});

test('createLimiter: bounds concurrency across concurrent schedule() calls', async () => {
  const { clock, sleep } = fakeClock();
  const limiter = createLimiter({ ratePerMinute: 100, maxConcurrency: 2, clock, sleep, windowMs: 60_000 });

  let concurrent = 0;
  let maxConcurrentSeen = 0;
  const task = () =>
    limiter.schedule(async () => {
      concurrent += 1;
      maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 15));
      concurrent -= 1;
    });

  await Promise.all([task(), task(), task(), task()]);
  assert.equal(maxConcurrentSeen <= 2, true, `expected max 2 concurrent, saw ${maxConcurrentSeen}`);
});

test('withRetry: grows backoff exponentially with full jitter, bounded by the cap', async () => {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  const randomSeq = [0.9, 0.9, 0.9];
  let i = 0;
  const random = () => randomSeq[i++];

  const err = Object.assign(new Error('retryable'), { classification: { class: 'RETRYABLE' } });
  await assert.rejects(
    withRetry(async () => ({ classification: { class: 'RETRYABLE' }, error: err }), {
      maxAttempts: 4,
      baseMs: 100,
      maxMs: 10_000,
      sleep,
      random,
    }),
    (e) => e === err,
  );

  // caps: attempt1->100, attempt2->200, attempt3->400; floor(0.9 * cap)
  assert.deepEqual(delays, [90, 180, 360]);
});

test('withRetry: backoff is capped at maxMs', async () => {
  const delays = [];
  const sleep = async (ms) => delays.push(ms);
  const random = () => 1; // just under the cap (floor(1 * cap) === cap)

  const err = Object.assign(new Error('retryable'), { classification: { class: 'RETRYABLE' } });
  await assert.rejects(
    withRetry(async () => ({ classification: { class: 'RETRYABLE' }, error: err }), {
      maxAttempts: 6,
      baseMs: 1000,
      maxMs: 3000,
      sleep,
      random,
    }),
    (e) => e === err,
  );

  for (const d of delays) assert.ok(d <= 3000, `delay ${d} exceeded maxMs`);
  assert.equal(delays[delays.length - 1], 3000, 'later attempts should saturate at maxMs');
});

test('withRetry: honours retry_after_ms for RATE_LIMIT, ignoring jittered backoff', async () => {
  const delays = [];
  const sleep = async (ms) => delays.push(ms);
  let calls = 0;

  const value = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        return { classification: { class: 'RATE_LIMIT', retry_after_ms: 2500 }, error: new Error('rate limited') };
      }
      return { classification: { class: 'SUCCESS' }, value: 'done' };
    },
    { maxAttempts: 3, baseMs: 100, sleep, random: () => 0.5 },
  );

  assert.equal(value, 'done');
  assert.deepEqual(delays, [2500]);
});

test('withRetry: honourRetryAfter=false falls back to jittered backoff even for RATE_LIMIT', async () => {
  const delays = [];
  const sleep = async (ms) => delays.push(ms);
  let calls = 0;

  await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        return { classification: { class: 'RATE_LIMIT', retry_after_ms: 9999 }, error: new Error('rate limited') };
      }
      return { classification: { class: 'SUCCESS' }, value: 'done' };
    },
    { maxAttempts: 3, baseMs: 100, sleep, random: () => 0.5, honourRetryAfter: false },
  );

  assert.notEqual(delays[0], 9999);
  assert.equal(delays[0], 50); // floor(0.5 * 100)
});

test('withRetry: retries RATE_LIMIT and RETRYABLE, then succeeds', async () => {
  const outcomes = ['RATE_LIMIT', 'RETRYABLE', 'SUCCESS'];
  let i = 0;
  const value = await withRetry(
    async () => {
      const cls = outcomes[i++];
      if (cls === 'SUCCESS') return { classification: { class: 'SUCCESS' }, value: 42 };
      return { classification: { class: cls }, error: new Error(cls) };
    },
    { maxAttempts: 5, baseMs: 10, sleep: async () => {}, random: () => 0 },
  );
  assert.equal(value, 42);
  assert.equal(i, 3);
});

for (const cls of ['UNKNOWN', 'AUTH', 'NON_RETRYABLE']) {
  test(`withRetry: never retries ${cls}, even with attempts remaining`, async () => {
    let calls = 0;
    const err = Object.assign(new Error(cls), { classification: { class: cls } });
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          return { classification: { class: cls }, error: err };
        },
        { maxAttempts: 5, sleep: async () => { throw new Error('must not sleep/retry'); } },
      ),
      (e) => e === err,
    );
    assert.equal(calls, 1, `${cls} must fail after exactly one attempt`);
  });
}

test('withRetry: stops retrying once maxAttempts is exhausted', async () => {
  let calls = 0;
  const err = Object.assign(new Error('retryable'), { classification: { class: 'RETRYABLE' } });
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        return { classification: { class: 'RETRYABLE' }, error: err };
      },
      { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
    ),
    (e) => e === err,
  );
  assert.equal(calls, 3);
});
