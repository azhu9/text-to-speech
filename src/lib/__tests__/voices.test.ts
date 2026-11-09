import { describe, expect, it } from 'vitest';
import { defaultVoice, sortVoices } from '../voices';

const v = (name: string, lang = 'en-US', extra: Partial<SpeechSynthesisVoice> = {}) =>
  ({ name, lang, voiceURI: name, default: false, localService: true, ...extra }) as SpeechSynthesisVoice;

describe('voices', () => {
  const mac = [
    v('Albert'),
    v('Bad News'),
    v('Bubbles'),
    v('Eddy (English (US))'),
    v('Fred'),
    v('Samantha', 'en-US', { default: true }),
    v('Daniel', 'en-GB'),
    v('Zarvox'),
    v('Thomas', 'fr-FR'),
  ];

  it('hides novelty voices and ranks natural ones first', () => {
    const names = sortVoices(mac).map((x) => x.name);
    expect(names).not.toContain('Albert');
    expect(names).not.toContain('Bad News');
    expect(names).not.toContain('Zarvox');
    expect(names[0]).toBe('Samantha');
    expect(names.indexOf('Eddy (English (US))')).toBeGreaterThan(names.indexOf('Daniel'));
  });

  it('defaults to a good voice in the user language, never a novelty one', () => {
    expect(defaultVoice(sortVoices(mac), 'en-US')?.name).toBe('Samantha');
    const edge = [v('Microsoft David - English (United States)'), v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', { localService: false })];
    expect(defaultVoice(sortVoices(edge), 'en-US')?.name).toContain('Aria');
    expect(defaultVoice(sortVoices(mac), 'fr-FR')?.name).toBe('Thomas');
  });
});

describe('engineRate', () => {
  it('softens speed only for online Google voices', async () => {
    const { engineRate } = await import('../player');
    const google = v('Google US English', 'en-US', { localService: false });
    const local = v('Samantha');
    expect(engineRate(local, 2)).toBe(2);
    expect(engineRate(google, 1)).toBe(1);
    expect(engineRate(google, 2)).toBeCloseTo(1.35);
    expect(engineRate(google, 4)).toBeLessThanOrEqual(1.8);
    expect(engineRate(google, 0.7)).toBe(0.7);
  });
});
