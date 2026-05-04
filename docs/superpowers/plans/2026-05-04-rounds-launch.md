# Rounds Launch Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Launch Rounds as standalone Schedule Builder product by copying pip-web, rebranding, hiding non-core UI, marking new signups as `is_beta: true`, deploying to new Vercel.

**Architecture:** Copy pip-web → new GitHub repo `Rounds` → hide UI (don't delete) → deploy to new Vercel project (same Supabase).

**Tech Stack:** Vite + React 19 + TypeScript, Supabase, Vercel

**Today's Date:** 2026-05-04
**Beta Goal:** 20-50 testers

---

## File Structure

**Web app lives at:** `/Users/anthonydragone/Developer/pip-web/web/`

**Pages to KEEP:**
- `web/src/pages/Login.tsx` (auth)
- `web/src/pages/AcceptInvite.tsx` (invites)
- `web/src/pages/Clients.tsx` (clients screen)
- `web/src/pages/Schedule.tsx` (calendar)
- `web/src/pages/ScheduleBuilder.tsx` (core feature)
- `web/src/pages/ScheduleChange.tsx` (transitions)

**Pages to HIDE in nav (keep code):**
- `web/src/pages/Dashboard.tsx`
- `web/src/pages/Settings.tsx`
- `web/src/pages/Reports.tsx`
- `web/src/pages/Team.tsx`

**Components to HIDE:**
- `web/src/components/AITracePanel.tsx` — AI feature
- `web/src/components/SmartPlacementSuggestions.tsx` — AI feature
- `web/src/components/PipPlusGate.tsx` — Paywall (always allow)
- `web/src/components/SubscriptionModal.tsx` — Paywall
- `web/src/components/MessageTemplatesModal.tsx` — Email feature

---

## Tasks

### Task 1: Create GitHub Repo + Local Copy (USER + AGENT)

User creates `Rounds` repo on GitHub.com, then agent copies code.

### Task 2: Rebrand Pip → Rounds

Find all "Pip" references in `web/src/`, `web/index.html`, `web/package.json`, replace with "Rounds".

### Task 3: Hide Non-Core Nav Items

Find main nav component (likely `App.tsx` or similar), hide Dashboard, Settings, Reports, Team buttons.

### Task 4: Hide AI Features

Hide all AI panel/button references in Schedule, ScheduleBuilder.

### Task 5: Remove Pip+ Gates

Make `PipPlusGate.tsx` always render children (no gating). Hide upgrade CTAs.

### Task 6: Hide Email/Message Features

Hide MessageTemplatesModal triggers.

### Task 7: Mark New Signups `is_beta: true`

In Login/signup flow, set `is_beta: true` in user metadata or users table on signup.

### Task 8: Update Landing Page Copy

Update Login page hero/copy to "Rounds — Schedule Builder for recurring work".

### Task 9: Deploy to Vercel (USER)

User connects new repo to Vercel, sets env vars.

---

## Self-Review

✅ All scope items covered
✅ Same Supabase reused (no migration needed yet)
✅ `is_beta` column needs to exist or be added — handled in Task 7
✅ No deletions, just hides — easy rollback
