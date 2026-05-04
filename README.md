# @duckstech/provider-bypass

Direct API access to Claude and ChatGPT using local CLI OAuth credentials. No API keys needed.

One endpoint, one format. Switch providers by changing the model name — zero code changes.

## Install

```bash
npm install @duckstech/provider-bypass
```

## Prerequisites

You need the CLI tools installed and authenticated on the machine:

- **Claude**: Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code), run `claude` and log in
- **Codex**: Install [Codex CLI](https://github.com/openai/codex), run `codex` and log in

The library reads OAuth tokens from `~/.claude/.credentials.json` and `~/.codex/auth.json` automatically, with auto-refresh when they expire.

## Usage

```typescript
import { createClient } from '@duckstech/provider-bypass'

const ai = createClient()

// Claude
const res = await ai.send({
  model: 'claude-sonnet-4-6',
  input: [{ role: 'user', content: 'Hello!' }],
})

console.log(res.output[0].content[0].text)

// ChatGPT — same format, just change the model
const res2 = await ai.send({
  model: 'gpt-5.4',
  input: [{ role: 'user', content: 'Hello!' }],
})
```

### Streaming

```typescript
for await (const event of ai.stream({
  model: 'claude-sonnet-4-6',
  input: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (event.type === 'response.output_text.delta') {
    process.stdout.write(event.delta)
  }
}
```

### Tool Calling

```typescript
const res = await ai.send({
  model: 'claude-sonnet-4-6',
  input: [{ role: 'user', content: 'Weather in Tokyo?' }],
  tools: [{
    type: 'function',
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }],
})
```

### Tool Registry

Register tools once, use across requests:

```typescript
ai.tools.register({
  name: 'deploy',
  description: 'Deploy a service',
  input_schema: { type: 'object', properties: { service: { type: 'string' } } },
  handler_type: 'webhook',
  handler_config: { url: 'https://my-server.com/deploy' },
})

const res = await ai.send({
  model: 'gpt-5.4',
  input: [{ role: 'user', content: 'Deploy auth-service v2' }],
  registered_tools: ['deploy'],
})
```

### Presets

Group tools together:

```typescript
ai.presets.create({
  name: 'devops',
  tool_names: ['deploy', 'rollback', 'status'],
})

const tools = ai.presets.getTools('devops')
```

### Reasoning

Reasoning is provider-normalized. Clients express intent once and the library
maps it to the right wire format for Claude or Codex/OpenAI.

```typescript
const res = await ai.send({
  model: 'claude-opus-4-7',
  input: [{ role: 'user', content: 'Solve this carefully...' }],
  reasoning: {
    effort: 'max',   // none | minimal | low | medium | high | xhigh | max
    summary: 'auto', // auto = visible summary, none = hidden reasoning
  },
})
```

Reasoning models default to `{ effort: 'max', summary: 'auto' }`. Modern Claude
models use adaptive thinking internally, while Codex/OpenAI models receive the
strongest supported wire value (`max` maps to `xhigh` for Codex/OpenAI).
Claude reasoning summaries are emitted as normalized
`reasoning` output items and `response.reasoning_summary_text.delta` stream
events.

### Prompt Caching (Claude)

Automatic Anthropic prompt caching is **enabled by default** for Claude models. On every request the library injects `cache_control: { type: 'ephemeral' }` on:

1. the last `system` block (covers system prompt)
2. the last `tool` definition (covers tools list)
3. the last content block of the last message (rolling conversation breakpoint)

Cache reads cost ~10% of normal input tokens; writes cost ~125%. For multi-turn agentic loops this typically cuts input cost by **60–75%** with zero configuration.

Disable per-request:

```typescript
await ai.send({
  model: 'claude-opus-4-7',
  input: [...],
  cache: 'none',   // default: 'auto'
})
```

If the caller already sets `cache_control` on any system/tools/message block, the library **does not** inject additional breakpoints — explicit caller intent always wins. Codex/OpenAI models ignore this flag (OpenAI does automatic prompt caching server-side).

Inspect `response.usage.cache_read_input_tokens` and
`response.usage.cache_creation_input_tokens` to verify.

## Configuration

```typescript
const ai = createClient({
  concurrency: 3,                    // max simultaneous requests (default: 3)
  defaultModel: 'claude-sonnet-4-6', // default model
  timeout: 600_000,                  // 10 min timeout (default)
  claude: {
    credentialPath: '~/.claude/.credentials.json',
    apiUrl: 'https://api.anthropic.com/v1/messages',
  },
  codex: {
    credentialPath: '~/.codex/auth.json',
    apiUrl: 'wss://chatgpt.com/backend-api/codex/responses',
  },
})
```

### Auth Status

```typescript
const status = ai.status()
// { claude: { valid, expiresIn, subscriptionType }, codex: { valid, expiresIn, authMode }, queue: { ... } }
```

### Cleanup

```typescript
ai.destroy() // stops file watchers, clears registries
```

## Supported Models

| Provider | Models |
|----------|--------|
| Claude | `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-6`, any `claude-*` |
| Codex/OpenAI | `gpt-5.5`, `gpt-5.4`, `gpt-5`, `o1-*`, `o3-*`, `o4-*`, any `gpt-*` |

## Response Format

All responses follow the OpenAI Responses API format regardless of provider:

```typescript
{
  id: 'msg_xxx',
  object: 'response',
  model: 'claude-sonnet-4-6',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '...' }], role: 'assistant' }],
  status: 'completed',
  usage: { input_tokens: 10, output_tokens: 25, total_tokens: 35 },
  latencyMs: 2340,
  provider: 'claude'
}
```

## License

MIT
