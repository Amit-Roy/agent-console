import assert from 'node:assert/strict';
import { historyWireEvent } from '../server/history-wire.ts';

const events = [
  { type: 'system', subtype: 'init', tools: ['tool'.repeat(5000)], skills: ['skill'.repeat(5000)], session_id: 'session', model: 'sonnet' },
  { type: 'assistant', parent_tool_use_id: 'agent-1', uuid: 'uuid', context_usage: { diagnostics: 'diagnostic'.repeat(5000) }, message: { role: 'assistant', usage: { input_tokens: 999 }, diagnostics: 'unused'.repeat(5000), content: [
    { type: 'text', text: 'Preserve my answer', citations: [] },
    { type: 'thinking', thinking: 'Visible reasoning', signature: 'signed'.repeat(5000) },
    { type: 'redacted_thinking', data: 'encrypted'.repeat(5000) },
    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd', description: 'Check working directory' } },
  ] } },
  { type: 'user', parent_tool_use_id: 'agent-1', tool_result_meta: { metadata: 'unused'.repeat(5000) }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'The output', is_error: true }] } },
  { type: 'result', subtype: 'success', duration_ms: 1234, total_cost_usd: .1, is_error: false, result: 'Answer already in assistant event'.repeat(1000), usage: { input_tokens: 999 } },
  { type: 'system', subtype: 'task_progress', tool_use_id: 'agent-1', usage: { tool_uses: 4, total_tokens: 100, duration_ms: 12 }, description: 'Working' },
  { type: 'system', subtype: 'task_started', tool_use_id: 'agent-1', is_backgrounded: true },
  { type: 'system', subtype: 'task_notification', tool_use_id: 'agent-1', status: 'completed', summary: 'Finished' },
  { type: 'user_input', text: 'My message', delivery: 'steer', attachments: [{ id: 'image', name: 'image.png', kind: 'image', n: 1 }] },
  { type: 'command_status', command: 'compact', status: 'done', text: 'Compacted' },
  { type: 'tool_update', tool_use_id: 'tool-1', name: 'web_search', input: { action: 'open_page', ref_id: 'https://example.com' } },
  { type: 'tool_label', tool_use_id: 'tool-1', label: 'Checking directory' },
  { type: 'console_error', text: 'A useful error' },
  { type: 'rate_limit_event', rate_limit_info: { ignored: 'quota'.repeat(1000) } },
  { type: 'future_event', useful: 'Preserve unknown event' },
];
const original = structuredClone(events);
const views = events.map(historyWireEvent);
assert.deepEqual(events, original, 'projection never changes source events, logs, or exports');
assert.deepEqual(views[0], { type: 'system', subtype: 'init' });
assert.equal(views[1].parent_tool_use_id, 'agent-1');
assert.deepEqual(views[1].message.content, [
  { type: 'text', text: 'Preserve my answer' },
  { type: 'thinking', thinking: 'Visible reasoning' },
  { type: 'redacted_thinking' },
  original[1].message!.content![3],
]);
assert.deepEqual(views[2].message.content, original[2].message!.content);
assert.deepEqual(views[3], { type: 'result', subtype: 'success', duration_ms: 1234, total_cost_usd: .1, is_error: false });
assert.deepEqual(historyWireEvent({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', usage: {} }), { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }, 'error results keep their short text');
for (let i = 4; i < 12; i++) assert.deepEqual(views[i], original[i], `rendered event ${i} stays intact`);
assert.deepEqual(views[12], { type: 'rate_limit_event' });
assert.deepEqual(views[13], original[13]);
assert.deepEqual(historyWireEvent({ type: 'assistant', message: { content: [{ type: 'future_block', payload: 'keep' }] } }).message.content, [{ type: 'future_block', payload: 'keep' }]);
const imageResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'image-tool', content: [{ type: 'text', text: 'Image inspected' }, { type: 'image', source: { type: 'base64', data: 'binary'.repeat(1000) } }] }] } };
assert.deepEqual(historyWireEvent(imageResult).message.content[0].content, [{ type: 'text', text: 'Image inspected' }, { type: 'image' }]);
assert.ok(imageResult.message.content[0].content[1].source!.data, 'embedded result data remains in the original log');
assert.ok(JSON.stringify(views).length < JSON.stringify(events).length * .1, 'representative provider metadata is omitted from history transport');
console.log(`PASS history projection: display fields and subagent state preserved; source immutable; ${JSON.stringify(events).length} → ${JSON.stringify(views).length} bytes`);
