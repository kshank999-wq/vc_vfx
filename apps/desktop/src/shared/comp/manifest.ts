import { COMP_NODES, compGraphData, type CompDocument, type CompReference } from '@vcvfx/domain';
import type { NukeScript } from './nuke';

/**
 * The machine-readable graph manifest written beside the Nuke script
 * (master spec §14 "otherwise export all assets, mattes, tracks and a
 * machine-readable graph manifest"; addendum 13 §6): every node with every
 * parameter and how it was translated, the connections in Nuke's input
 * order, every asset the comp read or wrote with its checksum, the tracks it
 * used, and what the .nk does not carry exactly. Written always — whether or
 * not the .nk is complete.
 */

export interface CompAsset {
  /** source: a module output / plate the comp read; baked: a node VC VFX rendered for the script; render / review: the comp's own render. */
  role: 'source' | 'baked' | 'render' | 'review' | 'graph' | 'nuke';
  node: string | null;
  /** Package-relative (or absolute, for a camera file on the drive) printf pattern or file. */
  path: string;
  label: string;
  /** Every file of it, with its SHA-256. */
  files: { path: string; bytes: number; sha256: string }[];
}

export interface CompManifestInfo {
  generator: string;
  shot: string;
  version: number;
  writtenAt: string;
  by: string;
  frames: { first: number; last: number };
  resolution: { width: number; height: number };
  fps: number;
  encoding: { label: string; linear: boolean; ocio: string | null };
  references: CompReference[];
  assets: CompAsset[];
  tracks: { id: string; name: string; kind: string; frames: number }[];
  render: { folder: string; pattern: string; review: string | null; seconds: number } | null;
  nukeFile: string;
  /** Approval of the task at the time of writing (null: not approved). */
  approval: { by: string; at: string } | null;
}

export function compGraphManifest(doc: CompDocument, nuke: NukeScript, info: CompManifestInfo) {
  const graph = compGraphData(doc);
  const byId = new Map(nuke.nodes.map((n) => [n.id, n]));
  return {
    format: 'vcvfx.comp-manifest/1',
    generator: info.generator,
    shot: info.shot,
    version: `v${String(info.version).padStart(3, '0')}`,
    writtenAt: info.writtenAt,
    by: info.by,
    approval: info.approval,
    revision: doc.revision,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    frames: { ...info.frames, count: info.frames.last - info.frames.first + 1 },
    resolution: info.resolution,
    fps: info.fps,
    colour: {
      working: info.encoding.label,
      linear: info.encoding.linear,
      ocioConfig: info.encoding.ocio ? 'aces_1.2' : null,
      ocioWorkingSpace: info.encoding.ocio,
      images: 'premultiplied RGBA; mattes as alpha (and colour = the matte)',
      note: 'Scene-linear; no display transform or look is in any EXR. The review encode alone goes through the viewer’s Rec.709 (approx.) view.',
    },
    nuke: { file: info.nukeFile, stack: 'input 0 on top; inputs written last to first' },
    nodes: graph.nodes.map((n) => {
      const t = byId.get(n.id);
      return { ...n, category: COMP_NODES[n.type].category, nuke: t ? { class: t.nukeClass, node: t.output, translation: t.translation } : null };
    }),
    edges: graph.edges,
    viewer: graph.viewer,
    renderSettings: graph.render,
    references: info.references,
    tracks: info.tracks,
    assets: info.assets,
    render: info.render,
    untranslated: nuke.untranslated,
  };
}
export type CompGraphManifest = ReturnType<typeof compGraphManifest>;
