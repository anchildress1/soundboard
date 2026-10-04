import { span } from '../mocks/sentry';

/** What the agents recorded on their `invoke_agent` spans, read from the shared span mock. */
export function agentSpanIO() {
  const input = span.setAttributes.mock.calls
    .map(([attributes]) => attributes as Record<string, string>)
    .filter((attributes) => 'gen_ai.input.messages' in attributes);
  const output = span.setAttribute.mock.calls
    .filter(([key]) => key === 'gen_ai.output.messages')
    .map(([, value]) => JSON.parse(value as string) as { parts: { content: string }[] }[])
    .map((messages) => messages[0]!.parts[0]!.content);
  return { input, output };
}

export function clearAgentSpan() {
  span.setAttribute.mockClear();
  span.setAttributes.mockClear();
}
