import Queue

-- Keep each theorem restricted to these standard Lean foundational axioms.

/-- info: 'Queue.step_capacity' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Queue.step_capacity

/-- info: 'Queue.reachable_capacity' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Queue.reachable_capacity

/-- info: 'Queue.running_drain' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Queue.running_drain

/-- info: 'Queue.held_head_drain' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Queue.held_head_drain

/-- info: 'Queue.stop_clears' does not depend on any axioms -/
#guard_msgs in
#print axioms Queue.stop_clears

/-- info: 'Queue.stopped_restart_drain' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Queue.stopped_restart_drain

/-- info: 'Queue.restart_preserves_queue' does not depend on any axioms -/
#guard_msgs in
#print axioms Queue.restart_preserves_queue

/-- info: 'Queue.restart_idle' does not depend on any axioms -/
#guard_msgs in
#print axioms Queue.restart_idle

/-- info: 'Queue.stale_save_entry' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Queue.stale_save_entry

/-- info: 'Queue.stale_cancel_entry' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Queue.stale_cancel_entry

/-- info: 'Queue.drain_prefix' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Queue.drain_prefix

/-- info: 'Queue.drain_suffix' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Queue.drain_suffix

/-- info: 'Queue.drain_order' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Queue.drain_order
