/**
 * A `vcdit.vfx-handoff/1` exactly as VCDIT's `VfxService.sendToPrep` writes
 * it (vc-dit apps/desktop/src/main/vfx/vfx-service.ts; its own test,
 * __tests__/vfx.test.ts, asserts the first shot below field for field).
 *
 * Day 1 of HALCYON: 14B take 3 shot on two cameras (A and B), both flagged by
 * the script supervisor and hard-linked; one clip the DIT tagged, on a drive
 * that cannot hold hard links, so it is referenced instead; and a BRAW clip.
 * Written at <drive>/HALCYON/SHOOT_DAY_001_2026-10-07/VFX/VC_VFX_PREP_HLC_D001_20261007_201500Z.json.
 */
export const VCDIT_FIXTURE = {
  schema: 'vcdit.vfx-handoff/1',
  createdAt: '2026-10-07T20:15:00.000Z',
  tool: { name: 'VC DIT', version: '1.4.0' },
  production: { name: 'HALCYON', code: 'HLC', frameRate: '23.976 fps' },
  day: { number: 1, date: '2026-10-07' },
  shots: [
    {
      scene: '14',
      setup: 'B',
      take: '03',
      clip: 'A015C002',
      note: 'Sky replacement',
      flaggedBy: 'Script sup.',
      mirror: { method: 'Hard link', folder: 'SCENE_014/SETUP_B/T03_A015C002' },
      editorialFolder: '../CAMERA_ORIGINALS/A015',
      checksumMethod: 'xxHash64',
      files: [
        { path: 'A015R1AB/A015C002_261007_R1AB.mxf', size: 200000, checksum: '8d1c3a7e5b2f0c94' },
        { path: 'A015R1AB/A015C002_261007_R1AB.xml', size: 7, checksum: '0f3e6a2b9c1d4e57' },
      ],
    },
    {
      scene: '14',
      setup: 'B',
      take: '03',
      clip: 'B007C002',
      note: 'Sky replacement',
      flaggedBy: 'Script sup.',
      mirror: { method: 'Hard link', folder: 'SCENE_014/SETUP_B/T03_B007C002' },
      editorialFolder: '../CAMERA_ORIGINALS/B007',
      checksumMethod: 'xxHash64',
      files: [{ path: 'B007R2CD/B007C002_261007_R2CD.mxf', size: 180000, checksum: '1a2b3c4d5e6f7081' }],
    },
    {
      scene: '14',
      setup: '—',
      take: '01',
      clip: 'A015C001',
      note: 'Monitor comp',
      flaggedBy: 'DIT tag',
      mirror: { method: 'Reference', folder: 'SCENE_014/SETUP_NONE/T01_A015C001' },
      editorialFolder: '../CAMERA_ORIGINALS/A015',
      checksumMethod: 'xxHash64',
      files: [{ path: 'A015R1AB/A015C001_261007_R1AB.mxf', size: 8, checksum: null }],
    },
    {
      scene: '22A',
      setup: 'C',
      take: '05',
      clip: 'C003_10071422_C012',
      note: '',
      flaggedBy: 'Script sup.',
      mirror: { method: 'Physical copy', folder: 'SCENE_22A/SETUP_C/T05_C003_10071422_C012' },
      editorialFolder: '../CAMERA_ORIGINALS/C003',
      checksumMethod: 'MD5',
      files: [{ path: 'C003_10071422_C012.braw', size: 900000, checksum: '9e107d9d372bb6826bd81d3542a419d6' }],
    },
  ],
};
