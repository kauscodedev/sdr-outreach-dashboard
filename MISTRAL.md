# MISTRAL.md

**Guidance for Mistral AI and human developers working with this repository.**

This file provides context about the SDR Outreach Dashboard project, focusing on the **Enhanced Attention Board** feature that was recently shipped. It explains the architecture, key decisions, and implementation patterns to help both AI assistants and human developers understand and extend the codebase.

> **Source of truth:** for the full architecture, data model, and cross-cutting conventions, see
> [`CLAUDE.md`](./CLAUDE.md) — the canonical, up-to-date agent guide. This file is scoped to the
> **Attention Board** feature. The app is now on **V2** (renamed **TrackerAI**): HubSpot **deals**,
> **Deal Health** (green/yellow/red), and a **demo-status funnel** (Demo Pending / Scheduled / Done)
> now sit alongside hot/warm/cold temperature, and the tracked roster is **DB-backed** (`sdr_roster`,
> admin-editable) rather than a hard-coded config list. Read the temperature/coverage notes below as
> one part of that larger picture.

---

## 📦 What Was Shipped: Enhanced Attention Board

### Overview

The **Enhanced Attention Board** transforms the AI agent's output from a static list of hot accounts into an **actionable, prioritized work queue** for SDRs. It was built on top of the existing AI agent infrastructure (`lib/agent/*`) and replaces the basic `AttentionBoard` component with a feature-rich version.

### Key Features Delivered

| Feature | Description | User Value |
|---------|-------------|------------|
| **Smart Ranking Algorithm** | Composite score (0-100) based on priority, recency, account value, velocity, and confidence | SDRs focus on highest-impact accounts first |
| **Kanban View** | Group watches by workflow status (Not Started, In Progress, Completed, Snoozed) | Visual workflow management |
| **List View (Enhanced)** | Traditional table view with rank scores, workflow status badges | Familiar interface with new data |
| **Quick Action Buttons** | One-click: Call, Email, Snooze, Complete | Faster action logging |
| **Snooze Functionality** | Hide watches for 1/3/7/14 days with auto-resurface | Reduce noise, focus on relevant work |
| **Workflow Status Tracking** | Client-side state management per watch | Track progress without database changes |
| **Cross-tab Synchronization** | Actions sync across browser tabs via BroadcastChannel | Seamless multi-tab experience |
| **Rank Score Display** | Shows composite score (0-100) on each watch | Transparent prioritization |

### Files Shipped

```
├── components/AttentionBoardEnhanced.tsx  # Main UI component (795 lines)
├── lib/agent/ranking.ts                   # Smart ranking algorithm (194 lines)
├── lib/agent/actions.ts                  # Client-side action tracking (274 lines)
├── tests/agent-ranking.test.ts           # Comprehensive test suite (228 lines)
└── app/attention/page.tsx               # Updated to use enhanced component
```

**Total: 5 files, +1,493 lines, -2 lines, 19 new tests**

---

## 🏗️ Architecture & Design Decisions

### Core Philosophy

1. **Zero Database Changes**: The entire feature works with existing data. No new tables, no schema migrations.
2. **Client-Side First**: Action tracking uses localStorage + BroadcastChannel. No server round-trips for workflow state.
3. **Progressive Enhancement**: The original `AttentionBoard.tsx` is preserved. The new component can be swapped in/out.
4. **No Breaking Changes**: All existing types, functions, and components remain compatible.

### Data Flow

```
HubSpot Data → Postgres Spine → Snapshot → AI Agent → sdr_agent_watches
                                                      ↓
                                              AttentionBoardEnhanced
                                                      ↓
                                          [Client-Side State]
                                              localStorage
                                                  ↓
                                            BroadcastChannel
                                                  ↓
                                          Cross-tab Sync
```

### Ranking Algorithm

The smart ranking uses a **weighted composite score** (0-100):

