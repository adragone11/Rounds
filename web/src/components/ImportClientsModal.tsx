import { useState, useRef } from 'react'
import { parseVCard, type ParsedContact } from '../lib/vcardParser'
import { useStore } from '../store'

type Props = {
  onClose: () => void
}

export default function ImportClientsModal({ onClose }: Props) {
  const store = useStore()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [contacts, setContacts] = useState<ParsedContact[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setError(null)
    try {
      const text = await file.text()
      const parsed = parseVCard(text)
      if (parsed.length === 0) {
        setError('No contacts found in file')
        return
      }
      setContacts(parsed)
      setSelected(new Set(parsed.map((_, i) => i)))
    } catch (err) {
      setError('Failed to read file')
    }
  }

  const toggleSelect = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === contacts.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(contacts.map((_, i) => i)))
    }
  }

  const handleImport = async () => {
    if (selected.size === 0) return
    setImporting(true)
    setImported(0)

    const toImport = contacts.filter((_, i) => selected.has(i))
    let count = 0

    for (const contact of toImport) {
      await store.addClient(contact.name, contact.address, null, contact.phone)
      count++
      setImported(count)
    }

    setImporting(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Import Clients</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          {contacts.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-gray-600 mb-4">
                Export contacts from your phone as a .vcf file, then upload here.
              </p>
              <p className="text-xs text-gray-400 mb-6">
                iOS: Contacts → Select → Share → Save to Files
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".vcf"
                onChange={handleFileSelect}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700"
              >
                Choose .vcf File
              </button>
              {error && <p className="text-xs text-red-500 mt-3">{error}</p>}
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-gray-600">
                  Found {contacts.length} contact{contacts.length !== 1 ? 's' : ''}
                </p>
                <button
                  onClick={toggleAll}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  {selected.size === contacts.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {contacts.map((contact, i) => (
                  <label
                    key={i}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selected.has(i) ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggleSelect(i)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{contact.name}</p>
                      {contact.address && (
                        <p className="text-xs text-gray-500 truncate">{contact.address}</p>
                      )}
                      {contact.phone && (
                        <p className="text-xs text-gray-400">{contact.phone}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {contacts.length > 0 && (
          <div className="p-4 border-t border-gray-200">
            <button
              onClick={handleImport}
              disabled={importing || selected.size === 0}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {importing
                ? `Importing... ${imported}/${selected.size}`
                : `Import ${selected.size} Client${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
