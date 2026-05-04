import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { useLanguage } from '../lib/language'
import { getMyTeam, createTeam, getTeamInviteLink, updateMember, removeMember, type Team, type TeamMember } from '../lib/teams'

const ROLE_COLORS: Record<string, { color: string; bg: string }> = {
  owner:   { color: '#3B82F6', bg: '#EFF6FF' },
  cleaner: { color: '#10B981', bg: '#ECFDF5' },
}

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  active:      { color: '#10B981', bg: '#ECFDF5' },
  invited:     { color: '#F59E0B', bg: '#FFFBEB' },
  deactivated: { color: '#9CA3AF', bg: '#F3F4F6' },
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export default function TeamPage() {
  const { user } = useAuth()
  const { t } = useLanguage()
  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [myRole, setMyRole] = useState<'owner' | 'cleaner' | null>(null)
  const [loading, setLoading] = useState(true)

  const [showCreate, setShowCreate] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [creating, setCreating] = useState(false)

  const [showInvite, setShowInvite] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)

  const roleLabel = (role: string): string => {
    if (role === 'owner') return t('team.role.owner')
    if (role === 'cleaner') return t('team.role.cleaner')
    return role
  }

  const statusLabel = (status: string): string => {
    if (status === 'active') return t('team.status.active')
    if (status === 'invited') return t('team.status.invited')
    if (status === 'deactivated') return t('team.status.deactivated')
    return status
  }

  const loadTeam = useCallback(async () => {
    if (!user) { setLoading(false); return }
    try {
      const result = await getMyTeam()
      if (result) {
        setTeam(result.team)
        setMembers(result.members)
        setMyRole(result.myMembership?.role ?? null)
      }
    } catch (err) {
      console.error('Failed to load team:', err)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { void loadTeam() }, [loadTeam])

  const handleCreateTeam = async () => {
    if (!teamName.trim()) return
    setCreating(true)
    try {
      const { team: newTeam, ownerMember } = await createTeam(teamName.trim())
      setTeam(newTeam)
      setMembers([ownerMember])
      setMyRole('owner')
      setShowCreate(false)
      setTeamName('')
    } catch (err) {
      const e = err as any
      console.error('Failed to create team:', e?.message, e)
      alert(`${t('team.create.failed')}: ${e?.message || t('team.unknownError')}`)
    } finally {
      setCreating(false)
    }
  }

  const handleCopyInviteLink = () => {
    if (!team?.invite_code) return
    const link = getTeamInviteLink(team.invite_code)
    void navigator.clipboard.writeText(link)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 2000)
  }

  const handleDeactivate = async (member: TeamMember) => {
    if (member.role === 'owner') return
    const isReactivate = member.status === 'deactivated'
    const displayName = member.name || member.email
    const message = isReactivate
      ? t('team.confirm.reactivate', { name: displayName })
      : t('team.confirm.deactivate', { name: displayName })
    if (!confirm(message)) return
    try {
      await updateMember(member.id, { status: isReactivate ? 'active' : 'deactivated' })
      setMembers(prev => prev.map(m => m.id === member.id ? { ...m, status: isReactivate ? 'active' : 'deactivated' } : m))
    } catch (err) {
      console.error('Failed to update member:', err)
    }
  }

  const handleRemove = async (member: TeamMember) => {
    if (member.role === 'owner') return
    const displayName = member.name || member.email
    if (!confirm(t('team.confirm.remove', { name: displayName }))) return
    try {
      await removeMember(member.id)
      setMembers(prev => prev.filter(m => m.id !== member.id))
    } catch (err) {
      console.error('Failed to remove member:', err)
    }
  }

  const isOwner = myRole === 'owner'
  const activeMembers = members.filter(m => m.status === 'active')
  const deactivatedMembers = members.filter(m => m.status === 'deactivated')

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-page">
        <p className="text-sm text-gray-400">{t('team.loading')}</p>
      </div>
    )
  }

  // No team yet
  if (!team) {
    return (
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface-page">
        <div className="shrink-0 px-8 pt-7 pb-5">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">{t('team.title')}</h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          {showCreate ? (
            <div className="bg-white rounded-3xl shadow-lg p-8 w-full max-w-sm">
              <h2 className="text-lg font-bold text-gray-900 mb-1">{t('team.create.title')}</h2>
              <p className="text-sm text-gray-400 mb-5">{t('team.create.subtitle')}</p>
              <input
                autoFocus
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateTeam()}
                placeholder={t('team.create.placeholder')}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200 mb-4"
              />
              <div className="flex gap-2">
                <button onClick={() => setShowCreate(false)} className="flex-1 px-4 py-2.5 text-sm text-gray-500 rounded-xl hover:bg-gray-50">{t('common.cancel')}</button>
                <button onClick={handleCreateTeam} disabled={!teamName.trim() || creating}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold text-white rounded-xl disabled:opacity-40 transition-colors" style={{ backgroundColor: '#4A7CFF' }}>
                  {creating ? t('team.create.creating') : t('team.create.submit')}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-white flex items-center justify-center mx-auto mb-4 shadow-sm">
                <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-gray-900 mb-1">{t('team.empty.title')}</h2>
              <p className="text-sm text-gray-400 mb-5 max-w-xs">{t('team.empty.subtitle')}</p>
              <button onClick={() => setShowCreate(true)}
                className="px-5 py-2.5 text-sm font-semibold text-white rounded-xl transition-colors" style={{ backgroundColor: '#4A7CFF' }}>
                {t('team.create.submit')}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Has a team
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface-page">
      <div className="shrink-0 px-8 pt-7 pb-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">{team.name}</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {activeMembers.length === 1
                ? t('team.memberCount.one', { count: activeMembers.length })
                : t('team.memberCount.other', { count: activeMembers.length })}
            </p>
          </div>
          {isOwner && (
            <button onClick={() => setShowInvite(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white rounded-xl transition-colors" style={{ backgroundColor: '#4A7CFF' }}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
              </svg>
              {t('team.inviteMember')}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-6">
        {activeMembers.length > 0 && (
          <div className="mb-6">
            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 px-1">{t('team.section.active')}</p>
            <div className="space-y-2">
              {activeMembers.map(member => (
                <MemberCard key={member.id} member={member} isOwner={isOwner} onDeactivate={handleDeactivate} onRemove={handleRemove} roleLabel={roleLabel} statusLabel={statusLabel} />
              ))}
            </div>
          </div>
        )}

        {deactivatedMembers.length > 0 && (
          <div className="mb-6">
            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 px-1">{t('team.section.deactivated')}</p>
            <div className="space-y-2">
              {deactivatedMembers.map(member => (
                <MemberCard key={member.id} member={member} isOwner={isOwner} onDeactivate={handleDeactivate} onRemove={handleRemove} roleLabel={roleLabel} statusLabel={statusLabel} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Invite modal — just copy the link */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm" onClick={() => { setShowInvite(false); setLinkCopied(false) }}>
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">{t('team.invite.title')}</h2>
            <p className="text-sm text-gray-400 mb-5">{t('team.invite.subtitle')}</p>
            <button
              onClick={handleCopyInviteLink}
              className="w-full px-4 py-3 text-sm font-semibold text-white rounded-xl transition-colors mb-3"
              style={{ backgroundColor: linkCopied ? '#10B981' : '#4A7CFF' }}
            >
              {linkCopied ? t('team.invite.copied') : t('team.invite.copyLink')}
            </button>
            <button onClick={() => { setShowInvite(false); setLinkCopied(false) }}
              className="text-sm text-gray-400 hover:text-gray-600">
              {t('common.done')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MemberCard({ member, isOwner, onDeactivate, onRemove, roleLabel, statusLabel }: {
  member: TeamMember
  isOwner: boolean
  onDeactivate: (m: TeamMember) => void
  onRemove: (m: TeamMember) => void
  roleLabel: (role: string) => string
  statusLabel: (status: string) => string
}) {
  const { t } = useLanguage()
  const [showActions, setShowActions] = useState(false)
  const displayName = member.name || member.email.split('@')[0]
  const roleCfg = ROLE_COLORS[member.role] ?? ROLE_COLORS.cleaner
  const statusCfg = STATUS_COLORS[member.status] ?? STATUS_COLORS.invited

  return (
    <div className="bg-white rounded-2xl shadow-sm px-4 py-3.5 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ backgroundColor: member.color }}>
        {getInitials(displayName)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-gray-900 truncate">{displayName}</p>
          <span className="text-[10px] font-medium px-1.5 py-px rounded-full shrink-0" style={{ color: roleCfg.color, backgroundColor: roleCfg.bg }}>{roleLabel(member.role)}</span>
          {member.status !== 'active' && (
            <span className="text-[10px] font-medium px-1.5 py-px rounded-full shrink-0" style={{ color: statusCfg.color, backgroundColor: statusCfg.bg }}>{statusLabel(member.status)}</span>
          )}
        </div>
        <p className="text-xs text-gray-400 truncate mt-0.5">{member.email}</p>
      </div>
      {isOwner && member.role !== 'owner' && (
        <div className="relative">
          <button onClick={() => setShowActions(!showActions)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
            </svg>
          </button>
          {showActions && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
              <div className="absolute right-0 top-8 z-20 bg-white rounded-xl shadow-lg border border-gray-100 py-1 w-40">
                <button onClick={() => { onDeactivate(member); setShowActions(false) }} className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50">
                  {member.status === 'deactivated' ? t('team.action.reactivate') : t('team.action.deactivate')}
                </button>
                <button onClick={() => { onRemove(member); setShowActions(false) }} className="w-full px-3 py-2 text-sm text-left text-red-500 hover:bg-red-50">
                  {t('common.remove')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
