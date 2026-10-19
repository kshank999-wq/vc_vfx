/** The VC VFX mark: registration corners around a half-matted circle. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#14161c" stroke="#353a47" />
      <path
        d="M7 12V7h5M20 7h5v5M25 20v5h-5M12 25H7v-5"
        fill="none"
        stroke="#f2a33a"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="5.2" fill="none" stroke="#f2a33a" strokeWidth="1.6" />
      <path d="M16 10.8a5.2 5.2 0 0 1 0 10.4z" fill="#f2a33a" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <>
      <Mark />
      <span>
        VC <b>VFX</b>
      </span>
    </>
  );
}
