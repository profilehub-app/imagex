import React, { useId } from 'react';

export interface ImagexAppMarkProps {
  size?: number;
  className?: string;
}

/**
 * Crisp geometric vector adaptation of IMAGEX's metallic lens + neon violet/cyan X app icon,
 * engineered to stay sharp down to 28x28px in mobile headers without raster blur.
 */
export const ImagexAppMark: React.FC<ImagexAppMarkProps> = ({ size = 28, className = '' }) => {
  const uid = useId().replace(/:/g, '');
  const bezelId = `imx-bezel-${uid}`;
  const lensId = `imx-lens-${uid}`;
  const magentaId = `imx-mag-${uid}`;
  const cyanId = `imx-cyan-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-imagex-app-mark="true"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={bezelId} x1="2" y1="2" x2="34" y2="34" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#94a3b8" />
          <stop offset="48%" stopColor="#1e293b" />
          <stop offset="100%" stopColor="#475569" />
        </linearGradient>
        <radialGradient id={lensId} cx="42%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#1e293b" />
          <stop offset="70%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#090d16" />
        </radialGradient>
        <linearGradient id={magentaId} x1="15" y1="8" x2="21" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f472b6" />
          <stop offset="50%" stopColor="#d946ef" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <linearGradient id={cyanId} x1="21" y1="8" x2="29" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#67e8f9" />
          <stop offset="55%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="34.5" height="34.5" rx="9" fill="#0b101b" stroke={`url(#${bezelId})`} strokeWidth="1.5" />
      <circle cx="15" cy="18" r="10.2" fill={`url(#${lensId})`} stroke="#475569" strokeWidth="1" />
      <path d="M15 8.5A9.5 9.5 0 0 0 15 27.5" stroke="#a855f7" strokeOpacity="0.6" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M8.5 14.5L13.5 17.5M8.5 21.5L13.5 18.5" stroke="#64748b" strokeOpacity="0.55" strokeWidth="0.9" strokeLinecap="round" />
      <circle cx="15" cy="18" r="4" fill="#172554" stroke="#60a5fa" strokeWidth="1.2" />
      <circle cx="14.1" cy="17" r="1.2" fill="#93c5fd" fillOpacity="0.85" />
      <path d="M15.8 9L21.8 18L15.8 27" stroke={`url(#${magentaId})`} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M27.8 9L21.8 18L27.8 27" stroke={`url(#${cyanId})`} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};
