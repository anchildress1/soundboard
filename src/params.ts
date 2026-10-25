import { defineParams } from '@sveltejs/kit/params';
import type { GuideKind } from '#lib/brand.js';

export const params = defineParams({
  guide: (param): GuideKind | undefined =>
    param === 'voice' || param === 'brand' ? param : undefined,
});
