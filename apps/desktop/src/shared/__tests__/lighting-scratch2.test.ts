import { it } from 'vitest';
import { STUDIO_SCENE, renderScene, renderChromeBall, renderGreyBall, renderEquirect } from '../lighting/synthetic';
import { analyseLighting } from '../lighting/analyse';
const LUMA: [number, number, number] = [0.2722, 0.6741, 0.0537];
it('analyse', () => {
  const sc = { ...STUDIO_SCENE, width: 320, height: 180, samples: 16 };
  const shot = renderScene(sc);
  const base = { frame: shot.image, frameNumber: 1001, frames: [1001], luma: LUMA, gamut: 'ap1' as const, subject: { matte: shot.matte, source: 'sample' as const }, sky: null,
    camera: { focalMm: 35, focalSource: 'metadata' as const, filmBackMm: { width: 36, height: 20.25 }, filmBackSource: 'handoff' as const, pitchDeg: sc.pitchDeg, rollDeg: 0, k1: null, k1Source: null, iris: null, focusDistance: null, subjectDistanceM: 4, subjectDistanceSource: 'sample' as const },
    ground: { heightM: sc.cameraHeightM, source: 'sample' as const }, whiteBalance: { kelvin: 5600, source: 'metadata' as const }, revision: 0 };
  for (const refs of [{ chrome: [], grey: [], hdri: null }, { chrome: [{ id: 'chrome1', ...renderChromeBall(sc), inPlate: false }], grey: [{ id: 'grey1', ...renderGreyBall(sc), inPlate: false }], hdri: null }, { chrome: [], grey: [], hdri: { id: 'hdri1', image: renderEquirect(sc, 512, 30), headingDeg: 30 } }]) {
    const t = Date.now();
    const out = analyseLighting({ ...base, references: refs as never });
    console.log('ANALYSIS ms', Date.now() - t, 'conf', out.analysis.keyConfidence, 'match', out.analysis.matchScore);
    for (const l of out.analysis.lights) console.log(' ', l.id, l.role, l.type, 'az', l.azimuth.value.toFixed(1), `[${l.azimuth.low.toFixed(1)},${l.azimuth.high.toFixed(1)}]`, 'el', l.elevation.value.toFixed(1), `[${l.elevation.low.toFixed(1)},${l.elevation.high.toFixed(1)}]`, 'st', l.intensity.value.toFixed(2), `[${l.intensity.low.toFixed(2)},${l.intensity.high.toFixed(2)}]`, 'size', l.size?.value.toFixed(1), `[${l.size?.low.toFixed(1)},${l.size?.high.toFixed(1)}]`, 'K', l.temperature?.value, `[${l.temperature?.low},${l.temperature?.high}]`, l.evidence.join('+'));
    console.log('  lens', JSON.stringify(out.analysis.lens.focalMm), out.analysis.lens.focalSource, JSON.stringify(out.analysis.lens.checks), JSON.stringify(out.analysis.lens.aperture));
    console.log('  warn', out.analysis.warnings.join(' | '));
  }
  console.log('truth', JSON.stringify(shot.truth));
});
