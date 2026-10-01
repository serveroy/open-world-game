/** URL query parameters for debugging & testing. */
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

export const params = {
  quality: q.get('quality') as 'low' | 'med' | 'high' | null,
  seed: Number(q.get('seed') ?? 1337) | 0,
  debug: q.get('debug') === '1',
  test: q.get('test') === '1',
  mission: q.get('mission'),
  noSave: q.get('nosave') === '1',
  spawn: q.get('spawn'),
  time: q.has('time') ? Number(q.get('time')) : null,
  weather: q.get('weather'),
  autoplay: q.get('autoplay') === '1',
  /** Skip the title screen (tests / screenshots). */
  skipTitle: q.get('play') === '1',
};
