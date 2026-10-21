import { describe, expect, it } from 'vitest';
import { CAMERA_DB, SAMPLE_HANDOFF, createProject, parseHandoff, shotState, type Project } from '@vcvfx/domain';
import { applyOps, dispatch, type CameraCommand, type CameraSession } from '../../shared/camera/commands';
import { MemoryStore, sessionBase } from '../../shared/camera/session';
import { TsCameraSolver } from '../../shared/camera/solver';
import { groupCameras, searchCameras } from '../components/CameraPicker';
import { fitScene, needsReframe } from '../components/PointCloudView';

/** The camera database in the Track workspace: picking bodies, fixed lenses, custom bodies, and the 3D view's framing. */

const SHOT = '020_010';
const now = new Date('2026-10-21T12:00:00Z');

function harness() {
  const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!h.ok) throw new Error('sample');
  let project: Project = createProject(h.handoff, '/drive/handoff.json', 'Ana', now);
  const session = (): CameraSession => ({
    ...sessionBase(project, SHOT, { first: 1001, last: 1010, fps: 24 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
    io: { frame: async () => ({ width: 2, height: 2, data: new Float32Array(4) }), readFile: async () => new Uint8Array(), writeExport: async (folder) => ({ folder: folder.name, files: [] }) },
    store: new MemoryStore(),
    solver: new TsCameraSolver(),
    actor: 'Ana',
    now: () => now,
    generator: 'test',
  });
  const run = async (cmd: CameraCommand) => {
    const out = await dispatch(session(), cmd);
    if (!out.ok) throw new Error(out.error);
    const r = applyOps(project, SHOT, out.ops, 'Ana', now);
    if (!r.ok) throw new Error(r.reason);
    project = r.project;
    return out;
  };
  return { run, doc: () => shotState(project, SHOT)!.camtrack!, project: () => project };
}

describe('camera picker', () => {
  it('searches by maker, model and aliases, filters by category, groups by maker', () => {
    const venice = searchCameras(CAMERA_DB, 'venice', null);
    expect(venice.map((c) => c.id)).toEqual(expect.arrayContaining(['sony-venice', 'sony-venice-6k', 'sony-venice-2-8k']));
    expect(searchCameras(CAMERA_DB, 'alexa35', null)[0]?.id).toBe('arri-alexa-35');
    const drones = searchCameras(CAMERA_DB, 'mavic 3 pro', 'drone').map((c) => c.id);
    expect(drones).toEqual(expect.arrayContaining(['dji-mavic-3-pro-hasselblad-wide', 'dji-mavic-3-pro-medium-tele-70-mm', 'dji-mavic-3-pro-tele-166-mm']));
    expect(searchCameras(CAMERA_DB, 'mavic', 'cinema')).toEqual([]);
    const groups = groupCameras(searchCameras(CAMERA_DB, '', 'phone'));
    expect(groups.map((g) => g.make)).toEqual(['Apple', 'Samsung', 'Google']);
  });

  it('chooses a body at its default mode; a fixed-lens drone camera fills the focal; leaving it clears it', async () => {
    const t = harness();
    await t.run({ verb: 'set_camera', cameraId: 'dji-mavic-3-pro-medium-tele-70-mm' });
    expect(t.doc().camera).toMatchObject({ cameraId: 'dji-mavic-3-pro-medium-tele-70-mm', source: 'database', verified: false });
    expect(t.doc().lens).toMatchObject({ focalMm: 19.6, focalMode: 'approx' });
    await t.run({ verb: 'set_camera', cameraId: 'arri-alexa-35' });
    expect(t.doc().camera?.modeId).toBe('4.6k-3x2-og');
    expect(t.doc().lens.focalMode).toBe('unknown');
    expect(t.doc().lens.focalMm).toBeNull();
  });

  it('an anamorphic raster sets the squeeze', async () => {
    const t = harness();
    const sxt = CAMERA_DB.find((c) => c.id === 'arri-alexa-sxt-plus')!;
    const ana = sxt.modes.find((m) => m.anamorphicSqueeze === 2)!;
    await t.run({ verb: 'set_camera', cameraId: sxt.id, modeId: ana.id });
    expect(t.doc().lens.squeeze).toBe(2);
  });

  it('adds a custom body to the project and uses it', async () => {
    const t = harness();
    await t.run({ verb: 'set_camera', custom: { id: 'custom-acme-cam', make: 'Acme', model: 'Cam', category: 'other', aliases: [], source: 'Entered by hand', modes: [{ id: 'custom', name: 'Full', filmBackMm: { width: 22.3, height: 14.9 }, px: { width: 6000, height: 4000 }, verified: false, aliases: [] }] } });
    expect(t.project().customCameras.map((c) => c.id)).toEqual(['custom-acme-cam']);
    expect(t.doc().camera).toMatchObject({ source: 'custom', cameraId: 'custom-acme-cam', filmBackMm: { width: 22.3, height: 14.9 } });
    expect(t.project().log.some((l) => l.action === 'camera.custom_added')).toBe(true);
  });
});

describe('3D view framing', () => {
  const cams = (x: number, y = 1.5, z = 0) => Array.from({ length: 5 }, (_, i) => ({ position: [x + i * 0.1, y, z], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }));
  const pts = (x: number, y: number, z: number) => Float32Array.from(Array.from({ length: 300 }, (_, i) => [x + (i % 10) - 5, y + (Math.floor(i / 10) % 3), z - 5 - (i % 7)]).flat());

  it('fits the scene where it is, e.g. after a solve in LiDAR coordinates', () => {
    const fit = fitScene([], { positions: pts(1250, -853, -6) }, cams(1250, -852, -3))!;
    expect(Math.hypot(fit.target[0]! - 1250, fit.target[1]! + 853)).toBeLessThan(10);
    expect(fit.dist).toBeGreaterThan(1);
    expect(fit.dist).toBeLessThan(100);
  });

  it('re-frames when the content leaves the view or changes size, not for small changes', () => {
    const before = fitScene([], { positions: pts(0, 0, 0) }, cams(0))!;
    const view = { target: before.target, dist: before.dist };
    expect(needsReframe(before, fitScene([], { positions: pts(0.3, 0, 0) }, cams(0))!, view)).toBe(false);
    expect(needsReframe(before, fitScene([], { positions: pts(1250, -853, -6) }, cams(1250, -852, -3))!, view)).toBe(true);
    expect(needsReframe(null, before, view)).toBe(true);
  });
});