```typescript
score = (
  priorityWeight   * priorityScore    // 30% - Agent's priority (high=100, medium=60, low=30)
  + recencyWeight   * recencyScore     // 25% - Linear decay over 3 days (100 at now, 0 at 72h)
  + valueWeight     * valueScore       // 20% - Account segment (top_150=100, smb=40)
  + velocityWeight  * velocityScore    // 15% - Uses agent confidence as proxy
  + confidenceWeight * confidenceScore // 10% - Agent's confidence (0-1 → 0-100)
)
```

**Weights are configurable** in `RANKING_WEIGHTS` constant. Easy to tune without changing logic.

### Segment Scores

Account value by market segment:

| Segment | Score | Rationale |
|---------|-------|-----------|
| top_150 | 100 | Highest-value accounts |
| enterprise_a | 95 | Large enterprise |
| enterprise_b | 90 | Enterprise tier B |
| enterprise_c | 85 | Enterprise tier C |
| mm_group | 70 | Mid-market group |
| mm_single | 60 | Mid-market single |
| smb | 40 | Small business |
| unsized | 50 | Default fallback |

### Client-Side State Management

**Why localStorage?**
- No database changes required
- Works offline
- Fast (no network latency)
- Simple to implement
- Can be migrated to server-side later

**State Structure:**
```typescript
interface WatchAction {
  accountId: string;
  status: "not_started" | "in_progress" | "completed" | "snoozed";
  lastActionAt: string | null;        // ISO timestamp
  lastActionType: "call" | "email" | "meeting" | "note" | "snoozed" | null;
  snoozedUntil: string | null;        // ISO timestamp for auto-resurface
  notes: string[];                    // History of actions
}
```

**Sync Mechanism:**
- Uses `BroadcastChannel` API for cross-tab communication
- All tabs receive updates when any tab modifies state
- Graceful degradation if BroadcastChannel not supported

---

## 🔧 Implementation Patterns

### 1. Pure Functions First

The ranking algorithm (`lib/agent/ranking.ts`) is **100% pure**:
- No side effects
- No dependencies on external state
- Easy to test
- Easy to reason about
- Can be used anywhere (server, client, scripts)

```typescript
// Good: Pure function
export function calculateRankScore(watch: AgentWatch, segment?: string): number {
  // Only uses input parameters, no external state
  // Returns deterministic output
}

// Good: Pure function
export function sortWatchesByRank(watches: AgentWatch[], segmentMap: Map<string, string>): AgentWatch[] {
  // Returns new sorted array, doesn't mutate input
}
```

### 2. Client-Side State with localStorage

Pattern for persistent client-side state:

```typescript
// lib/agent/actions.ts

// Storage key
const ACTION_STORAGE_KEY = "sdr-attention-actions";

// Load from localStorage
export function loadActions(): Map<string, WatchAction> {
  if (typeof window === "undefined") return new Map();
  try {
    const stored = localStorage.getItem(ACTION_STORAGE_KEY);
    return stored ? new Map(Object.entries(JSON.parse(stored))) : new Map();
  } catch {
    return new Map();
  }
}

// Save to localStorage + broadcast
export function updateAction(accountId: string, updates: Partial<WatchAction>): WatchAction {
  const actions = loadActions();
  const newAction = { ...actions.get(accountId), ...updates, accountId };
  actions.set(accountId, newAction);
  saveActions(actions);  // Persists to localStorage
  broadcastActionsUpdate(actions);  // Syncs to other tabs
  return newAction;
}
```

### 3. React Hooks Pattern

Component uses React hooks for state and effects:

```typescript
// In AttentionBoardEnhanced.tsx

// State hooks
const [actions, setActions] = useState<Map<string, WatchAction>>(new Map());
const [viewMode, setViewMode] = useState<"list" | "kanban">("list");

// Effect hook for initialization
useEffect(() => {
  setActions(loadActions());
  initActionsListener(() => setActions(loadActions()));
  return () => closeActionsListener();
}, []);

// Memoized derived state
const enhancedWatches = useMemo(() => {
  return enhanceWatches(watches, segmentMap, actionMap);
}, [watches, segmentMap, actionMap]);

const sortedWatches = useMemo(() => {
  return sortWatchesByRank(enhancedWatches, segmentMap);
}, [enhancedWatches, segmentMap]);
```

