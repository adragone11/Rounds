import { useEffect, useRef } from 'react'

/* Minimal Google Maps types — avoids @types/google.maps dependency */
declare global {
  interface Window {
    google?: {
      maps: {
        places: {
          Autocomplete: new (
            input: HTMLInputElement,
            opts?: Record<string, unknown>,
          ) => GoogleAutocomplete
        }
        event: { clearInstanceListeners(instance: unknown): void }
      }
    }
  }
}

interface GoogleAutocomplete {
  addListener(event: string, handler: () => void): void
  getPlace(): {
    formatted_address?: string
    geometry?: { location: { lat(): number; lng(): number } }
  }
}

/* ── Script loader (runs once) ── */

let loadPromise: Promise<void> | null = null

function loadGoogleMaps(): Promise<void> {
  if (window.google?.maps?.places) return Promise.resolve()
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
    if (!key) { reject(new Error('VITE_GOOGLE_MAPS_API_KEY not set')); return }

    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => { loadPromise = null; reject(new Error('Failed to load Google Maps')) }
    document.head.appendChild(script)
  })

  return loadPromise
}

/* ── Component ── */

interface Props {
  value: string
  onChange: (value: string) => void
  onSelect: (result: { address: string; lat: number; lng: number }) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

export default function AddressAutocomplete({
  value, onChange, onSelect, placeholder = 'Address', className, autoFocus, onKeyDown,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const acRef = useRef<GoogleAutocomplete | null>(null)
  // Stable refs so the listener closure always sees latest callbacks
  const onSelectRef = useRef(onSelect)
  const onChangeRef = useRef(onChange)
  onSelectRef.current = onSelect
  onChangeRef.current = onChange

  useEffect(() => {
    if (!inputRef.current) return
    const input = inputRef.current

    let ac: GoogleAutocomplete | null = null

    loadGoogleMaps()
      .then(() => {
        if (!input.isConnected) return

        ac = new window.google!.maps.places.Autocomplete(input, {
          types: ['address'],
          componentRestrictions: { country: 'us' },
          fields: ['formatted_address', 'geometry'],
        })

        ac.addListener('place_changed', () => {
          const place = ac!.getPlace()
          if (place.geometry?.location && place.formatted_address) {
            const result = {
              address: place.formatted_address,
              lat: place.geometry.location.lat(),
              lng: place.geometry.location.lng(),
            }
            onChangeRef.current(result.address)
            onSelectRef.current(result)
          }
        })

        acRef.current = ac
      })
      .catch(() => {
        // Google Maps failed to load — input still works as plain text
      })

    return () => {
      if (ac && window.google) window.google.maps.event.clearInstanceListeners(ac)
      acRef.current = null
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // When the Google autocomplete dropdown is visible and user presses Enter,
    // let Google handle the selection — don't propagate to parent (which would submit the form).
    if (e.key === 'Enter') {
      const pac = document.querySelector('.pac-container')
      if (pac && getComputedStyle(pac).display !== 'none') {
        e.preventDefault()
        return
      }
    }
    onKeyDown?.(e)
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={className}
      autoFocus={autoFocus}
    />
  )
}
