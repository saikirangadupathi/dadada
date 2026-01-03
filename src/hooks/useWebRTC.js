import { useState, useEffect, useRef, useCallback } from 'react';

const WEB_RTC_SIGNALING = {
  OFFER: 'OFFER',
  ANSWER: 'ANSWER',
  ICE_CANDIDATE: 'ICE_CANDIDATE'
};

const configuration = {
  iceServers: [{ urls: 'stun:stun.1.google.com:13902' }]
};

const defaultConstraints = {
  audio: true,
  video: true
};

export const useWebRTC = (socket) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [personalCode, setPersonalCode] = useState('');
  const [messages, setMessages] = useState([]);
  const [inCall, setInCall] = useState(false);
  const [callType, setCallType] = useState(null);
  const [micActive, setMicActive] = useState(true);
  const [cameraActive, setCameraActive] = useState(true);
  const [messagingReady, setMessagingReady] = useState(false);
  const [dialog, setDialog] = useState(null);

  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const connectedUserDetailsRef = useRef(null);
  const isInitiatorRef = useRef(false);
  const dataChannelMessageQueueRef = useRef([]);

  const getLocalPreview = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(defaultConstraints);
      setLocalStream(stream);
      return stream;
    } catch (err) {
      console.log('Error accessing camera:', err);
      return null;
    }
  }, []);

  useEffect(() => {
    getLocalPreview();
  }, [getLocalPreview]);

  useEffect(() => {
    if (!socket) return;

    socket.on('connect', () => {
      console.log('Connected to server:', socket.id);
      setPersonalCode(socket.id);
    });

    socket.on('register_personal_code_answer', (data) => {
      if (data && data.success) {
        setPersonalCode(data.personalCode);
      }
    });

    socket.on('preOffers', handlePreOffer);
    socket.on('pre_offer_answer', handlePreOfferAnswer);
    socket.on('webRTC_signaling', handleWebRTCSignaling);
    socket.on('user_hanged_up', handleUserHangedUp);

    return () => {
      socket.off('connect');
      socket.off('register_personal_code_answer');
      socket.off('preOffers');
      socket.off('pre_offer_answer');
      socket.off('webRTC_signaling');
      socket.off('user_hanged_up');
    };
  }, [socket]);

  const createPeerConnection = async () => {
    const pc = new RTCPeerConnection(configuration);
    peerConnectionRef.current = pc;

    if (isInitiatorRef.current) {
      const dc = pc.createDataChannel('chat');
      dataChannelRef.current = dc;
      setupDataChannelHandlers(dc);
    }

    pc.ondatachannel = (event) => {
      dataChannelRef.current = event.channel;
      setupDataChannelHandlers(event.channel);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webRTC_signaling', {
          connectedUserSocketId: connectedUserDetailsRef.current.socketId,
          type: WEB_RTC_SIGNALING.ICE_CANDIDATE,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        console.log('Successfully connected to peer');
      }
    };

    const rStream = new MediaStream();
    setRemoteStream(rStream);

    pc.ontrack = (event) => {
      rStream.addTrack(event.track);
    };

    if (connectedUserDetailsRef.current.connection_type === 'personal_code_video') {
      let lStream = localStream;
      if (!lStream) {
        try {
          lStream = await navigator.mediaDevices.getUserMedia(defaultConstraints);
          setLocalStream(lStream);
        } catch (err) {
          console.log('Error accessing camera:', err);
          showInfoDialog('ERROR', 'Could not access camera/microphone');
          return false;
        }
      }
      for (const track of lStream.getTracks()) {
        pc.addTrack(track, lStream);
      }
    }
    return true;
  };

  const setupDataChannelHandlers = (channel) => {
    channel.onopen = () => {
      console.log('Data channel opened');
      while (dataChannelMessageQueueRef.current.length > 0 && channel.readyState === 'open') {
        const msg = dataChannelMessageQueueRef.current.shift();
        try {
          channel.send(JSON.stringify(msg));
        } catch (e) {
          console.log('Send queue error:', e);
          break;
        }
      }
      setMessagingReady(true);
    };

    channel.onmessage = (event) => {
      const message = JSON.parse(event.data);
      setMessages(prev => [...prev, { text: message, isOwn: false }]);
    };

    channel.onclose = () => {
      setMessagingReady(false);
    };
  };

  const sendMessage = (text) => {
    const message = { text, isOwn: true };
    setMessages(prev => [...prev, message]);

    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
      dataChannelMessageQueueRef.current.push(text);
      return;
    }

    try {
      dataChannelRef.current.send(JSON.stringify(text));
    } catch (err) {
      console.log('Error sending message:', err);
      dataChannelMessageQueueRef.current.push(text);
    }
  };

  const initiateCall = async (connectionType, code) => {
    isInitiatorRef.current = true;
    connectedUserDetailsRef.current = {
      connection_type: connectionType,
      socketId: code
    };

    setDialog({ type: 'calling' });
    socket.emit('preOffer', { connection_type: connectionType, personal_code: code });
  };

  const handlePreOffer = async (data) => {
    console.log('Received pre-offer:', data);
    const { connection_type, personal_code } = data;

    isInitiatorRef.current = false;
    connectedUserDetailsRef.current = {
      socketId: personal_code,
      connection_type
    };

    setDialog({
      type: 'incoming',
      callType: connection_type === 'personal_code_chat' ? 'Chat' : 'Video'
    });
  };

  const acceptCall = async () => {
    const ok = await createPeerConnection();
    if (!ok) return;

    socket.emit('pre_offer_answer', {
      callerSocketId: connectedUserDetailsRef.current.socketId,
      preOfferAnswer: 'Call_Accepted'
    });

    setDialog(null);
    setInCall(true);
    setCallType(connectedUserDetailsRef.current.connection_type);
  };

  const rejectCall = () => {
    socket.emit('pre_offer_answer', {
      callerSocketId: connectedUserDetailsRef.current.socketId,
      preOfferAnswer: 'Call_Rejected'
    });
    setDialog(null);
  };

  const handlePreOfferAnswer = async (data) => {
    const { preOfferAnswer } = data;
    setDialog(null);

    if (preOfferAnswer === 'Call_Accepted') {
      setInCall(true);
      setCallType(connectedUserDetailsRef.current.connection_type);
      const ok = await createPeerConnection();
      if (!ok) return;
      await sendWebRTCOffer();
    } else {
      showInfoDialog(preOfferAnswer);
    }
  };

  const sendWebRTCOffer = async () => {
    const offer = await peerConnectionRef.current.createOffer();
    await peerConnectionRef.current.setLocalDescription(offer);

    socket.emit('webRTC_signaling', {
      connectedUserSocketId: connectedUserDetailsRef.current.socketId,
      type: WEB_RTC_SIGNALING.OFFER,
      offer
    });
  };

  const handleWebRTCSignaling = async (data) => {
    switch (data.type) {
      case WEB_RTC_SIGNALING.OFFER:
        await peerConnectionRef.current.setRemoteDescription(data.offer);
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socket.emit('webRTC_signaling', {
          connectedUserSocketId: connectedUserDetailsRef.current.socketId,
          type: WEB_RTC_SIGNALING.ANSWER,
          answer
        });
        break;

      case WEB_RTC_SIGNALING.ANSWER:
        await peerConnectionRef.current.setRemoteDescription(data.answer);
        break;

      case WEB_RTC_SIGNALING.ICE_CANDIDATE:
        try {
          await peerConnectionRef.current.addIceCandidate(data.candidate);
        } catch (err) {
          console.log('Error adding ICE candidate:', err);
        }
        break;
    }
  };

  const hangUp = () => {
    socket.emit('user_hanged_up', {
      connectedUserSocketId: connectedUserDetailsRef.current.socketId
    });
    closePeerConnection();
  };

  const handleUserHangedUp = () => {
    console.log('User hanged up');
    closePeerConnection();
  };

  const closePeerConnection = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (connectedUserDetailsRef.current?.connection_type === 'personal_code_video' && localStream) {
      localStream.getVideoTracks().forEach(track => track.enabled = true);
      localStream.getAudioTracks().forEach(track => track.enabled = true);
    }

    setInCall(false);
    setCallType(null);
    setMessages([]);
    setMessagingReady(false);
    setRemoteStream(null);
    setMicActive(true);
    setCameraActive(true);
    connectedUserDetailsRef.current = null;
    isInitiatorRef.current = false;
    dataChannelMessageQueueRef.current = [];
  };

  const toggleMic = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setMicActive(audioTrack.enabled);
      }
    }
  };

  const toggleCamera = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setCameraActive(videoTrack.enabled);
      }
    }
  };

  const showInfoDialog = (title, description) => {
    const messages = {
      'Call_Rejected': { title: 'Call Rejected', desc: 'Client rejected the call' },
      'Not_Found': { title: 'Not Found', desc: 'Client disconnected or wrong personal code' },
      'Call_Unavailable': { title: 'Unavailable', desc: 'Client is busy' }
    };

    const info = messages[title] || { title, desc: description };
    setDialog({ type: 'info', title: info.title, description: info.desc });

    setTimeout(() => setDialog(null), 3000);
  };

  const registerPersonalCode = (code) => {
    socket.emit('register_personal_code', { personalCode: code });
  };

  return {
    localStream,
    remoteStream,
    personalCode,
    messages,
    inCall,
    callType,
    micActive,
    cameraActive,
    messagingReady,
    dialog,
    initiateCall,
    acceptCall,
    rejectCall,
    hangUp,
    sendMessage,
    toggleMic,
    toggleCamera,
    registerPersonalCode,
    setDialog
  };
};
