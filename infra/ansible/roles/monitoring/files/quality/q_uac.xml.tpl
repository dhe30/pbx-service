<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<!-- Quality test caller: offers ONLY @CODEC@ (pt @PT@), plays 3 s of @CODEC@ audio after the
     answer, answers re-INVITEs with the same SDP, hangs up after 5 s without one. -->
<scenario name="Quality caller @CODEC@">
  <send retrans="500">
    <![CDATA[

      INVITE sip:[service]@[domain] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:[from]@[domain]>;tag=[pid]QUac[call_number]
      To: <sip:[service]@[domain]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      User-Agent: pbx-synthetic-quality
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PT@
      a=rtpmap:@PT@ @RTPMAP@
      @EXTRA@
      a=ptime:@PTIME@

    ]]>
  </send>
  <recv response="100" optional="true"/>
  <recv response="407" auth="true"/>
  <send>
    <![CDATA[

      ACK sip:[service]@[domain] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: <sip:[from]@[domain]>;tag=[pid]QUac[call_number]
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
      From: <sip:[from]@[domain]>;tag=[pid]QUac[call_number]
      To: <sip:[service]@[domain]>
      Call-ID: [call_id]
      CSeq: 2 INVITE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      [authentication]
      Max-Forwards: 70
      User-Agent: pbx-synthetic-quality
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 2 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PT@
      a=rtpmap:@PT@ @RTPMAP@
      @EXTRA@
      a=ptime:@PTIME@

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
      From: <sip:[from]@[domain]>;tag=[pid]QUac[call_number]
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
    </action>
  </nop>
  <label id="1"/>
  <recv request="INVITE" timeout="5000" ontimeout="2"/>
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
      o=sipp 1 2 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PT@
      a=rtpmap:@PT@ @RTPMAP@
      @EXTRA@
      a=ptime:@PTIME@

    ]]>
  </send>
  <recv request="ACK" next="1"/>
  <label id="2"/>
  <send retrans="500">
    <![CDATA[

      BYE [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      [routes]
      From: <sip:[from]@[domain]>;tag=[pid]QUac[call_number]
      To:[$remote_to]
      Call-ID: [call_id]
      CSeq: 3 BYE
      Contact: <sip:[from]@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>
  <recv response="200" crlf="true"/>
</scenario>
