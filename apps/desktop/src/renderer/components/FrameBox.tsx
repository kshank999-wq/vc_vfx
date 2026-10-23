import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { formatPixelAspect, isSquare, shotPixelAspect, type PixelAspectDecision, type Project } from '@vcvfx/domain';
import { fitFrame, type Size } from '../frame-fit';

/**
 * Showing plates at their pixel aspect (addendum 17). Every picture of a shot
 * is shown de-squeezed — in the view only; the pixels are never resampled —
 * unless the artist turns on "Show squeezed" to check the stored raster.
 * The choice is the session's, shared by the viewer and every module.
 */

export interface PixelAspectView {
  squeezed: boolean;
  setSqueezed(on: boolean): void;
}

export const PixelAspectViewContext = createContext<PixelAspectView>({ squeezed: false, setSqueezed: () => undefined });

export function PixelAspectViewProvider({ children }: { children: ReactNode }) {
  const [squeezed, setSqueezed] = useState(false);
  const value = useMemo(() => ({ squeezed, setSqueezed }), [squeezed]);
  return <PixelAspectViewContext.Provider value={value}>{children}</PixelAspectViewContext.Provider>;
}

export interface ShotAspect {
  decision: PixelAspectDecision | null;
  /** The shot's pixel aspect. */
  pixelAspect: number;
  /** The aspect the picture is drawn at: the pixel aspect, or 1 when showing squeezed. */
  display: number;
  squeezed: boolean;
  setSqueezed(on: boolean): void;
}

export function useShotAspect(project: Project | null | undefined, shotId: string | null | undefined): ShotAspect {
  const { squeezed, setSqueezed } = useContext(PixelAspectViewContext);
  const decision = useMemo(() => {
    if (!project || !shotId) return null;
    try {
      return shotPixelAspect(project, shotId);
    } catch {
      return null;
    }
  }, [project, shotId]);
  const pixelAspect = decision?.value ?? 1;
  return { decision, pixelAspect, display: squeezed ? 1 : pixelAspect, squeezed, setSqueezed };
}

/** The stage's size, watched. Null until measured (and in tests without layout). */
export function useStageSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize(width > 0 && height > 0 ? { width, height } : null);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * The frame's box in its stage: canvas and overlays inside it fill it, so
 * they are shown at the de-squeezed shape and map onto each other exactly.
 * Before the stage is measured the box fills the stage and children keep
 * their own contain fit.
 */
export function FrameBox({ stage, size, pixelAspect, children, className }: { stage: Size | null; size: Size | null; pixelAspect: number; children: ReactNode; className?: string }) {
  const box = stage && size ? fitFrame(stage, size, pixelAspect) : null;
  return (
    <div className={`frame-box${box ? ' fitted' : ''}${className ? ` ${className}` : ''}`} style={box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined} data-pixel-aspect={pixelAspect}>
      {children}
    </div>
  );
}

/** `preserveAspectRatio` for an overlay drawn in image pixels inside a FrameBox. */
export const overlayAspect = (stage: Size | null): 'none' | 'xMidYMid meet' => (stage ? 'none' : 'xMidYMid meet');

/** The small tag on a non-square shot's picture: the pixel aspect, and the squeezed / de-squeezed toggle. */
export function AspectTag({ aspect }: { aspect: ShotAspect }) {
  if (isSquare(aspect.pixelAspect)) return null;
  const d = aspect.decision;
  return (
    <button
      type="button"
      className={`aspect-tag${aspect.squeezed ? ' squeezed' : ''}`}
      aria-pressed={aspect.squeezed}
      title={`${d?.summary ?? ''}${d?.warnings.length ? `\n⚠ ${d.warnings.join('\n⚠ ')}` : ''}\nShown ${aspect.squeezed ? 'squeezed (as stored)' : 'de-squeezed (view only; the plate is never resampled)'}. Click to show ${aspect.squeezed ? 'de-squeezed' : 'squeezed'}.`}
      onClick={(e) => {
        e.stopPropagation();
        aspect.setSqueezed(!aspect.squeezed);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      PAR {formatPixelAspect(aspect.pixelAspect)} · {aspect.squeezed ? 'squeezed' : 'de-squeezed'}
      {d?.warnings.length ? ' ⚠' : ''}
    </button>
  );
}
