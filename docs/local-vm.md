# Phase 1 on a local VM (Windows + VirtualBox)

The same all-in-one deploy as `docs/phase1.md`, on a VirtualBox VM on your Windows PC. Ansible
runs in WSL (Ubuntu). At the end you call the test DID from a softphone on Windows (playing the
carrier), hear the IVR, and answer in the browser as staff "alice". Then you test hold and call
waiting.

```
 Windows host (192.168.56.1)                         VirtualBox VM "pbx-aio" (Debian 13)
 ┌──────────────────────────────┐   host-only net   ┌──────────────────────────────────────┐
 │ MicroSIP = fake carrier  ────┼── SIP/RTP ───────►│ 192.168.56.10  "public":             │
 │ Chrome   = staff alice   ────┼── HTTPS/WSS ─────►│   Kamailio, rtpengine ext, HAProxy   │
 │ WSL Ubuntu = Ansible     ────┼── SSH ───────────►│ 10.0.2.15      "private" (NAT):      │
 └──────────────────────────────┘                   │   Asterisk, rtpengine int, Postgres… │
                                                    └──────────────────────────────────────┘
```

Why two adapters: rtpengine needs two different addresses for its internal (Asterisk) and
external (carrier/browser) sides, like a cloud VM's private and public IPs.

Time: ~30 min of setup, plus ~20-30 min for the first playbook run (Asterisk compiles from source).

## 1. Create the VM

1. Install **VirtualBox 7.1** (it works next to WSL2) and download the **Debian 13 netinst** ISO
   (amd64) from debian.org.
2. New VM: 4 vCPU (2 works, but the Asterisk build is slower), **4 GB RAM**, **25 GB** disk.
3. Settings -> Network:
   - Adapter 1: **NAT** (the default). Gives internet access, and becomes `private_ip` (10.0.2.15).
   - Adapter 2: **Host-only Adapter**, "VirtualBox Host-Only Ethernet Adapter" (192.168.56.0/24).
     This becomes `public_ip`.
4. Install Debian. At "Software selection" pick only **SSH server** and **standard system
   utilities** (no desktop). Set a root password and create a normal user (e.g. `daniel`).
5. Log in on the VM console as root and give the host-only adapter a fixed address:
   ```bash
   ip -4 addr                     # find the 2nd interface name, e.g. enp0s8
   cat >> /etc/network/interfaces <<'EOF'

   auto enp0s8
   iface enp0s8 inet static
       address 192.168.56.10/24
   EOF
   systemctl restart networking
   apt install -y python3 rsync   # Ansible needs python3; synchronize needs rsync on both ends
   ip -4 addr                     # expect 10.0.2.15 on enp0s3 and 192.168.56.10 on enp0s8
   ```
   If the NAT address isn't 10.0.2.15, put the real one in `infra/ansible/inventory/local-vm.ini`.

   **If VirtualBox did an unattended install** (you land on a Debian desktop, and step 4 never
   asked you anything): that works too. Open a Terminal in the VM and become root with `su -`
   (the root password is the one you gave VirtualBox). The desktop uses NetworkManager, so set
   the address with nmcli instead of `/etc/network/interfaces`, and install SSH:
   ```bash
   apt install -y openssh-server python3 rsync
   ip link             # match MACs with VirtualBox: Adapter 1 (NAT) = enp0s3, Adapter 2 = enp0s8
   nmcli device status # "unmanaged" enp0s3 = it's listed in /etc/network/interfaces: comment
                       # out its lines there, then: systemctl restart NetworkManager
   # Auto-created "Wired connection N" names can move between devices, so pin each profile to
   # its device by name:
   nmcli con delete "Wired connection 1" "Wired connection 2" 2>/dev/null
   nmcli con add type ethernet ifname enp0s3 con-name nat ipv4.method auto
   nmcli con add type ethernet ifname enp0s8 con-name hostonly ipv4.method manual \
     ipv4.addresses 192.168.56.10/24 ipv4.never-default yes ipv6.method disabled
   nmcli con up nat && nmcli con up hostonly
   ip -4 addr                                          # 10.0.2.15 and 192.168.56.10
   ip route                                            # must say: default via 10.0.2.2
   systemctl set-default multi-user.target             # optional: no desktop after reboot (~1 GB RAM back)
   ```
   Only one device has an address? Check the VM's Settings -> Network with the VM powered off:
   Adapter 1 = **NAT**, Adapter 2 = **Host-only**, both enabled, with "Cable Connected" ticked
   (under Advanced). No `10.0.2.x` address and no `default via` route = no internet.