### 4. Type Safety

All new code is **fully typed** with TypeScript:

```typescript
// Extended type for enhanced watches
export interface RankedWatch extends AgentWatch {
  rank: number;                    // 0-100 composite score
  workflowStatus: WorkflowStatus;  // not_started | in_progress | completed | snoozed
  segment?: MarketSegment | string; // Account segment
}

// Workflow status type
export type WorkflowStatus = "not_started" | "in_progress" | "completed" | "snoozed";

// Action tracking type
export interface WatchAction {
  accountId: string;
  status: WorkflowStatus;
  lastActionAt: string | null;
  lastActionType: "call" | "email" | "meeting" | "note" | "snoozed" | null;
  snoozedUntil: string | null;
  notes: string[];
}
```

### 5. Test Pattern

Tests follow the **AAA pattern** (Arrange, Act, Assert):

```typescript
// tests/agent-ranking.test.ts

describe("calculateRankScore", () => {
  it("returns 100 for a perfect watch", () => {
    // Arrange
    const watch = makeWatch({
      accountId: "A",
      priority: "high",
      lastSignalMs: NOW,
      confidence: 1.0,
    });
    
    // Act
    const score = calculateRankScore(watch, "top_150");
    
    // Assert
    expect(score).toBeCloseTo(100, 0.1);
  });
});
```

**Test Coverage:**
- All ranking functions tested
- Edge cases covered (null values, boundary conditions)
- Constants validated (weights sum to 1.0, segment scores ordered correctly)

---

## 🎯 Key Design Decisions

### Decision 1: Client-Side State vs. Database

**Chosen:** Client-side state with localStorage

**Rationale:**
- ✅ No database schema changes required
- ✅ Works immediately, no deployment coordination
- ✅ Fast, no network latency
- ✅ Offline-capable
- ✅ Easy to implement and test
- ⚠️ State is per-browser (not synced across devices)
- ⚠️ Cleared when user clears browser data

**Future Migration Path:**
```typescript
// When ready for server-side persistence:
// 1. Add workflow_status column to sdr_agent_watches
// 2. Modify store.ts to read/write workflow status
// 3. Update actions.ts to sync with server
// 4. Remove localStorage dependency
```

### Decision 2: Composite Score vs. Simple Priority

**Chosen:** Composite score with 5 weighted factors

**Rationale:**
- ✅ More nuanced prioritization
- ✅ Considers multiple dimensions (not just priority)
- ✅ Configurable weights for tuning
- ✅ Transparent (score visible to users)
- ⚠️ Slightly more complex than simple priority sort

**Alternative Considered:** Simple priority + recency sort
- Would have been simpler but less effective
- Doesn't account for account value or confidence

### Decision 3: Kanban + List Views

**Chosen:** Both views available, user can toggle

**Rationale:**
- ✅ Different users prefer different workflows
- ✅ Kanban for visual thinkers
- ✅ List for data-oriented users
- ✅ Shared underlying data model
- ⚠️ Slightly more code to maintain

**Alternative Considered:** Kanban-only or List-only
- Would have limited user flexibility
- Harder to satisfy all user preferences

### Decision 4: Snooze with Auto-Resurface

**Chosen:** Snooze with configurable durations + auto-resurface

**Rationale:**
- ✅ Reduces noise in the queue
- ✅ Accounts automatically reappear when relevant
- ✅ Configurable durations (1/3/7/14 days)
- ✅ Visual indicator of snooze countdown
- ⚠️ Requires checking snooze expiration

