# BharatPoint mobile (Expo Go)

One app, four role areas: Agent ATM, Customer phone (simulator), Admin, Bank operations.
Setup and the LAN demo steps are in the [root README](../README.md).

```bash
cp .env.example .env      # set EXPO_PUBLIC_API_URL to the laptop's LAN IP
npm install
npx expo start            # scan the QR with Expo Go on a phone on the same Wi-Fi
npm run typecheck && npx expo lint
```

Add packages with `npx expo install <pkg>` (keeps them SDK-compatible). Only modules
bundled in Expo Go may be used. See AGENTS.md.