## 2. Set up the control machine (WSL Ubuntu)

```bash
sudo apt update && sudo apt install -y ansible rsync openssh-client
ping -c 2 192.168.56.10          # WSL must reach the VM
```
If the ping fails, turn on WSL mirrored networking: in `%UserProfile%\.wslconfig` put
`[wsl2]` / `networkingMode=mirrored`, then run `wsl --shutdown` from Windows and reopen WSL.

SSH key for root (Debian allows root login with a key, not with a password):
```bash
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
ssh-copy-id daniel@192.168.56.10
ssh -t daniel@192.168.56.10 "su -c 'mkdir -p /root/.ssh && cat /home/daniel/.ssh/authorized_keys >> /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys'"
ssh root@192.168.56.10 true && echo ROOT_SSH_OK    # also records the host key (host_key_checking)
```

Copy the repo into the Linux filesystem. Ansible ignores `ansible.cfg` under `/mnt/c/...`
(world-writable). **Re-run this after every change made on the Windows side.** The vault exclude
keeps `--delete` from removing the `vault.yml` you create in step 3, which exists only in WSL.
`--chmod=go-w` matters too: files under `/mnt/c` are world-writable, and Ansible ignores
`ansible.cfg` (and then can't find the roles) in a world-writable directory:
```bash
rsync -a --delete --chmod=go-w --exclude node_modules --exclude dist --exclude .git \
  --exclude infra/ansible/group_vars/all/vault.yml \
  /mnt/c/Users/danie/pbx-service/ ~/pbx-service/
```

## 3. Configure and deploy

```bash
cd ~/pbx-service/infra/ansible
ansible-galaxy collection install -r requirements.yml

cp group_vars/all/vault.yml.example group_vars/all/vault.yml
nano group_vars/all/vault.yml     # fill every CHANGE_ME (generation commands are in the file)
ansible-vault encrypt group_vars/all/vault.yml

ansible -i inventory/local-vm.ini all -m ping --ask-vault-pass   # expect "pong"
ansible-playbook -i inventory/local-vm.ini phase1-allinone.yml --ask-vault-pass
```

The run ends by waiting for the ARI app's `/health`. Re-runs only change what changed. If it
fails, the task name tells you which role. Common first-run problems are listed in
`docs/phase1.md` §6.

Quick health check on the VM (`ssh root@192.168.56.10`):
```bash
systemctl --no-pager status kamailio rtpengine-daemon asterisk pbx-ari-app haproxy postgresql garage | grep -E "●|Active"
asterisk -rx "pjsip show endpoints"      # edge-a: Avail
kamcmd dispatcher.list | grep -E "URI|FLAGS"   # FLAGS: AP (active, probing)
curl -s 127.0.0.1:9101/health            # {"ari":true,"db":true}
ls /var/lib/asterisk/moh | head -3       # music-on-hold files (*.ulaw)
```

## 4. Staff: the browser rings

1. In Chrome on Windows, open **https://192.168.56.10/webrtc-test** and accept the self-signed
   certificate warning (Advanced -> Proceed).
2. Domain `pbx.local` (`sip_domain`), user `alice`, password = `vault_test_alice_password`.
   **Go online** -> allow the microphone -> status *registered as alice*.
3. Check on the VM: `kamcmd ul.dump | grep -i alice`.

## 5. Carrier: call the DID and hear the IVR

Install **MicroSIP** (microsip.org) on Windows. It can call an IP address without an account:
- Settings: leave the account empty; DTMF method **RFC2833**; allow MicroSIP through Windows
  Firewall on **both** private and public networks when asked (the host-only network may be
  classed as "public"; without this you hear nothing).
- Dial `sip:15555550100@192.168.56.10`.

You should hear Asterisk's stock "hello world" greeting (the IVR menu prompt) and then:

| Press | Result (seeded test tenant)                                 |
|-------|-------------------------------------------------------------|
| 0     | rings **alice in the browser** -> Answer -> two-way audio   |
| 1     | rings alice + bob together (bob unregistered -> only alice) |
| 2     | voicemail "Main" (beep, speak, hang up)                     |
| none  | after 3 tries -> voicemail "Main"                           |

Kamailio only accepts carrier INVITEs from `192.168.56.1` (`carrier_cidrs` in the local
inventory). A 403 means the call came from another address: check `sngrep` on the VM.

## 6. Hold and call waiting

MicroSIP can hold several calls at once, so it can be both caller 1 and caller 2.
1. Call, press 0, answer in the browser, talk. Then **Hold** in the browser: MicroSIP hears
   music on hold. **Resume**: audio is back.
2. With call 1 held, call again from MicroSIP and press 0: the browser shows call #2 *waiting*
   with a short beep. **Answer**, hang up #2, **Resume** #1.
3. While talking on #1, call again and **Answer** #2 directly: #1 is held automatically.
4. **Decline** a waiting call: that caller goes to alice's voicemail.
5. Hold for more than 2 minutes, then resume: the call must still be up, with audio.

Recording is on for the test tenant, so this covers "MOH with recording on". To test with
recording off:
`sudo -u postgres psql pbx -c "update tenant_settings set record_calls=false"`. The next
playbook run re-applies the seed and turns recording back on.

Watch it happen (VM):
```bash
journalctl -u pbx-ari-app -f | grep -E "hold|answered|hung up"
asterisk -rx "core show channels"          # caller channel in MusicOnHold while held
curl -s 127.0.0.1:9101/metrics | grep hold
sngrep                                     # the re-INVITEs: a=sendonly / a=recvonly
```
Then tick the boxes in `docs/hold-call-waiting.md` §5.

## 7. Known limitation: audio quality when Hyper-V is on

If WSL2 (or Memory integrity) is enabled, Windows runs Hyper-V and VirtualBox falls back to
its slow "NEM" mode (green turtle in the VM status bar; `VBox.log` says
`fall back to NEM: VT-x is not available`). The guest clock is then imprecise: Asterisk sends
~46 instead of 50 audio packets per second (measured 2026-10-29). Voice stays understandable,
but **music on hold sounds garbled/robotic**, with short crisp moments while the softphone's
jitter buffer refills. That's a property of the local VM, not the design: judge audio quality on
a cloud (KVM) VM.

Measure it (on the VM, during a call; ~500 per stream in 10 s = real time):
```bash
asterisk -rx "timing test"            # expect ~50 ticks
timeout -s INT 10 tcpdump -n -i any -w /dev/null 'udp and src host 10.0.2.15 and src portrange 10000-20000'
```
For accurate local audio, turn Hyper-V off (`bcdedit /set hypervisorlaunchtype off`, Memory
integrity off, reboot; WSL then needs version 1: `wsl --set-version Ubuntu 1`). Undo with
`bcdedit /set hypervisorlaunchtype auto`.

## 8. Day-to-day
- Change code on Windows -> rsync (§2) -> re-run the playbook. Only changed parts restart.
- Snapshot the VM after the first good deploy (VirtualBox -> Take Snapshot), so you can roll
  back instead of rebuilding Asterisk.
- Stop the VM when you're done. All services start by themselves on the next boot.
