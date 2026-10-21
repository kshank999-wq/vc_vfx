import type { Track2d } from '@vcvfx/domain';

/**
 * 2D track exports (master spec §9 last bullet; addendum 06 §7), into
 * 05_TRACKS_2D:
 *
 *  - Nuke CornerPin2D `.nk`: `to1…to4` animated (Nuke's y-up pixels;
 *    to1 = bottom-left, to2 = bottom-right, to3 = top-right, to4 = top-left),
 *    `from1…from4` the plate's corners, so an insert reformatted to the plate
 *    pins onto the surface. A point track becomes a Tracker-style Transform's
 *    translate curve.
 *  - After Effects `.jsx`: applies the Corner Pin effect (match names
 *    ADBE Corner Pin-0001 … -0004: upper left, upper right, lower left, lower
 *    right) with keyframes to the selected layer, scaled from plate pixels to
 *    that layer's size; a point track keys the layer's anchor/position.
 *  - "Adobe After Effects 6.0 Keyframe Data" text — the clipboard format
 *    Mocha writes for a corner pin — paste onto a layer in AE.
 *  - JSON with every frame, its points, confidence and status.
 */

export interface Track2dExportInfo {
  shot: string;
  version: number;
  generator: string;
  fps: number;
  width: number;
  height: number;
  first: number;
  writtenAt: string;
}

