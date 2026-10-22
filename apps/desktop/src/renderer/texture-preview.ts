import { TEXTURE_TASK, TEXTURE_UNIT_METRES, parseProject, shotState, textureBuildProblem, textureDoc, textureTaskVersion, type TextureReferenceInput, type TextureRunResult } from '@vcvfx/domain';
import type { ApiResult, JobProgress } from '../shared/bridge';
import type { PointCloud } from '../shared/camera/lidar';
import { resizeLinear, type LinearImage } from '../shared/key/linear';
import { CancelledError } from '../shared/roto/engine';
import type { TextureBridge, TextureImageView, TextureScanView, TextureSessionInfo, TextureShotInput } from '../shared/texture/bridge-types';
import { buildTextures, type TextureIO } from '../shared/texture/engine';
import { scanViewOf } from '../shared/texture/scan-view';
import { SAMPLE_SET, renderSample, sampleReferences, sampleRegions, type SampleSetOptions } from '../shared/texture/synthetic';
import { TEXTURE_SPACE, cachedRegion, shrinkRgb, srgb8, type CachedRegion } from '../shared/texture/view';

/**
 * Texture extraction in the browser preview (addendum 12 §9). The preview has
 * no drive, so the sample project's storeroom shot (040_010) comes with a
 * synthetic set made in the page — three stills of a brick wall, a plaster
 * wall and a tiled floor under two lamps (one with barrel distortion, one
 * under-exposed), a 360° panorama from the middle of the room and a coloured
 * LiDAR-like scan of it — and the same engine the desktop runs builds the
 * textures here for real: rectification, delighting, exposure matching,
 * tiling, the scan's planes, the panorama's heading and each region's place
 * on the scan. Nothing is written; exporting says it is the desktop app's.
 */

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });
const breathe = () =>
  new Promise<void>((r) => {
    if (typeof MessageChannel === 'undefined') return void setTimeout(r, 0);
    const c = new MessageChannel();
    c.port1.onmessage = () => {
      c.port1.close();
      r();
    };
    c.port2.postMessage(0);
  });

export interface TexturePreview extends TextureBridge {
  cancel(jobId: string): boolean;
}

