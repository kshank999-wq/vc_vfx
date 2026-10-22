import Link from 'next/link';
import { fetchPlanPrices } from '@/lib/pricing';
import { PricingCards } from './pricing-cards';

/**
 * The front page. Copy follows docs/spec/master-spec.md and says plainly what
 * V1 does (handoff, queue, printable list, checksums, plates, packages) and
 * what is on the roadmap (everything from §20 item 3 on).
 */

const QUEUE = [
  {
    shot: '010_020',
    scene: '12A / Setup 3',
    frames: '1001–1128',
    prep: [{ label: 'DPX', plate: true }, { label: 'Key' }, { label: 'Roto' }],
    notes: 'Actor exits screen',
    status: { label: 'Processing', tone: 'processing' },
    approval: '—',
  },
  {
    shot: '010_030',
    scene: '12A / Setup 4',
    frames: '1001–1082',
    prep: [{ label: 'EXR', plate: true }, { label: '2D Track' }],
    notes: 'Monitor replacement',
    status: { label: 'Prep Approved', tone: 'approved' },
    approval: 'Approved',
  },
  {
    shot: '012_010',
    scene: '14 / Setup 1',
    frames: '1001–1240',
    prep: [{ label: 'EXR', plate: true }, { label: 'Clean Plate' }],
    notes: 'Remove boom shadow',
    status: { label: 'Needs Review', tone: 'review' },
    approval: '—',
  },
  {
    shot: '015_040',
    scene: '19B / Setup 2',
    frames: '1001–1096',
    prep: [{ label: 'TIFF', plate: true }, { label: 'Sky' }],
    notes: 'Overcast to dusk',
    status: { label: 'Ready for Prep', tone: 'ready' },
    approval: '—',
  },
] as const;

const STEPS = [
  {
    title: 'Handoff',
    body: 'Open the VCDIT handoff on the DIT drive. Every shot, take, frame range, camera, lens and colour setting arrives as data, not a spreadsheet to retype.',
  },
  {
    title: 'Queue',
    body: 'VC VFX builds the shot queue and verifies source files against their checksums before anything runs. Filter by scene, status or circle take.',
  },
  {
    title: 'Plates',
    body: 'Generate DPX, TIFF or EXR image sequences, renumbered from 1001 with optional head and tail handles. Originals are only ever read.',
  },
  {
    title: 'Review & approve',
    body: 'Look at the work, then approve it per task and per shot. Approval is a person’s decision and is recorded with who and when.',
  },
  {
    title: 'Package',
    body: 'Write each shot to a standard folder structure with a manifest, checksums and a printable report — ready for your artist or VFX house.',
  },
];