**Implementation:**
```typescript
// Snooze for N days
export function snoozeWatch(accountId: string, days: number): WatchAction {
  const snoozedUntil = new Date();
  snoozedUntil.setDate(snoozedUntil.getDate() + days);
  return updateAction(accountId, {
    status: "snoozed",
    lastActionType: "snoozed",
    snoozedUntil: snoozedUntil.toISOString(),
  });
}

// Check if should resurface
export function shouldResurface(accountId: string): boolean {
  const action = getAction(accountId);
  if (!action?.snoozedUntil) return false;
  return new Date(action.snoozedUntil) <= new Date();
}
```

### Decision 5: Preserve Original Component

**Chosen:** Keep `AttentionBoard.tsx` unchanged, create new `AttentionBoardEnhanced.tsx`

**Rationale:**
- ✅ Zero risk to existing functionality
- ✅ Easy rollback if issues arise
- ✅ Can A/B test both versions
- ✅ Gradual migration path
- ⚠️ Slight code duplication

**Migration Path:**
```bash
# When ready to fully migrate:
rm components/AttentionBoard.tsx
mv components/AttentionBoardEnhanced.tsx components/AttentionBoard.tsx
# Update import in app/attention/page.tsx
```

---

## 🚀 How to Extend This Feature

### Adding Server-Side Persistence

1. **Add column to database:**
   ```sql
   ALTER TABLE sdr_agent_watches ADD COLUMN workflow_status TEXT;
   ALTER TABLE sdr_agent_watches ADD COLUMN last_action_at TIMESTAMPTZ;
   ALTER TABLE sdr_agent_watches ADD COLUMN snoozed_until TIMESTAMPTZ;
   ```

2. **Update store.ts:**
   ```typescript
   // Add workflow status to upsertWatch
   export async function upsertWatch(account: HotAccount, verdict: AgentVerdict, model: string, existed: boolean, workflowStatus?: WorkflowStatus): Promise<void> {
     const row: Record<string, unknown> = {
       // ... existing fields
       workflow_status: workflowStatus ?? "not_started",
       last_action_at: workflowStatus ? new Date().toISOString() : null,
     };
     // ... rest of function
   }
   ```

3. **Update actions.ts:**
   ```typescript
   // Sync with server when actions change
   export function updateAction(accountId: string, updates: Partial<WatchAction>): WatchAction {
     const actions = loadActions();
     const newAction = { ...actions.get(accountId), ...updates, accountId };
     actions.set(accountId, newAction);
     saveActions(actions);
     broadcastActionsUpdate(actions);
     
     // NEW: Sync to server
     if (updates.status) {
       syncWorkflowStatusToServer(accountId, updates.status);
     }
     
     return newAction;
   }
   ```

### Adding Real Velocity Calculation

1. **Track activity history:**
   ```typescript
   // In store.ts or a new file
   export async function getActivityHistory(accountId: string, days: number = 7): Promise<Activity[]> {
     const db = supabaseAdmin();
     const { data } = await db
       .from("sdr_activities")
       .select("*")
       .contains("company_ids", [accountId])
       .gte("ts_ms", Date.now() - days * 86400000)
       .order("ts_ms", { ascending: false });
     return data as Activity[];
   }
   ```

2. **Calculate velocity:**
   ```typescript
   // In ranking.ts
   export function calculateVelocityScore(accountId: string): number {
     const history = getActivityHistory(accountId);
     if (history.length < 2) return 50; // Neutral score
     
     // Calculate acceleration: are activities increasing over time?
     const recent = history.slice(0, 3); // Last 3 activities
     const older = history.slice(3, 6); // Previous 3 activities
     
     const recentRate = recent.length / (recent[0].ts_ms - recent[recent.length-1].ts_ms);
     const olderRate = older.length / (older[0].ts_ms - older[older.length-1].ts_ms);
     
     // If recent rate > older rate, velocity is positive
     const acceleration = recentRate - olderRate;
     
     // Normalize to 0-100
     return Math.min(100, Math.max(0, acceleration * 1000));
   }
   ```

### Adding Drag-and-Drop to Kanban

1. **Install drag-and-drop library:**
   ```bash
   npm install @dnd-kit/core @dnd-kit/sortable
   ```

