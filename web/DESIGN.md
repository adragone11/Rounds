# Pip Design System — Web Reference

Translated from the mobile app's `src/theme/` directory. Use these values to maintain visual consistency between mobile and web.

---

## Colors

### Brand / Primary
| Token | Light | Dark |
|-------|-------|------|
| primary.main | `#2196F3` | `#64B5F6` |
| primary.light | `#E3F2FD` | `#1E3A5F` |
| primary.dark | `#1976D2` | `#42A5F5` |

### Status
| Token | Light | Dark |
|-------|-------|------|
| success | `#4CAF50` | `#66BB6A` |
| warning | `#FF9800` | `#FFA726` |
| error | `#F44336` | `#EF5350` |
| info | `#2196F3` | `#64B5F6` |

### Backgrounds
| Token | Light | Dark | Tailwind Equivalent |
|-------|-------|------|---------------------|
| background.primary | `#F8F8FA` | `#0D0D0F` | `bg-gray-50` / `bg-gray-950` |
| background.secondary | `#F2F2F7` | `#1C1C1E` | `bg-gray-100` / `bg-gray-900` |
| background.card | `#FFFFFF` | `#18181B` | `bg-white` / `bg-zinc-900` |

### Text
| Token | Light | Dark | Tailwind Equivalent |
|-------|-------|------|---------------------|
| text.primary | `#000000` | `#FFFFFF` | `text-gray-900` / `text-white` |
| text.secondary | `#636366` | `#B0B0B0` | `text-gray-500` / `text-gray-400` |
| text.tertiary | `#8E8E93` | `#808080` | `text-gray-400` / `text-gray-500` |

### Borders
| Token | Light | Dark |
|-------|-------|------|
| border.light | `#E5E5EA` | `rgba(255,255,255,0.06)` |
| border.medium | `#D1D1D6` | `#48484A` |

### Surface
| Token | Light | Dark |
|-------|-------|------|
| surface.badge | `#EEEEF0` | `#222225` |
| surface.divider | `#E5E5EA` | `rgba(255,255,255,0.06)` |

---

## Zone / Day Colors (from `clusterUtils.ts`)

Used for map pins, calendar cards, and day-of-week identification.

```
ZONE_COLORS = [
  '#3B82F6',  // blue
  '#EF4444',  // red
  '#F97316',  // orange
  '#8B5CF6',  // purple
  '#10B981',  // green
  '#EC4899',  // pink
  '#06B6D4',  // cyan
  '#EAB308',  // yellow
  '#14B8A6',  // teal
  '#64748B',  // slate
]
```

### Day-of-Week Mapping (web Schedule Builder)
```
Sun = #F97316 (orange)
Mon = #3B82F6 (blue)
Tue = #EF4444 (red)
Wed = #10B981 (green)
Thu = #8B5CF6 (purple)
Fri = #EC4899 (pink)
Sat = #06B6D4 (cyan)

Unplaced = #9CA3AF (grey)
```

---

## Spacing Scale

Base-8 system. In Tailwind, map roughly to:

| Token | Value | Tailwind |
|-------|-------|----------|
| xs | 4px | `p-1` |
| sm | 8px | `p-2` |
| md | 12px | `p-3` |
| lg | 16px | `p-4` |
| xl | 20px | `p-5` |
| 2xl | 24px | `p-6` |
| 3xl | 32px | `p-8` |
| 4xl | 40px | `p-10` |

---

## Border Radius

| Token | Value | Tailwind |
|-------|-------|----------|
| xs | 4px | `rounded` |
| sm | 8px | `rounded-lg` |
| md | 12px | `rounded-xl` |
| lg | 16px | `rounded-2xl` |
| xl | 20px | `rounded-2xl` |
| 2xl | 24px | `rounded-3xl` |
| full | 9999px | `rounded-full` |

---

## Typography

| Preset | Size | Weight | Use |
|--------|------|--------|-----|
| h1 | 32px | 700 | Page titles |
| h2 | 24px | 600 | Section headers |
| h3 | 20px | 600 | Card titles |
| h4 | 18px | 600 | Sub-headers |
| h5 | 16px | 600 | Small headers |
| body | 14px | 400 | Default text |
| bodySmall | 12px | 400 | Secondary text |
| caption | 10px | 400 | Tiny labels |
| label | 12px | 500 | Form labels |
| button | 16px | 600 | Button text |

Font: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`)

---

## Shadows (Light Mode)

| Preset | CSS Equivalent |
|--------|----------------|
| sm | `shadow-sm` — `0 1px 2px rgba(0,0,0,0.05)` |
| base | `shadow` — `0 2px 4px rgba(0,0,0,0.08)` |
| card | `shadow-md` — `0 6px 16px rgba(0,0,0,0.15)` |
| lg | `shadow-lg` — `0 8px 16px rgba(0,0,0,0.12)` |

Dark mode: No shadows. Elevation through lighter background colors.

---

## Map Pin Style (from `map/styles.ts`)

```css
/* Pin dot */
width: 14px;
height: 14px;
border-radius: 50%;
border: 2.5px solid white;
background: <zone-color>;
box-shadow: 0 1px 3px rgba(0,0,0,0.3);

/* Pin callout (hover tooltip) */
background: white;
border-radius: 10px;
padding: 5px 10px;
box-shadow: 0 2px 6px rgba(0,0,0,0.15);
font-weight: 600;
font-size: 13px;
/* Arrow: 7px white triangle below */
```

---

## UI Patterns

- **Cards:** White bg, rounded-xl (12px), subtle shadow in light mode, no shadow in dark mode
- **Buttons (primary):** `bg-gray-900 text-white rounded-lg` (dark button style)
- **Buttons (secondary):** `border border-gray-300 text-gray-600 rounded-lg`
- **Status badges:** Colored bg with matching text: success=green, warning=amber, error=red, info=blue
- **Sidebar:** `bg-gray-900` with white text, active nav item has `bg-white/10`
- **Inputs:** `border border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-900/20`
- **Dividers:** `border-gray-200` (light), `border-white/6` (dark)
