import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'

export type Profile = {
  fullName: string | null
  startAddress: string | null
  startLat: number | null
  startLng: number | null
  // Pip+ subscription flag. Mobile owns this — RevenueCat is the source of
  // truth and writes it to profiles.is_plus on entitlement changes. Web
  // reads it to gate paid features (Schedule Builder, Smart Placement).
  isPlus: boolean
}

const EMPTY: Profile = { fullName: null, startAddress: null, startLat: null, startLng: null, isPlus: false }

type Ctx = {
  profile: Profile
  loading: boolean
  save: (patch: Partial<Profile>) => Promise<string | null>
  refresh: () => Promise<void>
}

const ProfileCtx = createContext<Ctx | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [profile, setProfile] = useState<Profile>(EMPTY)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!user) { setProfile(EMPTY); setLoading(false); return }
    setLoading(true)
    const { data, error } = await supabase
      .from('profiles')
      .select('full_name, start_address, start_lat, start_lng, is_plus')
      .eq('id', user.id)
      .maybeSingle()
    if (error) {
      console.error('Failed to load profile:', error)
      setProfile(EMPTY)
    } else if (data) {
      setProfile({
        fullName: (data.full_name as string | null) ?? null,
        startAddress: (data.start_address as string | null) ?? null,
        startLat: (data.start_lat as number | null) ?? null,
        startLng: (data.start_lng as number | null) ?? null,
        isPlus: Boolean(data.is_plus ?? false),
      })
    } else {
      setProfile(EMPTY)
    }
    setLoading(false)
  }, [user])

  useEffect(() => { refresh() }, [refresh])

  // Realtime: pick up mobile-side changes (is_plus flip after RevenueCat
  // entitlement, name edits, start address). Filter on PK so we only
  // get our own row.
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel(`profile:${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` },
        payload => {
          const row = (payload.new ?? {}) as Record<string, unknown>
          setProfile({
            fullName: (row.full_name as string | null) ?? null,
            startAddress: (row.start_address as string | null) ?? null,
            startLat: (row.start_lat as number | null) ?? null,
            startLng: (row.start_lng as number | null) ?? null,
            isPlus: Boolean(row.is_plus ?? false),
          })
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user])

  const save = useCallback(async (patch: Partial<Profile>): Promise<string | null> => {
    if (!user) return 'Not signed in'
    const row: Record<string, unknown> = {}
    if ('fullName' in patch) row.full_name = patch.fullName?.trim() || null
    if ('startAddress' in patch) row.start_address = patch.startAddress?.trim() || null
    if ('startLat' in patch) row.start_lat = patch.startLat
    if ('startLng' in patch) row.start_lng = patch.startLng
    if (Object.keys(row).length === 0) return null

    const { error } = await supabase.from('profiles').update(row).eq('id', user.id)
    if (error) {
      // First-run fallback: profile row may not exist yet (mobile usually
      // creates it on onboarding, but a web-first signup wouldn't have one).
      const { error: insertErr } = await supabase
        .from('profiles')
        .insert({ id: user.id, ...row })
      if (insertErr) {
        console.error('Failed to save profile:', insertErr)
        return insertErr.message
      }
    }
    setProfile(prev => ({ ...prev, ...patch }))
    return null
  }, [user])

  return (
    <ProfileCtx.Provider value={{ profile, loading, save, refresh }}>
      {children}
    </ProfileCtx.Provider>
  )
}

export function useProfile(): Ctx {
  const ctx = useContext(ProfileCtx)
  if (!ctx) throw new Error('useProfile must be inside ProfileProvider')
  return ctx
}
