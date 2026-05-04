export type ParsedContact = {
  name: string
  address: string
  phone: string
  email: string
}

export function parseVCard(vcfText: string): ParsedContact[] {
  const contacts: ParsedContact[] = []
  const cards = vcfText.split(/(?=BEGIN:VCARD)/i).filter(c => c.trim())

  for (const card of cards) {
    const lines = card.split(/\r?\n/)
    let name = ''
    let address = ''
    let phone = ''
    let email = ''

    for (const line of lines) {
      const upper = line.toUpperCase()

      // Full name (FN) - preferred
      if (upper.startsWith('FN:') || upper.startsWith('FN;')) {
        name = extractValue(line)
      }
      // Fallback to N (structured name) if no FN
      else if (!name && (upper.startsWith('N:') || upper.startsWith('N;'))) {
        const parts = extractValue(line).split(';')
        const lastName = parts[0] || ''
        const firstName = parts[1] || ''
        name = `${firstName} ${lastName}`.trim()
      }
      // Address (ADR)
      else if (upper.startsWith('ADR:') || upper.startsWith('ADR;')) {
        const parts = extractValue(line).split(';')
        // ADR format: PO Box;Extended;Street;City;State;Zip;Country
        const street = parts[2] || ''
        const city = parts[3] || ''
        const state = parts[4] || ''
        const zip = parts[5] || ''
        address = [street, city, state, zip].filter(Boolean).join(', ')
      }
      // Phone (TEL)
      else if (upper.startsWith('TEL:') || upper.startsWith('TEL;')) {
        if (!phone) phone = extractValue(line)
      }
      // Email
      else if (upper.startsWith('EMAIL:') || upper.startsWith('EMAIL;')) {
        if (!email) email = extractValue(line)
      }
    }

    if (name) {
      contacts.push({ name, address, phone, email })
    }
  }

  return contacts
}

function extractValue(line: string): string {
  // Handle lines like "FN:John Doe" or "FN;CHARSET=UTF-8:John Doe"
  const colonIndex = line.indexOf(':')
  if (colonIndex === -1) return ''
  return line.slice(colonIndex + 1).trim()
}
