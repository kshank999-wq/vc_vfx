import type { ModuleId } from '../modules';

/** Line icons for the module tabs and the shot list, drawn on a 24-unit grid in the current colour. */

export type IconName = ModuleId | 'settings' | 'help' | 'user' | 'prev' | 'next' | 'check' | 'chevron' | 'close' | 'ai' | 'info' | 'folder' | 'warning';

const PATHS: Record<IconName, JSX.Element> = {
  shots: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14h18M8 4v16" />
    </>
  ),
  plates: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
    </>
  ),
  roto: (
    <>
      <path d="M4 20c2.5 0 4-1.2 4-3.2 0-1.3-1-2.3-2.2-2.3C4.4 14.5 4 16 4 17.2 4 18.6 3.4 19.6 2.6 20" />
      <path d="M9.5 15.5 20 5a1.8 1.8 0 0 0-2.5-2.5L7 13" />
    </>
  ),
  key: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <path d="M12 8.2c1.6 2 2.4 3.3 2.4 4.3a2.4 2.4 0 0 1-4.8 0c0-1 .8-2.3 2.4-4.3Z" />
      <path d="M8 21h8" />
    </>
  ),
  cleanplate: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="1.5" />
      <circle cx="11" cy="8.6" r="1.7" strokeDasharray="1.6 1.4" />
      <path d="M8 18v-3.4a3 3 0 0 1 6 0V18" strokeDasharray="1.6 1.4" />
      <path d="m15.5 21 5-5" />
    </>
  ),
  isolate: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="1.5" />
      <path d="M3 13.5h3.5v-3h3v-2h3v4h3v-2h5.5" />
      <path d="M8 8.2c1.6-.9 3.2-.9 4.8 0" strokeDasharray="1.4 1.3" />
      <path d="M7 21h10" />
    </>
  ),
  texture: (
    <>
      <path d="M3 8.5 9.5 5l6.5 3.5-6.5 3.5Z" />
      <path d="M3 8.5v7l6.5 3.5v-7" />
      <path d="M13 14h8v7h-8z" />
      <path d="M17 14v7M13 17.5h8" />
    </>
  ),
  comp: (
    <>
      <rect x="2.5" y="3" width="7" height="5" rx="1" />
      <rect x="14.5" y="3" width="7" height="5" rx="1" />
      <rect x="8.5" y="16" width="7" height="5" rx="1" />
      <path d="M6 8v3.5c0 1.4 1 2.5 2.5 2.5H11v2M18 8v3.5c0 1.4-1 2.5-2.5 2.5H13v2" />
    </>
  ),
  lighting: (
    <>
      <circle cx="9" cy="14" r="3.5" />
      <path d="M9 7.5v-2M3.5 14h-2M5.1 10.1 3.7 8.7M12.9 10.1l1.4-1.4" />
      <path d="M14.5 4.5 21 3l-1.5 6.5-5-5z" />
      <path d="M15.5 9.5 12 13" />
    </>
  ),
  camera: (
    <>
      <rect x="2.5" y="7" width="13" height="10" rx="1.5" />
      <path d="m15.5 10.5 6-3v9l-6-3" />
      <circle cx="6.5" cy="4.5" r="1.8" />
      <circle cx="11.5" cy="4.5" r="1.8" />
    </>
  ),
  track2d: (
    <>
      <path d="M5 6.5 18.5 4 20 17.5 6 20Z" />
      <circle cx="5" cy="6.5" r="1.4" />
      <circle cx="18.5" cy="4" r="1.4" />
      <circle cx="20" cy="17.5" r="1.4" />
      <circle cx="6" cy="20" r="1.4" />
    </>
  ),
  deliver: (
    <>
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M4.2 6.2l2.1 2.1M17.7 15.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 17.8l2.1-2.1M17.7 8.3l2.1-2.1" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.9v.5" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1-4 4.2-6 8-6s7 2 8 6" />
    </>
  ),
  prev: <path d="m15 5-7 7 7 7" />,
  next: <path d="m9 5 7 7-7 7" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  ai: (
    <>
      <path d="M12 3.5 13.8 9l5.7 1.5-5.7 1.6L12 17.5l-1.8-5.4L4.5 10.5 10.2 9Z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <circle cx="12" cy="7.5" r=".6" fill="currentColor" />
    </>
  ),
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z" />,
  warning: (
    <>
      <path d="M12 3.5 21.5 20h-19Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.2" r=".6" fill="currentColor" />
    </>
  ),
};

export function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon-svg${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
