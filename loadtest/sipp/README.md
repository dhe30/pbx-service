# SIPp load tests

One scenario per codec (PCMU, G.723.1, G.729, Opus); RTP pcaps go in `pcap/`.
Ramp concurrent calls / CPS and record capacity per pbx node and per rtpengine (CLAUDE.md §16).

- `uac_inbound.xml` – fake carrier: INVITE a DID, play RTP, send DTMF 1.
- `uas_staff.xml`   – fake staff phone registered over UDP, answers calls.
