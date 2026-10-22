import { it } from 'vitest';
import { STUDIO_SCENE, renderScene, type SyntheticScene } from '../lighting/synthetic';
import { fitShading, silhouetteNormals } from '../lighting/shading';
import { azElOf } from '../lighting/geometry';

function run(label: string, scene: SyntheticScene) {
  const shot = renderScene(scene);
  const field = silhouetteNormals(shot.matte, shot.image.width, shot.image.height, 0.5, shot.camera)!;
  const t = Date.now();
  const fit = fitShading(shot.image, field, [0.2722, 0.6741, 0.0537], shot.camera)!;
  const f = (L: number[]) => { const a = azElOf(L); return `${a.az.toFixed(1)}/${a.el.toFixed(1)}`; };
  console.log(label, 'key', f(fit.key!.L), 'sd', fit.key!.azRange.toFixed(2), fit.key!.elRange.toFixed(2), 'size', (2*Math.asin(fit.key!.sinA)*57.3).toFixed(1), 'dist', (1/fit.key!.inv).toFixed(1), '| fill', fit.fill ? `${f(fit.fill.L)} ${Math.log2(fit.fill.ratio).toFixed(2)} sz ${(2*Math.asin(fit.fill.sinA)*57.3).toFixed(0)}` : '-', '| rim', fit.rim ? `${f(fit.rim.L)} ${Math.log2(fit.rim.ratio).toFixed(2)}` : '-', '| amb', Math.log2(fit.ambient.ratio).toFixed(2), 'r2', fit.r2.toFixed(4), 'ms', Date.now()-t, '| terms', fit.terms.map(t=>`${f(t.L)}:${t.e.toFixed(2)}`).join(' '), '| cl', fit.clusters.map(c=>`${f(c.L)}:${c.weight.toFixed(2)}`).join(' '));
}
const base: SyntheticScene = { ...STUDIO_SCENE, width: 320, height: 180, supersample: 2, samples: 16, noise: 0.003 };
it('scratch', () => {
  const L = STUDIO_SCENE.lights;
  run('key only', { ...base, lights: [L[0]!], practicals: [], ambient: { stops: -20, kelvin: 6500 } });
  run('key+amb', { ...base, lights: [L[0]!], practicals: [] });
  run('key+fill', { ...base, lights: [L[0]!, L[1]!], practicals: [], ambient: { stops: -20, kelvin: 6500 } });
  run('key+rim', { ...base, lights: [L[0]!, L[2]!], practicals: [], ambient: { stops: -20, kelvin: 6500 } });
  run('all', base);
});
