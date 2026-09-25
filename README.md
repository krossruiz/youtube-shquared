# YouTube Shquared

Watch YouTube together across the internet with **synced playback** over **WebRTC** data channels.

Live: https://youtubeshquared.vercel.app

## How it works

1. One person **creates a room** (they become the host).
2. Others **join** with the room code or shared `?room=` link.
3. The host loads a YouTube video and controls play / pause / seek.
4. Guests stay in sync: the host broadcasts playback state over peer-to-peer data channels.

Signaling uses the [PeerJS](https://peerjs.com/) cloud broker so the static site can run on Vercel without your own WebSocket server. Playback control messages travel over WebRTC data channels between browsers (STUN for NAT traversal).

## Local

```bash
npm start
# open http://localhost:4173
```

Or open `index.html` via any static file server.

## Deploy

```bash
vercel --prod
```

Project is configured for the Vercel hostname `youtubeshquared.vercel.app`.

## Stack

- YouTube IFrame API
- PeerJS (WebRTC)
- Static HTML / CSS / JS
