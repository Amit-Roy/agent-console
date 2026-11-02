import History

-- Audit every exported theorem; custom axioms and admitted proofs fail this build.

/-- info: 'History.scan_append' depends on axioms: [propext] -/
#guard_msgs in
#print axioms History.scan_append

/-- info: 'History.offsets_append' depends on axioms: [propext] -/
#guard_msgs in
#print axioms History.offsets_append

/-- info: 'History.offsets_prefix_preserved' depends on axioms: [propext] -/
#guard_msgs in
#print axioms History.offsets_prefix_preserved

/-- info: 'History.valid_lookup' depends on axioms: [propext] -/
#guard_msgs in
#print axioms History.valid_lookup

/-- info: 'History.valid_page' does not depend on any axioms -/
#guard_msgs in
#print axioms History.valid_page

/-- info: 'History.rejected_fallback' does not depend on any axioms -/
#guard_msgs in
#print axioms History.rejected_fallback

/-- info: 'History.selected_reference' does not depend on any axioms -/
#guard_msgs in
#print axioms History.selected_reference

/-- info: 'History.selected_page' does not depend on any axioms -/
#guard_msgs in
#print axioms History.selected_page

/-- info: 'History.adjacent_pages' depends on axioms: [propext] -/
#guard_msgs in
#print axioms History.adjacent_pages

/-- info: 'History.filtered_adjacent_pages' depends on axioms: [propext] -/
#guard_msgs in
#print axioms History.filtered_adjacent_pages
