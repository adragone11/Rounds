import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import type { TransitionMove, Frequency } from '../types'
import { useStore } from '../store'
import ClientMap from '../components/ClientMap'
import TransitionView from '../components/TransitionView'
import RotationGrid from '../components/RotationGrid'
import type { ManualPlacementContext } from '../components/RotationGrid'
import CutoverDatePicker from '../components/CutoverDatePicker'
import { useLanguage } from '../lib/language'

export default function ScheduleChange() {
  const navigate = useNavigate()
  const location = useLocation()
  const store = useStore()
  const { t } = useLanguage()
  const DAY_COLORS = store.dayColors

  // ── Redirect if no active plan ──
  // Do this check after hooks (Rules of Hooks) — navigate inside useEffect.
  const hasPlan = !!store.schedulePlan
  useEffect(() => {
    if (!hasPlan) navigate('/schedule', { replace: true })
  }, [hasPlan, navigate])

  // ── Nav state from Builder ──
  const navState = (location.state as {
    transitionMoves?: TransitionMove[]
    transitionConfig?: { maxJobsPerDay: number; workingDays: boolean[] }
    planId?: string
  } | null)

  const [initialMoves] = useState<TransitionMove[]>(() => navState?.transitionMoves ?? [])
  const [transitionConfig] = useState(() => navState?.transitionConfig ?? { maxJobsPerDay: 5, workingDays: [false, true, true, true, true, true, false] })

  // Clear nav state so reloads don't re-trigger
  useEffect(() => {
    if (navState?.planId) window.history.replaceState({}, '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Manual placement (rotation grid) state ──
  // Tracks which client (if any) is currently being manually placed via the
  // rotation grid. When set, the grid enters placement mode and TransitionView
  // hides its swap picker. Cleared on cell-click or cancel.
  const [placementCtx, setPlacementCtx] = useState<ManualPlacementContext | null>(null)

  // ── Map state ──
  const [mapWidthPercent, setMapWidthPercent] = useState(40)
  const isDraggingDivider = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingDivider.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mapPercent = Math.max(20, Math.min(65, ((rect.width - mouseX) / rect.width) * 100))
      setMapWidthPercent(mapPercent)
    }
    const handleMouseUp = () => {
      isDraggingDivider.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // ── Plan stats ──
  const plan = store.schedulePlan
  const confirmed = plan ? plan.clients.filter(c => c.status === 'confirmed').length : 0
  const total = plan ? plan.clients.length : 0
  // ── Finish → Apply flow ──
  // User must press Finish in the sidebar before the Apply button appears.
  const [finished, setFinished] = useState(false)
  const [showApplyModal, setShowApplyModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const handleDelete = () => {
    store.discardSchedulePlan()
    setShowDeleteConfirm(false)
    navigate('/schedule')
  }
  const [cutoverDate, setCutoverDate] = useState<Date>(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const day = d.getDay()
    const daysUntilMon = day === 1 ? 7 : (8 - day) % 7 || 7
    const mon = new Date(d)
    mon.setDate(d.getDate() + daysUntilMon)
    return mon
  })

  const [applying, setApplying] = useState(false)
  const handleApply = async () => {
    if (applying) return
    setApplying(true)
    try {
      const ok = await store.commitSchedulePlan(cutoverDate)
      if (ok) {
        setShowApplyModal(false)
        navigate('/schedule')
      }
    } finally {
      setApplying(false)
    }
  }

  // ── Manual-placement: cell-click handler ──
  // Writes the user-picked (day, rotation) into the plan for the targeted
  // client. Keeps status='to-ask' (unlocked) so the user can still confirm
  // the placement after texting the client. The week-of-cycle from the cell
  // click is unused in the data model today; biweekly clients use rotation
  // (Wk1+3 = 0, Wk2+4 = 1), monthly clients collapse to a single row.
  const handlePlaceCell = (cell: { day: number; week: 0 | 1 | 2 | 3; rotation: 0 | 1 }) => {
    if (!placementCtx) return
    const targetId = placementCtx.clientId
    store.updateSchedulePlan(p => ({
      ...p,
      clients: p.clients.map(pc =>
        pc.clientId === targetId
          ? {
              ...pc,
              plannedDay: cell.day,
              plannedRotation: placementCtx.cadence === 'biweekly' ? cell.rotation : 0,
              status: 'to-ask',
              locked: false,
              swapPartnerClientId: null,
            }
          : pc,
      ),
    }))
    setPlacementCtx(null)
  }

  // ── Map: build color map from confirmed clients ──
  const clientDayColorMap = new Map<string, string>()
  const placedClientIds = new Set<string>()
  if (plan) {
    for (const pc of plan.clients) {
      if (pc.status === 'confirmed' && pc.plannedDay >= 0) {
        clientDayColorMap.set(pc.clientId, DAY_COLORS[pc.plannedDay])
        placedClientIds.add(pc.clientId)
      }
    }
  }

  const mapClients = store.clients.filter(c => c.lat !== null && c.lng !== null)

  if (!hasPlan) {
    // Render nothing while redirect fires
    return null
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header — mirrors Builder review step style */}
      <div className="px-5 py-3 border-b border-gray-200/80 bg-white shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/schedule')}
            className="px-2 py-1 text-[11px] font-medium text-red-600 hover:text-white border border-red-200 rounded-md hover:bg-red-600 hover:border-red-600 transition-colors"
          >
            {t('scheduleChange.exit')}
          </button>
          <h1 className="text-sm font-bold text-gray-900 tracking-tight">{t('scheduleChange.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-gray-100 rounded-lg px-3 py-1.5">
            <span className="text-xs font-bold text-gray-700 tabular-nums">{confirmed}</span>
            <span className="text-xs text-gray-400">/</span>
            <span className="text-xs text-gray-400 tabular-nums">{total}</span>
            <span className="text-[10px] text-gray-400 ml-0.5">{t('scheduleChange.confirmed')}</span>
          </div>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-white border border-gray-200 rounded-lg hover:bg-red-600 hover:border-red-600 transition-colors"
          >
            {t('common.delete')}
          </button>
          {finished && (
            <button
              onClick={() => setShowApplyModal(true)}
              className="px-3 py-1.5 text-xs font-bold text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors shadow-sm"
            >
              {t('scheduleChange.applyToSchedule')}
            </button>
          )}
        </div>
      </div>

      {/* Two-panel body */}
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {/* Left panel: TransitionView + calendar */}
        <div
          className="flex flex-col overflow-hidden"
          style={{ flex: `${100 - mapWidthPercent} 0 0%` }}
        >
          {/* TransitionView provides its own width/border/bg */}
          <div className="flex-1 flex overflow-hidden">
            {plan && (
              <TransitionView
                clients={store.clients}
                clientDayMap={new Map(
                  store.clients
                    .filter(c => c.startDate)
                    .map(c => [c.id, new Date(c.startDate! + 'T00:00:00').getDay()])
                )}
                initialMoves={initialMoves}
                config={transitionConfig}
                homeAddress={store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : { lat: 0, lng: 0 }}
                onClose={() => navigate('/schedule')}
                finished={finished}
                onFinish={() => setFinished(true)}
                onRequestManualPlacement={clientId => {
                  if (!plan) return
                  const pc = plan.clients.find(c => c.clientId === clientId)
                  if (!pc) return
                  const client = store.clients.find(c => c.id === clientId)
                  const cadenceMap = new Map<string, Frequency>(plan.builderRecurrence)
                  setPlacementCtx({
                    clientId,
                    clientName: client?.name ?? clientId,
                    cadence: cadenceMap.get(clientId) ?? 'weekly',
                  })
                }}
              />
            )}

            {/* Rotation grid panel — replaces the old 3-month calendar.
                Shows the full 4-week cycle at a glance and doubles as the
                manual-placement surface when placementCtx is set. */}
            <div className="flex-1 flex flex-col overflow-y-auto bg-surface-page">
              {plan && (
                <RotationGrid
                  plan={plan}
                  clients={store.clients}
                  workingDays={transitionConfig.workingDays}
                  maxJobsPerDay={transitionConfig.maxJobsPerDay}
                  placement={placementCtx}
                  onPlaceCell={handlePlaceCell}
                  onCancelPlacement={() => setPlacementCtx(null)}
                />
              )}
            </div>
          </div>
        </div>

        {/* Divider */}
        <div
          className="w-1.5 bg-gray-200 cursor-col-resize hover:bg-gray-400 active:bg-gray-500 transition-colors shrink-0"
          onMouseDown={() => {
            isDraggingDivider.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        />

        {/* Map panel (right) */}
        <div className="relative" style={{ flex: `${mapWidthPercent} 0 0%` }}>
          <ClientMap
            clients={mapClients}
            placedClientIds={placedClientIds}
            clientDayColorMap={clientDayColorMap}
            highlightedClientIds={null}
            emphasizedClientId={null}
            selectedDateLabel={null}
            onPinClick={() => {}}
            homeAddress={store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : null}
            route={null}
            dayColors={DAY_COLORS}
          />
        </div>
      </div>

      {/* Delete modal — discards the plan so the user can build a new one. */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">{t('scheduleChange.deleteTitle')}</h3>
            <p className="text-sm text-gray-600 mb-5">
              {t('scheduleChange.deleteBody')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDelete}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Apply modal — commits the plan to the live schedule from the cutover date. */}
      {showApplyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowApplyModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-4">{t('scheduleChange.applyTitle')}</h3>
            <div className="space-y-2 mb-5">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t('scheduleChange.totalClientsInPlan')}</span>
                <span className="font-semibold text-gray-900">{total}</span>
              </div>
            </div>
            <CutoverDatePicker value={cutoverDate} onChange={setCutoverDate} />
            <div className="text-xs text-gray-500 my-5 space-y-1.5">
              <p>
                {t('scheduleChange.jobsBeforePrefix')}{' '}
                <span className="font-semibold text-gray-700">
                  {cutoverDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>{' '}
                {t('scheduleChange.jobsBeforeSuffix')}
              </p>
              <p>{t('scheduleChange.fromDateForward')}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowApplyModal(false)}
                disabled={applying}
                className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleApply}
                disabled={applying}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-80 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {applying && (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                  </svg>
                )}
                {applying ? t('scheduleChange.applying') : t('scheduleChange.apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
