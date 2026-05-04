import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { joinTeamByCode } from '../lib/teams'
import { useLanguage } from '../lib/language'

export default function AcceptInvite() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const { t } = useLanguage()
  const [status, setStatus] = useState<'loading' | 'joining' | 'done' | 'error' | 'login-required'>('loading')
  const [teamName, setTeamName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (authLoading) return
    if (!token) { setStatus('error'); setError(t('team.acceptInvite.invalidLink')); return }

    if (!user) {
      sessionStorage.setItem('pip-pending-invite', token)
      setStatus('login-required')
      return
    }

    // Auto-join on load
    setStatus('joining')
    void (async () => {
      try {
        const member = await joinTeamByCode(token)
        setTeamName(member.name ?? '')
        setStatus('done')
        sessionStorage.removeItem('pip-pending-invite')
        setTimeout(() => navigate('/'), 2000)
      } catch (err) {
        setStatus('error')
        setError((err as Error).message || t('team.acceptInvite.invalidOrUsed'))
      }
    })()
  }, [token, user, authLoading, navigate, t])

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-page">
      <div className="bg-white rounded-3xl shadow-lg p-8 w-full max-w-sm text-center">
        {(status === 'loading' || status === 'joining') && (
          <>
            <div className="w-10 h-10 border-3 border-gray-200 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-gray-400">{t('team.acceptInvite.joining')}</p>
          </>
        )}

        {status === 'login-required' && (
          <>
            <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">{t('team.acceptInvite.title')}</h2>
            <p className="text-sm text-gray-500 mb-5">{t('team.acceptInvite.signInToJoin')}</p>
            <button onClick={() => navigate('/')}
              className="w-full px-4 py-2.5 text-sm font-semibold text-white rounded-xl transition-colors" style={{ backgroundColor: '#4A7CFF' }}>
              {t('auth.login.signInButton')}
            </button>
          </>
        )}

        {status === 'done' && (
          <>
            <div className="w-14 h-14 rounded-2xl bg-green-50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">{t('team.acceptInvite.successTitle')}</h2>
            <p className="text-sm text-gray-400">
              {teamName
                ? t('team.acceptInvite.welcomeNamedRedirecting', { name: teamName })
                : t('team.acceptInvite.welcomeRedirecting')}
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">{t('team.acceptInvite.errorTitle')}</h2>
            <p className="text-sm text-gray-400 mb-5">{error}</p>
            <button onClick={() => navigate('/')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
              {t('team.acceptInvite.goToDashboard')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
