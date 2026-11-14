<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<!-- Quality test callee: answers with ONLY @CODEC@ (pt @PT@), plays 3 s of @CODEC@ audio,
     answers re-INVITEs with the same SDP, waits for the BYE. -->
<scenario name="Quality callee @CODEC@">
  <recv request="INVITE" crlf="true"/>
  <send retrans="500">
    <![CDATA[

      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:];tag=[pid]QUas[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      [last_Record-Route:]
      Contact: <sip:[local_ip]:[local_port];transport=[transport]>
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 2 1 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [media_port] RTP/AVP @PT@
      a=rtpmap:@PT@ @RTPMAP@
      @EXTRA@
      a=ptime:@PTIME@

    ]]>
  </send>
  <recv request="ACK" crlf="true"/>
  <nop>
    <action>
      <exec play_pcap_audio="@PCAP@"/>
    </action>
  </nop>
  <label id="1"/>
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
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 2 2 IN IP[local_ip_type] [local_ip]
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
