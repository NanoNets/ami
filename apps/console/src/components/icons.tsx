/** The console's single icon set: 24×24 stroke SVGs rendered at 12–16px.
 * Everything that used to be an emoji or a text glyph (⚙ 🔊 🎤 🔒 ✓ ✗ ↗ ✕ …)
 * goes through here so weight and color always match the type around it. */

const p = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

type IconProps = { size?: number; className?: string };

export const TerminalIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

export const FileIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

export const GlobeIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

export const SparkIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
  </svg>
);

export const ToolIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

export const EyeIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const BrainIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z" />
  </svg>
);

export const SearchIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.2" y2="16.2" />
  </svg>
);

export const ZapIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

export const TrendUpIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </svg>
);

export const ChevronIcon = ({ size = 14, className, open }: IconProps & { open?: boolean }) => (
  <svg {...p(size)} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""} ${className ?? ""}`}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export const MicIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
    <line x1="12" y1="18" x2="12" y2="22" />
  </svg>
);

export const SpeakerIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

export const StopIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <rect x="6" y="6" width="12" height="12" />
  </svg>
);

export const LockIcon = ({ size = 12, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <rect x="4" y="11" width="16" height="10" rx="1" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const PlusIcon = ({ size = 12, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const CheckIcon = ({ size = 12, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const XIcon = ({ size = 12, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const ExternalIcon = ({ size = 12, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

export const DotsIcon = ({ size = 16, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <circle cx="5" cy="12" r="0.8" />
    <circle cx="12" cy="12" r="0.8" />
    <circle cx="19" cy="12" r="0.8" />
  </svg>
);

export const SproutIcon = ({ size = 28, className }: IconProps) => (
  <svg {...p(size)} className={className} strokeWidth={1.5}>
    <path d="M12 21v-8" />
    <path d="M12 13c0-4 3-7 8-7 0 4-3 7-8 7z" />
    <path d="M12 13c0-3-2.5-5.5-6.5-5.5 0 3.2 2.5 5.5 6.5 5.5z" />
  </svg>
);

export const BranchIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7" />
    <path d="M18 10.5a6 6 0 0 1-6 5.5H8.5" />
  </svg>
);

export const CalendarIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <rect x="3" y="5" width="18" height="16" rx="1" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <line x1="8" y1="3" x2="8" y2="7" />
    <line x1="16" y1="3" x2="16" y2="7" />
  </svg>
);

export const VideoIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <rect x="2" y="6" width="14" height="12" rx="1" />
    <path d="M16 10l6-3v10l-6-3" />
  </svg>
);

export const MegaphoneIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M3 11l14-6v14L3 13v-2z" />
    <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </svg>
);

export const PaperclipIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

export const BoxIcon = ({ size = 14, className }: IconProps) => (
  <svg {...p(size)} className={className}>
    <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
    <path d="M3 8l9 5 9-5" />
    <line x1="12" y1="13" x2="12" y2="21" />
  </svg>
);

/** Quiet progress indicator: a slow spinner, never a pulse. Pulsing is
 * reserved for the one thing waiting on the user (pending questions). */
export const Spinner = ({ size = 12, className }: IconProps) => (
  <svg {...p(size)} className={`animate-spin ${className ?? ""}`} style={{ animationDuration: "1.2s" }}>
    <path d="M12 2a10 10 0 0 1 10 10" />
  </svg>
);
