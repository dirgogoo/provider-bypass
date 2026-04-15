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
    apiUrl: 'https://chatgpt.com/backend-api/codex/responses',
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
| Claude | `claude-sonnet-4-6`, `claude-opus-4-6`, any `claude-*` |
| Codex/OpenAI | `gpt-5.4`, `gpt-5`, `o1-*`, `o3-*`, `o4-*`, any `gpt-*` |

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
