import { describe, it, expect } from 'vitest';
import { toOpenAIMessages } from '../src/llmDeepSeek.js';
import { ChatTurn } from '../src/llm.js';

/**
 * Regression: DeepSeek/OpenAI reject a role:'tool' message that doesn't follow
 * an assistant message whose tool_calls includes a matching id ("Messages with
 * role 'tool' must be a response to a preceding message with 'tool_calls'").
 * Our stored history carries bare tool turns, so the mapper must synthesize the
 * pairing.
 */
describe('toOpenAIMessages — tool pairing', () => {
  it('precedes every tool message with an assistant tool_calls of the same id', () => {
    const history: ChatTurn[] = [
      { role: 'user', content: 'resumen' },
      { role: 'tool', tool_name: 'chatter.list', content: '{"notes":[]}' },
      { role: 'assistant', content: 'No hay notas.' },
      { role: 'user', content: '¿y antecedentes?' },           // this is the turn that used to 400
    ];
    const msgs = toOpenAIMessages(history, 'SYS');

    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'tool') {
        const prev = msgs[i - 1];
        expect(prev).toBeDefined();
        expect(prev.role).toBe('assistant');
        expect(Array.isArray(prev.tool_calls)).toBe(true);
        const ids = prev.tool_calls.map((c: any) => c.id);
        expect(ids).toContain(msgs[i].tool_call_id);
      }
    }
    // The tool turn produced exactly one assistant(tool_calls)+tool pair.
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    expect(toolMsgs.length).toBe(1);
    // function name is sanitized (dots → underscores).
    const synthAssistant = msgs.find(m => m.role === 'assistant' && m.tool_calls);
    expect(synthAssistant.tool_calls[0].function.name).toBe('chatter_list');
  });

  it('passes plain user/assistant/system turns through unchanged', () => {
    const msgs = toOpenAIMessages(
      [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'qué tal' }],
      'SYS'
    );
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'hola' });
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'qué tal' });
    expect(msgs.some(m => m.role === 'tool')).toBe(false);
  });
});
