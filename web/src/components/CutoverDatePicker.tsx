function formatDateForInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function CutoverDatePicker({ value, onChange }: { value: Date; onChange: (d: Date) => void }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dayOfWeek = today.getDay()
  const daysUntilMon = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7 || 7
  const nextMon = new Date(today)
  nextMon.setDate(today.getDate() + daysUntilMon)

  const fmt = (d: Date) => `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`

  const isToday = formatDateForInput(value) === formatDateForInput(today)
  const isNextMon = formatDateForInput(value) === formatDateForInput(nextMon)
  const isCustom = !isToday && !isNextMon

  return (
    <div>
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Cutover date</label>
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <button
            onClick={() => onChange(today)}
            className={`flex-1 px-2.5 py-2 text-[11px] font-semibold rounded-lg border transition-colors ${
              isToday ? 'bg-purple-50 border-purple-300 text-purple-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            Today
            <span className="block text-[10px] font-normal text-gray-400 mt-0.5">{fmt(today)}</span>
          </button>
          <button
            onClick={() => onChange(nextMon)}
            className={`flex-1 px-2.5 py-2 text-[11px] font-semibold rounded-lg border transition-colors ${
              isNextMon ? 'bg-purple-50 border-purple-300 text-purple-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            Next Monday
            <span className="block text-[10px] font-normal text-gray-400 mt-0.5">{fmt(nextMon)}</span>
          </button>
        </div>
        <input
          type="date"
          value={formatDateForInput(value)}
          onChange={e => {
            const d = new Date(e.target.value + 'T00:00:00')
            if (!isNaN(d.getTime())) onChange(d)
          }}
          className={`w-full h-8 px-2 text-sm border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/20 ${
            isCustom ? 'border-purple-300 text-purple-700' : 'border-gray-200 text-gray-500'
          }`}
        />
      </div>
    </div>
  )
}