const ROADMAP: ReadonlyArray<{ title: string; desc: string; v1?: boolean }> = [
  {
    title: 'VCDIT handoff parser, shot queue and printable prep list',
    desc: 'Read the handoff, build the queue, print the list.',
    v1: true,
  },
  {
    title: 'Image-sequence generation and colour-safe plate packaging',
    desc: 'DPX / TIFF / EXR, 1001 numbering, handles, checksums, manifests.',
    v1: true,
  },
  {
    title: 'Paint-to-roto',
    desc: 'Paint the subject on one frame; the matte follows it through the shot, with parts, confidence review and local corrections.',
    v1: true,
  },
  {
    title: 'Camera tracking',
    desc: 'Track and solve the camera on your machine, with a camera database, lens calibration and LiDAR / survey alignment; export to Nuke, Maya, Blender, After Effects, Houdini, Fusion / Resolve, 3ds Max, FBX, Unreal Engine 5, Unity and USD.',
    v1: true,
  },
  {
    title: '2D / planar tracking',
    desc: 'Pin a surface by its four corners or track a point, preview the replacement on it, correct any frame, export corner pins for Nuke and After Effects.',
    v1: true,
  },
  {
    title: 'Green / blue screen keying',
    desc: 'One-click auto key in linear light against a clean-plate model of the screen, garbage and holdout mattes, repairs painted with roto, despill against a background reference, light-wrap and colour-match previews; versioned alpha and premultiplied EXR foreground.',
    v1: true,
  },
  {
    title: 'Clean-plate generation',
    desc: 'Remove a crew member, a rig or a passer-by: frames aligned for the camera’s motion, the background rebuilt from the frames that see it, a still or a plate per frame, and what no frame sees shown for paint; versioned EXR plates with confidence maps.',
    v1: true,
  },
  {
    title: 'Background and sky isolation',
    desc: 'Find the sky automatically, or isolate a subject from a box, paint or roto: consistent through the shot, branches, wires and hair kept as soft edges, corrections painted on any frame; the matte, the foreground and the sky or background plate exported separately, versioned.',
    v1: true,
  },
  {
    title: 'Texture extraction',
    desc: 'Turn set photographs into flat, seamless textures: squared up from four corners with the lens taken out, the light flattened, one exposure across a surface, tiled without a seam; placed on the LiDAR scan with the 360° panorama, for you to accept or move; versioned EXR and PNG maps, a mapping file and an OBJ of the patches.',
    v1: true,
  },
  {
    title: 'Node compositor and Nuke handoff',
    desc: 'Connect the prep in a node graph — plate, key, roto, clean plate, sky and background — preview any two nodes with a wipe, render a versioned linear EXR comp, and hand it to Nuke as a script with real Nuke nodes, the modules’ own files and a manifest of every asset.',
    v1: true,
  },
  {
    title: 'Lighting and lens analysis',
    desc: 'Estimate the key, fill, rim, practicals and ambient from the plate — or measure them from a chrome ball, a grey ball or an HDRI — each figure with its range, plus the lens from metadata, the camera track or vanishing points; tune every light on a rig diagram against a relit preview, then export an Unreal Engine 5 script, USD, Blender and a printable report, versioned.',
    v1: true,
  },
];

const FAQ = [
  {
    q: 'Does VC VFX ever modify my camera originals?',
    a: 'No. Source media is only ever read. Plates, packages and reports are written to new locations, outputs are versioned rather than silently overwritten, and every source file can be checked against the checksums in the handoff.',
  },
  {
    q: 'Do I need VCDIT?',
    a: 'VC VFX builds its shot queue from the VCDIT handoff specification — the machine-readable file VCDIT writes alongside the VFX folder structure on the drive. VCDIT is the intended way in, and the two are designed to work as a pair.',
  },
  {
    q: 'Does V1 do roto, tracking, keying, clean plates, sky replacement, textures, compositing or lighting?',
    a: 'Roto, yes: paint the subject on a key frame and VC VFX propagates the matte through the shot, flags the frames it is least sure of, and re-propagates your corrections locally. It runs on your own machine. Tracking, yes: camera tracking (solve, LiDAR alignment, exports for Nuke, Maya, Blender, After Effects, Houdini, Fusion / Resolve, Unreal Engine, Unity and USD) and 2D / planar tracking with corner-pin export. Keying, yes: green- and blue-screen keys with roto repairs, despill against a background reference and exports of the alpha and the despilled foreground. Clean plates, yes: remove a rotoscoped subject and VC VFX rebuilds the background from the frames that see it, aligned for the camera’s motion, as a still or a plate per frame, with what no frame sees shown for paint. Sky and background isolation, yes: the sky is found by itself and a subject from a box, paint or roto, kept consistent through the shot, with the matte, the foreground and the sky or background plate exported separately. Textures, yes: mark a surface on a set photo and VC VFX squares it up, flattens the light, makes it tile and suggests where it belongs on the LiDAR scan using the 360° panorama, with texture maps, a mapping file and an OBJ of the patches for your 3D package. Compositing, for prep: a light node graph connects the plate with the key, roto, clean plate and sky or background outputs, previews any two nodes with a wipe, renders a versioned linear EXR comp, and exports a Nuke script built from real Nuke nodes that reads the modules’ own files, with a manifest of every asset — not a replacement for Nuke, a clean start in it. Lighting, yes: VC VFX estimates how the shot was lit — key, fill, rim, practicals and ambient, each with a range rather than a false-precise number, measured outright from a chrome ball, grey ball or HDRI when you shot one — and the lens; you tune the rig against a relit preview and export it for Unreal Engine 5, USD and Blender with the camera.',
  },
  {
    q: 'Which plate formats are supported?',
    a: 'DPX, TIFF and EXR image sequences, with a configurable start frame (1001 by default) and optional head and tail handles. Sources can be ProRes, DNxHR, H.264/HEVC or DPX/EXR/TIFF sequences; camera raw is transcoded first. EXR plates can be converted from camera log to ACEScg using the camera makers\' published maths, the transform is recorded with each plate, and display looks are never baked in.',
  },
  {
    q: 'Is my footage uploaded anywhere?',
    a: 'No. VC VFX is a desktop app and processes media locally. The only things that reach vc-vfx.com are your account, your licence check and downloads of the installer — and, only if you ask the optional AI assistant for a second opinion with frames allowed, the downscaled frames it looks at.',
  },
  {
    q: 'What happens if my subscription lapses or I am offline on set?',
    a: 'The app keeps working offline for up to 30 days from its last licence check. A lapsed copy can still open projects and print shot lists — your work on disk is never held hostage — but it cannot run processing or write packages until the subscription is active again.',
  },
  {
    q: 'How many computers can I use?',
    a: 'Each licence covers Windows and macOS and can be active on two computers at once. Free a seat yourself from your account page when you replace a machine.',
  },
];

