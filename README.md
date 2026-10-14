# BharatPoint

Rural agent-banking and micro-ATM **simulation**: an agent serves a customer's cash-in or
cash-out, and the customer independently confirms the exact amount before any money moves.

> Demo software. Every bank, customer, biometric and bank response is simulated.
> It is not an approved banking or AePS system.

- Architecture, threat model and plan: [docs/ARCHITECTURE_AUDIT.md](docs/ARCHITECTURE_AUDIT.md)
- Build prompt for coding agents: [docs/BUILD_SCAFFOLD_PROMPT.md](docs/BUILD_SCAFFOLD_PROMPT.md)

## Layout

```
backend/   Express 5 + TypeScript API, PostgreSQL (one backend, one database)
mobile/    Expo Go app (Expo Router): agent, customer simulator, admin, bank screens
docs/      audit and build prompt
docker-compose.yml   Postgres (loopback only)
```

## Run it (Windows, PowerShell or Git Bash)

Prerequisites: Node 22+, Docker Desktop, Expo Go on each phone, phones and laptop on the same Wi-Fi.

```bash
cp .env.example .env               # set POSTGRES_PASSWORD and the same password in DATABASE_URL
docker compose up -d               # Postgres on 127.0.0.1:5432

cd backend
npm install
npm run db:migrate
npm test
npm run dev                        # http://127.0.0.1:4000/health

cd ../mobile
cp .env.example .env               # EXPO_PUBLIC_API_URL=http://<laptop LAN IP>:4000
npm install
npx expo start                     # scan the QR with Expo Go
```

For phones to reach the API, set `HOST=0.0.0.0` in the root `.env` and allow TCP 4000 through
Windows Firewall on **private** networks only. The home screen shows **SERVER: Connected** when it works.
