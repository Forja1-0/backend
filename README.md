# forja-api

Backend central de Forja: webhook de Evolution, bot, REST API, cron jobs.

## Dev

```bash
cp .env.example .env
npm install
npm run dev
```

## Estructura

- `src/app.ts` · Express + middleware
- `src/server.ts` · entry point
- `src/config/` · env, db, logger
- `src/routes/` · REST API
- `src/webhooks/` · receiver de Evolution
- `src/bot/` · router de intents, handlers, parser, personalidad
- `src/services/` · Evolution, Anthropic, summary, journey cards
- `src/cron/` · jobs programados
- `src/repositories/` · queries SQL
- `sql/` · schema + seeds
