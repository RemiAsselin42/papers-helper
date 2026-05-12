import styles from './Skeleton.module.scss'

interface SkeletonProps {
  width?: string | number | (string | number)[]
  height?: string | number
  radius?: string
  count?: number
  gap?: string | number
  className?: string
}

function px(v: string | number): string {
  return typeof v === 'number' ? `${v}px` : v
}

export function Skeleton({
  width = '100%',
  height = 16,
  radius = 'var(--radius-sm)',
  count = 1,
  gap = 8,
  className,
}: SkeletonProps) {
  const widths = Array.isArray(width) ? width : Array.from({ length: count }, () => width)

  if (count <= 1) {
    return (
      <span
        className={`${styles.bone} ${className ?? ''}`}
        style={{ width: px(widths[0]), height: px(height), borderRadius: radius }}
        aria-hidden
      />
    )
  }

  return (
    <div
      className={`${styles.group} ${className ?? ''}`}
      style={{ gap: px(gap) }}
      aria-hidden
    >
      {widths.map((w, i) => (
        <span
          key={i}
          className={styles.bone}
          style={{ width: px(w), height: px(height), borderRadius: radius }}
        />
      ))}
    </div>
  )
}
