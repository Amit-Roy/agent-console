import Std

namespace History

/-- Each Boolean represents one byte: true precisely for a newline byte.
The scanner emits the byte position immediately following each newline. -/
def scan : List Bool → Nat → List Nat
  | [], _ => []
  | newline :: rest, position =>
    if newline then (position + 1) :: scan rest (position + 1)
    else scan rest (position + 1)

/-- Physical line starts, including the initial start at byte zero. -/
def offsets (bytes : List Bool) : List Nat := 0 :: scan bytes 0

/-- A snapshot is valid only if its offsets equal a scan of these same bytes.
Filesystem metadata equality alone is not this predicate. -/
def ValidSnapshot (bytes : List Bool) (cached : List Nat) : Prop :=
  cached = offsets bytes

/-- Validation failure chooses the reference scan. -/
def selectOffsets (bytes : List Bool) (cached : List Nat) (accepted : Bool) : List Nat :=
  if accepted then cached else offsets bytes

def page {α : Type} (items : List α) (start count : Nat) : List α :=
  (items.drop start).take count

/-- Scanning an appended suffix starts exactly at the old byte length. -/
theorem scan_append (prior suffix : List Bool) (position : Nat) :
    scan (prior ++ suffix) position =
      scan prior position ++ scan suffix (position + prior.length) := by
  induction prior generalizing position with
  | nil => simp [scan]
  | cons newline rest inductionHypothesis =>
    cases newline <;>
      simp [scan, inductionHypothesis, Nat.add_comm, Nat.add_left_comm]

/-- Existing newline boundaries remain an exact prefix after an append. -/
theorem offsets_append (prior suffix : List Bool) :
    offsets (prior ++ suffix) = offsets prior ++ scan suffix prior.length := by
  simp [offsets, scan_append]

theorem offsets_prefix_preserved (prior suffix : List Bool) :
    (offsets (prior ++ suffix)).take (offsets prior).length = offsets prior := by
  rw [offsets_append]
  simp

theorem valid_lookup (bytes : List Bool) (cached : List Nat)
    (valid : ValidSnapshot bytes cached) (line : Nat) :
    cached[line]? = (offsets bytes)[line]? := by
  rw [valid]

theorem valid_page (bytes : List Bool) (cached : List Nat)
    (valid : ValidSnapshot bytes cached) (start count : Nat) :
    page cached start count = page (offsets bytes) start count := by
  rw [valid]

theorem rejected_fallback (bytes : List Bool) (cached : List Nat) :
    selectOffsets bytes cached false = offsets bytes := by
  rfl

/-- Runtime acceptance must imply semantic validity; this is an explicit premise. -/
theorem selected_reference (bytes : List Bool) (cached : List Nat) (accepted : Bool)
    (sound : accepted = true → ValidSnapshot bytes cached) :
    selectOffsets bytes cached accepted = offsets bytes := by
  cases accepted with
  | false => rfl
  | true => exact sound rfl

theorem selected_page (bytes : List Bool) (cached : List Nat) (accepted : Bool)
    (sound : accepted = true → ValidSnapshot bytes cached) (start count : Nat) :
    page (selectOffsets bytes cached accepted) start count =
      page (offsets bytes) start count := by
  rw [selected_reference bytes cached accepted sound]

private theorem split_take {α : Type} (items : List α) (first second : Nat) :
    items.take first ++ (items.drop first).take second = items.take (first + second) := by
  induction first generalizing items with
  | zero => simp
  | succ first inductionHypothesis =>
    cases items with
    | nil => simp
    | cons item rest =>
      simpa [Nat.succ_add] using congrArg (List.cons item) (inductionHypothesis rest)

/-- Cursors count physical entries before any display filtering. -/
theorem adjacent_pages {α : Type} (items : List α) (start first second : Nat) :
    page items start first ++ page items (start + first) second =
      page items start (first + second) := by
  unfold page
  rw [← List.drop_drop, split_take]

theorem filtered_adjacent_pages {α : Type} (items : List α) (keep : α → Bool)
    (start first second : Nat) :
    (page items start first).filter keep ++
      (page items (start + first) second).filter keep =
      (page items start (first + second)).filter keep := by
  rw [← List.filter_append, adjacent_pages]

end History
