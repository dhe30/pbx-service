# Telephony config templates

Jinja2 templates rendered by Ansible (`infra/ansible/roles/{kamailio,rtpengine,asterisk}`).
Variables come from the inventory and `group_vars`. The routing spec is in CLAUDE.md §7–§9;
what changed for the course spec is in [docs/spec-transition.md](../docs/spec-transition.md).

| File | What |
|---|---|
| `kamailio/kamailio.cfg.j2` | SIP edge: registrar (in memory + DMQ), carrier/phone/vendor routes, forking, rtpengine flags per leg |
| `kamailio/tls.cfg.j2` | TLS for `_sips._tcp` phones (5061) |
| `kamailio/dispatcher.list.j2` | pbx nodes (inventory group `pbx`) |
| `rtpengine/rtpengine.conf.j2` | media relay + transcoding (kernel forwarding on) |
| `asterisk/*.conf.j2` | PJSIP trunks to the edges, vendor endpoints, dialplan → Stasis |
| `webrtc-test/index.html` | bare WebRTC test page served by HAProxy at `/webrtc-test` |

## Checking a change

```sh
npm run test:configs     # Linux/WSL: render for a 2-edge/2-pbx inventory + `kamailio -c`
npm test                 # includes services/ari-app/test/configs.test.ts (assertions on the render)
```
`tests/check-configs.sh` explains how to run it without root (Kamailio binaries extracted from
the .debs).
