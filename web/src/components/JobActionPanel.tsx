import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useToast } from '../lib/toast'
import { useCurrency } from '../lib/currency'
import { useLanguage } from '../lib/language'
import type { Job } from '../lib/jobs'
import type { Frequency } from '../types'
import { DEFAULT_AVATAR_COLOR } from '../theme'
import ColorPickerChip from './ColorPickerChip'
import { deleteJobPhoto, getJobPhotos, uploadJobPhoto, MAX_PHOTOS_PER_JOB, type JobPhoto } from '../lib/photos'
import { toMobileTime, ALL_DAY } from '../lib/time'
import { formatClockTime, formatDurationMs, getJobTimeEntries, type TimeEntry } from '../lib/timeEntries'

interface Props {
  job: Job | null
  onClose: () => void
}

type ViewMode = 'overview' | 'edit' | 'photos'

// Right-side docked panel. Mirrors the mobile action sheet:
//  - Overview:  single-occurrence actions (complete, cancel, delete), notes,
//               checklist, directions, and a row that opens Edit Job.
//  - Edit Job:  dedicated editor for title/date/time/price/notes, with the
//               "This Event / This & Future" scope selector that ONLY
//               applies to edits. Complete/cancel/paid/checklist are always
//               per-occurrence and live in the overview.
export default function JobActionPanel({ job, onClose }: Props) {
  const store = useStore()
  const toast = useToast()
  const { currencyInfo, formatCurrency } = useCurrency()
  const { t } = useLanguage()
  const [view, setView] = useState<ViewMode>('overview')
  const [liveId, setLiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [editDraft, setEditDraft] = useState<{
    title: string; date: string; startTime: string; endTime: string; price: string; notes: string; frequency: Frequency; clientId: string | null; color: string
  }>({
    title: '', date: '', startTime: '', endTime: '', price: '', notes: '', frequency: 'weekly', clientId: null, color: DEFAULT_AVATAR_COLOR,
  })
  const [editScope, setEditScope] = useState<'this' | 'future'>('this')
  const [paidPrompt, setPaidPrompt] = useState(false)
  const [deletePicker, setDeletePicker] = useState(false)
  // Photos live at the panel level so the overview action row can show a
  // count badge without either (a) prop-drilling state into a nested
  // component or (b) fetching twice per panel open.
  const [photos, setPhotos] = useState<JobPhoto[]>([])
  const [photosLoaded, setPhotosLoaded] = useState(false)

  const isVirtualOccurrence = !!job && !job.isTemplate && !!job.templateId

  const current: Job | null = liveId
    ? store.jobs.find(j => j.id === liveId) ?? job
    : isVirtualOccurrence
      ? job
      : job
        ? store.jobs.find(j => j.id === job.id && !j.isTemplate) ?? job
        : null

  useEffect(() => {
    // If this virtual was already materialized in a previous panel session,
    // find its real row so per-occurrence data (photos, notes, completion)
    // loads instead of showing the empty virtual.
    const existing = job && !job.isTemplate && job.templateId
      ? store.jobs.find(j =>
          !j.isTemplate &&
          j.templateId === job.templateId &&
          (j.originalOccurrenceDate ?? j.date) === (job.originalOccurrenceDate ?? job.date)
        )
      : null
    setLiveId(existing?.id ?? null)
    setView('overview')
    setEditingNotes(false)
    setEditScope('this')
    setNotesDraft(job?.notes ?? '')
    setPhotos([])
    setPhotosLoaded(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.date, job?.originalOccurrenceDate])

  // Fetch photos as soon as we know the materialized row id. Virtuals get
  // an empty list until the user materializes via upload or any other action.
  const photosLiveId = liveId ?? (isVirtualOccurrence ? null : job?.id ?? null)
  useEffect(() => {
    let cancelled = false
    if (!photosLiveId) { setPhotos([]); setPhotosLoaded(true); return }
    setPhotosLoaded(false)
    getJobPhotos(photosLiveId)
      .then(ps => { if (!cancelled) { setPhotos(ps); setPhotosLoaded(true) } })
      .catch(() => { if (!cancelled) { setPhotos([]); setPhotosLoaded(true) } })
    return () => { cancelled = true }
  }, [photosLiveId])

  if (!current) return null

  const client = current.clientId ? store.clients.find(c => c.id === current.clientId) : null
  const isTask = !current.clientId
  const headerTitle = client
    ? client.name
    : (current.title?.trim() ? current.title : t('jobActionPanel.noTitle'))
  const titleOverride = client && current.title?.trim() ? current.title : null
  const isVirtual = !liveId && isVirtualOccurrence

  const templateId = current.templateId ?? null
  const isRecurringOccurrence = !!templateId || (current.isRecurring && !current.isTemplate)
  const canUseFutureScope = !!templateId

  // Past-due nudge: end time has passed but the visit isn't marked complete.
  // Computed once per render — cheap enough we don't bother memoizing.
  const isPastDue = (() => {
    if (current.completed || current.cancelled) return false
    const endHM = current.endTime || current.startTime
    if (!endHM) return false
    const endMs = new Date(`${current.date}T${endHM}:00`).getTime()
    return Date.now() >= endMs
  })()

  const ensureMaterialized = async (): Promise<string | null> => {
    if (!isVirtual) return current.id
    const id = await store.materializeVirtualOccurrence(current)
    if (id) setLiveId(id)
    return id
  }

  // Per-occurrence mutation — materializes virtuals, always writes to the
  // instance row. Used by every single-visit action (complete, cancel, paid,
  // checklist, notes-in-overview).
  const mutate = async (patch: Record<string, unknown>) => {
    setBusy(true)
    const id = await ensureMaterialized()
    if (id) await store.updateJob(id, patch)
    setBusy(false)
  }

  const onToggleComplete = () => {
    if (current.completed) { mutate({ completed: false }); return }
    if (current.price > 0) { setPaidPrompt(true); return }
    mutate({ completed: true })
  }
  const confirmCompleteWith = (paid: boolean) => {
    setPaidPrompt(false)
    mutate({ completed: true, paid })
  }
  const onToggleCancelled = () => mutate({ cancelled: !current.cancelled })
  const onTogglePaid = () => mutate({ paid: !current.paid })

  const onSaveNotes = async () => {
    await mutate({ notes: notesDraft.trim() || null })
    setEditingNotes(false)
  }

  const toggleChecklistItem = async (index: number) => {
    const list = [...(current.checklist ?? [])]
    if (!list[index]) return
    list[index] = { ...list[index], done: !list[index].done }
    await mutate({ checklist: list })
  }
  const addChecklistItem = async (text: string) => {
    const t = text.trim()
    if (!t) return
    const list = [...(current.checklist ?? []), { text: t, done: false }]
    await mutate({ checklist: list })
  }
  const removeChecklistItem = async (index: number) => {
    const list = [...(current.checklist ?? [])]
    list.splice(index, 1)
    await mutate({ checklist: list.length ? list : null })
  }

  const onDelete = async () => {
    // Recurring → scope picker (mirrors drag-off-schedule UX). Same backend
    // calls as the calendar remove picker, so the job is actually gone — no
    // ghost cancelled-instance lingering to "Restore".
    if (isRecurringOccurrence && current.clientId) {
      setDeletePicker(true)
      return
    }
    if (!confirm(t('jobActionPanel.deleteConfirm'))) return
    setBusy(true)
    const id = liveId ?? await ensureMaterialized()
    if (id) await store.deleteJob(id)
    setBusy(false)
    onClose()
    toast('Job deleted')
  }

  const doDeleteScoped = async (scope: 'just-this' | 'this-and-future' | 'all') => {
    if (!current.clientId) return
    setDeletePicker(false)
    setBusy(true)
    const d = new Date(current.date + 'T00:00:00')
    const y = d.getFullYear()
    const m = d.getMonth()

    if (scope === 'just-this') {
      store.unplaceClient(current.clientId, current.date)
      await store.syncCancelOccurrence(current.clientId, current.date)
    } else if (scope === 'this-and-future') {
      // unplaceClientFuture is global (year/month params are stubs); pairs
      // with syncEndRecurrence which sets recurring_end_date forever.
      store.unplaceClientFuture(current.clientId, current.date, y, m)
      await store.syncEndRecurrence(current.clientId, current.date)
    } else {
      // "All instances ever" — past + future, every month. Wipes the client's
      // entire visit history and recurrence template.
      store.unplaceClientEverything(current.clientId)
      await store.syncDeleteClientJobs(current.clientId)
    }
    setBusy(false)
    onClose()
    toast(scope === 'all' ? 'All visits deleted' : 'Job deleted')
  }

  const openEdit = () => {
    setEditDraft({
      title: current.title ?? '',
      date: current.date,
      startTime: current.startTime ?? '',
      endTime: current.endTime ?? addHours(current.startTime, current.duration),
      price: current.price > 0 ? String(current.price) : '',
      notes: current.notes ?? '',
      frequency: recurringToFrequency(current.recurring),
      clientId: current.clientId,
      color: current.avatarColor || client?.color || DEFAULT_AVATAR_COLOR,
    })
    setEditScope('this')
    setView('edit')
  }

  const onSaveEdit = async () => {
    const { title, date, startTime, endTime, price, notes, frequency, clientId, color: editColor } = editDraft
    const priceNum = price.trim() ? Number(price) : 0
    const isAllDay = startTime === ALL_DAY
    const dur = isAllDay
      ? 0
      : (startTime && endTime ? hoursBetween(startTime, endTime) : current.duration)
    const basePatch: Record<string, unknown> = {
      title: title.trim() ? title.trim() : null,
      start_time: isAllDay ? ALL_DAY : toMobileTime(startTime),
      end_time: isAllDay ? null : toMobileTime(endTime),
      duration: isAllDay ? 0 : (dur > 0 ? dur : current.duration),
      price: Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : 0,
      notes: notes.trim() || null,
    }
    // Reassigning between clients (or to/from a task) also re-copies the
    // avatar_color so the card paint follows the new owner on mobile.
    // Manual color picks always win over the reassign default.
    if (clientId !== current.clientId) {
      basePatch.client_id = clientId
      const newClient = clientId ? store.clients.find(c => c.id === clientId) : null
      basePatch.avatar_color = newClient?.color ?? DEFAULT_AVATAR_COLOR
    }
    const initialColor = current.avatarColor || client?.color || DEFAULT_AVATAR_COLOR
    if (editColor !== initialColor) basePatch.avatar_color = editColor

    // Frequency changed? Reanchor first, preserving the edited time/price/etc.
    // on the new template. This is destructive to future overrides, so confirm.
    const currentFreq = recurringToFrequency(current.recurring)
    const freqChanged = canUseFutureScope && current.clientId && frequency !== currentFreq
    if (freqChanged) {
      const ok = confirm(
        `${t('jobActionPanel.changeRecurrenceTitle', { frequency: frequencyLabel(frequency, t) })}\n\n` +
        t('jobActionPanel.changeRecurrenceBody'),
      )
      if (!ok) return
      setBusy(true)
      await store.changeRecurrenceFrequency(current.clientId!, current.date, frequency, basePatch)
      setBusy(false)
      setView('overview')
      return
    }

    if (editScope === 'future' && templateId) {
      // Date-of-visit is instance-scoped; scope='future' never shifts dates.
      await store.updateRecurrenceFromDate(templateId, current.date, basePatch)
    } else {
      await mutate({ ...basePatch, date })
    }
    // Force a fresh pull so chips/lists reflect the new color, price, etc.
    // immediately instead of waiting on realtime echo.
    await store.refreshJobs()
    setView('overview')
  }

  const color = current.avatarColor || client?.color || DEFAULT_AVATAR_COLOR
  const prettyDate = new Date(current.date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  const directionsHref = client?.address
    ? `https://maps.google.com/?q=${encodeURIComponent(client.address)}`
    : null

  // ── Render ───────────────────────────────────────────────────────────────

  if (view === 'photos') {
    return (
      <PhotosView
        photos={photos}
        setPhotos={setPhotos}
        ensureMaterialized={ensureMaterialized}
        liveId={photosLiveId}
        onBack={() => setView('overview')}
      />
    )
  }

  if (view === 'edit') {
    return (
      <div className="w-[320px] h-full border-r border-gray-200/60 bg-white flex flex-col">
        {/* Edit header */}
        <div className="px-3 py-2.5 border-b border-gray-100 flex items-center justify-between shrink-0">
          <button
            onClick={() => setView('overview')}
            className="text-gray-500 hover:text-gray-800 text-xl leading-none px-1"
            aria-label={t('common.back')}
          >×</button>
          <p className="text-[13px] font-semibold text-gray-900">{t('editJob.title')}</p>
          <button
            onClick={onSaveEdit}
            disabled={busy}
            className="text-[12px] font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40 px-1"
          >{t('common.save')}</button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {store.jobSyncError && <ErrorBanner msg={store.jobSyncError} onDismiss={store.clearJobSyncError} />}

          {/* Scope selector — recurring jobs only */}
          {isRecurringOccurrence && canUseFutureScope && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{t('editJob.editScope')}</p>
              <div className="flex bg-gray-100 rounded-lg p-0.5">
                {(['this', 'future'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setEditScope(s)}
                    className={`flex-1 py-1.5 text-[11px] font-semibold rounded-md transition-all ${
                      editScope === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {s === 'this' ? t('editJob.thisEvent') : t('editJob.allEvents')}
                  </button>
                ))}
              </div>
              <div className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 ${
                editScope === 'future' ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-50 text-gray-600'
              }`}>
                <span className="text-[11px]">ⓘ</span>
                <p className="text-[10.5px]">
                  {editScope === 'this'
                    ? t('editJob.thisInfo')
                    : t('editJob.allInfo')}
                </p>
              </div>
            </div>
          )}

          {/* Subject card (client or task) */}
          <div className="rounded-lg border border-gray-200 p-2.5 flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-[11px] font-semibold shrink-0"
              style={{ backgroundColor: color }}
            >
              {client ? initials(client.name) : '•'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-gray-900 truncate">{headerTitle}</p>
              {client?.address && <p className="text-[10.5px] text-gray-500 truncate">{client.address}</p>}
            </div>
            {current.price > 0 && (
              <span className="px-2 py-1 rounded bg-emerald-50 text-emerald-700 text-[11px] font-semibold">
                {formatCurrency(current.price)}
              </span>
            )}
          </div>

          {/* Recurrence dropdown — only available under "This & Future" scope
              because changing cadence inherently applies to every upcoming
              visit; it makes no sense for a single-occurrence edit. */}
          {canUseFutureScope && current.clientId && editScope === 'future' && (
            <Field label={t('addJob.labels.recurring')}>
              <select
                value={editDraft.frequency}
                onChange={e => setEditDraft(d => ({ ...d, frequency: e.target.value as Frequency }))}
                className="w-full px-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md bg-white focus:outline-none focus:border-blue-400"
              >
                <option value="weekly">{t('addJob.recurring.weekly')}</option>
                <option value="biweekly">{t('addJob.recurring.biWeekly')}</option>
                <option value="monthly">{t('jobActionPanel.monthlyEvery4Weeks')}</option>
              </select>
              {editDraft.frequency !== recurringToFrequency(current.recurring) && (
                <p className="text-[10.5px] text-indigo-600 mt-1">
                  {t('jobActionPanel.changeRecurrenceBody')}
                </p>
              )}
            </Field>
          )}

          {/* Fields */}
          <Field label={t('addJob.labels.client')}>
            <select
              value={editDraft.clientId ?? ''}
              onChange={e => setEditDraft(d => ({ ...d, clientId: e.target.value || null }))}
              className="w-full px-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md bg-white focus:outline-none focus:border-blue-400"
            >
              <option value="">{t('jobActionPanel.noClientTask')}</option>
              {[...store.clients]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
            {editDraft.clientId !== current.clientId && (
              <p className="text-[10.5px] text-amber-600 mt-1">
                {editDraft.clientId
                  ? t('jobActionPanel.reassigningToClient')
                  : t('jobActionPanel.reassigningToTask')}
              </p>
            )}
          </Field>

          <Field label={`${t('addJob.labels.jobTitle')} ${t('addJob.labels.optional')}`}>
            <input
              value={editDraft.title}
              onChange={e => setEditDraft(d => ({ ...d, title: e.target.value }))}
              placeholder={t('addJob.placeholders.jobTitleWithClient')}
              className="w-full px-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400"
            />
          </Field>

          {editScope === 'this' ? (
            <Field label={t('addJob.labels.date')}>
              <input
                type="date"
                value={editDraft.date}
                onChange={e => setEditDraft(d => ({ ...d, date: e.target.value }))}
                className="w-full px-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400"
              />
            </Field>
          ) : (
            <p className="text-[10.5px] text-gray-400 italic">
              {t('jobActionPanel.dateChangeRequiresThis')}
            </p>
          )}

          <Field label={t('addJob.labels.time')}>
            <label className="flex items-center gap-1.5 mb-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={editDraft.startTime === ALL_DAY}
                onChange={e => setEditDraft(d => e.target.checked
                  ? { ...d, startTime: ALL_DAY, endTime: '' }
                  : { ...d, startTime: '09:00', endTime: '10:00' })}
                className="w-3.5 h-3.5"
              />
              <span className="text-[11px] text-gray-700">{t('addJob.labels.allDay')}</span>
            </label>
            {editDraft.startTime === ALL_DAY ? (
              <div className="px-2.5 py-1.5 text-[12px] text-gray-500 bg-gray-50 border border-gray-200 rounded-md">
                {t('jobActionPanel.allDayHint')}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <input
                    type="time"
                    value={editDraft.startTime}
                    onChange={e => setEditDraft(d => ({ ...d, startTime: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[11px] text-gray-400">{t('addJob.time.to')}</span>
                  <input
                    type="time"
                    value={editDraft.endTime}
                    onChange={e => setEditDraft(d => ({ ...d, endTime: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400"
                  />
                </div>
                <p className="text-[10.5px] text-gray-400 mt-1">
                  {t('addJob.time.duration')}{editDraft.startTime && editDraft.endTime
                    ? formatDuration(hoursBetween(editDraft.startTime, editDraft.endTime))
                    : formatDuration(current.duration)}
                </p>
              </>
            )}
          </Field>

          <Field label={`${t('addJob.labels.price')} ${t('addJob.labels.optional')}`}>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-emerald-600 font-semibold pointer-events-none">{currencyInfo.symbol}</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={editDraft.price}
                onChange={e => setEditDraft(d => ({ ...d, price: e.target.value }))}
                className="w-full pl-6 pr-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400"
              />
            </div>
          </Field>

          <Field label="Color">
            <ColorPickerChip
              color={editDraft.color}
              label={headerTitle}
              onChange={hex => setEditDraft(d => ({ ...d, color: hex }))}
              size="sm"
            />
          </Field>

          <Field label={`${t('addJob.labels.notes')} ${t('addJob.labels.optional')}`}>
            <textarea
              value={editDraft.notes}
              onChange={e => setEditDraft(d => ({ ...d, notes: e.target.value }))}
              rows={3}
              placeholder={t('addJob.placeholders.notes')}
              className="w-full px-2.5 py-1.5 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400 resize-none"
            />
          </Field>
        </div>
      </div>
    )
  }

  // ── Overview ─────────────────────────────────────────────────────────────
  return (
    <div className="w-[320px] h-full border-r border-gray-200/60 bg-white flex flex-col">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100 shrink-0" style={{ borderTop: `3px solid ${color}` }}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className={`text-base font-bold truncate ${headerTitle === t('jobActionPanel.noTitle') ? 'text-gray-400 italic' : 'text-gray-900'}`}>
                {headerTitle}
              </h2>
              {current.price > 0 && (
                <span className={`text-[13px] font-bold shrink-0 ${
                  current.cancelled
                    ? 'text-gray-400 line-through'
                    : current.paid
                      ? 'text-emerald-600/50 line-through'
                      : 'text-emerald-600'
                }`}>
                  {formatCurrency(current.price)}
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {prettyDate}
              {current.startTime === ALL_DAY
                ? ` · ${t('addJob.labels.allDay')}`
                : current.startTime
                  ? ` · ${formatTimeRange(current.startTime, current.endTime, current.duration)}`
                  : ''}
            </p>
            {client?.address && <p className="text-[11px] text-gray-400 mt-0.5 truncate">{client.address}</p>}
            {titleOverride && <p className="text-[11px] text-gray-500 mt-0.5 italic truncate">“{titleOverride}”</p>}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl leading-none px-1"
            aria-label={t('jobActionPanel.close')}
          >×</button>
        </div>

        {/* Status pills. Cancelled is a hard override — when set, we hide the
            Completed/Paid/Unpaid pills so the row reads as a single state.
            Recurrence + Task badges are descriptive metadata (not status), so
            they always show. */}
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {current.cancelled
            ? <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-red-50 text-red-700">{t('calendar.statusCancelled')}</span>
            : (
              <>
                {current.completed && <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-emerald-50 text-emerald-700">{t('calendar.statusCompleted')}</span>}
                {current.paid && <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-emerald-50 text-emerald-700">{t('payment.paid')}</span>}
                {current.price > 0 && current.completed && !current.paid && <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-rose-50 text-rose-700">{t('payment.unpaid')}</span>}
              </>
            )}
          {current.isRecurring && <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-gray-100 text-gray-600">{current.recurring}</span>}
          {isTask && <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-gray-100 text-gray-600">{t('jobActionPanel.taskBadge')}</span>}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {store.jobSyncError && <ErrorBanner msg={store.jobSyncError} onDismiss={store.clearJobSyncError} />}

        {paidPrompt && (
          <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-2 shadow-sm">
            <p className="text-[13px] font-semibold text-gray-900">Was it paid?</p>
            <p className="text-[11px] text-gray-500">{formatCurrency(current.price)} for this visit.</p>
            <div className="flex gap-1.5">
              <button
                onClick={() => confirmCompleteWith(true)}
                className="flex-1 px-2 py-1.5 text-[11.5px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-md"
              >Yes, paid</button>
              <button
                onClick={() => confirmCompleteWith(false)}
                className="flex-1 px-2 py-1.5 text-[11.5px] font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md"
              >Not yet</button>
              <button
                onClick={() => setPaidPrompt(false)}
                className="px-2 py-1.5 text-[11.5px] font-medium text-gray-400 hover:text-gray-600 rounded-md"
              >Cancel</button>
            </div>
          </div>
        )}

        {/* Quick actions — Complete + Mark Paid + Directions (single-occurrence).
            Cancellation is a hard override: while cancelled, Complete/Mark Paid
            are disabled (the row's underlying flags are preserved so Restore
            returns to prior state, but the user shouldn't be able to toggle
            money-affecting state on a cancelled visit). Directions stays live
            because navigating to the address is still useful. */}
        <div className="grid grid-cols-3 gap-2">
          <QuickAction
            label={current.cancelled ? 'Complete' : current.completed ? 'Completed' : 'Complete'}
            tint={!current.cancelled && current.completed ? 'emerald-solid' : 'emerald-soft'}
            disabled={busy || paidPrompt || current.cancelled}
            onClick={onToggleComplete}
            icon={<CheckIcon />}
            badge={isPastDue ? 'past-due' : undefined}
          />
          <QuickAction
            label={current.cancelled ? 'Mark Paid' : current.paid ? 'Paid' : 'Mark Paid'}
            tint={!current.cancelled && current.paid ? 'emerald-solid' : 'emerald-soft'}
            disabled={busy || paidPrompt || current.cancelled}
            onClick={onTogglePaid}
            icon={<DollarIcon />}
          />
          <QuickAction
            label="Directions"
            tint="violet-soft"
            disabled={!directionsHref}
            href={directionsHref ?? undefined}
            icon={<ArrowIcon />}
          />
        </div>

        {/* Restore CTA — surfaces the unblock when the user tries to interact
            with a cancelled visit. Cancel/Restore is also in the action rows
            below, but pinning it here turns the disabled tiles into a clear
            "do this first" signpost. */}
        {current.cancelled && (
          <button
            onClick={onToggleCancelled}
            disabled={busy}
            className="w-full py-2 text-[12px] font-semibold rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-40"
          >
            Restore Job to enable
          </button>
        )}

        {/* Notes */}
        <div className="pt-1">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Notes</p>
            {!editingNotes && (
              <button
                onClick={() => { setNotesDraft(current.notes ?? ''); setEditingNotes(true) }}
                className="text-[10px] text-blue-600 hover:underline"
              >{current.notes ? 'Edit' : 'Add'}</button>
            )}
          </div>
          {editingNotes ? (
            <div className="space-y-1.5">
              <textarea
                autoFocus
                value={notesDraft}
                onChange={e => setNotesDraft(e.target.value)}
                rows={4}
                className="w-full px-2 py-1.5 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400 resize-none"
                placeholder="Add a note…"
              />
              <div className="flex gap-1.5 justify-end">
                <button onClick={() => setEditingNotes(false)} className="px-2 py-1 text-[10px] text-gray-500 hover:bg-gray-100 rounded">Cancel</button>
                <button onClick={onSaveNotes} className="px-2 py-1 text-[10px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded">Save</button>
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-gray-600 whitespace-pre-wrap min-h-[2rem]">
              {current.notes || <span className="text-gray-300 italic">No notes</span>}
            </p>
          )}
        </div>

        {/* Checklist */}
        <ChecklistSection
          items={current.checklist ?? []}
          busy={busy}
          onToggle={toggleChecklistItem}
          onAdd={addChecklistItem}
          onRemove={removeChecklistItem}
        />

        {/* Time Log — read-only. Mobile owns writes (Field OS). Web is the
            Command Center, so we just show what happened on Sunday review. */}
        <TimeLogSection
          jobKey={`${current.id}:${current.date}`}
          liveId={liveId ?? (isVirtual ? null : current.id)}
        />

        {/* Action rows — mobile parity */}
        <div className="pt-2 space-y-1">
          <ActionRow
            icon={<CameraIcon />}
            iconBg="bg-gray-100"
            iconColor="text-gray-500"
            label="Photos"
            subtitle={!photosLoaded
              ? 'Loading…'
              : photos.length === 0
                ? 'Add photos of this visit'
                : `${photos.length} attached`}
            onClick={() => setView('photos')}
            disabled={busy}
          />
          <ActionRow
            icon={<PencilIcon />}
            iconBg="bg-blue-50"
            iconColor="text-blue-600"
            label="Edit Job"
            onClick={openEdit}
            disabled={busy}
          />
          <ActionRow
            icon={<BanIcon />}
            iconBg="bg-gray-100"
            iconColor="text-gray-500"
            label={current.cancelled ? 'Restore Job' : 'Cancel Job'}
            subtitle={current.cancelled ? undefined : 'Keeps record, no earnings'}
            onClick={onToggleCancelled}
            disabled={busy || paidPrompt}
          />
          <ActionRow
            icon={<TrashIcon />}
            iconBg="bg-red-50"
            iconColor="text-red-600"
            label="Delete Job"
            subtitle="Removes from calendar entirely"
            labelColor="text-red-600"
            onClick={onDelete}
            disabled={busy}
          />
        </div>
      </div>

      {/* Delete-scope picker — same UX as dragging a recurring visit off the
          schedule. Only appears for recurring occurrences. */}
      {deletePicker && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onClick={() => setDeletePicker(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-4 w-72"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-gray-900 mb-1">Delete recurring visit</p>
            <p className="text-xs text-gray-400 mb-3">
              {(client?.name ?? headerTitle)} — {new Date(current.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </p>
            <div className="space-y-1.5">
              <button
                onClick={() => doDeleteScoped('just-this')}
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 transition-colors text-gray-700"
              >
                Just this one
              </button>
              {canUseFutureScope && (
                <button
                  onClick={() => doDeleteScoped('this-and-future')}
                  className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 transition-colors text-gray-700"
                >
                  This and all future
                </button>
              )}
              <button
                onClick={() => doDeleteScoped('all')}
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-red-50 transition-colors text-red-600"
              >
                All visits ever (past & future)
              </button>
            </div>
            <button
              onClick={() => setDeletePicker(false)}
              className="w-full mt-2 px-3 py-2 text-sm font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TimeLogSection({ jobKey, liveId }: { jobKey: string; liveId: string | null }) {
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [loading, setLoading] = useState(false)

  // Only fetch for materialized rows — virtuals have no id in job_time_entries.
  useEffect(() => {
    let cancelled = false
    if (!liveId) { setEntries([]); return }
    setLoading(true)
    getJobTimeEntries(liveId)
      .then(es => { if (!cancelled) setEntries(es) })
      .catch(() => { if (!cancelled) setEntries([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jobKey, liveId])

  if (loading || entries.length === 0) return null

  const totalMs = entries.reduce((sum, e) => sum + e.durationMs, 0)

  return (
    <div className="pt-1">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
          Time Log · {entries.length}
        </p>
        <p className="text-[10px] font-semibold text-sky-700">
          {formatDurationMs(totalMs) || '—'}
        </p>
      </div>
      <div className="space-y-1">
        {entries.map(e => (
          <div key={e.id} className="flex items-center justify-between px-2 py-1 rounded bg-gray-50 border border-gray-100">
            <span className="text-[11px] text-gray-600 font-mono">
              {formatClockTime(e.clockIn)} – {e.clockOut ? formatClockTime(e.clockOut) : '…'}
            </span>
            <span className="text-[11px] font-semibold text-gray-700">
              {e.clockOut ? formatDurationMs(e.durationMs) : 'Running'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold text-gray-700">{label}</p>
      {children}
    </div>
  )
}

function ErrorBanner({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-2 flex items-start gap-2">
      <p className="flex-1 text-[11px] text-red-700">{msg}</p>
      <button onClick={onDismiss} className="text-[11px] text-red-500 hover:text-red-700">×</button>
    </div>
  )
}

type QuickActionTint = 'emerald-soft' | 'emerald-solid' | 'violet-soft' | 'amber-soft'

function QuickAction({
  label, tint, icon, onClick, href, disabled, badge,
}: {
  label: string
  tint: QuickActionTint
  icon: React.ReactNode
  onClick?: () => void
  href?: string
  disabled?: boolean
  /** Past-due flag — paints an amber "!" pip in the top-right corner so the
   *  user reads "this is the action you're being nudged toward". */
  badge?: 'past-due'
}) {
  const tintMap: Record<QuickActionTint, string> = {
    'emerald-soft': 'bg-emerald-50 text-emerald-600 border-emerald-100',
    'emerald-solid': 'bg-emerald-500 text-white border-emerald-500',
    'violet-soft': 'bg-violet-50 text-violet-600 border-violet-100',
    'amber-soft': 'bg-amber-50 text-amber-600 border-amber-100',
  }
  const cls = `relative flex flex-col items-center justify-center gap-1 py-3 rounded-xl border font-semibold text-[11px] transition-colors disabled:opacity-40 ${tintMap[tint]}`
  const badgeEl = badge === 'past-due' ? (
    <span
      className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-amber-400 text-white text-[11px] font-bold shadow-sm ring-2 ring-white"
      title="End time has passed — mark complete?"
      aria-label="Past due"
    >
      !
    </span>
  ) : null
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cls}
        aria-disabled={disabled}
        onClick={disabled ? (e) => e.preventDefault() : undefined}
      >
        {badgeEl}
        <div className="w-5 h-5">{icon}</div>
        {label}
      </a>
    )
  }
  return (
    <button onClick={onClick} disabled={disabled} className={cls}>
      {badgeEl}
      <div className="w-5 h-5">{icon}</div>
      {label}
    </button>
  )
}

function ActionRow({
  icon, iconBg, iconColor, label, subtitle, labelColor, onClick, disabled,
}: {
  icon: React.ReactNode
  iconBg: string
  iconColor: string
  label: string
  subtitle?: string
  labelColor?: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-40 text-left"
    >
      <div className={`w-7 h-7 rounded-md ${iconBg} ${iconColor} flex items-center justify-center shrink-0`}>
        <div className="w-3.5 h-3.5">{icon}</div>
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-[12.5px] font-semibold ${labelColor ?? 'text-gray-800'}`}>{label}</p>
        {subtitle && <p className="text-[10.5px] text-gray-400">{subtitle}</p>}
      </div>
      <ChevronRight />
    </button>
  )
}

function ChecklistSection({
  items, busy, onToggle, onAdd, onRemove,
}: {
  items: { text: string; done: boolean }[]
  busy: boolean
  onToggle: (i: number) => Promise<void> | void
  onAdd: (text: string) => Promise<void> | void
  onRemove: (i: number) => Promise<void> | void
}) {
  const [draft, setDraft] = useState('')
  const submit = async () => {
    const t = draft.trim()
    if (!t) return
    await onAdd(t)
    setDraft('')
  }
  return (
    <div className="pt-1">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Checklist</p>
      <div className="space-y-1">
        {items.map((item, i) => (
          <div key={i} className="group flex items-center gap-2 text-[12px]">
            <button
              onClick={() => onToggle(i)}
              disabled={busy}
              className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                item.done
                  ? 'bg-emerald-500 border-emerald-500 text-white'
                  : 'bg-white border-gray-300 hover:border-gray-400'
              }`}
            >
              {item.done && (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5 9-10" />
                </svg>
              )}
            </button>
            <span className={`flex-1 ${item.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{item.text}</span>
            <button
              onClick={() => onRemove(i)}
              disabled={busy}
              className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 text-[13px] leading-none transition-opacity"
            >×</button>
          </div>
        ))}
        {items.length === 0 && <p className="text-[11px] text-gray-300 italic">No items yet</p>}
      </div>
      <div className="flex gap-1.5 mt-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
          placeholder="Add an item…"
          className="flex-1 px-2 py-1 text-[12px] border border-gray-300 rounded-md focus:outline-none focus:border-blue-400"
        />
        <button
          onClick={submit}
          disabled={busy || !draft.trim()}
          className="px-2 py-1 text-[10px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40"
        >Add</button>
      </div>
    </div>
  )
}

/** Full-screen photos view — shown when view === 'photos'. State lives in the
 *  parent so the overview action row can surface the count badge. */
function PhotosView({
  photos, setPhotos, ensureMaterialized, liveId, onBack,
}: {
  photos: JobPhoto[]
  setPhotos: (next: JobPhoto[] | ((prev: JobPhoto[]) => JobPhoto[])) => void
  ensureMaterialized: () => Promise<string | null>
  liveId: string | null
  onBack: () => void
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const atCap = photos.length >= MAX_PHOTOS_PER_JOB

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setError(null)
    setUploading(true)
    try {
      const id = liveId ?? await ensureMaterialized()
      if (!id) throw new Error('Couldn\'t save this visit to attach photos')
      // Sequential keeps the max-N DB trigger happy and lets us short-circuit
      // mid-loop if the user selected more than the remaining capacity.
      let current = photos.length
      for (const file of Array.from(files)) {
        if (current >= MAX_PHOTOS_PER_JOB) {
          setError(`Max ${MAX_PHOTOS_PER_JOB} photos per job`)
          break
        }
        await uploadJobPhoto(id, file, 'general')
        current += 1
      }
      const fresh = await getJobPhotos(id)
      setPhotos(fresh)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const onDelete = async (id: string) => {
    if (!confirm('Delete this photo?')) return
    setError(null)
    try {
      await deleteJobPhoto(id)
      setPhotos(prev => prev.filter(p => p.id !== id))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <div className="w-[320px] h-full border-r border-gray-200/60 bg-white flex flex-col">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-100 flex items-center justify-between shrink-0">
        <button
          onClick={onBack}
          className="text-gray-500 hover:text-gray-800 text-xl leading-none px-1"
          aria-label="Back"
        >×</button>
        <p className="text-[13px] font-semibold text-gray-900">
          Photos{photos.length > 0 ? ` · ${photos.length}` : ''}
        </p>
        <label className={`text-[12px] font-semibold cursor-pointer ${uploading || atCap ? 'text-gray-300 cursor-not-allowed' : 'text-blue-600 hover:text-blue-700'} px-1`}>
          {uploading ? '…' : 'Add'}
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={uploading || atCap}
            onChange={e => {
              onPick(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5">
            <p className="text-[11px] text-red-700">{error}</p>
          </div>
        )}
        {photos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center mb-2">
              <div className="w-5 h-5"><CameraIcon /></div>
            </div>
            <p className="text-[12px] text-gray-500 mb-0.5">No photos yet</p>
            <p className="text-[11px] text-gray-400">Tap "Add" above to attach photos of this visit</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {photos.map(p => (
              <div key={p.id} className="relative group aspect-square rounded-md overflow-hidden bg-gray-100">
                <button
                  type="button"
                  onClick={() => p.url && setLightbox(p.url)}
                  className="w-full h-full block"
                  aria-label="View photo"
                >
                  <img src={p.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(p.id)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[11px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Delete photo"
                >×</button>
              </div>
            ))}
          </div>
        )}
        {atCap && (
          <p className="text-[10.5px] text-gray-400 pt-1">Max {MAX_PHOTOS_PER_JOB} photos reached. Delete one to add more.</p>
        )}
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
        >
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-md shadow-2xl" />
        </div>
      )}
    </div>
  )
}

// ── Util ────────────────────────────────────────────────────────────────────

function recurringToFrequency(r: Job['recurring']): Frequency {
  if (r === 'bi-weekly') return 'biweekly'
  if (r === 'weekly') return 'weekly'
  if (r === 'monthly') return 'monthly'
  if (r === 'custom') return 'custom'
  return 'one-time'
}

function frequencyLabel(f: Frequency, t: (key: string) => string): string {
  if (f === 'weekly') return t('recurrence.weekly')
  if (f === 'biweekly') return t('recurrence.biWeekly')
  if (f === 'monthly') return t('recurrence.monthly')
  if (f === 'one-time') return t('recurrence.oneTime')
  return t('recurrence.custom')
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '•'
}

function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0m'
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null
  const [h, m] = s.split(':').map(n => Number(n))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

function hoursBetween(start: string, end: string): number {
  const s = parseHHMM(start), e = parseHHMM(end)
  if (s == null || e == null) return 0
  return Math.max(0, (e - s) / 60)
}

function formatHHMM(s: string | null | undefined): string {
  const mins = parseHHMM(s ?? null)
  if (mins == null) return ''
  const h24 = Math.floor(mins / 60)
  const m = mins % 60
  const period = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

function formatTimeRange(start: string | null, end: string | null, durationHours: number): string {
  const startStr = formatHHMM(start)
  if (!startStr) return ''
  const endStr = end ? formatHHMM(end) : formatHHMM(addHours(start, durationHours))
  return endStr ? `${startStr} – ${endStr}` : startStr
}

function addHours(start: string | null, hours: number): string {
  const s = parseHHMM(start)
  if (s == null) return ''
  const total = s + Math.round(hours * 60)
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ── Icons ───────────────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5 9-10" />
    </svg>
  )
}
function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M3 11l18-8-8 18-2-8-8-2z" />
    </svg>
  )
}
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.536-6.536a2 2 0 112.828 2.828L11.828 15.828 9 16l.172-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20h16" />
    </svg>
  )
}
function DollarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M17 7H9.5a2.5 2.5 0 000 5H14a2.5 2.5 0 010 5H6" />
    </svg>
  )
}
function BanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M5.5 5.5l13 13" />
    </svg>
  )
}
function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8.5A1.5 1.5 0 015.5 7h2l1.3-2h6.4L16.5 7h2A1.5 1.5 0 0120 8.5v9A1.5 1.5 0 0118.5 19h-13A1.5 1.5 0 014 17.5v-9z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M10 7V5a2 2 0 012-2h0a2 2 0 012 2v2" />
    </svg>
  )
}
function ChevronRight() {
  return (
    <svg className="w-3 h-3 text-gray-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}
