# SIPp scenarios

| Scenario          | Plays the role of | What it does                                                        |
|-------------------|-------------------|---------------------------------------------------------------------|
| `uac_inbound.xml` | the carrier       | INVITEs a DID (PCMA + RFC 4733), presses **1**, sends audio, BYE after 20 s |
| `register.xml`    | a staff phone     | REGISTERs a staff user (digest auth) from a given local port         |
| `uas_staff.xml`   | a staff phone     | Answers incoming calls on that port and echoes RTP back              |
| `uas_staff_hold.xml` | a staff phone  | Same, plus holds the call after 3 s (`a=sendonly`) for `-d` ms, then resumes |

## Setup

- Install SIPp **with RTP/pcap support** (`sip-tester` on Debian/Ubuntu, or build with `-DUSE_PCAP=1`).
- Copy `dtmf_2833_1.pcap` and `g711a.pcap` from SIPp's source tree (`pcap/` directory) into
  `loadtest/sipp/pcap/` (they are not committed).
- `cp users.csv.example users.csv` and put bob's SIP password (from the vault) in it.
- The machine's public IP must be in `carrier_cidrs` (`infra/ansible/group_vars/all/main.yml`),
  otherwise Kamailio answers the INVITE with 403.

## Phase-1 end-to-end call (run from `loadtest/sipp/`)

```bash
EDGE=203.0.113.10   # the VM's public IP

# 1. Staff phone "bob": register, then answer calls on the same port (leave running).
sipp -sf register.xml -inf users.csv -p 5070 -m 1 $EDGE:5060
sipp -sf uas_staff.xml -p 5070 -rtp_echo $EDGE:5060

# 2. In another terminal: the carrier calls the test DID and presses 1.
sipp -sf uac_inbound.xml -s 15555550100 -p 5062 -m 1 $EDGE:5060
```

Expected: the IVR answers, DTMF 1 rings the "Everyone" group (alice in the browser + bob here),
bob answers after 1 s, the call is recorded, and the UAC hangs up after ~20 s. A `calls` row with
`disposition = 'answered'` and a recording in the object store appear shortly after.

## Hold and call waiting (docs/hold-call-waiting.md)

```bash
# Hold: bob answers, holds 10 s, resumes. The caller hears music on hold in between.
sipp -sf uas_staff_hold.xml -p 5070 -rtp_echo -d 10000 $EDGE:5060
sipp -sf uac_inbound.xml -s 15555550100 -p 5062 -m 1 $EDGE:5060

# Call waiting: two calls 5 s apart while bob is still on the first one. Both must reach bob
# (no busy check on the server) and both must be answered.
sipp -sf uas_staff.xml -p 5070 -rtp_echo $EDGE:5060
sipp -sf uac_inbound.xml -s 15555550100 -p 5062 -m 2 -l 2 -r 1 -rp 5000 $EDGE:5060
```

While a call is held, on the VM: `asterisk -rx "core show channels"` shows the caller channel
running MusicOnHold, the ARI app logs `agent hold`, and `curl -s 127.0.0.1:9101/metrics | grep
hold` shows `pbx_calls_on_hold 1`.

## Load testing (phase 6)

Same scenarios with `-r <calls/s> -l <max concurrent> -m <total>`. Add one UAC per codec
(PCMU, G.723.1, G.729, Opus pcaps) and record capacity per pbx node and per rtpengine.