export function createTexturePreview(options: { desktopOnly: (what: string) => string; progress: (p: JobProgress) => void; set?: SampleSetOptions; maxTexture?: number }): TexturePreview {
  const set = options.set ?? SAMPLE_SET;
  const rendered = new Map<string, LinearImage | PointCloud>();
  const jobs = new Map<string, AbortController>();
  /** Built results for review: per shot, task version and settings revision. */
  const built = new Map<string, { revision: number; regions: Map<string, CachedRegion>; scan: Omit<TextureScanView, 'built'> | null }>();
  let plainScan: Omit<TextureScanView, 'built'> | null = null;

  const sample = async (path: string) => {
    let v = rendered.get(path);
    if (!v) {
      // Let the page breathe before each render (a message, not a timer: timers are throttled in a background tab).
      await breathe();
      v = renderSample(path, set);
      rendered.set(path, v);
    }
    return v;
  };

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('texture extraction reads the references on the drive.') } as const;
    return { project, state, doc: textureDoc(state) } as const;
  };
  const keyOf = (shotId: string, version: number) => `${shotId}|v${version}`;

  const job = async <T>(jobId: string, label: string, fn: (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<T>): Promise<ApiResult<T>> => {
    const controller = new AbortController();
    jobs.set(jobId, controller);
    let last = 0;
    const report = (done: number, total: number) => {
      const now = Date.now();
      if (done < total && now - last < 150) return;
      last = now;
      options.progress({ jobId, label, done, total });
    };
    try {
      return ok(await fn(controller.signal, report));
    } catch (error) {
      return fail(error instanceof CancelledError || controller.signal.aborted ? 'Cancelled' : (error as Error).message);
    } finally {
      jobs.delete(jobId);
    }
  };

  return {
    cancel(jobId) {
      const j = jobs.get(jobId);
      j?.abort();
      return Boolean(j);
    },

    textureSession: async (input: TextureShotInput) => {
      const c = context(input.text, input.shotId);
      const base: TextureSessionInfo = { available: false, reason: null, exportable: false, fromDisk: false, handoff: [], references: [], working: { label: TEXTURE_SPACE.label, linear: true }, sample: true };
      if ('error' in c) return ok({ ...base, reason: c.error ?? null });
      if (!c.state.tasks.some((t) => t.kind === TEXTURE_TASK)) return ok({ ...base, reason: 'This shot has no Texture extraction task. Add it to work on it here.' });
      const shot = c.project.handoff.shots.find((s) => s.shotId === input.shotId)!;
      const kindOf: Record<string, 'photo' | 'panorama' | 'scan' | undefined> = { reference_photo: 'photo', panorama: 'panorama', hdri: 'panorama', lidar: 'scan', survey: 'scan' };
      return ok({
        ...base,
        available: true,
        handoff: shot.references.filter((r) => kindOf[r.kind]).map((r) => ({ kind: kindOf[r.kind]!, path: r.path, name: r.path.split('/').pop() ?? r.path, onDisk: false })),
        references: (c.doc?.references ?? []).map((r) => ({ id: r.id, onDisk: true, changed: false })),
        sampleRegions: sampleRegions(set),
      });
    },

    textureIngest: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      return job(input.jobId, `Reading the sample ${input.kind === 'photo' ? 'photos' : input.kind}`, async (_signal, progress): Promise<TextureReferenceInput[]> => {
        // The sample's panorama comes with its position surveyed (the build finds its heading from the scan).
        const refs = sampleReferences(set, { position: 'given' }).filter((r) => r.kind === input.kind);
        const out: TextureReferenceInput[] = [];
        for (const [i, r] of refs.entries()) {
          progress(i, refs.length);
          if (r.kind === 'scan') out.push({ ...r, points: ((await sample(r.path)) as PointCloud).count });
          else out.push(r);
        }
        progress(refs.length, refs.length);
        return out;
      });
    },

    textureImage: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const r = input.request;
      try {
        if (r.kind === 'reference') {
          const ref = c.doc?.references.find((x) => x.id === r.id);
          if (!ref || ref.kind === 'scan') return fail(`No picture ${r.id}`);
          const img = (await sample(ref.path)) as LinearImage;
          return ok({ ...srgb8(img, r.maxWidth), mask: null, built: 'none', label: `Sample ${ref.kind === 'panorama' ? 'panorama' : 'still'} (synthetic, linear ACEScg) → sRGB, for viewing` } satisfies TextureImageView);
        }
        const version = textureTaskVersion(c.state);
        const b = built.get(keyOf(input.shotId, version));
        const cached = b?.regions.get(r.regionId);
        if (!b || !cached) return fail('Build the textures (step 3) to see them here.');
        const pic = r.stage === 'tiled' ? (cached.tiled ?? cached.delit) : r.stage === 'delit' ? cached.delit : cached.original;
        const shown = shrinkRgb(pic, r.maxWidth);
        return ok({ ...shown, mask: cached.maskWidth === shown.width && cached.maskHeight === shown.height ? cached.mask : null, built: b.revision === c.doc?.revision ? 'current' : 'stale', label: `${TEXTURE_SPACE.label} → sRGB (the texture view)` });
      } catch (error) {
        return fail((error as Error).message);
      }
    },

    textureScan: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const scan = c.doc?.references.find((r) => r.kind === 'scan');
      if (!scan?.scan) return ok(null);
      const b = built.get(keyOf(input.shotId, textureTaskVersion(c.state)));
      if (b?.scan) return ok({ ...b.scan, built: b.revision === c.doc?.revision ? 'current' : 'stale' });
      if (!plainScan) plainScan = scanViewOf((await sample(scan.path)) as PointCloud, { up: scan.scan.up, planes: [], threshold: 0.03, panorama: null, patches: [] });
      return ok({ ...plainScan, built: 'none' });
    },

    textureBuild: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const doc = c.doc;
      const problem = textureBuildProblem(doc);
      if (problem || !doc) return fail(problem ?? 'Add the references first (step 1).');
      return job(input.jobId, `Building the textures of ${input.shotId}`, async (signal, progress): Promise<{ result: TextureRunResult }> => {
        const io: TextureIO = {
          signal,
          picture: async (id, maxLong) => {
            const ref = doc.references.find((r) => r.id === id);
            if (!ref) throw new Error(`No reference ${id}`);
            const img = (await sample(ref.path)) as LinearImage;
            await breathe();
            if (!maxLong || Math.max(img.width, img.height) <= maxLong) return img;
            const k = maxLong / Math.max(img.width, img.height);
            return resizeLinear(img, Math.round(img.width * k), Math.round(img.height * k));
          },
          scan: async (id) => (await sample(doc.references.find((r) => r.id === id)!.path)) as PointCloud,
        };
        const regions = new Map<string, CachedRegion>();
        const out = await buildTextures(io, doc, { luma: TEXTURE_SPACE.luma, revision: doc.revision, maxTexture: Math.min(doc.workingWidth, options.maxTexture ?? 768), maxPhoto: null, progress }, async (r) => {
          regions.set(r.regionId, cachedRegion(r, 768));
          await breathe();
        });
        const scan = doc.references.find((r) => r.kind === 'scan');
        const scanView = out.cloud && scan?.scan ? scanViewOf(out.cloud, { up: scan.scan.up, planes: out.result.planes, threshold: 0.03 / TEXTURE_UNIT_METRES[scan.scan.units], panorama: out.panoramaPosition, patches: out.patches }) : null;
        built.set(keyOf(input.shotId, textureTaskVersion(c.state)), { revision: doc.revision, regions, scan: scanView });
        return { result: out.result };
      });
    },

    textureExport: async () => fail(options.desktopOnly('the textures, the mapping file and the mesh are written into the shot package on disk.')),
  };
}
