import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { useLanguage } from '../lib/language'
import { supabase } from '../lib/supabase'

export default function Login() {
  const { signInWithApple, signInWithGoogle, signInWithEmail } = useAuth()
  const { t } = useLanguage()
  // showEmail state removed - email form is always shown for beta
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleApple = async () => {
    try {
      setLoading(true)
      setError(null)
      await signInWithApple()
    } catch (e: any) {
      setError(e.message || t('auth.errors.appleSignInFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleEmail = async () => {
    if (!email.trim()) return
    // Login mode requires password, signup does not
    if (mode === 'signin' && !password) return
    setLoading(true)
    setError(null)
    setInfo(null)
    if (mode === 'signin') {
      const err = await signInWithEmail(email.trim(), password)
      if (err) setError(err)
    } else {
      // Beta signup: auto-generate password so user only needs email
      const autoPassword = crypto.randomUUID()
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password: autoPassword,
        options: { data: { is_beta: true } },
      })
      if (error) {
        setError(error.message)
      } else if (data.session) {
        // Email confirmation is OFF — user is signed in, redirect
        window.location.href = '/schedule'
      } else if (data.user && !data.session) {
        // Fallback: email confirmation required
        setInfo('Check your email to confirm your account.')
      }
    }
    setLoading(false)
  }

  const isSignup = mode === 'signup'

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="w-full max-w-sm mx-auto px-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Rounds</h1>
          <p className="text-gray-500 mt-2">Schedule Builder for recurring work</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-4">
          {/* Apple Sign-In - hidden for beta */}
          {false && (
            <button
              onClick={handleApple}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-black text-white py-3 rounded-xl text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
              </svg>
              {t('auth.login.appleButton')}
            </button>
          )}

          {/* Google Sign-In - hidden for beta */}
          {false && (
            <button
              onClick={async () => {
                try {
                  setLoading(true)
                  setError(null)
                  await signInWithGoogle()
                } catch (e: any) {
                  setError(e.message || t('auth.errors.googleSignInFailed'))
                } finally {
                  setLoading(false)
                }
              }}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-white text-gray-700 border border-gray-300 py-3 rounded-xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              {t('auth.login.googleButton')}
            </button>
          )}

          {/* Divider - hidden when OAuth buttons are hidden */}
          {false && (
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-3 text-gray-400">{t('onboarding.account.divider')}</span>
              </div>
            </div>
          )}

          {/* Email form - always shown now */}
          <div className="space-y-3">
            {isSignup && (
              <p className="text-sm text-gray-600 text-center">Enter your email to try Rounds</p>
            )}
            <input
              type="email"
              placeholder={isSignup ? 'Email address' : t('auth.login.emailLabel')}
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEmail()}
              className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-900/20"
            />
            {/* Password field only shown for login, not signup */}
            {!isSignup && (
              <input
                type="password"
                placeholder={t('auth.login.passwordLabel')}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEmail()}
                className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-900/20"
              />
            )}
            <button
              onClick={handleEmail}
              disabled={loading || !email.trim() || (!isSignup && !password)}
              className="w-full bg-gray-900 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {loading
                ? (isSignup ? 'Getting started...' : t('web.login.signingIn'))
                : (isSignup ? 'Get Started' : t('auth.login.signInButton'))}
            </button>
            <button
              type="button"
              onClick={() => { setMode(isSignup ? 'signin' : 'signup'); setError(null); setInfo(null) }}
              className="w-full text-xs text-gray-500 hover:text-gray-700 py-1"
            >
              {isSignup ? 'Already have an account? Sign in' : "New to Rounds? Get started"}
            </button>
          </div>

          {info && (
            <p className="text-xs text-emerald-600 text-center">{info}</p>
          )}
          {error && (
            <p className="text-xs text-red-500 text-center">{error}</p>
          )}
        </div>

        <p className="text-xs text-gray-400 text-center mt-4">
          {t('web.login.footerHint')}
        </p>
      </div>
    </div>
  )
}
