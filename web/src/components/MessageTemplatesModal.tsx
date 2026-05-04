import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useProfile } from '../lib/profile'
import { useLanguage } from '../lib/language'
import { listTemplates, fillTemplate, FREE_WATERMARK, type MessageTemplate } from '../lib/messageTemplates'

/** Read-only message templates view. Mobile owns editing/seeding —
 *  web is copy-paste only so users on the desktop can grab a template
 *  for a quick text without round-tripping to their phone. */
export default function MessageTemplatesModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  const { profile } = useProfile()
  const { t } = useLanguage()
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isPlus = profile.isPlus

  useEffect(() => {
    if (!user) return
    let cancelled = false
    listTemplates(user.id, isPlus).then(list => {
      if (!cancelled) { setTemplates(list); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [user, isPlus])

  const copy = async (tpl: MessageTemplate) => {
    // Free tier gets the watermark appended — same behavior as mobile send,
    // so what the user copies from web matches what mobile would have texted.
    const text = fillTemplate(tpl.body, isPlus)
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(tpl.id)
      setTimeout(() => setCopiedId(prev => (prev === tpl.id ? null : prev)), 1500)
    } catch {
      // Some browsers reject clipboard writes from non-secure contexts —
      // surface a manual selection fallback instead of failing silently.
      setCopiedId(`fail:${tpl.id}`)
      setTimeout(() => setCopiedId(prev => (prev === `fail:${tpl.id}` ? null : prev)), 2000)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-blue-600 hover:text-blue-700 p-1 -ml-1" aria-label="Close">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <p className="text-lg font-bold text-gray-900">
                {t('settings.messaging.messageTemplates') || 'Message Templates'}
              </p>
              <p className="text-[11px] text-gray-400 mt-0.5">
                {t('settings.messaging.subtitle') || 'Customize your quick messages'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {!isPlus && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-600 text-white">Pip+</span>
                <p className="text-[11px] font-semibold text-blue-900">Custom templates</p>
              </div>
              <p className="text-[11px] text-blue-900/80">
                {t('messageTemplates.freeWatermarkNotice') || 'Free plan shows the 3 default templates with a "— Pip: Job & Client Scheduler" tag on copy. Upgrade to Pip+ in the mobile app to add your own templates and drop the tag.'}
              </p>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
          ) : (
            templates.map(tpl => (
              <Card
                key={tpl.id}
                template={tpl}
                isPlus={isPlus}
                copied={copiedId === tpl.id}
                copyFailed={copiedId === `fail:${tpl.id}`}
                onCopy={() => copy(tpl)}
              />
            ))
          )}

          <div className="rounded-xl border border-dashed border-gray-200 p-3 text-center">
            <p className="text-[11px] text-gray-400">
              {t('messageTemplates.editOnMobile') || 'Add or edit templates in the Pip mobile app.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Card({ template, isPlus, copied, copyFailed, onCopy }: {
  template: MessageTemplate
  isPlus: boolean
  copied: boolean
  copyFailed: boolean
  onCopy: () => void
}) {
  return (
    <div className="bg-gray-50 rounded-xl border border-gray-100 p-3.5">
      <div className="flex items-start gap-3 mb-2">
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: '#3B82F61F' }}>
          <Icon name={template.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900">{template.name}</p>
        </div>
        <button
          onClick={onCopy}
          className={`text-[11px] font-bold px-2.5 py-1 rounded-md transition-colors ${
            copied
              ? 'bg-emerald-100 text-emerald-700'
              : copyFailed
                ? 'bg-amber-100 text-amber-700'
                : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
          }`}
        >
          {copied ? 'Copied' : copyFailed ? 'Select & copy' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed select-text">
        {template.body}
        {!isPlus && <span className="text-gray-400">{FREE_WATERMARK}</span>}
      </p>
    </div>
  )
}

function Icon({ name }: { name: string }) {
  const cls = 'w-4 h-4 text-blue-600'
  if (name === 'bell') {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    )
  }
  if (name === 'x-circle') {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    )
  }
  if (name === 'alert-circle') {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
    )
  }
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  )
}
