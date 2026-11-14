<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<!-- Long-call test caller (pbx-long-call-test, follow-up 2 of docs/incidents/2026-11-14-codec-flip.md).
     A desk phone that leaves the session refresh to Asterisk:
       - offers several codecs, non-PCMU first (m= order @PTS@), sends PCMU (@PCAP@);
       - Supported: timer + Session-Expires: @SE@;refresher=uas, so Asterisk (the UAS) refreshes
         at @SE@/2 s; Allow: @ALLOW@ (without UPDATE, pjsip refreshes with a re-INVITE + SDP);
       - answers re-INVITEs from Asterisk with its own preference list, UPDATEs with a bare 200;
       - sends one re-INVITE of its own at @REINVITE_S@ s (same SDP, like a phone's periodic
         re-INVITE or hold), which is when the 2026-11-14 flip showed up; hangs up at @HANGUP_S@ s. -->
<scenario name="Long call caller, offer @PTS@">
  <send retrans="500">
    <![CDATA[

      INVITE sip:[service]@[domain] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:[from]@[domain]>;tag=[pid]QLac[call_number]
      To: <sip:[service]@[domain]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Allow: @ALLOW@
      Supported: timer
      Session-Expires: @SE@;refresher=uas
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
      From: <sip:[from]@[domain]>;tag=[pid]QLac[call_number]
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
      From: <sip:[from]@[domain]>;tag=[pid]QLac[call_number]
      To: <sip:[service]@[domain]>
      Call-ID: [call_id]
      CSeq: 2 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      [authentication]
      Max-Forwards: 70
      Allow: @ALLOW@
      Supported: timer
      Session-Expires: @SE@;refresher=uas
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
      From: <sip:[from]@[domain]>;tag=[pid]QLac[call_number]
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

  <!-- Until @REINVITE_S@ s: answer UPDATE (label 7) and re-INVITE from Asterisk. The 1 s timeouts
       on both recvs keep the clock check (label 2) running while nothing arrives. -->
  <label id="1"/>
  <recv request="UPDATE" optional="true" timeout="1000" ontimeout="2" next="7"/>
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
      Allow: @ALLOW@
      Supported: timer
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
  <recv request="ACK" next="2"/>
  <label id="7"/>
  <send next="2">
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      [last_Session-Expires:]
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Supported: timer
      Content-Length: 0

    ]]>
  </send>
  <label id="2"/>
  <nop>
    <action>
      <gettimeofday assign_to="t_now,t_now_us"/>
      <divide assign_to="t_now_us" value="1000000"/>
      <add assign_to="t_now" variable="t_now_us"/>
      <subtract assign_to="t_now" variable="t_ans"/>
      <test assign_to="before_reinvite" variable="t_now" compare="less_than" value="@REINVITE_S@"/>
    </action>
  </nop>
  <nop next="1" test="before_reinvite"/>

  <!-- The phone's own re-INVITE: same SDP as its INVITE. -->
  <send retrans="500">
    <![CDATA[

      INVITE [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      [routes]
      From: <sip:[from]@[domain]>;tag=[pid]QLac[call_number]
      To:[$remote_to]
      Call-ID: [call_id]
      CSeq: 3 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Allow: @ALLOW@
      Supported: timer
      Session-Expires: @SE@;refresher=uas
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
      From: <sip:[from]@[domain]>;tag=[pid]QLac[call_number]
      To:[$remote_to]
      Call-ID: [call_id]
      CSeq: 3 ACK
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <!-- Until @HANGUP_S@ s: same answering loop (labels 3/8/4). -->
  <label id="3"/>
  <recv request="UPDATE" optional="true" timeout="1000" ontimeout="4" next="8"/>
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
      Allow: @ALLOW@
      Supported: timer
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
  <recv request="ACK" next="4"/>
  <label id="8"/>
  <send next="4">
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      [last_Session-Expires:]
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Supported: timer
      Content-Length: 0

    ]]>
  </send>
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
      From: <sip:[from]@[domain]>;tag=[pid]QLac[call_number]
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
