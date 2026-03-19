# Claude Proxy

OpenAI-compatible proxy server that forwards requests to the Anthropic API.

## Setup

```bash
npm install
```

Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

## Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

Server runs on port 8765 by default. Override with `PORT` env var.

## Endpoints

- `GET /health` — health check
- `GET /v1/models` — list available models
- `POST /v1/chat/completions` — chat completions (streaming & non-streaming)

## Usage

Point any OpenAI-compatible client at `http://localhost:8765`:

```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Model Mapping

| OpenAI Model | Anthropic Model |
|---|---|
| gpt-4 | claude-sonnet-4-5-20251001 |
| gpt-4-turbo | claude-sonnet-4-5-20251001 |
| gpt-3.5-turbo | claude-haiku-3-5-20241022 |
| claude-sonnet-4-5 | claude-sonnet-4-5-20251001 |
| claude-haiku | claude-haiku-3-5-20241022 |

Unmapped model names are passed through as-is.
