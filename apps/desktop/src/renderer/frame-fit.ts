/**
 * Where a plate frame sits on screen, honouring its pixel aspect
 * (addendum 17). A frame of `size` stored pixels is shown de-squeezed — its
 * width × the pixel aspect — and "contained" in its stage (letterboxed,
 * centred). Overlays are stored in image pixels and drawn through the same
 * box, so a point maps exactly both ways. With `pixelAspect` 1 this is the
 * plain contain fit every workspace used before.
 *
 * Pure (no DOM), so the mapping is tested exactly.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The frame's box inside a stage of `stage` size, in the stage's own coordinates. */
export function fitFrame(stage: Size, size: Size, pixelAspect: number): Box & { scale: number } {
  const shownW = size.width * pixelAspect;
  const s = Math.min(stage.width / shownW, stage.height / size.height) || 1;
  const width = shownW * s;
  const height = size.height * s;
  return { left: (stage.width - width) / 2, top: (stage.height - height) / 2, width, height, scale: s };
}

/**
 * Stage-relative pointer position → image pixels; null outside the frame.
 * `clamp` lets a drag that leaves the frame keep its last edge.
 */
export function stageToImage(stage: Size, size: Size, pixelAspect: number, x: number, y: number, clamp = false): { x: number; y: number } | null {
  const b = fitFrame(stage, size, pixelAspect);
  let ix = (x - b.left) / (b.scale * pixelAspect);
  let iy = (y - b.top) / b.scale;
  if (clamp) {
    ix = Math.min(size.width, Math.max(0, ix));
    iy = Math.min(size.height, Math.max(0, iy));
  }
  return ix >= 0 && iy >= 0 && ix <= size.width && iy <= size.height ? { x: ix, y: iy } : null;
}

/** Image pixels → stage-relative position. */
export function imageToStage(stage: Size, size: Size, pixelAspect: number, x: number, y: number): { x: number; y: number } {
  const b = fitFrame(stage, size, pixelAspect);
  return { x: b.left + x * b.scale * pixelAspect, y: b.top + y * b.scale };
}

/** A client (pointer) position → image pixels, against an element's bounding box. */
export function clientToImage(el: Element, size: Size, pixelAspect: number, clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
  const r = el.getBoundingClientRect();
  return stageToImage({ width: r.width, height: r.height }, size, pixelAspect, clientX - r.left, clientY - r.top, clamp);
}

/** A marker radius in image pixels that reads as a circle on screen: [rx, ry]. */
export function markerRadii(r: number, pixelAspect: number): [number, number] {
  return [r / pixelAspect, r];
}
