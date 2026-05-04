import { type ReactNode } from 'react'
import type { PipPlusFeature } from '../lib/entitlements'

/**
 * Rounds rebrand: this gate is fully neutralized. Every feature is free —
 * we just render the children. The component is preserved (not deleted) so
 * existing imports keep working.
 */
export default function PipPlusGate({
  children,
}: {
  feature: PipPlusFeature
  children: ReactNode
  layout?: 'page' | 'inline'
}) {
  return <>{children}</>
}