const num = (v: number, d = 4) => {
  const s = v.toFixed(d);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

function usable(t: Track2d) {
  return t.frames.filter((f) => f.status !== 'lost');
}

function curve(frames: number[], values: number[]): string {
  // Explicit frame before every key keeps gaps (lost frames) correct.
  return `{curve ${frames.map((f, i) => `x${f} ${num(values[i]!)}`).join(' ')}}`;
}

export function writeNukeCornerPin(t: Track2d, info: Track2dExportInfo): string {
  const fr = usable(t);
  const frames = fr.map((f) => f.frame);
  const yUp = (y: number) => info.height - y - 0.5; // pixel-index centre → Nuke's y-up pixel coordinates
  const xN = (x: number) => x + 0.5;
  const head = [`#! nuke file written by ${info.generator}`, 'version 13.0 v1', `# ${info.shot} 2D track ${t.name} v${String(info.version).padStart(3, '0')} (${t.kind}), ${fr.length} frames`];
  if (t.kind === 'point') {
    const xs = fr.map((f) => xN(f.points[0]![0]));
    const ys = fr.map((f) => yUp(f.points[0]![1]));
    const x0 = xs[0] ?? 0;
    const y0 = ys[0] ?? 0;
    return `${[
      ...head,
      'Transform {',
      ` translate {${curve(frames, xs.map((x) => x - x0))} ${curve(frames, ys.map((y) => y - y0))}}`,
      ` center {${num(x0)} ${num(y0)}}`,
      ` name Track_${id(t.name)}`,
      ` label "point track from frame ${frames[0] ?? ''}"`,
      '}',
    ].join('\n')}\n`;
  }
  // Our corners: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left (image y down).
  const order = [3, 2, 1, 0]; // to1 BL, to2 BR, to3 TR, to4 TL
  const to = order.map((ci, k) => ` to${k + 1} {${curve(frames, fr.map((f) => xN(f.points[ci]![0])))} ${curve(frames, fr.map((f) => yUp(f.points[ci]![1])))}}`);
  return `${[
    ...head,
    'CornerPin2D {',
    ...to,
    ' from1 {0 0}',
    ` from2 {${info.width} 0}`,
    ` from3 {${info.width} ${info.height}}`,
    ` from4 {0 ${info.height}}`,
    ` name CornerPin_${id(t.name)}`,
    ` label "${t.name} v${String(info.version).padStart(3, '0')}"`,
    '}',
  ].join('\n')}\n`;
}

export function writeCornerPinJsx(t: Track2d, info: Track2dExportInfo): string {
  const fr = usable(t);
  const times = fr.map((f) => num((f.frame - info.first) / info.fps, 6));
  const pts = (ci: number) => `[${fr.map((f) => `[${num(f.points[ci]![0] + 0.5)},${num(f.points[ci]![1] + 0.5)}]`).join(',')}]`;
  if (t.kind === 'point') {
    return `// ${info.shot} point track ${t.name} for After Effects, written by ${info.generator}
// Select the layer to move, then File > Scripts > Run Script File. Keys its Position (plate pixels scaled to the comp).
(function () {
  var comp = app.project.activeItem;
  if (!(comp && comp instanceof CompItem) || comp.selectedLayers.length !== 1) { alert("Select one layer in a composition first."); return; }
  app.beginUndoGroup("VC VFX track ${t.name}");
  var layer = comp.selectedLayers[0];
  var kx = comp.width / ${info.width}, ky = comp.height / ${info.height};
  var times = [${times.join(',')}];
  var p = ${pts(0)};
  for (var i = 0; i < p.length; i++) { times[i] += comp.displayStartTime; p[i] = [p[i][0] * kx, p[i][1] * ky]; }
  layer.property("ADBE Transform Group").property("ADBE Position").setValuesAtTimes(times, p);
  app.endUndoGroup();
})();
`;
  }
  return `// ${info.shot} corner pin ${t.name} v${String(info.version).padStart(3, '0')} for After Effects, written by ${info.generator}
// Select the insert layer, then File > Scripts > Run Script File. Adds a Corner Pin effect keyed to the
// tracked surface. Corners are plate pixels (${info.width}×${info.height}) scaled to the selected layer's size.
(function () {
  var comp = app.project.activeItem;
  if (!(comp && comp instanceof CompItem) || comp.selectedLayers.length !== 1) { alert("Select one layer in a composition first."); return; }
  app.beginUndoGroup("VC VFX corner pin ${t.name}");
  var layer = comp.selectedLayers[0];
  var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Corner Pin");
  fx.name = "VC VFX ${t.name}";
  var kx = layer.width / ${info.width}, ky = layer.height / ${info.height};
  var times = [${times.join(',')}];
  for (var i = 0; i < times.length; i++) times[i] += comp.displayStartTime;
  var corners = { "ADBE Corner Pin-0001": ${pts(0)}, "ADBE Corner Pin-0002": ${pts(1)}, "ADBE Corner Pin-0003": ${pts(3)}, "ADBE Corner Pin-0004": ${pts(2)} };
  for (var name in corners) {
    var v = corners[name];
    for (var j = 0; j < v.length; j++) v[j] = [v[j][0] * kx, v[j][1] * ky];
    fx.property(name).setValuesAtTimes(times, v);
  }
  app.endUndoGroup();
})();
`;
}

export function writeMochaText(t: Track2d, info: Track2dExportInfo): string {
  const fr = usable(t);
  const header = ['Adobe After Effects 6.0 Keyframe Data', '', `\tUnits Per Second\t${num(info.fps, 3)}`, `\tSource Width\t${info.width}`, `\tSource Height\t${info.height}`, '\tSource Pixel Aspect Ratio\t1', '\tComp Pixel Aspect Ratio\t1', ''];
  const block = (label: string, ci: number) => [`Effects\tCorner Pin #1\t${label}`, '\tFrame\tX pixels\tY pixels\t', ...fr.map((f) => `\t${f.frame - info.first}\t${num(f.points[ci]![0] + 0.5, 3)}\t${num(f.points[ci]![1] + 0.5, 3)}\t`), ''];
  if (t.kind === 'point') {
    return `${[...header, 'Transform\tPosition', '\tFrame\tX pixels\tY pixels\tZ pixels\t', ...fr.map((f) => `\t${f.frame - info.first}\t${num(f.points[0]![0] + 0.5, 3)}\t${num(f.points[0]![1] + 0.5, 3)}\t0\t`), '', 'End of Keyframe Data'].join('\r\n')}\r\n`;
  }
  return `${[...header, ...block('Upper Left #2', 0), ...block('Upper Right #3', 1), ...block('Lower Left #4', 3), ...block('Lower Right #5', 2), 'End of Keyframe Data'].join('\r\n')}\r\n`;
}

export function writeTrack2dJson(t: Track2d, info: Track2dExportInfo): string {
  return `${JSON.stringify(
    {
      format: 'vcvfx.track2d/1',
      generator: info.generator,
      writtenAt: info.writtenAt,
      shot: info.shot,
      version: `v${String(info.version).padStart(3, '0')}`,
      track: { id: t.id, name: t.name, kind: t.kind, engine: t.engine, occluders: t.occluders },
      plate: { width: info.width, height: info.height, fps: info.fps },
      coordinates: 'plate pixels, origin top-left, pixel centres at integer + 0.5 (as AE); corners top-left, top-right, bottom-right, bottom-left',
      keys: t.keys.map((k) => ({ frame: k.frame, points: k.points.map(([x, y]) => [x + 0.5, y + 0.5]), by: k.by, at: k.at })),
      frames: t.frames.map((f) => ({ frame: f.frame, points: f.points.map(([x, y]) => [x + 0.5, y + 0.5]), confidence: f.confidence, status: f.status })),
    },
    null,
    2,
  )}\n`;
}
