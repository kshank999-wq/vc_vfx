import { it } from 'vitest';
import { STUDIO_SCENE, renderScene, renderEquirect } from '../lighting/synthetic';
import { analyseLighting } from '../lighting/analyse';
const LUMA: [number, number, number] = [0.2722, 0.6741, 0.0537];
it('analyse', () => {
  const sc = { ...STUDIO_SCENE, width: 320, height: 180, samples: 14 };
  const shot = renderScene(sc);
  for (const pitch of [sc.pitchDeg, null]) {
    const out = analyseLighting({ frame: shot.image, frameNumber: 1001, frames: [1001], luma: LUMA, gamut: 'ap1', subject: { matte: shot.matte, source: 'sample' }, sky: null,
      camera: { focalMm: 35, focalSource: 'metadata', filmBackMm: { width: 36, height: 20.25 }, filmBackSource: 'handoff', pitchDeg: pitch, rollDeg: pitch === null ? null : 0, k1: null, k1Source: null, iris: 'T2.8', focusDistance: null, subjectDistanceM: 3, subjectDistanceSource: 'setting' },
      ground: { heightM: 1.5, source: 'assumed' }, whiteBalance: { kelvin: 5600, source: 'metadata' }, revision: 0,
      references: { chrome: [], grey: [], hdri: { id: 'h', image: renderEquirect(sc, 256, 20), headingDeg: 20 } } });
    console.log('pitch', pitch, 'match', out.analysis.matchScore, 'ground', JSON.stringify(out.analysis.ground), out.model ? 'model' : 'nomodel');
  }
});
