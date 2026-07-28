/**
 * Inline SVG icons.
 *
 * Hand-rolled rather than pulled from an icon package: the app needs eight
 * glyphs, and every icon library costs tens of kilobytes plus a render-time
 * component layer for the same result. These are `currentColor` throughout, so
 * they inherit state styling for free.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </Icon>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 9v3a3 3 0 0 0 4.6 2.5" />
      <path d="M15 11.5V6a3 3 0 0 0-5.6-1.5" />
      <path d="M5 11a7 7 0 0 0 10.6 6" />
      <path d="M19 11a7 7 0 0 1-.6 2.8" />
      <path d="M12 18v3" />
      <path d="m3 3 18 18" />
    </Icon>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="6" width="12" height="12" rx="2.5" />
      <path d="m15 11 5-3v8l-5-3z" />
    </Icon>
  );
}

export function CameraOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 6H13a2 2 0 0 1 2 2v1.5" />
      <path d="M15 14.5V16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 .6-1.4" />
      <path d="m15 11 5-3v8l-3-1.8" />
      <path d="m3 3 18 18" />
    </Icon>
  );
}

export function ScreenShareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 7.5v5" />
      <path d="m9.5 10 2.5-2.5 2.5 2.5" />
    </Icon>
  );
}

export function ScreenShareStopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M9.5 10.5 12 13l2.5-2.5" />
    </Icon>
  );
}

export function LeaveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 12.5c4.7-4.7 12.3-4.7 17 0l-2.2 2.2a1.6 1.6 0 0 1-2.1.1l-1.5-1.2a1.6 1.6 0 0 1-.5-1.7l.3-1a9.6 9.6 0 0 0-5 0l.3 1c.2.6 0 1.3-.5 1.7l-1.5 1.2a1.6 1.6 0 0 1-2.1-.1z" />
    </Icon>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 6.3" />
      <path d="M17.5 14.6A5.5 5.5 0 0 1 20.5 19" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3 5 6v5.5c0 4 2.9 7.6 7 8.5 4.1-.9 7-4.5 7-8.5V6z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  );
}

/** Signal bars. `level` 0-3; unfilled bars render at low opacity. */
export function SignalIcon({ level = 3, ...props }: IconProps & { level?: number }) {
  return (
    <Icon {...props} strokeWidth={2} strokeLinecap="round">
      <path d="M5 18v-2" opacity={level >= 1 ? 1 : 0.25} />
      <path d="M10 18v-6" opacity={level >= 2 ? 1 : 0.25} />
      <path d="M15 18v-9" opacity={level >= 3 ? 1 : 0.25} />
      <path d="M20 18V5" opacity={level >= 4 ? 1 : 0.25} />
    </Icon>
  );
}

export function VideoOffAllIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="6" width="12" height="12" rx="2.5" />
      <path d="m15 11 5-3v8l-5-3z" />
      <path d="m3 3 18 18" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12a7.5 7.5 0 0 1-7.5 7.5H8l-4 2.5v-4.2A7.5 7.5 0 0 1 12.5 4.5 7.5 7.5 0 0 1 20 12Z" />
    </Icon>
  );
}

/** Grid vs stage layout. */
export function LayoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="12" height="14" rx="2" />
      <rect x="17" y="5" width="4" height="6" rx="1.2" />
      <rect x="17" y="13" width="4" height="6" rx="1.2" />
    </Icon>
  );
}
