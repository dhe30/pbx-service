<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<!-- Long-call test callee (pbx-long-call-test). A desk phone rung by Asterisk that does not do
     session timers itself:
       - answers the INVITE with PCMU only, WITHOUT Session-Expires and without "timer" in
         Supported, so Asterisk (the UAC on this leg) is the refresher; Allow: @ALLOW@;
       - plays PCMU (@PCAP@);
       - answers a re-INVITE from Asterisk with its preference list @PTS@ (non-PCMU first), the
         way the course's phones answered Asterisk's re-INVITEs on 2026-11-14; UPDATE -> bare 200;
       - waits for the BYE. -->
<scenario name="Long call callee, answers re-INVITEs with @PTS@">
  <recv request="INVITE" crlf="true"/>
  <send retrans="500">
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:];tag=[pid]QLas[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      [last_Record-Route:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      Allow: @ALLOW@
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 2 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP 0 101
      a=rtpmap:0 PCMU/8000
      a=rtpmap:101 telephone-event/8000
      a=fmtp:101 0-16
      a=ptime:20
      a=sendrecv

    ]]>
  </send>
  <recv request="ACK" crlf="true"/>
  <nop>
    <action>
      <exec play_pcap_audio="@PCAP@"/>
    </action>
  </nop>
  <label id="1"/>
  <recv request="UPDATE" optional="true" next="4"/>
  <recv request="INVITE" optional="true" next="2"/>
  <recv request="BYE" next="3"/>
  <label id="2"/>
  <send>
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      Allow: @ALLOW@
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 2 2 IN IP[local_ip_type] [local_ip]
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
  <recv request="ACK" next="1"/>
  <label id="4"/>
  <send next="1">
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      Content-Length: 0

    ]]>
  </send>
  <label id="3"/>
  <send>
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      Content-Length: 0

    ]]>
  </send>
</scenario>
