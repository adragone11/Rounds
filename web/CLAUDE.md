# Pip Web — Schedule Command Center

## What This Is

Pip Web is the web companion to the Pip mobile app (iOS, React Native + Expo). Pip is a scheduling and client management app for house cleaners and solo service providers.

**Mobile = Field OS** — run your day (today's jobs, route, check-ins, earnings)
**Web = Command Center** — plan your schedule (Schedule Builder, optimization, client roster)

Owner plans on web (Sunday night, kitchen table). Executes on mobile (Monday-Friday, in the truck).

## Tech Stack

- **Framework:** Vite + React + TypeScript
- **Styling:** Tailwind CSS v4 (`@tailwindcss/vite` plugin)
- **Map:** Leaflet + react-leaflet + CartoDB Positron tiles
- **Backend:** Supabase (same project as mobile — shared `clients` table)
- **Auth:** Apple Sign-In (OAuth) + email/password + guest mode (localStorage)
- **Deployment:** Vercel
- **Repo:** https://github.com/adragone11/pip-web.git (separate from mobile)

## Important: TypeScript Config

This project uses `verbatimModuleSyntax: true` and `erasableSyntaxOnly: true`. This means:
- Type-only exports MUST use `export type { Foo }`, not `export interface Foo`
- Type-only imports MUST use `import type { Foo }`, not `import { Foo }`
- Mixing value and type imports in the same statement will cause runtime white screens

## Architecture

### Data Flow
- **Signed in:** Clients come from Supabase (`clients` table, same as mobile app). CRUD operations write to Supabase.
- **Guest mode:** Clients stored in localStorage. No Supabase calls.
- **Placements/recurrence/optimization:** Always localStorage (web-only scheduling state, not synced to mobile)

### Key Files
- `src/store.tsx` — Central data store (React context). Handles Supabase vs localStorage depending on auth state. All placement/recurrence logic lives here.
- `src/lib/supabase.ts` — Supabase client
- `src/lib/auth.tsx` — Auth context (Apple OAuth, email, guest mode)
- `src/optimizer.ts` — Schedule optimization engine (local moves + swap pairs). Currently uses Haversine distance, will be upgraded to ORS + VROOM.
- `src/types.ts` — Shared types (Client, Placement, ProposedMove, OptimizationState)
- `src/components/ClientMap.tsx` — Leaflet map with Pip-style pins
- `src/components/OptimizeView.tsx` — Full optimizer UI (move cards, swaps, confirmation flow, different day picker)
- `src/pages/Schedule.tsx` — Main schedule builder (calendar + sidebar + map, month/week/day views)
- `src/pages/Dashboard.tsx` — Stats and route scoring
- `src/pages/Clients.tsx` — Client roster + bulk import
- `src/pages/Login.tsx` — Auth page

### Optimization Engine (Critical Product Feature)

The optimizer uses **local moves, not global optimization**. Each suggestion is computed against the CURRENT schedule independently. No move depends on any other move. This prevents cascading failures when a client says "no."

Read `memory/project_schedule_optimizer_ux.md` in the mobile repo's memory for the full design doc — it covers the confirmation loop, client state machine, swap pairs, and the "perfect world" view strategy.

**Key principle:** VROOM (VRP solver at `pip-vroom.fly.dev`) generates the "perfect schedule" as a hypothesis. Each suggestion is then validated independently against the current state. The user sees only safe, independent moves.

### Mobile App Connection
- Same Supabase project: `eyblaqvwchwforutpowo.supabase.co`
- Same `clients` table with RLS (`auth.uid() = user_id`)
- Client columns: `id, user_id, name, phone, address, notes, avatar_color, latitude, longitude, rate, created_at`
- Web maps these to its own `Client` type in `types.ts`

## Env Vars

```
VITE_SUPABASE_URL=https://eyblaqvwchwforutpowo.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

## Apple Sign-In Setup
- Service ID: `com.pip.web.auth`
- Supabase Client IDs: `com.anthony.pip, com.pip.web.auth`
- Secret Key: JWT generated from Apple private key (expires every 6 months)
- Key ID: `RX73D4TK58`, Team ID: `2L4J8KLTK2`

## What's Next (Priority Order)
1. Deploy to Vercel (env vars needed)
2. Wire up real VROOM + ORS engine (replace mock Haversine in optimizer.ts)
3. Route preview per day
4. Client search/filter
5. "Perfect world" motivation view
6. Apple MapKit JS (replace Leaflet)
7. Dark mode

## Day Color Scheme
```
Sun=#F97316 Mon=#3B82F6 Tue=#EF4444 Wed=#10B981
Thu=#8B5CF6 Fri=#EC4899 Sat=#06B6D4
Grey (#9CA3AF) = Unplaced
```
Same zone colors as the mobile app's `clusterUtils.ts`.
