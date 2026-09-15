# HyOS

HyOS is an experimental desktop agent workspace built with Electron. It combines persistent agent sessions with coding tools, browser tabs, patch review, and a whiteboard.

## Setup

Create a `.env` file in the repository root:

```env
AI_GATEWAY_API_KEY=your_ai_gateway_key
PARALLEL_API_KEY=your_parallel_api_key
```

`AI_GATEWAY_API_KEY` is required to use the gateway-hosted models. `PARALLEL_API_KEY` is optional and enables web search.

Install dependencies and start the app:

```sh
npm install
npm run demo:hyos
```
