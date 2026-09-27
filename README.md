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

## Video call

In a room, **Join call** starts a PeerJS **media mesh** over the player (YouTube stays in back). Mute / cam toggles and **Leave call** are separate from leaving the watch-party room.

Soft limit: **6 participants** on the call. Each peer sends N−1 uplink streams (no SFU); past ~6, bandwidth and CPU get rough on typical home networks.

Local mesh debugging can point PeerJS at a broker with `?peerlocal=1` (host `127.0.0.1:9000`) or `?peerhost=&peerport=`.

## Stack

- YouTube IFrame API
- PeerJS (WebRTC data + media)
- Static HTML / CSS / JS
