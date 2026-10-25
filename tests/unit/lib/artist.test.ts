import { describe, expect, it } from 'vitest';
import { BANDCAMP_ERROR, parseArtist } from '#lib/artist.js';

const valid = { name: 'Test Artist', bandcampUrl: '', contactLine: '' };
const errorsOf = (patch: Record<string, unknown>) => {
  const result = parseArtist({ ...valid, ...patch });
  return 'errors' in result ? result.errors : {};
};

describe('parseArtist', () => {
  it('accepts a full profile', () => {
    expect(
      parseArtist({
        name: 'Test Artist',
        bandcampUrl: 'https://test-artist.bandcamp.com',
        contactLine: 'Booking: test@example.com',
      }),
    ).toEqual({
      value: {
        name: 'Test Artist',
        bandcampUrl: 'https://test-artist.bandcamp.com',
        contactLine: 'Booking: test@example.com',
      },
    });
  });

  it('stores empty optional fields as null', () => {
    expect(parseArtist(valid)).toEqual({
      value: { name: 'Test Artist', bandcampUrl: null, contactLine: null },
    });
  });

  it('trims every field', () => {
    expect(
      parseArtist({
        name: '  Test Artist ',
        bandcampUrl: ' https://x.bandcamp.com ',
        contactLine: '  Booking: a@b.co ',
      }),
    ).toEqual({
      value: {
        name: 'Test Artist',
        bandcampUrl: 'https://x.bandcamp.com',
        contactLine: 'Booking: a@b.co',
      },
    });
  });

  it.each([null, 'text', 42, []])('treats a non-object body (%j) as an empty form', (body) => {
    expect(parseArtist(body)).toEqual({ errors: { name: 'Add the artist name.' } });
  });

  it('ignores fields that are not strings', () => {
    expect(errorsOf({ name: 7 })).toEqual({ name: 'Add the artist name.' });
    expect(parseArtist({ ...valid, bandcampUrl: 5, contactLine: {} })).toEqual({
      value: { name: 'Test Artist', bandcampUrl: null, contactLine: null },
    });
  });

  describe('name', () => {
    it('requires one', () => {
      expect(errorsOf({ name: '   ' })).toEqual({ name: 'Add the artist name.' });
    });

    it('takes 100 characters and refuses 101', () => {
      expect(errorsOf({ name: 'a'.repeat(100) })).toEqual({});
      expect(errorsOf({ name: 'a'.repeat(101) })).toEqual({
        name: 'Artist names are at most 100 characters.',
      });
    });

    it.each(['<b>', 'a > b'])('refuses angle brackets in %j', (name) => {
      expect(errorsOf({ name })).toEqual({ name: "Artist names can't contain < or >." });
    });

    it('refuses a comma, which would split the tag', () => {
      expect(errorsOf({ name: 'A, B' })).toEqual({ name: "Artist names can't contain commas." });
    });

    it('refuses a leading # but accepts one inside', () => {
      expect(errorsOf({ name: '#band' })).toEqual({ name: "Artist names can't start with #." });
      expect(errorsOf({ name: 'Band #1' })).toEqual({});
    });
  });

  describe('Bandcamp URL', () => {
    it('normalizes case and a trailing slash to the bare origin', () => {
      expect(parseArtist({ ...valid, bandcampUrl: 'https://Name.Bandcamp.com/' })).toMatchObject({
        value: { bandcampUrl: 'https://name.bandcamp.com' },
      });
    });

    it.each([
      'http://name.bandcamp.com',
      'javascript:alert(1)',
      'https://user:pw@name.bandcamp.com',
      'https://name.bandcamp.com:8443',
      'https://name.bandcamp.com/album/x',
      'https://name.bandcamp.com/?a=1',
      'https://name.bandcamp.com/#top',
      'https://bandcamp.com',
      'https://name.bandcamp.com.evil.com',
      'https://-name.bandcamp.com',
      'https://music.example.com',
      'not a url',
    ])('refuses %s', (bandcampUrl) => {
      expect(errorsOf({ bandcampUrl })).toEqual({ bandcampUrl: BANDCAMP_ERROR });
    });

    it('says what address it wants', () => {
      expect(BANDCAMP_ERROR).toBe('Use your https://<name>.bandcamp.com address.');
    });
  });

  describe('contact line', () => {
    it('takes 200 characters and refuses 201', () => {
      expect(errorsOf({ contactLine: 'a'.repeat(200) })).toEqual({});
      expect(errorsOf({ contactLine: 'a'.repeat(201) })).toEqual({
        contactLine: 'Contact lines are at most 200 characters.',
      });
    });

    it.each(['<a@b.co>', 'x > y'])('refuses angle brackets in %j', (contactLine) => {
      expect(errorsOf({ contactLine })).toEqual({
        contactLine: "Contact lines can't contain < or >.",
      });
    });

    it.each(['DM #myband', '#booking a@b.co'])('refuses a # anywhere, as in %j', (contactLine) => {
      expect(errorsOf({ contactLine })).toEqual({ contactLine: "Contact lines can't contain #." });
    });
  });

  it('reports every bad field at once', () => {
    expect(errorsOf({ name: '', bandcampUrl: 'http://x', contactLine: 'DM #x' })).toEqual({
      name: 'Add the artist name.',
      bandcampUrl: BANDCAMP_ERROR,
      contactLine: "Contact lines can't contain #.",
    });
  });
});
