import { useState } from 'react'
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { useLanguage } from './lib/language'
import { useProfile } from './lib/profile'
import { useStore } from './store'
import Dashboard from './pages/Dashboard'
import Schedule from './pages/Schedule'
import ScheduleBuilder from './pages/ScheduleBuilder'
import ScheduleChange from './pages/ScheduleChange'
import Clients from './pages/Clients'
import Login from './pages/Login'
import Settings from './pages/Settings'
import Reports from './pages/Reports'
import TeamPage from './pages/Team'
import AcceptInvite from './pages/AcceptInvite'
import PipPlusGate from './components/PipPlusGate'

function getInitial(name: string | null | undefined, email: string | null | undefined): string {
  const src = (name?.trim() || email || 'A').toUpperCase()
  return src[0]
}

function App() {
  const { user, loading: authLoading, signOut } = useAuth()
  const { loading: storeLoading, jobSyncError, clearJobSyncError } = useStore()
  const { t } = useLanguage()
  const { profile } = useProfile()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)

  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-page">
        <div className="text-center">
          <h1 className="text-xl font-bold text-ink-primary mb-2">Rounds</h1>
          <p className="text-sm text-ink-tertiary">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) return <Login />

  const w = collapsed ? 'w-[68px]' : 'w-[232px]'

  const navItem = ({ isActive }: { isActive: boolean }) =>
    [
      'flex items-center rounded-[10px] transition-all duration-150',
      collapsed ? 'justify-center py-2.5' : 'gap-3 px-3 py-2.5',
      isActive
        ? 'bg-white/[0.06] text-white font-semibold'
        : 'text-gray-400 font-medium hover:bg-white/[0.04] hover:text-gray-200',
    ].join(' ')

  const initial = getInitial(profile.fullName, user.email)
  const displayName = profile.fullName || user.email?.split('@')[0] || 'You'
  const startAddress = profile.startAddress || ''

  return (
    <div className="flex h-screen bg-surface-page">
      <aside
        className={`${w} shrink-0 flex flex-col text-white transition-[width] duration-200 ease-out relative z-[2] dark:border-r dark:border-white/[0.06]`}
        style={{ backgroundColor: '#0E1014' }}
      >
        {/* Brand row — icon also serves as the global Add Job trigger so we
            don't lose the + entry point when swapping in the logo mark. */}
        <div className={`flex items-center justify-between border-b border-white/[0.06] ${collapsed ? 'py-5 px-0 justify-center' : 'py-5 px-[18px]'}`}>
          {!collapsed ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={() => navigate('/schedule?action=addJob')}
                title="Add job"
                aria-label="Add job"
                className="w-11 h-11 shrink-0 flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
              >
                <img src="/pip-icon.png" alt="Rounds" className="w-11 h-11 object-contain" />
              </button>
              <div className="min-w-0 leading-tight">
                <div className="text-[18px] font-bold tracking-tight">Rounds</div>
                <div className="text-[10px] text-gray-400 font-medium tracking-tight truncate">Schedule Builder</div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => navigate('/schedule?action=addJob')}
              title="Add job"
              aria-label="Add job"
              className="w-11 h-11 flex items-center justify-center mx-auto hover:scale-105 active:scale-95 transition-transform"
            >
              <img src="/pip-icon.png" alt="Rounds" className="w-11 h-11 object-contain" />
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className={`flex-1 flex flex-col gap-0.5 ${collapsed ? 'px-2 py-3' : 'px-3 py-3'}`}>
          {false && (
          <NavLink to="/" end className={navItem} title={t('nav.dashboard')}>
            <svg className="w-[18px] h-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="9" rx="1.5" />
              <rect x="14" y="3" width="7" height="5" rx="1.5" />
              <rect x="14" y="12" width="7" height="9" rx="1.5" />
              <rect x="3" y="16" width="7" height="5" rx="1.5" />
            </svg>
            {!collapsed && <span className="text-sm">{t('nav.dashboard')}</span>}
          </NavLink>
          )}

          <NavLink to="/schedule" className={navItem} title={t('nav.schedule')}>
            <svg className="w-[18px] h-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M3 9h18M8 3v4M16 3v4" />
            </svg>
            {!collapsed && <span className="text-sm">{t('nav.schedule')}</span>}
          </NavLink>

          <NavLink to="/clients" className={navItem} title={t('nav.clients')}>
            <svg className="w-[18px] h-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="8" r="3.5" />
              <path d="M3 20c0-3 3-5 6-5s6 2 6 5" />
              <circle cx="17" cy="9" r="2.5" />
              <path d="M15 20c0-2 2-4 4-4s2.5 1 2.5 2" />
            </svg>
            {!collapsed && <span className="text-sm">{t('nav.clients')}</span>}
          </NavLink>

          {false && (
          <NavLink to="/settings" className={navItem} title={t('nav.settings')}>
            <svg className="w-[18px] h-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 14a1.5 1.5 0 0 0 .3 1.6l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.5 1.5 0 0 0-1.6-.3 1.5 1.5 0 0 0-.9 1.4V20a2 2 0 0 1-4 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.6.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.5 1.5 0 0 0 .3-1.6 1.5 1.5 0 0 0-1.4-.9H4a2 2 0 0 1 0-4h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.5 1.5 0 0 0 1.6.3H10a1.5 1.5 0 0 0 .9-1.4V4a2 2 0 1 1 4 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.6-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.5 1.5 0 0 0-.3 1.6V10a1.5 1.5 0 0 0 1.4.9H20a2 2 0 0 1 0 4h-.1a1.5 1.5 0 0 0-1.4.9z" />
            </svg>
            {!collapsed && <span className="text-sm">{t('nav.settings')}</span>}
          </NavLink>
          )}
        </nav>

{/* Get iOS app - hidden for Rounds beta */}

        {/* Pip+ promo — hidden in Rounds rebrand */}
        {false && !collapsed && (
          <div className="px-3 pb-3">
            <button
              onClick={() => navigate('/settings')}
              className="w-full flex items-center gap-2.5 rounded-xl px-3.5 py-3 cursor-pointer"
              style={{
                background: profile.isPlus
                  ? 'linear-gradient(135deg, #1E40AF 0%, #3B82F6 100%)'
                  : 'rgba(255,255,255,0.04)',
                color: profile.isPlus ? '#fff' : '#9CA3AF',
              }}
              title={profile.isPlus ? 'Active' : 'Free plan'}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  background: profile.isPlus ? '#60A5FA' : '#6B7280',
                  boxShadow: profile.isPlus ? '0 0 0 3px rgba(96,165,250,0.2)' : 'none',
                }}
              />
              <span className="flex-1 text-[13px] font-bold tracking-tight text-left">
                {profile.isPlus ? 'Active' : 'Free plan'}
              </span>
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        )}

        {/* Profile footer */}
        <div className={`flex items-center gap-2.5 border-t border-white/[0.06] ${collapsed ? 'py-3 justify-center' : 'py-3 px-3.5'}`}>
          <div
            className="rounded-[10px] flex items-center justify-center font-bold text-white shrink-0"
            style={{ width: collapsed ? 32 : 30, height: collapsed ? 32 : 30, background: '#3B82F6', fontSize: collapsed ? 12 : 11 }}
          >
            {initial}
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-white truncate">{displayName}</div>
                {startAddress && <div className="text-[11px] text-gray-500 truncate">{startAddress}</div>}
              </div>
              <button
                onClick={signOut}
                title={t('nav.signOut')}
                className="text-gray-500 hover:text-gray-200 transition-colors shrink-0"
              >
                <svg className="w-[15px] h-[15px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="M16 17l5-5-5-5" />
                  <path d="M21 12H9" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Collapse toggle — small chevron tab on the right edge */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute -right-3 top-7 w-6 h-6 rounded-full flex items-center justify-center bg-surface-card ring-1 ring-edge-default text-ink-secondary hover:text-ink-primary transition-colors shadow-sm"
        >
          <svg className={`w-3 h-3 transition-transform ${collapsed ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </aside>

      {jobSyncError && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-red-600 text-white text-xs px-4 py-3 rounded-xl shadow-lg flex items-start gap-3">
          <span className="flex-1 leading-relaxed">{jobSyncError}</span>
          <button onClick={clearJobSyncError} className="text-white/80 hover:text-white text-sm leading-none">✕</button>
        </div>
      )}

      <main className="flex-1 overflow-auto">
        {storeLoading ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-ink-tertiary">Loading clients...</p>
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/schedule/builder" element={
              <PipPlusGate feature="schedule-builder">
                <ScheduleBuilder />
              </PipPlusGate>
            } />
            <Route path="/schedule-change" element={<ScheduleChange />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/invite/:token" element={<AcceptInvite />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/settings/reports" element={
              <PipPlusGate feature="reports">
                <Reports />
              </PipPlusGate>
            } />
          </Routes>
        )}
      </main>
    </div>
  )
}

export default App
