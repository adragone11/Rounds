import { supabase } from './supabase'

export interface Team {
  id: string
  name: string
  owner_id: string
  created_at: string
  invite_code: string | null
}

/** Build the team invite link from the team's invite_code. */
export function getTeamInviteLink(inviteCode: string): string {
  return `${window.location.origin}/invite/${inviteCode}`
}

/** Join a team using an invite code. */
export async function joinTeamByCode(inviteCode: string): Promise<TeamMember> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase.rpc('join_team_by_code', {
    p_invite_code: inviteCode,
    p_user_id: user.id,
    p_email: user.email ?? '',
    p_name: user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Member',
  })

  if (error) throw error
  if (!data || data.length === 0) throw new Error('Failed to join team')
  return data[0] as TeamMember
}

export interface TeamMember {
  id: string
  team_id: string
  user_id: string | null
  email: string
  name: string | null
  role: 'owner' | 'cleaner'
  status: 'invited' | 'active' | 'deactivated'
  invited_at: string
  joined_at: string | null
  color: string
  invite_token: string | null
}

const MEMBER_COLORS = ['#3B82F6', '#10B981', '#F97316', '#EC4899', '#8B5CF6', '#06B6D4', '#EF4444']

function pickColor(existingMembers: number): string {
  return MEMBER_COLORS[existingMembers % MEMBER_COLORS.length]
}

/** Build an invite link from a member's invite_token. */
export function getInviteLink(inviteToken: string): string {
  return `${window.location.origin}/invite/${inviteToken}`
}

/** Get the current user's team (if any). Returns null for solo users. */
export async function getMyTeam(): Promise<{ team: Team; members: TeamMember[]; myMembership: TeamMember } | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // Check if user owns a team
  const { data: ownedTeam } = await supabase
    .from('teams')
    .select('*')
    .eq('owner_id', user.id)
    .maybeSingle()

  if (ownedTeam) {
    const { data: members } = await supabase
      .from('team_members')
      .select('*')
      .eq('team_id', ownedTeam.id)
      .order('invited_at')

    const myMembership = (members ?? []).find(m => m.user_id === user.id)
    return {
      team: ownedTeam as Team,
      members: (members ?? []) as TeamMember[],
      myMembership: myMembership as TeamMember,
    }
  }

  // Check if user is a member of someone else's team
  const { data: membership } = await supabase
    .from('team_members')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle()

  if (!membership) return null

  const { data: team } = await supabase
    .from('teams')
    .select('*')
    .eq('id', membership.team_id)
    .single()

  if (!team) return null

  const { data: members } = await supabase
    .from('team_members')
    .select('*')
    .eq('team_id', team.id)
    .order('invited_at')

  return {
    team: team as Team,
    members: (members ?? []) as TeamMember[],
    myMembership: membership as TeamMember,
  }
}

/** Create a new team. The creator becomes the owner member. */
export async function createTeam(name: string): Promise<{ team: Team; ownerMember: TeamMember }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: team, error: teamErr } = await supabase
    .from('teams')
    .insert({ name, owner_id: user.id })
    .select()
    .single()

  if (teamErr || !team) {
    console.error('Team insert failed:', teamErr?.message, teamErr?.details, teamErr?.hint, teamErr?.code)
    throw teamErr ?? new Error('Failed to create team')
  }

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .insert({
      team_id: team.id,
      user_id: user.id,
      email: user.email ?? '',
      name: user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Owner',
      role: 'owner',
      status: 'active',
      joined_at: new Date().toISOString(),
      color: MEMBER_COLORS[0],
    })
    .select()
    .single()

  if (memberErr || !member) throw memberErr ?? new Error('Failed to create owner member')

  // Backfill existing clients/jobs with team_id
  await supabase.from('clients').update({ team_id: team.id }).eq('user_id', user.id)
  await supabase.from('jobs').update({ team_id: team.id }).eq('user_id', user.id)

  return { team: team as Team, ownerMember: member as TeamMember }
}

/** Invite a new member. Returns the member with invite_token for link generation. */
export async function inviteMember(teamId: string, email: string, name?: string): Promise<TeamMember> {
  const { data: existing } = await supabase
    .from('team_members')
    .select('id')
    .eq('team_id', teamId)

  const { data, error } = await supabase
    .from('team_members')
    .insert({
      team_id: teamId,
      email: email.toLowerCase().trim(),
      name: name?.trim() || null,
      role: 'cleaner',
      status: 'invited',
      color: pickColor(existing?.length ?? 1),
    })
    .select()
    .single()

  if (error || !data) throw error ?? new Error('Failed to invite member')
  return data as TeamMember
}

/** Update a member's role or status. */
export async function updateMember(memberId: string, updates: { role?: 'owner' | 'cleaner'; status?: 'active' | 'deactivated'; name?: string }): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .update(updates)
    .eq('id', memberId)

  if (error) throw error
}

/** Remove a member from the team. */
export async function removeMember(memberId: string): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('id', memberId)

  if (error) throw error
}

/** Look up an invite by token (public — no auth needed for lookup). */
export async function getInviteByToken(token: string): Promise<{ member: TeamMember; teamName: string } | null> {
  // Use a direct RPC or anon query — invite_token lookup needs to bypass RLS
  // Since the invite is pending (no user_id), the member can't see it via RLS.
  // We query teams (which has a public-ish name) and team_members together.
  // For now, use the service role via an API route. As a simpler approach,
  // we'll do it client-side: the user must be logged in to accept.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // The logged-in user can see invited members if they match by email
  // But they can't query by invite_token directly since RLS blocks it.
  // Workaround: use an RPC function.
  const { data, error } = await supabase.rpc('get_invite_by_token', { p_token: token })
  if (error || !data || data.length === 0) return null

  const row = data[0]
  return {
    member: {
      id: row.id,
      team_id: row.team_id,
      user_id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      invited_at: row.invited_at,
      joined_at: row.joined_at,
      color: row.color,
      invite_token: row.invite_token,
    },
    teamName: row.team_name,
  }
}

/** Accept an invite by token. Links the current user to the team member row. */
export async function acceptInviteByToken(token: string): Promise<TeamMember> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase.rpc('accept_invite', {
    p_token: token,
    p_user_id: user.id,
  })

  if (error) throw error
  if (!data || data.length === 0) throw new Error('Invite not found or already accepted')
  return data[0] as TeamMember
}

/** Auto-accept: check if the logged-in user's email matches any pending invite. */
export async function checkAndAcceptInvite(): Promise<TeamMember | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return null

  // Use RPC to find and accept by email (bypasses RLS for pending rows)
  const { data, error } = await supabase.rpc('accept_invite_by_email', {
    p_email: user.email.toLowerCase(),
    p_user_id: user.id,
  })

  if (error || !data || data.length === 0) return null
  return data[0] as TeamMember
}
