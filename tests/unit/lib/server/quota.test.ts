// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { db, resetClients } from '$lib/server/clients';
import {
  hashIp,
  quotaDay,
  reserveVisitorRun,
  RUNS_PER_DAY,
  RUNS_PER_IP,
  takeUploadSlot,
  takeVisitorRun,
  UPLOADS_PER_DAY,
  VISITOR_UPLOADS_PER_DAY,
} from '$lib/server/quota';

const VISITOR_IP = '203.0.113.7';
const QUOTA_DOC = 'quota/2026-10-04';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

const NOW = new Date('2026-10-04T18:00:00Z');

const reserveUpload = (visitor: boolean, now?: Date) =>
  db().runTransaction((tx) => takeUploadSlot(tx, visitor, now));

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('SESSION_SECRET', 'secret-a');
  resetStore();
  resetClients();
});

describe('quotaDay', () => {
  it('uses the Pacific calendar day', () => {
    expect(quotaDay(new Date('2026-10-04T06:59:59Z'))).toBe('2026-10-03');
    expect(quotaDay(new Date('2026-10-04T07:00:00Z'))).toBe('2026-10-04');
  });

  it('follows standard time in winter', () => {
    expect(quotaDay(new Date('2026-01-15T07:59:00Z'))).toBe('2026-01-14');
    expect(quotaDay(new Date('2026-01-15T08:00:00Z'))).toBe('2026-01-15');
  });

  it('defaults to now', () => {
    expect(quotaDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('hashIp', () => {
  it('is stable for the same ip and secret', () => {
    expect(hashIp(VISITOR_IP)).toBe(hashIp(VISITOR_IP));
    expect(hashIp(VISITOR_IP)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs per ip', () => {
    expect(hashIp(VISITOR_IP)).not.toBe(hashIp('203.0.113.8'));
  });

  it('is salted by the session secret', () => {
    const a = hashIp(VISITOR_IP);
    vi.stubEnv('SESSION_SECRET', 'secret-b');
    expect(hashIp(VISITOR_IP)).not.toBe(a);
  });

  it('never contains the raw ip', () => {
    expect(hashIp('127001')).not.toContain('127001');
    expect(hashIp('::1')).not.toContain('::1');
  });

  it('throws without a session secret', () => {
    vi.stubEnv('SESSION_SECRET', '');
    expect(() => hashIp('203.0.113.9')).toThrow('SESSION_SECRET');
  });
});

describe('reserveVisitorRun', () => {
  it('counts a run on a fresh day', async () => {
    expect(await reserveVisitorRun('ipA', NOW)).toBeNull();
    expect(store.get(QUOTA_DOC)).toEqual({
      runs: 1,
      ips: { ipA: 1 },
      uploads: 0,
      visitorUploads: 0,
    });
  });

  it(`caps one ip at ${RUNS_PER_IP} runs a day`, async () => {
    for (let i = 0; i < RUNS_PER_IP; i++) expect(await reserveVisitorRun('ipA', NOW)).toBeNull();
    expect(await reserveVisitorRun('ipA', NOW)).toBe(
      '5 runs per visitor per day. Try again tomorrow.',
    );
    expect(await reserveVisitorRun('ipB', NOW)).toBeNull();
    expect(store.get(QUOTA_DOC)).toMatchObject({ runs: 6, ips: { ipA: 5, ipB: 1 } });
  });

  it(`caps all visitors at ${RUNS_PER_DAY} runs a day`, async () => {
    store.set(QUOTA_DOC, {
      runs: RUNS_PER_DAY - 1,
      ips: {},
      uploads: 0,
      visitorUploads: 0,
    });
    expect(await reserveVisitorRun('ipA', NOW)).toBeNull();
    expect(await reserveVisitorRun('ipB', NOW)).toBe(
      "Today's 40 public runs are used up. Try again tomorrow.",
    );
    expect(store.get(QUOTA_DOC)).toMatchObject({ runs: RUNS_PER_DAY });
  });

  it('resets on the next Pacific day', async () => {
    store.set(QUOTA_DOC, { runs: RUNS_PER_DAY, ips: {}, uploads: 0, visitorUploads: 0 });
    expect(await reserveVisitorRun('ipA', new Date('2026-10-05T08:00:00Z'))).toBeNull();
  });
});

describe('takeVisitorRun', () => {
  it("counts a run inside the caller's transaction", async () => {
    expect(await db().runTransaction((tx) => takeVisitorRun(tx, 'ipA', NOW))).toBeNull();
    expect(store.get(QUOTA_DOC)).toMatchObject({ runs: 1, ips: { ipA: 1 } });
  });

  it('names the cap and counts nothing once the visitor is out of runs', async () => {
    store.set(QUOTA_DOC, {
      runs: 5,
      ips: { ipA: RUNS_PER_IP },
      uploads: 0,
      visitorUploads: 0,
    });
    expect(await db().runTransaction((tx) => takeVisitorRun(tx, 'ipA', NOW))).toBe(
      '5 runs per visitor per day. Try again tomorrow.',
    );
    expect(store.get(QUOTA_DOC)).toMatchObject({ runs: 5 });
  });

  it('defaults to today', async () => {
    await db().runTransaction((tx) => takeVisitorRun(tx, 'ipA'));
    expect([...store.keys()]).toEqual([`quota/${quotaDay()}`]);
  });
});

describe('takeUploadSlot', () => {
  it(`gives visitors at most ${VISITOR_UPLOADS_PER_DAY} uploads`, async () => {
    for (let i = 0; i < VISITOR_UPLOADS_PER_DAY; i++)
      expect(await reserveUpload(true, NOW)).toBe(true);
    expect(await reserveUpload(true, NOW)).toBe(false);
    expect(store.get(QUOTA_DOC)).toMatchObject({ uploads: 4, visitorUploads: 4 });
  });

  it('leaves the remaining slots for Nathan, up to the daily total', async () => {
    for (let i = 0; i < VISITOR_UPLOADS_PER_DAY; i++) await reserveUpload(true, NOW);
    expect(await reserveUpload(false, NOW)).toBe(true);
    expect(await reserveUpload(false, NOW)).toBe(true);
    expect(await reserveUpload(false, NOW)).toBe(false);
    expect(store.get(QUOTA_DOC)).toMatchObject({
      uploads: UPLOADS_PER_DAY,
      visitorUploads: VISITOR_UPLOADS_PER_DAY,
    });
  });

  it('lets Nathan use all six when visitors upload nothing', async () => {
    for (let i = 0; i < UPLOADS_PER_DAY; i++) expect(await reserveUpload(false, NOW)).toBe(true);
    expect(await reserveUpload(false, NOW)).toBe(false);
    expect(await reserveUpload(true, NOW)).toBe(false);
    expect(store.get(QUOTA_DOC)).toMatchObject({ uploads: 6, visitorUploads: 0 });
  });

  it('defaults to today', async () => {
    expect(await reserveUpload(false)).toBe(true);
    expect([...store.keys()]).toEqual([`quota/${quotaDay()}`]);
  });
});