2. **Wrap Kanban columns:**
   ```typescript
   import { DndContext, closestCenter } from '@dnd-kit/core';
   import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
   
   // In AttentionBoardEnhanced.tsx
   function KanbanView() {
     const [items, setItems] = useState(workflowGroups);
     
     const handleDragEnd = (event) => {
       const { active, over } = event;
       if (active.id !== over.id) {
         setItems((prev) => {
           const newItems = { ...prev };
           const fromColumn = active.data.current.column;
           const toColumn = over.data.current.column;
           const fromIndex = active.data.current.index;
           const toIndex = over.data.current.index;
           
           // Move item between columns
           const [removed] = newItems[fromColumn].splice(fromIndex, 1);
           newItems[toColumn].splice(toIndex, 0, removed);
           
           // Update workflow status
           updateAction(removed.accountId, { status: toColumn });
           
           return newItems;
         });
       }
     };
     
     return (
       <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
         <div className="grid grid-cols-4 gap-4">
           {(Object.entries(items) as [WorkflowStatus, RankedWatch[]][]).map(([status, watches]) => (
             <SortableContext key={status} items={watches} strategy={verticalListSortingStrategy}>
               {/* Column content */}
             </SortableContext>
           ))}
         </div>
       </DndContext>
     );
   }
   ```

### Adding Team Collaboration

1. **Add assignment field:**
   ```typescript
   // In types.ts
   export interface AgentWatch {
     // ... existing fields
     assignedTo: string | null;  // Rep owner_id who is working this
   }
   ```

2. **Add assignment UI:**
   ```typescript
   // In AttentionBoardEnhanced.tsx
   function WatchCard({ watch }: { watch: RankedWatch }) {
     const [assignedTo, setAssignedTo] = useState(watch.assignedTo);
     
     return (
       <div>
         {/* ... existing content */}
         <select 
           value={assignedTo ?? ""} 
           onChange={(e) => {
             updateAction(watch.accountId, { assignedTo: e.target.value });
             setAssignedTo(e.target.value);
           }}
         >
           <option value="">Unassigned</option>
           {reps.map((repId) => (
             <option key={repId} value={repId}>{REPS[repId] ?? repId}</option>
           ))}
         </select>
       </div>
     );
   }
   ```

---

## 🔍 Codebase Navigation Guide

### Key Directories

```
├── app/                    # Next.js pages and API routes
│   └── attention/          # Attention Board page
│       └── page.tsx        # Main page (uses AttentionBoardEnhanced)
│
├── components/             # React components
│   ├── AttentionBoard.tsx          # Original (preserved)
│   └── AttentionBoardEnhanced.tsx # Enhanced version (NEW)
│
├── lib/                    # Core logic and utilities
│   ├── agent/              # AI agent functionality
│   │   ├── ranking.ts      # Smart ranking algorithm (NEW)
│   │   ├── actions.ts      # Client-side action tracking (NEW)
│   │   ├── store.ts        # Database operations for watches
│   │   ├── runner.ts       # Agent execution logic
│   │   ├── detect.ts       # Watch detection logic
│   │   ├── openai.ts       # OpenAI integration
│   │   ├── prompt.ts       # Agent prompts
│   │   ├── context.ts      # Context building
│   │   └── types.ts        # Type definitions
│   │
│   ├── sync/               # Data synchronization
│   │   ├── aggregate.ts    # Snapshot aggregation
│   │   ├── temperature.ts   # Temperature classification
│   │   └── ...
│   │
│   └── spine/              # Postgres spine operations
│       ├── runner.ts       # Sync orchestration
│       ├── store.ts        # Spine database operations
│       └── ...
│
├── config/                # Configuration files
│   ├── reps.ts             # Rep seed/fallback — the DB roster (sdr_roster) is authoritative
│   ├── dispositions.ts     # HubSpot disposition mappings
│   └── hubspot.ts          # HubSpot configuration
│
├── supabase/              # Database schema and migrations
│   └── sdr_schema.sql      # Postgres schema for sdr_* tables
│
└── tests/                 # Test files
    ├── agent-ranking.test.ts  # Ranking tests (NEW)
    ├── agent-detect.test.ts    # Detection tests
    └── ...
```

