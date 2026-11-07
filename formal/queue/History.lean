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

/-- A cached projection of one physical line with the byte range it was built from. -/
structure View (γ : Type) where
  line : Nat
  start : Nat
  stop : Nat
  value : γ

/-- Persisted views, tagged with the snapshot fingerprint and projection key. -/
structure Sidecar (γ : Type) where
  fingerprint : Nat
  key : Nat
  views : List (View γ)

/-- Every view stored under this fingerprint and key equals the projection of its reference line. -/
def ValidViews {β γ : Type} (project : β → γ) (lines : List β) (fingerprint key : Nat)
    (sidecar : Sidecar γ) : Prop :=
  ∀ view ∈ sidecar.views, sidecar.fingerprint = fingerprint → sidecar.key = key →
    ∀ line, lines[view.line]? = some line → view.value = project line

/-- Keep views only for a matching fingerprint and key whose offsets equal the snapshot. -/
def selectViews {γ : Type} (fingerprint key : Nat) (cached : List Nat)
    (sidecar : Sidecar γ) : List (View γ) :=
  sidecar.views.filter fun view =>
    sidecar.fingerprint == fingerprint && sidecar.key == key &&
      cached[view.line]? == some view.start && cached[view.line + 1]? == some view.stop

/-- Accepted views replace the projection; other lines use the reference projection. -/
def render {β γ : Type} (project : β → γ) (selected : List (View γ)) : Nat → List β → List γ
  | _, [] => []
  | index, line :: rest =>
    (match selected.find? (fun view => view.line == index) with
      | some view => view.value
      | none => project line) :: render project selected (index + 1) rest

private theorem filter_none {α : Type} (keep : α → Bool) (items : List α)
    (rejects : ∀ item ∈ items, keep item = false) : items.filter keep = [] := by
  induction items with
  | nil => rfl
  | cons item rest inductionHypothesis =>
    rw [List.filter_cons_of_neg (by rw [rejects item (List.mem_cons_self ..)]; exact Bool.false_ne_true)]
    exact inductionHypothesis fun other member => rejects other (List.mem_cons_of_mem _ member)

/-- A different fingerprint selects nothing. -/
theorem fingerprint_mismatch_rejected {γ : Type} (fingerprint key : Nat) (cached : List Nat)
    (sidecar : Sidecar γ) (mismatch : sidecar.fingerprint ≠ fingerprint) :
    selectViews fingerprint key cached sidecar = [] := by
  apply filter_none
  intro view _
  have rejected : (sidecar.fingerprint == fingerprint) = false := by
    cases same : (sidecar.fingerprint == fingerprint) with
    | false => rfl
    | true => exact absurd (Nat.eq_of_beq_eq_true same) mismatch
  rw [rejected]
  rfl

/-- A different projection key selects nothing. -/
theorem key_mismatch_rejected {γ : Type} (fingerprint key : Nat) (cached : List Nat)
    (sidecar : Sidecar γ) (mismatch : sidecar.key ≠ key) :
    selectViews fingerprint key cached sidecar = [] := by
  apply filter_none
  intro view _
  have rejected : (sidecar.key == key) = false := by
    cases same : (sidecar.key == key) with
    | false => rfl
    | true => exact absurd (Nat.eq_of_beq_eq_true same) mismatch
  rw [rejected, Bool.and_false]
  rfl

private theorem render_reference {β γ : Type} (project : β → γ) (selected : List (View γ))
    (lines : List β) (base : Nat)
    (valid : ∀ view ∈ selected, ∀ offset line, view.line = base + offset →
      lines[offset]? = some line → view.value = project line) :
    render project selected base lines = lines.map project := by
  induction lines generalizing base with
  | nil => rfl
  | cons line rest inductionHypothesis =>
    rw [render, List.map_cons]
    refine congr (congrArg List.cons ?_) ?_
    · cases found : selected.find? (fun view => view.line == base) with
      | none => rfl
      | some view =>
        have member := List.mem_of_find?_eq_some found
        have hit := List.find?_some found
        have same : view.line = base := Nat.eq_of_beq_eq_true hit
        exact valid view member 0 line (by rw [same]; rfl) rfl
    · apply inductionHypothesis
      intro view member offset other same lookup
      exact valid view member (offset + 1) other (by rw [same, Nat.add_assoc, Nat.add_comm 1 offset]) lookup

theorem selected_view_page {β γ : Type} (project : β → γ) (lines : List β)
    (fingerprint key : Nat) (cached : List Nat) (sidecar : Sidecar γ)
    (valid : ValidViews project lines fingerprint key sidecar) (start count : Nat) :
    page (render project (selectViews fingerprint key cached sidecar) 0 lines) start count =
      page (lines.map project) start count := by
  have reference : render project (selectViews fingerprint key cached sidecar) 0 lines =
      lines.map project := by
    apply render_reference
    intro view member offset line same lookup
    unfold selectViews at member
    rw [List.mem_filter] at member
    obtain ⟨inSidecar, accepted⟩ := member
    rw [Bool.and_eq_true, Bool.and_eq_true, Bool.and_eq_true] at accepted
    exact valid view inSidecar (Nat.eq_of_beq_eq_true accepted.1.1.1) (Nat.eq_of_beq_eq_true accepted.1.1.2) line
      (by rw [← lookup, same, Nat.zero_add])
  rw [reference]

end History
