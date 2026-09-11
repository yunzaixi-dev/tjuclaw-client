import type { ImgHTMLAttributes } from 'react';
import brandIconUrl from '../assets/brand-icon.webp';
import './brand-icon.css';

export interface BrandIconProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** Optional accessible label. If omitted, image is marked decorative with alt=''. */
  label?: string;
  size?: number | string;
}

export function BrandIcon({
  alt,
  label,
  size,
  className = '',
  width,
  height,
  style,
  ...rest
}: BrandIconProps) {
  const resolvedAlt = label !== undefined ? label : (alt ?? '');
  const resolvedWidth = width ?? size;
  const resolvedHeight = height ?? size;

  return (
    <img
      src={brandIconUrl}
      alt={resolvedAlt}
      aria-hidden={resolvedAlt === '' ? true : undefined}
      width={resolvedWidth}
      height={resolvedHeight}
      className={`brand-icon ${className}`.trim()}
      style={{
        ...(size !== undefined
          ? {
              width: typeof size === 'number' ? `${size}px` : size,
              height: typeof size === 'number' ? `${size}px` : size,
            }
          : undefined),
        ...style,
      }}
      {...rest}
    />
  );
}
