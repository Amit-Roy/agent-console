# Pending queue model

This is a dependency-free Lean 4 model of one thread's pending queue. It checks queue rules with kernel-checked proofs and exercises selected corresponding behaviors through the public TypeScript `Threads` API. It does not change the application or generate production code.

## Run

Install [elan](https://github.com/leanprover/elan), put its `bin` directory on `PATH`, then run:

```sh
npm run test:formal
node test/queue-edit.ts
```

`lean-toolchain` pins Lean to `leanprover/lean4:v4.35.0`. `lake build` uses only Lean's bundled standard library. The Lake configuration treats warnings as errors, so an admitted proof fails the build. `ProofAudit.lean` checks every theorem’s reported axiom dependencies against an explicit list containing only standard Lean foundations (`propext` and `Quot.sound`); introducing a custom axiom into these proofs fails the audit. The `release` CI job installs Lean and checks the proofs; Node runtime installation and ordinary application tests do not require Lean.

## Model and source correspondence

`Entry` contains an abstract natural-number identity, revision, and edit hold. `State` contains a running flag and an ordered list. Production UUIDs are represented by distinct natural numbers. The model assumes fresh enqueue identities, successful persistence, and valid loaded queues. Text, attachments, timestamps, validation errors, providers, and multiple threads are outside its state.

| Model operation | Production source in `server/threads.ts` |
| --- | --- |
| Capacity 20; `enqueue` | `MAX_QUEUE` near line 221; `enqueue` near line 2639 |
| `edit`, revision-checked `save` and `cancel` | `editQueued`, `saveQueued`, `cancelQueuedEdit` near lines 2672–2705 |
| `delete` | `unqueue` immediately before `drain` |
| `drain` | `drain` near lines 2744–2780 |
| `stop` | `abort` near lines 2838–2868 |
| `restart` | `reviveThread` near line 316, `sanitizeQueued` near line 336, `loadQueues` near line 844 |

Line numbers are navigation hints, not a generated correspondence proof. `save` abstracts successful text validation; stale or unheld saves leave model state unchanged instead of throwing. Cancellation requires only a matching revision, as in production. List updates represent the production first matching item under the distinct-identity assumption. Enqueue accepts an abstract entry; production additionally initializes revision zero and no hold. Allowing more abstract entries makes the capacity result stronger without asserting those extra entries can arise in production.

`stop` models the durable queue-clearing phase, preserving the running flag. Provider interruption and the subsequent idle status are separate from that phase. `restart` models a completed reload with idle status and the full valid pending queue, including revisions and holds. It does not describe repair of malformed files or restoration of an interrupted provider operation.

A drain chooses an arbitrary prefix length. It succeeds only when idle, the length is positive and within the queue, and every selected entry is unheld. It returns the selected prefix and retains the suffix. Production chooses that length using command, attachment, and source-thread boundaries; these selection details and the 250 ms timer are abstracted. Provider turn-status changes are represented by the `Step.running` transition. The model drain itself only removes the queue prefix; it does not claim that provider dispatch has succeeded.

## Checked statements

- `reachable_capacity`: every state reachable from the empty initial state has at most 20 entries. `step_capacity` proves preservation for every transition, then reachability induction proves the bound.
- `running_drain` and `held_head_drain`: running threads and held queue heads prevent drain.
- `stop_clears` and `stopped_restart_drain`: stop empties the queue and restarting then draining cannot produce pending entries.
- `restart_preserves_queue` and `restart_idle`: reload preserves every modeled queue field and returns idle. `stale_save_entry` and `stale_cancel_entry` separately prove that a mismatched revision cannot alter the targeted entry.
- `drain_prefix`, `drain_suffix`, and `drain_order`: successful drain selects a prefix, retains its suffix, and their concatenation recovers the original ordered queue.

`test/queue-edit.ts` checks selected real API behavior: a held head blocks delivery; releasing it preserves order; holds and nonzero revisions survive reload; stale saves reject and stale cancellation leaves the hold; stop clears the durable queue and its cancelled prompt never dispatches after reload. Mock timers drive the actual scheduled drain boundary, including assertions that delivery did not occur. These examples establish limited conformance, not equivalence between TypeScript and Lean.

## Explicit limits

The proofs apply to this model, not to the TypeScript implementation. They do not establish exactly-once delivery, no-loss delivery, crash safety, filesystem atomicity, provider correctness, or performance gains. In particular, production drain persists queue removal **before** calling `send`; a crash or send failure can lose the selected pending prompt. There is no transaction spanning persistence and provider delivery. The capacity theorem begins with an empty queue; interpreting a loaded production state requires the stated validity and capacity assumptions.

## History offset cache model

`History.lean` models the optional persisted offset snapshot loaded by `server/history.ts` before physical history pages are parsed and filtered into wire events. It does not generate the TypeScript reader. A Boolean represents each raw byte: `true` means newline, `false` means any other byte. `scan` advances one byte at a time and emits positions immediately after newline bytes; `offsets` prepends zero. These are physical line-start candidates, including an end-of-file candidate when the last byte is a newline. Deciding which candidates represent readable records is outside this abstraction.

| Model | Production responsibility in `server/history.ts` |
| --- | --- |
| `scan`, `offsets` | Reference newline scan and physical byte-offset index |
| `ValidSnapshot` | Loaded offsets must have been produced by scanning the same modeled file bytes |
| `selectOffsets` | Optional snapshot acceptance; failed validation falls back to the reference scan |
| `page` | Physical slices and physical cursors before display filtering |
| `filtered_adjacent_pages` | Filter each physical slice without changing the cursor unit |

The runtime cache validates schema, a checksum, and exact `dev`, `ino`, `size`, `mtimeNs`, and `ctimeNs` metadata; it assumes a trusted private cache artifact. The checksum detects accidental corruption and does not authenticate another local writer. Source metadata is checked again after loading the snapshot. Metadata equality does **not** prove byte equality or that serialized offsets are correct. `selected_reference` therefore explicitly assumes that acceptance implies `ValidSnapshot`; this is the trust boundary, not a theorem about filesystem metadata. Any file change rejects a persisted snapshot. The in-memory append path can separately extend offsets incrementally.

The scanner append theorem is proved by induction over prior bytes. It decomposes scanning concatenated bytes into the old scan plus a suffix scan starting at the old byte length. `offsets_append` and `offsets_prefix_preserved` show that appending bytes preserves the existing boundary prefix. `valid_lookup` and `valid_page` establish reference equivalence given semantic snapshot validity. `rejected_fallback`, `selected_reference`, and `selected_page` establish fallback and conditional acceptance behavior. `adjacent_pages` reconstructs a combined physical slice from adjacent slices; `filtered_adjacent_pages` preserves that decomposition under filtering. Their cursor arithmetic still counts physical entries, not filtered output.

Run all queue and history proofs and both axiom audits with `npm run test:formal`, or run `cd formal/queue && lake build`. `HistoryAudit.lean` guards all ten exported history theorems; they use no axioms beyond `propext`. The private slice helper is checked transitively by its exported consumers. Both history targets are default Lake targets, so the existing formal CI job checks them.

History proofs exclude OS behavior, file serialization and cache corruption, concurrent filesystem changes, JSON parsing, correspondence with TypeScript, and performance. Runtime conformance tests and measurements must supply separate evidence. Physical-page decomposition alone does not establish end-to-end no-loss delivery or crash safety.
