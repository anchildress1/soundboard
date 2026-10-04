import type { Sample } from '$lib/types';
import { db } from './clients';

/** 30-second FLR clips under `samples/` in the bucket, each tied to its live video for the diff. */
export async function listSamples(): Promise<Sample[]> {
  const snap = await db().collection('samples').get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Omit<Sample, 'id'>), id: d.id }))
    .sort((a, b) => a.songTitle.localeCompare(b.songTitle));
}

export async function getSample(id: string): Promise<Sample | null> {
  const snap = await db().collection('samples').doc(id).get();
  return snap.exists ? { ...(snap.data() as Omit<Sample, 'id'>), id } : null;
}
