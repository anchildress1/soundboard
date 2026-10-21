// @vitest-environment node
import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { load } from '$routes/connections/+page.server';
import { seed, truncate } from '../../../helpers/db';
import { USER_A, USER_B, USERS } from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
type User = typeof USER_A | typeof USER_B | null;

type Data = {
  youtube: { status: string; channelTitle: string | null } | null;
  notice: string | null;
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
      },
      notice: null,
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

  it('sends a signed-out request home', async () => {
    const error = await run(null).catch((e: unknown) => e);
    expect(isRedirect(error) && error.location).toBe('/');
  });
});