### Important Files for Understanding the Feature

| File | Purpose | Key Functions/Exports |
|------|---------|----------------------|
| `lib/agent/ranking.ts` | Ranking algorithm | `calculateRankScore`, `sortWatchesByRank`, `enhanceWatches`, `groupWatchesByWorkflow` |
| `lib/agent/actions.ts` | Action tracking | `loadActions`, `updateAction`, `markInProgress`, `markCompleted`, `snoozeWatch` |
| `components/AttentionBoardEnhanced.tsx` | UI component | `AttentionBoardEnhanced` (default export) |
| `app/attention/page.tsx` | Page integration | Server component that loads watches and renders the board |
| `tests/agent-ranking.test.ts` | Tests | 19 tests for ranking algorithm |

### Data Model Reference

**AgentWatch (from `lib/agent/types.ts`):**
```typescript
interface AgentWatch {
  accountId: string;           // HubSpot company ID
  accountName: string | null;  // Company name
  repId: string | null;        // Owning rep's owner ID
  status: WatchStatus;         // watching | meeting_booked | drop_off | closed
  temp: string | null;         // hot | warm | cold
  reason: string | null;        // Why it's hot
  nextStep: string | null;     // JSON string with action details
  priority: Priority | null;    // high | medium | low
  confidence: number | null;   // 0-1 confidence score
  enteredHotAt: string | null;  // When first detected as hot
  lastSignalMs: number | null;  // Timestamp of last activity
  lastReviewedAt: string | null; // When agent last reviewed
  model: string | null;        // Model used for last review
}
```

**RankedWatch (extended type):**
```typescript
interface RankedWatch extends AgentWatch {
  rank: number;                    // 0-100 composite score
  workflowStatus: WorkflowStatus;  // not_started | in_progress | completed | snoozed
  segment?: MarketSegment | string; // Account segment
}
```

---

## 🎓 Learning Resources

### For Understanding the Ranking Algorithm

1. **Start with:** `lib/agent/ranking.ts` - Read the JSDoc comments at the top
2. **See the weights:** `RANKING_WEIGHTS` constant
3. **See the scores:** `SEGMENT_SCORES` constant
4. **Trace the calculation:** `calculateRankScore()` function
5. **See tests:** `tests/agent-ranking.test.ts` - Examples of how it works

### For Understanding the UI

1. **Start with:** `components/AttentionBoardEnhanced.tsx`
2. **See the state:** `useState` hooks at the top
3. **See the derived state:** `useMemo` hooks
4. **See the views:** `viewMode` state and conditional rendering
5. **See the actions:** Quick action button handlers

### For Understanding the Data Flow

1. **Start with:** `app/attention/page.tsx` - How data is loaded
2. **Follow to:** `lib/agent/store.ts` - How watches are fetched
3. **See enhancement:** `lib/agent/ranking.ts` - How watches are ranked
4. **See tracking:** `lib/agent/actions.ts` - How actions are tracked
5. **See UI:** `components/AttentionBoardEnhanced.tsx` - How it's displayed

---

## 💡 Common Patterns in This Codebase

### 1. Server-Only Modules

Modules that use Supabase admin client are marked with `server-only`:

```typescript
import "server-only";
import { supabaseAdmin } from "../supabase/admin";

export async function getWatches(): Promise<Map<string, AgentWatch>> {
  const db = supabaseAdmin();
  // ... database operations
}
```

**Why:** Prevents these modules from being imported in client components (would cause errors).

### 2. Static Imports for Vercel

Snapshot loading uses static imports to ensure files are included in the build:

```typescript
// In lib/snapshot.ts
import snapshotData from "../data/snapshot.json";

// This ensures snapshot.json is included in the Vercel output
```

