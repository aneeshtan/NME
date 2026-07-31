/**
 * Wordmark. The glyph is a rounded aperture — a lens that is also a shield,
 * which is the whole product in one shape.
 */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 select-none">
      <svg
        viewBox="0 0 32 32"
        className="h-7 w-7 shrink-0"
        role="img"
        aria-label="NME Talk"
        focusable="false"
      >
        <rect width="32" height="32" rx="9" className="fill-accent" />
        <path
          d="M11 11.5A1.5 1.5 0 0 1 13.4 10.3l5.8 4.3a1.5 1.5 0 0 1 0 2.4l-5.8 4.3A1.5 1.5 0 0 1 11 20.1z"
          className="fill-white"
        />
      </svg>
      {!compact && (
        <span className="text-[1.0625rem] font-semibold tracking-tight text-fg">NME Talk</span>
      )}
    </span>
  );
}
