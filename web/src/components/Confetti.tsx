import { useEffect, useRef } from 'react'

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899']
const DURATION_MS = 3500

interface Piece {
  id: number
  startX: number     // viewport x in vw (0-100)
  color: string
  delayMs: number    // 0-500
  durationMs: number // ~1800-2800
  driftPx: number    // -150..+150
  spinDeg: number    // -720..+720
  size: number       // 6-12 px
}

interface ConfettiProps {
  count?: number
  onAnimationEnd?: () => void
}

export default function Confetti({ count = 100, onAnimationEnd }: ConfettiProps) {
  // Pieces are generated once and frozen for the mount lifetime — random start
  // positions/colors must stay stable across re-renders, mirroring mobile's
  // useRef pattern in components/Confetti.tsx.
  const pieces = useRef<Piece[]>(
    Array.from({ length: count }, (_, i) => ({
      id: i,
      startX: Math.random() * 100,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delayMs: Math.random() * 500,
      durationMs: 1800 + Math.random() * 1000,
      driftPx: (Math.random() - 0.5) * 300,
      spinDeg: (Math.random() - 0.5) * 1440,
      size: 6 + Math.random() * 6,
    }))
  ).current

  useEffect(() => {
    // Self-clean via timer — covers max delay (500ms) + max duration (~2800ms).
    // After this, every piece is offscreen and faded; parent unmounts us.
    const t = setTimeout(() => {
      onAnimationEnd?.()
    }, DURATION_MS)
    return () => clearTimeout(t)
  }, [onAnimationEnd])

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes pip-confetti-fall {
          0%   { transform: translate(0, 0) rotate(0deg); opacity: 1; }
          70%  { opacity: 1; }
          100% { transform: translate(var(--pip-drift), 110vh) rotate(var(--pip-spin)); opacity: 0; }
        }
      `}</style>
      {pieces.map(p => (
        <span
          key={p.id}
          style={{
            position: 'absolute',
            top: -20,
            left: `${p.startX}vw`,
            width: p.size,
            height: p.size * 1.6,
            backgroundColor: p.color,
            borderRadius: 1,
            animation: `pip-confetti-fall ${p.durationMs}ms ease-in ${p.delayMs}ms forwards`,
            ['--pip-drift' as string]: `${p.driftPx}px`,
            ['--pip-spin' as string]: `${p.spinDeg}deg`,
            willChange: 'transform, opacity',
          }}
        />
      ))}
    </div>
  )
}
