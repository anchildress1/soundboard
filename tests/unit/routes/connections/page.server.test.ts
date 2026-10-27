// @vitest-environment node
import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { load } from '#src/routes/connections/+page.server.js';
import { seed, truncate } from '../../../helpers/db';
import { connections } from '#lib/server/core/schema.js';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/core/db.js';
import { USER_A, USER_B, USERS } from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
type User = typeof USER_A | typeof USER_B | null;

type Data = {
  youtube: { status: string; channelTitle: string | null; analytics: boolean } | null;
  notice: string | null;
  analyticsNotice: string | null;
};

const run = async (user: User, query = '') =>
  (await load({
    locals: { user },
    url: new URL(`http://localhost/connections${query}`),
  } as unknown as Event)) as Data;

const withStatus = (status: 'missing_scopes' | 'no_channel' | 'revoked') =>
  seed({
    connections: [
      {
        uid: USER_B.uid,
        status,
        channelId: status === 'revoked' ? 'UCb' : null,
        channelTitle: status === 'revoked' ? 'B channel' : null,
        scopes: [],
        tokenCiphertext: null,
        updatedAt: new Date(0),
      },
    ],
  });

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('/connections load', () => {
  it("returns the caller's connected channel and its channel ID, without the token", async () => {
    const data = await run(USER_A);
    expect(data).toEqual({
      youtube: {
        status: 'connected',
        channelTitle: 'Flies Like Robots',
        channelId: expect.stringMatching(/^UC/),
        analytics: false,
      },
      notice: null,
      analyticsNotice: null,
    });
    expect(JSON.stringify(data)).not.toContain('e2e-kms');
  });

  it.each(['missing_scopes', 'no_channel', 'revoked'] as const)(
    'returns a %s status',
    async (status) => {
      await withStatus(status);
      expect((await run(USER_B)).youtube?.status).toBe(status);
    },
  );

  it('returns no row for a user who never connected', async () => {
    expect((await run(USER_B)).youtube).toBeNull();
  });

  it.each(['missing_scopes', 'no_channel', 'mismatch', 'wrong-account', 'failed'] as const)(
    'passes the callback outcome %s through',
    async (notice) => {
      expect((await run(USER_A, `?connect=${notice}`)).notice).toBe(notice);
    },
  );

  it.each(['?connect=connected', '?connect=<b>', '?connect=', '?other=mismatch'])(
    'ignores %s',
    async (query) => {
      expect((await run(USER_A, query)).notice).toBeNull();
    },
  );

  describe('analytics', () => {
    const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
    const setScopes = (scopes: string[], status?: 'revoked') =>
      db()
        .update(connections)
        .set({ scopes, ...(status ? { status, tokenCiphertext: null } : {}) })
        .where(eq(connections.uid, USER_A.uid));

    it('is shared once the connected grant holds the Analytics scope', async () => {
      await setScopes(['openid', ANALYTICS]);
      expect((await run(USER_A)).youtube?.analytics).toBe(true);
    });

    it('is not shared on a connection without the scope', async () => {
      expect((await run(USER_A)).youtube?.analytics).toBe(false);
    });

    it('is not shared once the grant is revoked, even if the scope was stored', async () => {
      await setScopes(['openid', ANALYTICS], 'revoked');
      expect((await run(USER_A)).youtube?.analytics).toBe(false);
    });

    it.each(['shared', 'declined'] as const)(
      'passes the callback outcome %s through',
      async (n) => {
        expect((await run(USER_A, `?analytics=${n}`)).analyticsNotice).toBe(n);
      },
    );

    it.each(['?analytics=yes', '?analytics=', '?analytics=<b>'])('ignores %s', async (query) => {
      expect((await run(USER_A, query)).analyticsNotice).toBeNull();
    });
  });

  it('sends a signed-out request home', async () => {
    const error = await run(null).catch((e: unknown) => e);
    expect(isRedirect(error) && error.location).toBe('/');
  });
});
