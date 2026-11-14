<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<!-- Quality test caller for a session refresh (docs/incidents/2026-11-14-codec-flip.md).
     Behaves like the course's desk phones that went silent on 2026-11-14:
       - offers several codecs with a non-PCMU one first (m= order @PTS@), but sends PCMU
         (45 s of audio from @PCAP@);
       - answers any re-INVITE from Asterisk with its own preference list (same codecs, same order);
       - refreshes the session at @REFRESH_S@ s after the answer with a re-INVITE carrying the SAME
         SDP and Session-Expires: 90;refresher=uac;
       - hangs up at @HANGUP_S@ s.
     The script then checks the payload type and size of what reaches this phone after the refresh.
     Timing uses gettimeofday + test: a re-INVITE from Asterisk can arrive at any point and is
     answered without moving the refresh or the hangup. -->
<scenario name="Quality caller, session refresh, offer @PTS@">
  <send retrans="500">
    <![CDATA[

      INVITE sip:[service]@[domain] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:[from]@[domain]>;tag=[pid]QRac[call_number]
      To: <sip:[service]@[domain]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Supported: timer
      Session-Expires: 90;refresher=uac
      User-Agent: pbx-synthetic-quality
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PTS@
      a=rtpmap:0 PCMU/8000
      a=rtpmap:8 PCMA/8000
      a=rtpmap:18 G729/8000
      a=fmtp:18 annexb=no
      a=rtpmap:4 G723/8000
      a=fmtp:4 annexa=no
      a=rtpmap:101 telephone-event/8000
      a=fmtp:101 0-16
      a=ptime:20
      a=sendrecv

    ]]>
  </send>
  <recv response="100" optional="true"/>
  <recv response="407" auth="true"/>
  <send>
    <![CDATA[

      ACK sip:[service]@[domain] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:[from]@[domain]>;tag=[pid]QRac[call_number]
      To: <sip:[service]@[domain]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 ACK
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>
  <send retrans="500">
    <![CDATA[

      INVITE sip:[service]@[domain] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:[from]@[domain]>;tag=[pid]QRac[call_number]
      To: <sip:[service]@[domain]>
      Call-ID: [call_id]
      CSeq: 2 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      [authentication]
      Max-Forwards: 70
      Supported: timer
      Session-Expires: 90;refresher=uac
      User-Agent: pbx-synthetic-quality
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PTS@
      a=rtpmap:0 PCMU/8000
      a=rtpmap:8 PCMA/8000
      a=rtpmap:18 G729/8000
      a=fmtp:18 annexb=no
      a=rtpmap:4 G723/8000
      a=fmtp:4 annexa=no
      a=rtpmap:101 telephone-event/8000
      a=fmtp:101 0-16
      a=ptime:20
      a=sendrecv

    ]]>
  </send>
  <recv response="100" optional="true"/>
  <recv response="180" optional="true"/>
  <recv response="183" optional="true"/>
  <recv response="200" rrs="true">
    <action>
      <ereg regexp=".*" search_in="hdr" header="To:" assign_to="remote_to"/>
    </action>
  </recv>
  <send>
    <![CDATA[

      ACK [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      [routes]
      From: <sip:[from]@[domain]>;tag=[pid]QRac[call_number]
      To:[$remote_to]
      Call-ID: [call_id]
      CSeq: 2 ACK
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>
  <nop>
    <action>
      <exec play_pcap_audio="@PCAP@"/>
      <gettimeofday assign_to="t_ans,t_ans_us"/>
      <divide assign_to="t_ans_us" value="1000000"/>
      <add assign_to="t_ans" variable="t_ans_us"/>
    </action>
  </nop>

  <!-- Until @REFRESH_S@ s after the answer: answer re-INVITEs from Asterisk (label 1/2). -->
  <label id="1"/>
  <recv request="INVITE" timeout="1000" ontimeout="2"/>
  <send>
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PTS@
      a=rtpmap:0 PCMU/8000
      a=rtpmap:8 PCMA/8000
      a=rtpmap:18 G729/8000
      a=fmtp:18 annexb=no
      a=rtpmap:4 G723/8000
      a=fmtp:4 annexa=no
      a=rtpmap:101 telephone-event/8000
      a=fmtp:101 0-16
      a=ptime:20
      a=sendrecv

    ]]>
  </send>
  <recv request="ACK"/>
  <label id="2"/>
  <nop>
    <action>
      <gettimeofday assign_to="t_now,t_now_us"/>
      <divide assign_to="t_now_us" value="1000000"/>
      <add assign_to="t_now" variable="t_now_us"/>
      <subtract assign_to="t_now" variable="t_ans"/>
      <test assign_to="before_refresh" variable="t_now" compare="less_than" value="@REFRESH_S@"/>
    </action>
  </nop>
  <nop next="1" test="before_refresh"/>

  <!-- The phone's session refresh: same SDP as the INVITE (same o= version). -->
  <send retrans="500">
    <![CDATA[

      INVITE [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      [routes]
      From: <sip:[from]@[domain]>;tag=[pid]QRac[call_number]
      To:[$remote_to]
      Call-ID: [call_id]
      CSeq: 3 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Supported: timer
      Session-Expires: 90;refresher=uac
      User-Agent: pbx-synthetic-quality
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PTS@
      a=rtpmap:0 PCMU/8000
      a=rtpmap:8 PCMA/8000
      a=rtpmap:18 G729/8000
      a=fmtp:18 annexb=no
      a=rtpmap:4 G723/8000
      a=fmtp:4 annexa=no
      a=rtpmap:101 telephone-event/8000
      a=fmtp:101 0-16
      a=ptime:20
      a=sendrecv

    ]]>
  </send>
  <recv response="100" optional="true"/>
  <recv response="200"/>
  <send>
    <![CDATA[

      ACK [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      [routes]
      From: <sip:[from]@[domain]>;tag=[pid]QRac[call_number]
      To:[$remote_to]
      Call-ID: [call_id]
      CSeq: 3 ACK
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <!-- Until @HANGUP_S@ s: keep answering re-INVITEs from Asterisk (label 3/4). -->
  <label id="3"/>
  <recv request="INVITE" timeout="1000" ontimeout="4"/>
  <send>
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PTS@
      a=rtpmap:0 PCMU/8000
      a=rtpmap:8 PCMA/8000
      a=rtpmap:18 G729/8000
      a=fmtp:18 annexb=no
      a=rtpmap:4 G723/8000
      a=fmtp:4 annexa=no
      a=rtpmap:101 telephone-event/8000
      a=fmtp:101 0-16
      a=ptime:20
      a=sendrecv

    ]]>
  </send>
  <recv request="ACK"/>
  <label id="4"/>
  <nop>
    <action>
      <gettimeofday assign_to="t_now,t_now_us"/>
      <divide assign_to="t_now_us" value="1000000"/>
      <add assign_to="t_now" variable="t_now_us"/>
      <subtract assign_to="t_now" variable="t_ans"/>
      <test assign_to="before_hangup" variable="t_now" compare="less_than" value="@HANGUP_S@"/>
    </action>
  </nop>
  <nop next="3" test="before_hangup"/>

  <send retrans="500">
    <![CDATA[

      BYE [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      [routes]
      From: <sip:[from]@[domain]>;tag=[pid]QRac[call_number]
      To:[$remote_to]
      Call-ID: [call_id]
      CSeq: 4 BYE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>
  <recv response="200" crlf="true"/>
</scenario>
