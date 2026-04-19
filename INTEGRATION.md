# Integration Notes

## OCPlatform Brain Connection

- OmniRoute URL: `http://100.64.0.7:20129`
- Set via `/api/integrations` → `ocplatform.url`
- `/api/chat` supports SSE streaming response from OmniRoute
- Fallback: Gemini if OCPlatform unavailable

## Key Fix
OmniRoute returns SSE format (`data: {...}`), not plain JSON.
`/api/chat` in index.js handles both formats.
