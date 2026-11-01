import Std

namespace Queue

structure Entry where
  id : Nat
  revision : Nat
  editing : Bool
  deriving DecidableEq, Repr

structure State where
  running : Bool
  queue : List Entry
  deriving DecidableEq, Repr

def initial : State := ⟨false, []⟩

def enqueue (state : State) (entry : Entry) : State :=
  if state.queue.length < 20 then { state with queue := state.queue ++ [entry] } else state

def editEntry (target : Nat) (entry : Entry) : Entry :=
  if entry.id = target then { entry with editing := true } else entry

def saveEntry (target revision : Nat) (entry : Entry) : Entry :=
  if entry.id = target ∧ entry.revision = revision ∧ entry.editing = true then
    { entry with revision := entry.revision + 1, editing := false }
  else entry

def cancelEntry (target revision : Nat) (entry : Entry) : Entry :=
  if entry.id = target ∧ entry.revision = revision then { entry with editing := false } else entry

def edit (state : State) (target : Nat) : State :=
  { state with queue := state.queue.map (editEntry target) }

def save (state : State) (target revision : Nat) : State :=
  { state with queue := state.queue.map (saveEntry target revision) }

def cancel (state : State) (target revision : Nat) : State :=
  { state with queue := state.queue.map (cancelEntry target revision) }

def delete (state : State) (target : Nat) : State :=
  { state with queue := state.queue.filter (fun entry => entry.id != target) }

def stop (state : State) : State := { state with queue := [] }
def restart (state : State) : State := { state with running := false }

/-- Batch selection abstracts commands, attachments, and source-thread boundaries. -/
def canDrain (state : State) (count : Nat) : Prop :=
  state.running = false ∧ 0 < count ∧ count ≤ state.queue.length ∧
    ∀ entry ∈ state.queue.take count, entry.editing = false

instance (state : State) (count : Nat) : Decidable (canDrain state count) :=
  inferInstanceAs (Decidable (_ ∧ _ ∧ _ ∧ ∀ entry ∈ state.queue.take count, _))

def drain (state : State) (count : Nat) : State × List Entry :=
  if canDrain state count then
    ({ state with queue := state.queue.drop count }, state.queue.take count)
  else (state, [])

inductive Step : State → State → Prop where
  | enqueue (state entry) : Step state (enqueue state entry)
  | edit (state target) : Step state (edit state target)
  | save (state target revision) : Step state (save state target revision)
  | cancel (state target revision) : Step state (cancel state target revision)
  | delete (state target) : Step state (delete state target)
  | stop (state) : Step state (stop state)
  | restart (state) : Step state (restart state)
  | drain (state count) : Step state (drain state count).1
  | running (state flag) : Step state { state with running := flag }

inductive Reachable : State → Prop where
  | initial : Reachable initial
  | next : Reachable before → Step before after → Reachable after

theorem step_capacity (step : Step before after) (bound : before.queue.length ≤ 20) :
    after.queue.length ≤ 20 := by
  cases step with
  | enqueue entry =>
    simp only [enqueue]
    split <;> simp_all <;> omega
  | edit => simpa [edit] using bound
  | save => simpa [save] using bound
  | cancel => simpa [cancel] using bound
  | delete target =>
    have filtered := List.length_filter_le (fun entry : Entry => entry.id != target) before.queue
    simp only [delete]
    omega
  | stop => simp [stop]
  | restart => exact bound
  | drain count =>
    simp only [drain]
    split
    · simp only [List.length_drop]; omega
    · exact bound
  | running => exact bound

theorem reachable_capacity (reachable : Reachable state) : state.queue.length ≤ 20 := by
  induction reachable with
  | initial => simp [initial]
  | next _ step bounded => exact step_capacity step bounded

theorem running_drain (running : state.running = true) : drain state count = (state, []) := by
  simp [drain, canDrain, running]

theorem held_head_drain (head : state.queue = entry :: tail) (held : entry.editing = true) :
    drain state count = (state, []) := by
  have blocked : ¬ canDrain state count := by
    intro ⟨_, positive, _, unheld⟩
    cases count with
    | zero => omega
    | succ remaining =>
      have impossible := unheld entry (by simp [head])
      simp [held] at impossible
  simp [drain, blocked]

theorem stop_clears : (stop state).queue = [] := rfl

theorem stopped_restart_drain : drain (restart (stop state)) count = (restart (stop state), []) := by
  simp [drain, canDrain, restart, stop]

theorem restart_preserves_queue : (restart state).queue = state.queue := rfl

theorem restart_idle : (restart state).running = false := rfl

theorem stale_save_entry (stale : entry.revision ≠ revision) :
    saveEntry target revision entry = entry := by simp [saveEntry, stale]

theorem stale_cancel_entry (stale : entry.revision ≠ revision) :
    cancelEntry target revision entry = entry := by simp [cancelEntry, stale]

theorem drain_prefix (allowed : canDrain state count) :
    (drain state count).2 = state.queue.take count := by simp [drain, allowed]

theorem drain_suffix (allowed : canDrain state count) :
    (drain state count).1.queue = state.queue.drop count := by simp [drain, allowed]

theorem drain_order (allowed : canDrain state count) :
    (drain state count).2 ++ (drain state count).1.queue = state.queue := by
  simp [drain, allowed]

end Queue