**Why:** Vercel's output tracing misses dynamic `require()` calls.

### 3. US/Eastern Time Handling

The dashboard uses US/Eastern timezone for all date displays:

```typescript
function formatDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    // ... format options
  });
}
```

**Why:** Business operates in US/Eastern time.

### 4. HubSpot Integration

All HubSpot IDs are strings (not numbers):

```typescript
// Owner IDs, company IDs, contact IDs are all strings
interface Activity {
  ownerId: string;      // HubSpot owner ID
  companyIds: string[]; // HubSpot company IDs
  contactIds: string[]; // HubSpot contact IDs
}
```

**Why:** HubSpot uses string IDs, not numeric.

### 5. Disposition Handling

Call dispositions are mapped from GUIDs to labels:

```typescript
// In config/dispositions.ts
import { isConnected, isHighIntent, isNegative } from "../config/dispositions";

if (isConnected(activity.disposition)) {
  // Human was reached
}
```

**Why:** Business rule for "connected" is specific set of disposition GUIDs.

---

## 🚨 Troubleshooting Guide

### Issue: Tests Not Running

**Symptom:** New test file not being picked up by vitest

**Solution:**
1. Check file name ends with `.test.ts`
2. Check file is in `tests/` directory
3. Check vitest config includes the file pattern
4. Clear vitest cache: `rm -rf node_modules/.vite`

### Issue: TypeScript Errors

**Symptom:** Type errors in new code

**Solution:**
1. Check all imports are correct
2. Check all types are properly defined
3. Run `npx tsc --noEmit` for detailed errors
4. Use type assertions sparingly (`as Type`)

### Issue: localStorage Not Working

**Symptom:** Actions not persisting across page refreshes

**Solution:**
1. Check browser console for errors
2. Check if localStorage is available (`typeof window !== "undefined"`)
3. Check if localStorage is full (clear browser data)
4. Check if site has localStorage permissions

### Issue: BroadcastChannel Not Working

**Symptom:** Actions not syncing across tabs

**Solution:**
1. Check if browser supports BroadcastChannel
2. Check if tabs are on the same origin
3. Check for errors in browser console
4. Fallback: Use polling or manual refresh

---

## 📚 Glossary

| Term | Definition | Example |
|------|------------|---------|
| **Attention Board** | UI for viewing and managing hot account watches | `/attention` page |
| **Watch** | A hot account being tracked by the AI agent | `AgentWatch` interface |
| **Rank Score** | Composite score (0-100) for prioritizing watches | 85.5 |
| **Workflow Status** | Current state of work on a watch | not_started, in_progress |
| **Snooze** | Temporarily hide a watch | 3 days |
| **Velocity** | Engagement acceleration (uses confidence as proxy) | 0-100 score |
| **Spine** | Postgres data layer for outreach data | `sdr_*` tables |
| **Snapshot** | Aggregated outreach data (single jsonb row) | `sdr_snapshots` table |
| **Agent** | AI that analyzes hot accounts | GPT-4o-mini |
| **Temperature** | Account engagement level | hot, warm, cold |

---

## 🎯 Summary

This `MISTRAL.md` file documents the **Enhanced Attention Board** feature that was shipped to the SDR Outreach Dashboard. It provides:

1. **What was built** - Feature overview and scope
2. **How it's built** - Architecture, design decisions, implementation patterns
3. **How to extend it** - Future enhancement paths
4. **How to navigate** - Codebase structure and key files
5. **How to troubleshoot** - Common issues and solutions
6. **Glossary** - Key terms and definitions

**For LLMs:** Use this file to understand the codebase context, architecture, and patterns before making changes.

**For Humans:** Use this file as a reference for the Enhanced Attention Board feature and as a guide for extending it.

**Last Updated:** July 11, 2026 (after Enhanced Attention Board merge)

---

*This file is inspired by CLAUDE.md and AGENTS.md in the repository, providing guidance specifically for the Mistral AI assistant and human developers working with this codebase.*