export default async function HomePage() {
  const plans = await fetchPlanPrices();

  return (
    <>
      <section className="hero">
        <div className="shell">
          <span className="eyebrow">VFX preparation · Companion to VCDIT</span>
          <h1>
            Every VFX shot, <em>prepped once</em> and handed off clean.
          </h1>
          <p className="hero-sub">
            VC VFX reads the VCDIT handoff from your DIT drive, builds the shot queue, verifies every source file,
            generates numbered image-sequence plates and packages each shot with a manifest — so your artist or
            VFX house starts from organised, validated prep instead of raw camera media.
          </p>
          <div className="hero-actions">
            <Link href="/download" className="button large">
              Get VC VFX
            </Link>
            <Link href="/#workflow" className="button secondary large">
              See how it works
            </Link>
          </div>
          <div className="hero-meta">
            <span>Windows &amp; macOS</span>
            <span>Originals never touched</span>
            <span>Local processing</span>
          </div>

          <div className="queue-window" role="img" aria-label="Illustration of the VC VFX shot queue">
            <div className="queue-bar">
              <div className="queue-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <span className="queue-title">
                NIGHT_RUN · <b>Shot queue</b> · 4 shots
              </span>
              <div className="queue-tools" aria-hidden="true">
                <span>Scene ▾</span>
                <span>Status ▾</span>
                <span>Print list</span>
              </div>
            </div>
            <div className="queue-scroll">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th>Shot</th>
                    <th className="col-scene">Scene / Setup</th>
                    <th className="col-frames">Frames</th>
                    <th>Required prep</th>
                    <th className="col-notes">Notes</th>
                    <th>Status</th>
                    <th className="col-approval">Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {QUEUE.map((row) => (
                    <tr key={row.shot}>
                      <td className="shot">{row.shot}</td>
                      <td className="col-scene">{row.scene}</td>
                      <td className="col-frames frames">{row.frames}</td>
                      <td>
                        <div className="chips">
                          {row.prep.map((task) => (
                            <span key={task.label} className={'plate' in task && task.plate ? 'chip plate' : 'chip'}>
                              {task.label}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="col-notes notes">{row.notes}</td>
                      <td>
                        <span className={`status ${row.status.tone}`}>{row.status.label}</span>
                      </td>
                      <td className={`col-approval approval${row.approval === 'Approved' ? ' yes' : ''}`}>
                        {row.approval}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="queue-foot">
              <span>
                <span className="chip plate">DPX</span> plates run in V1
              </span>
              <span>
                <span className="chip">Key</span> keying, roto, clean plates, sky and background isolation, textures, tracking, the prep comp and lighting analysis run in V1 too
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="workflow">
        <div className="shell">
          <div className="section-head">
            <span className="eyebrow">How it works</span>
            <h2>From the DIT drive to a deliverable shot package.</h2>
            <p>
              The repeatable part of VFX prep, done the same way every time — with a person reviewing and
              approving the result rather than blind automation.
            </p>
          </div>
          <ol className="steps" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {STEPS.map((step, index) => (
              <li key={step.title} className="step">
                <span className="step-num">{String(index + 1).padStart(2, '0')}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <span className="arrow" aria-hidden="true" />
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" id="shot-list">
        <div className="shell split">
          <div>
            <span className="eyebrow">The printable shot list</span>
            <h2>A prep list you can hold in your hand.</h2>
            <p className="lead">
              On an independent production the DIT, the VFX supervisor and the prep artist are often the same two
              people with a clipboard. VC VFX prints the whole queue as a checklist so every shot can be
              physically reviewed and signed off — what has been done, and what has not.
            </p>
            <ul className="ticks">
              <li>
                Shot, scene and setup, frame range and required prep <span>— straight from the handoff</span>
              </li>
              <li>
                Status and approval for every shot <span>— with room for initials</span>
              </li>
              <li>
                Supervisor notes carried through <span>— nothing retyped</span>
              </li>
            </ul>
          </div>
          <div className="sheet" aria-label="Illustration of a printed VC VFX prep list" role="img">
            <div className="sheet-head">
              <strong>VFX PREP LIST — NIGHT_RUN</strong>
              <span>
                Day 14 · Unit A
                <br />
                Printed from VC VFX
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Shot</th>
                  <th>Frames</th>
                  <th>Prep</th>
                  <th className="col-notes">Notes</th>
                  <th>Done</th>
                  <th>OK</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono">010_020</td>
                  <td className="mono">1001–1128</td>
                  <td>DPX + Key + Roto</td>
                  <td className="col-notes">Actor exits screen</td>
                  <td>
                    <span className="box checked" />
                  </td>
                  <td>
                    <span className="box" />
                  </td>
                </tr>
                <tr>
                  <td className="mono">010_030</td>
                  <td className="mono">1001–1082</td>
                  <td>2D Track</td>
                  <td className="col-notes">Monitor replacement</td>
                  <td>
                    <span className="box checked" />
                  </td>
                  <td>
                    <span className="initials">JR</span>
                  </td>
                </tr>
                <tr>
                  <td className="mono">012_010</td>
                  <td className="mono">1001–1240</td>
                  <td>EXR + Clean plate</td>
                  <td className="col-notes">Remove boom shadow</td>
                  <td>
                    <span className="box" />
                  </td>
                  <td>
                    <span className="box" />
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="sheet-foot">
              <span>DIT</span>
              <span>VFX supervisor</span>
              <span>Date</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="plates">
        <div className="shell split flip">
          <pre className="tree" aria-label="Shot package folder structure">
            <b>PROJECT_VFX/</b>
            {'\n'}└─ <b>SCENE_012/</b>
            {'\n'}   └─ <b>SHOT_012A_030/</b>
            {'\n'}      ├─ 00_SOURCE_REFERENCE/
            {'\n'}      ├─ <i>01_PLATES/</i>
            {'\n'}      ├─ 02_MATTES_ROTO/
            {'\n'}      ├─ 03_KEYS/
            {'\n'}      ├─ 04_CLEAN_PLATES/
            {'\n'}      ├─ 05_TRACKS_2D/
            {'\n'}      ├─ 06_CAMERA_TRACK/
            {'\n'}      ├─ 07_TEXTURES_REFERENCES/
            {'\n'}      ├─ 08_PREVIEWS/
            {'\n'}      ├─ 09_PROJECT_DATA/
            {'\n'}      ├─ 10_DELIVERY/
            {'\n'}      ├─ <i>manifest.json</i>
            {'\n'}      └─ <i>prep_report</i>
          </pre>
          <div>
            <span className="eyebrow">Plates and packages</span>
            <h2>Plates your facility will trust.</h2>
            <p className="lead">
              The first processing stage turns the designated footage into the image sequence the production
              asked for, then writes a package any artist recognises.
            </p>
            <ul className="ticks">
              <li>
                DPX, TIFF and EXR sequences <span>— with frame numbering preserved</span>
              </li>
              <li>
                Renumbered from 1001 <span>— or any start frame, with optional head and tail handles</span>
              </li>
              <li>
                No baked looks <span>— colour settings are explicit and display transforms stay out of plates</span>
              </li>
              <li>
                Source checksum verification <span>— and checksums for every deliverable written</span>
              </li>
              <li>
                Timecode, reel, scene, take, camera and lens <span>— carried into the manifest</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section" id="principles">
        <div className="shell">
          <div className="section-head">
            <span className="eyebrow">Safety principles</span>
            <h2>Built like production media matters. Because it does.</h2>
          </div>
          <div className="grid three">
            <article className="card principle">
              <span className="num">01</span>
              <h3>Originals are never touched.</h3>
              <p>
                Camera media is read, verified against its checksums and left exactly as it was. Nothing is
                altered, moved or deleted.
              </p>
            </article>
            <article className="card principle">
              <span className="num">02</span>
              <h3>Everything is reproducible.</h3>
              <p>
                Every output can be rebuilt from source plus settings. Outputs are versioned, not overwritten, and
                operations are logged with their parameters.
              </p>
            </article>
            <article className="card principle">
              <span className="num">03</span>
              <h3>Approval is human.</h3>
              <p>
                Finishing a process never means a shot is approved. A person approves each task and each shot, and
                the record says who and when.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="section" id="roadmap">
        <div className="shell">
          <div className="section-head">
            <span className="eyebrow">Roadmap</span>
            <h2>V1 is the prep foundation. The rest is coming.</h2>
            <p>
              VC VFX ships the handoff, the queue and the plates first. The modules below are on the roadmap — and
              they can already be requested in the handoff and tracked per shot in the queue.
            </p>
          </div>
          <ol className="roadmap">
            {ROADMAP.map((item, index) => (
              <li key={item.title} className={item.v1 ? 'v1' : undefined}>
                <span className="idx">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{item.title}</strong>
                  <span className="desc">{item.desc}</span>
                </div>
                <span className={item.v1 ? 'badge v1' : 'badge'}>{item.v1 ? 'V1' : 'Roadmap'}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" id="vcdit">
        <div className="shell">
          <div className="companion">
            <div className="left">
              <span className="eyebrow">Companion to VCDIT</span>
              <h2>The DIT organises it. VC VFX prepares it.</h2>
              <p>
                VCDIT identifies the VFX-designated shots on set, duplicates them into a dedicated VFX hierarchy
                while the editorial originals stay untouched, and writes a machine-readable handoff that travels
                with the drive. VC VFX picks that handoff up and builds the queue automatically.
              </p>
              <p style={{ marginTop: 24 }}>
                <a href="https://vc-dit.com" className="button secondary">
                  Visit vc-dit.com →
                </a>
              </p>
            </div>
            <div className="right">
              <div className="handoff-flow" aria-label="Handoff flow">
                <div>
                  <span>VCDIT</span>
                  <span>on set · organise &amp; duplicate</span>
                </div>
                <div className="down">↓ handoff.json on the drive</div>
                <div>
                  <span>VC VFX</span>
                  <span>queue · verify · plates · package</span>
                </div>
                <div className="down">↓ shot packages + manifests</div>
                <div>
                  <span>Artist / VFX house</span>
                  <span>starts from validated prep</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="pricing">
        <div className="shell">
          <div className="section-head">
            <span className="eyebrow">Pricing</span>
            <h2>One subscription. Windows and macOS.</h2>
            <p>Every plan includes both platforms, two active computers and every update while subscribed.</p>
          </div>
          <PricingCards plans={plans} />
        </div>
      </section>

      <section className="section" id="download">
        <div className="shell">
          <div className="cta-band">
            <div>
              <h2>Download VC VFX</h2>
              <p>
                Installers for Windows and macOS are on your account page once you subscribe. Sign in to the app
                with the same account and it activates itself.
              </p>
            </div>
            <div className="actions">
              <Link href="/download" className="button large">
                Download
              </Link>
              <Link href="/account" className="button secondary large">
                My account
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="faq">
        <div className="shell">
          <div className="section-head">
            <span className="eyebrow">FAQ</span>
            <h2>Questions, answered.</h2>
          </div>
          <div className="faq">
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
