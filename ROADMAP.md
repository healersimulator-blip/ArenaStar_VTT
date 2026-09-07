# ROADMAP — deferred features with target milestone

Absent-by-design until their milestone (operating rule 2: no fake versions exist earlier).
Milestone assignment mirrors PLAN.md.

- [x] 3D dice (three.js, lazy Blob-URL module) — M3 (§11) [D-092]
- [x] Commit-reveal dice mode — M3 (§11) [D-093]
- [x] MQTT-over-WSS / WebTorrent tracker / generic WebSocket signaling adapters — M3 (§6.2) [D-052..D-054]
- QR code for Manual signaling — M3 polish (copy/paste ships in M1) (§6.2)
- [x] Realtime sim mode (tick loop, pause/resume/rate, interpolation) — M3 (§5A) [D-094]
- [x] TurnReport timeline animation + scrubber — M3 (§9A) [D-095]
- [x] Logistics documents + panel + forecast — M3 (§10, §12) [D-096]
- [x] Hero attachment (leaders in ranks) — M3 (§5A) [D-097]
- [x] Turn-level undo UI — M3 (§5A; OpLog machinery M1) [D-071]
- [x] After-action replay browser — M3 (§8A) [D-098]
- [x] Strategic↔tactical scene linking — M3 (§9A) [D-099]
- [x] File System Access "save to folder" — M3 (§8) [D-100]
- [x] Peer relay for unreachable players — M4 (§6.3) [D-101]
- [x] Assistant-GM failover — M4 (§6.5) [D-103]
- [x] TURN support (user credentials) — M4 (§6.3) [D-102]
- [x] Tiled maps > 4096 px — M4 (§7)
- [x] Voice/video mesh ≤ 6 — M4 (§1) [D-104]
- [x] PWA install — M4 (§19)
- [x] 100k-model stress + delta tuning — M4 (§19)
- wasm build of hot RulesModule paths / vision math — M4 optional (§12, §9)
- Fonts subsetting, wasm base64 inlining — as soon as real fonts/wasm enter the bundle (§15)
- [x] Firefox/WebKit Playwright projects — from M2 acceptance (matrix §15) [D-082]

## Post-M1 carry-overs (from Unit 20 review)

- Scene asset "mid" LOD tier between thumbnail and full (§7); external-URL asset alternative.
- Sidebar tabs beyond Chat + sheets (Scenes/Actors/Items/Settings as tabs, scene navigation,
  player list) — full §10 list; GM join-approval dialog + ban list UI (auto-approve covers M1).
- JoinApp: hide the manual code panel automatically once transportKind()==="nostr" connects.
- Public-relay smoke (damus/nos.lol) as an optional, non-CI e2e; CI keeps the local relay.

