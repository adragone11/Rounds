import { useCallback, useRef } from 'react'
import type { DragEvent, Dispatch } from 'react'
import type { Frequency, Client } from '../types'
import type { UIAction } from '../lib/scheduleReducers'

type Pending = { clientId: string; date: string } | null
type PendingMove = { clientId: string; sourceDate: string; targetDate: string } | null

type StoreLike = {
  clients: Client[]
  placeClient: (clientId: string, date: string) => void
  unplaceClient: (clientId: string, date: string) => void
  unplaceClientFuture: (clientId: string, date: string, year: number, month: number) => void
  unplaceClientEverything: (clientId: string) => void
  placeClientRecurring: (clientId: string, date: string, frequency: Frequency) => void
  reanchorClient: (clientId: string, date: string, frequency: Frequency) => void
  syncMoveOccurrence: (clientId: string, sourceDate: string, targetDate: string) => Promise<unknown> | void
  syncCancelOccurrence: (clientId: string, date: string) => Promise<unknown> | void
  syncEndRecurrence: (clientId: string, date: string) => Promise<unknown> | void
  syncDeleteClientJobs: (clientId: string) => Promise<unknown> | void
  syncReanchor: (clientId: string, sourceDate: string, targetDate: string, frequency: Frequency) => Promise<unknown> | void
}

/**
 * Drag/drop handlers + recurring-edit confirmation flows for the schedule.
 *
 * Drops onto a date prompt for frequency (new placement) or a "just this /
 * this and future / all" choice (existing placement) — mirroring mobile's
 * recurring-edit prompt. One-time placements skip the prompt and apply
 * immediately. Sidebar drops remove placements via the same prompt path.
 */
export function useScheduleDragDrop(
  store: StoreLike,
  uiDispatch: Dispatch<UIAction>,
  pending: { drop: Pending; remove: Pending; move: PendingMove },
  year: number,
  month: number,
) {
  // Latest-ref pattern: keep stable callback identities so memoized children
  // (views, sidebar cards) don't re-render every time the parent renders.
  // The refs always point at the current values, so callbacks see fresh data
  // without any of these unstable inputs being baked into useCallback deps.
  const storeRef = useRef(store)
  storeRef.current = store
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const yearRef = useRef(year)
  yearRef.current = year
  const monthRef = useRef(month)
  monthRef.current = month

  const onDragStart = useCallback((e: DragEvent, clientId: string, sourceDate?: string) => {
    e.dataTransfer.setData('clientId', clientId)
    if (sourceDate) e.dataTransfer.setData('sourceDate', sourceDate)
    e.dataTransfer.effectAllowed = 'move'
    document.body.classList.add('is-dragging')
  }, [])

  const onDragOver = useCallback((e: DragEvent, date: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    uiDispatch({ type: 'SET_DRAG_OVER_DATE', payload: date })
  }, [uiDispatch])

  const onDragLeave = useCallback(
    () => uiDispatch({ type: 'SET_DRAG_OVER_DATE', payload: null }),
    [uiDispatch],
  )

  const onDrop = useCallback((e: DragEvent, date: string) => {
    e.preventDefault()
    uiDispatch({ type: 'SET_DRAG_OVER_DATE', payload: null })
    document.body.classList.remove('is-dragging')
    const clientId = e.dataTransfer.getData('clientId')
    const sourceDate = e.dataTransfer.getData('sourceDate')
    if (!clientId) return

    if (sourceDate) {
      const s = storeRef.current
      const client = s.clients.find(c => c.id === clientId)
      const freq = client?.frequency ?? 'weekly'
      if (freq === 'one-time') {
        s.unplaceClient(clientId, sourceDate)
        s.placeClient(clientId, date)
        void s.syncMoveOccurrence(clientId, sourceDate, date)
      } else {
        uiDispatch({ type: 'SET_PENDING_MOVE', payload: { clientId, sourceDate, targetDate: date } })
      }
    } else {
      uiDispatch({ type: 'SET_PENDING_DROP', payload: { clientId, date } })
    }
  }, [uiDispatch])

  const onSidebarDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onSidebarDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    document.body.classList.remove('is-dragging')
    const clientId = e.dataTransfer.getData('clientId')
    const sourceDate = e.dataTransfer.getData('sourceDate')
    if (!clientId || !sourceDate) return

    const s = storeRef.current
    const client = s.clients.find(c => c.id === clientId)
    const freq = client?.frequency ?? 'weekly'
    if (freq === 'one-time') {
      s.unplaceClient(clientId, sourceDate)
    } else {
      uiDispatch({ type: 'SET_PENDING_REMOVE', payload: { clientId, date: sourceDate } })
    }
  }, [uiDispatch])

  const confirmDrop = useCallback((frequency: Frequency) => {
    const p = pendingRef.current
    if (!p.drop) return
    storeRef.current.placeClientRecurring(p.drop.clientId, p.drop.date, frequency)
    uiDispatch({ type: 'SET_PENDING_DROP', payload: null })
  }, [uiDispatch])

  const confirmRemove = useCallback((mode: 'just-this' | 'this-and-future' | 'all') => {
    const p = pendingRef.current
    if (!p.remove) return
    const { clientId, date } = p.remove
    const s = storeRef.current

    if (mode === 'just-this') {
      s.unplaceClient(clientId, date)
      void s.syncCancelOccurrence(clientId, date)
    } else if (mode === 'this-and-future') {
      s.unplaceClientFuture(clientId, date, yearRef.current, monthRef.current)
      void s.syncEndRecurrence(clientId, date)
    } else {
      s.unplaceClientEverything(clientId)
      void s.syncDeleteClientJobs(clientId)
    }
    uiDispatch({ type: 'SET_PENDING_REMOVE', payload: null })
  }, [uiDispatch])

  const confirmMove = useCallback((mode: 'just-this' | 'this-and-future') => {
    const p = pendingRef.current
    if (!p.move) return
    const { clientId, sourceDate, targetDate } = p.move
    const s = storeRef.current
    const client = s.clients.find(c => c.id === clientId)
    const freq = client?.frequency ?? 'weekly'

    if (mode === 'just-this') {
      s.unplaceClient(clientId, sourceDate)
      s.placeClient(clientId, targetDate)
      void s.syncMoveOccurrence(clientId, sourceDate, targetDate)
    } else {
      s.unplaceClientFuture(clientId, sourceDate, yearRef.current, monthRef.current)
      s.reanchorClient(clientId, targetDate, freq)
      void s.syncReanchor(clientId, sourceDate, targetDate, freq)
    }
    uiDispatch({ type: 'SET_PENDING_MOVE', payload: null })
  }, [uiDispatch])

  return {
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onSidebarDragOver,
    onSidebarDrop,
    confirmDrop,
    confirmRemove,
    confirmMove,
  }
}
