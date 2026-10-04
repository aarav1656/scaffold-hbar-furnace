/** The supply line stepping down, ending in an ember: the product in one glyph. */
export const Mark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
    <path
      d="M3 7 H11 V13 H18 V19 H25 V25"
      fill="none"
      stroke="var(--color-base-content)"
      strokeWidth="2.6"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    <circle cx="28.5" cy="25" r="3" fill="var(--color-primary)" />
  </svg>
);
