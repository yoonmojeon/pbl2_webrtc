import { createId } from './id.js';

// The server carries only SDP/ICE. Application data always uses RTCDataChannel.
export class SupportSession extends EventTarget {
  constructor(config) {
    super();
    this.config = config;
    this.stream = new MediaStream();
    this.remoteStream = new MediaStream();
    this.room = null;
    this.peer = null;
    this.selfId = null;
    this.ws = null;
    this.pc = null;
    this.channel = null;
    this.pending = new Map();
    this.metadata = { name: '', role: 'field' };
    this.localStatus = { video: false, audio: false, source: 'none', revision: 0 };
    this.remoteStatus = { video: false, audio: false, source: 'none', revision: 0 };
    this.quality = 'auto';
    this.autoLevel = 'high';
    this.logs = [];
    this.statsHistory = [];
    this.intentionalClose = false;
    this.retryCount = 0;
    this.signalQueue = Promise.resolve();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(text) {
    const item = { at: new Date().toISOString(), text };
    this.logs.push(item);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', item);
  }
  get connected() { return this.pc?.connectionState === 'connected'; }
  get dataReady() { return this.channel?.readyState === 'open'; }
  async openSocket() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.intentionalClose = false;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`);
    this.ws = ws;
    ws.addEventListener('message', event => {
      if (this.ws !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      // Serialize descriptions and candidates; ICE must not race setRemoteDescription.
      this.signalQueue = this.signalQueue.then(() => this.receiveSignal(message)).catch(error => {
        this.log(`신호 처리 오류: ${error.name}`);
        this.emit('error', '연결 정보를 처리하지 못했습니다. 연결 다시 시도를 눌러 주세요.');
      });
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('신호 서버 연결이 끊겼습니다.')); }
      this.pending.clear();
      this.emit('signal-state', false);
      if (!this.intentionalClose && this.room) {
        this.log('신호 서버 연결 끊김 · 자동 복구 대기');
        this.scheduleReconnect();
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { ws.close(); reject(new Error('신호 서버에 연결할 수 없습니다. 서버 실행 상태를 확인해 주세요.')); }, 8000);
      ws.addEventListener('open', () => { clearTimeout(timeout); this.emit('signal-state', true); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('신호 서버에 연결할 수 없습니다.')); }, { once: true });
      ws.addEventListener('close', () => { clearTimeout(timeout); reject(new Error('신호 서버 연결이 종료되었습니다.')); }, { once: true });
    });
  }
  request(type, body = {}) {
    return new Promise((resolve, reject) => {
      const requestId = createId();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('서버 응답 시간이 초과되었습니다. 다시 시도해 주세요.')); }, 8000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type, ...body, requestId }));
    });
  }
  async start(type, metadata, room) {
    this.metadata = metadata;
    this.retryCount = 0;
    this.logs = []; this.statsHistory = [];
    await this.openSocket();
    return this.request(type, { ...metadata, room });
  }
  async receiveSignal(message) {
    if (message.type === 'welcome') { this.selfId = message.selfId; return; }
    if (message.type === 'error') {
      const pending = this.pending.get(message.requestId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.reject(Object.assign(new Error(message.message), { code: message.code })); }
      else if (message.code !== 'PEER_NOT_FOUND') this.emit('error', message.message);
      return;
    }
    if (message.type === 'joined') {
      this.resetPeer();
      this.room = message.room;
      this.selfId = message.selfId;
      this.retryCount = 0;
      this.log('방 입장 완료 · 1:1 P2P 모드');
      this.emit('joined', { room: this.room, selfId: this.selfId });
      if (message.peers.length) this.createPeer(message.peers[0]);
      const pending = this.pending.get(message.requestId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.resolve(message); }
      return;
    }
    if (message.type === 'peer-joined') {
      this.resetPeer(); this.createPeer(message.peer);
      return;
    }
    if (message.type === 'peer-left' && message.peerId === this.peer?.id) {
      const name = this.peer.name;
      this.resetPeer();
      this.log('상대방 퇴장 · 다시 입장 가능');
      this.emit('peer-left', name);
      this.emit('state', 'waiting');
      return;
    }
    if (message.type !== 'signal' || message.from !== this.peer?.id || !this.pc) return;
    const pc = this.pc;
    const { description, candidate } = message.payload;
    if (description) {
      const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.settingRemoteAnswer);
      const collision = description.type === 'offer' && !readyForOffer;
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      this.settingRemoteAnswer = description.type === 'answer';
      try { await pc.setRemoteDescription(description); }
      finally { this.settingRemoteAnswer = false; }
      if (this.pc !== pc) return;
      this.log(`SDP ${description.type === 'offer' ? 'Offer' : 'Answer'} 수신`);
      for (const queued of this.candidateQueue.splice(0)) await pc.addIceCandidate(queued);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.sendSignal({ description: pc.localDescription });
        this.log('SDP Answer 전송');
      }
    } else if (candidate && !this.ignoreOffer) {
      if (!pc.remoteDescription) this.candidateQueue.push(candidate);
      else {
        try { await pc.addIceCandidate(candidate); }
        catch (error) { if (!this.ignoreOffer) throw error; }
      }
    }
  }
  sendSignal(payload) {
    if (this.ws?.readyState === WebSocket.OPEN && this.peer) this.ws.send(JSON.stringify({ type: 'signal', target: this.peer.id, payload }));
  }
  createPeer(peer) {
    this.peer = peer;
    this.polite = this.selfId.localeCompare(peer.id) > 0;
    this.makingOffer = false; this.ignoreOffer = false; this.settingRemoteAnswer = false;
    this.candidateQueue = [];
    this.startedAt = performance.now(); this.establishedMs = null;
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' });
    this.pc = pc;
    this.remoteStream = new MediaStream();
    this.senders = {};
    for (const kind of ['audio', 'video']) {
      const track = this.stream.getTracks().find(t => t.kind === kind);
      const transceiver = pc.addTransceiver(track || kind, { direction: 'sendrecv', streams: [this.stream] });
      this.senders[kind] = transceiver.sender;
    }
    const channel = pc.createDataChannel('fieldlink', { negotiated: true, id: 0, ordered: true });
    this.channel = channel;
    channel.onopen = () => {
      if (this.pc !== pc) return;
      this.log('RTCDataChannel 연결 완료');
      this.emit('data-state', true);
      this.sendStatus();
      void this.applyQuality().catch(() => this.log('영상 품질 설정 대기'));
    };
    channel.onclose = () => { if (this.pc === pc) this.emit('data-state', false); };
    channel.onerror = () => { if (this.pc === pc) this.log('데이터 채널 오류'); };
    let incomingAt = 0, incomingCount = 0;
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 32768 || this.pc !== pc) return;
      if (Date.now() - incomingAt > 1000) { incomingAt = Date.now(); incomingCount = 0; }
      if (++incomingCount > 250) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'status') {
        this.remoteStatus = {
          video: message.video === true, audio: message.audio === true,
          source: ['screen', 'camera'].includes(message.source) ? message.source : 'none',
          revision: Number.isSafeInteger(message.revision) ? message.revision : 0
        };
        this.emit('remote-media', this.remoteStatus);
      } else this.emit('data', message);
    };
    pc.ontrack = ({ track }) => {
      if (this.pc !== pc) return;
      if (!this.remoteStream.getTrackById(track.id)) this.remoteStream.addTrack(track);
      for (const type of ['mute', 'unmute', 'ended']) track.addEventListener(type, () => { if (this.pc === pc) this.emit('remote-media', this.remoteStatus); });
      this.emit('remote-media', this.remoteStatus);
    };
    pc.onicecandidate = ({ candidate }) => { if (this.pc === pc && candidate) this.sendSignal({ candidate: candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (this.pc !== pc) return;
        this.sendSignal({ description: pc.localDescription });
        this.log(`SDP ${pc.localDescription.type === 'offer' ? 'Offer' : 'Answer'} 전송`);
      } catch (error) { if (this.pc === pc && pc.signalingState !== 'closed') this.log(`협상 대기: ${error.name}`); }
      finally { this.makingOffer = false; }
    };
    pc.oniceconnectionstatechange = () => { if (this.pc === pc) this.emit('ice-state', pc.iceConnectionState); };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const state = pc.connectionState;
      this.log(`P2P 상태: ${state}`);
      this.emit('state', state);
      clearTimeout(this.iceRetryTimer);
      if (state === 'connected') {
        this.iceAttempts = 0;
        if (this.establishedMs === null) this.establishedMs = Math.round(performance.now() - this.startedAt);
        this.sendStatus();
      } else if (state === 'failed' || state === 'disconnected') {
        this.iceRetryTimer = setTimeout(() => { if (this.pc === pc && this.iceAttempts < 3) this.restartIce(); }, state === 'failed' ? 1500 : 6000);
      }
    };
    this.iceAttempts = 0;
    this.previousRtp = null;
    this.statsTimer = setInterval(() => void this.collectStats().catch(() => {}), 1500);
    this.emit('peer', peer);
    this.emit('state', 'connecting');
    this.log(`${peer.role === 'expert' ? '전문가' : '현장 작업자'} 연결 시작`);
  }
  async setTrack(kind, track, source = 'none') {
    const old = this.stream.getTracks().find(t => t.kind === kind);
    if (this.senders?.[kind]) await this.senders[kind].replaceTrack(track);
    if (old) { this.stream.removeTrack(old); if (old !== track) old.stop(); }
    if (track) this.stream.addTrack(track);
    this.localStatus[kind === 'video' ? 'video' : 'audio'] = !!track && track.enabled;
    if (kind === 'video') { this.localStatus.source = track ? source : 'none'; this.localStatus.revision++; }
    this.sendStatus();
    this.emit('local-media', this.localStatus);
    if (kind === 'video') await this.applyQuality().catch(() => this.log('영상 품질 설정은 협상 완료 후 적용됩니다.'));
  }
  toggleAudio() {
    const track = this.stream.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    this.localStatus.audio = track.enabled;
    this.sendStatus(); this.emit('local-media', this.localStatus);
    return true;
  }
  sendStatus() { this.sendData({ type: 'status', ...this.localStatus }); }
  sendData(message) {
    if (!this.dataReady || this.channel.bufferedAmount > 1024 * 1024) return false;
    const raw = JSON.stringify(message);
    if (raw.length > 32768) return false;
    try { this.channel.send(raw); return true; } catch { return false; }
  }
  restartIce() {
    if (this.pc && this.peer && this.ws?.readyState === WebSocket.OPEN) {
      this.iceAttempts++;
      this.pc.restartIce();
      this.log('ICE 경로 재탐색 요청');
      return true;
    }
    return false;
  }
  scheduleReconnect(immediate = false) {
    clearTimeout(this.reconnectTimer);
    if (this.retryCount >= 8) { this.emit('error', '신호 서버 자동 복구를 중단했습니다. 서버 상태를 확인한 뒤 연결 다시 시도를 눌러 주세요.'); return; }
    const delay = immediate ? 0 : Math.min(30000, 1000 * 2 ** this.retryCount);
    this.reconnectTimer = setTimeout(async () => {
      if (!this.room || this.intentionalClose) return;
      this.retryCount++;
      try {
        await this.openSocket();
        await this.request('join', { ...this.metadata, room: this.room });
        this.log('신호 서버 및 세션 복구 완료');
      } catch (error) {
        if (error.code === 'ROOM_NOT_FOUND') { this.emit('error', '서버에 기존 방이 없습니다. 연결 종료 후 새 세션을 만들어 주세요.'); return; }
        this.log(`신호 복구 ${this.retryCount}회 실패`);
        this.scheduleReconnect();
      }
    }, delay);
  }
  reconnect() {
    this.retryCount = 0;
    if (this.ws?.readyState !== WebSocket.OPEN) this.scheduleReconnect(true);
    else if (this.pc) { this.iceAttempts = 0; this.restartIce(); }
    else this.emit('error', '상대방이 입장하면 연결을 시작합니다.');
  }
  async applyQuality() {
    const sender = this.senders?.video;
    if (!sender || !sender.track || !this.pc || this.pc.signalingState === 'closed') return;
    const level = this.quality === 'auto' ? this.autoLevel : this.quality;
    const limits = { high: [2500000, 30, 1], medium: [1000000, 24, 1.5], low: [350000, 15, 2] }[level];
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings[0].maxBitrate = limits[0];
    parameters.encodings[0].maxFramerate = limits[1];
    parameters.encodings[0].scaleResolutionDownBy = limits[2];
    await sender.setParameters(parameters);
  }
  async collectStats() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected' || this.collectingStats) return;
    this.collectingStats = true;
    try {
      const report = await pc.getStats();
      if (this.pc !== pc) return;
      let pair, inbound, outbound;
      for (const value of report.values()) {
        if (value.type === 'transport' && value.selectedCandidatePairId) pair = report.get(value.selectedCandidatePairId);
        if (!pair && value.type === 'candidate-pair' && value.state === 'succeeded' && value.nominated) pair = value;
        if (value.type === 'inbound-rtp' && value.kind === 'video') inbound = value;
        if (value.type === 'outbound-rtp' && value.kind === 'video' && !value.isRemote) outbound = value;
      }
      const rtp = this.remoteStatus.video && inbound ? inbound : this.localStatus.video ? outbound : null;
      const bytes = rtp?.bytesReceived ?? rtp?.bytesSent ?? 0;
      const old = this.previousRtp;
      let bitrate = null, loss = null;
      if (rtp && old?.id === rtp.id && rtp.timestamp > old.timestamp) {
        bitrate = Math.max(0, (bytes - old.bytes) * 8 / (rtp.timestamp - old.timestamp)); // kbps
        if (rtp.packetsReceived !== undefined) {
          const received = Math.max(0, rtp.packetsReceived - old.received);
          const lost = Math.max(0, (rtp.packetsLost || 0) - old.lost);
          if (received + lost > 0) loss = lost * 100 / (received + lost);
        }
      }
      this.previousRtp = rtp ? { id: rtp.id, timestamp: rtp.timestamp, bytes, received: rtp.packetsReceived || 0, lost: rtp.packetsLost || 0 } : null;
      const local = pair && report.get(pair.localCandidateId);
      const remote = pair && report.get(pair.remoteCandidateId);
      const stats = {
        at: new Date().toISOString(), rtt: pair?.currentRoundTripTime === undefined ? null : pair.currentRoundTripTime * 1000,
        bitrate, loss, fps: rtp?.framesPerSecond ?? null, width: rtp?.frameWidth ?? null, height: rtp?.frameHeight ?? null,
        jitter: inbound && this.remoteStatus.video ? inbound.jitter * 1000 : null,
        establish: this.establishedMs, direction: rtp?.type === 'inbound-rtp' ? '수신' : '송신',
        path: local && remote ? `${local.candidateType} ↔ ${remote.candidateType}` : null,
        relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
        ice: pc.iceConnectionState, quality: this.quality === 'auto' ? `auto/${this.autoLevel}` : this.quality
      };
      this.statsHistory.push(stats);
      if (this.statsHistory.length > 240) this.statsHistory.shift();
      this.emit('stats', stats);
      if (this.quality === 'auto' && Date.now() - (this.lastAdaptAt || 0) > 9000) {
        const next = stats.rtt > 350 || stats.loss > 8 ? 'low' : stats.rtt > 180 || stats.loss > 3 ? 'medium' : 'high';
        if (next !== this.autoLevel) { this.autoLevel = next; this.lastAdaptAt = Date.now(); await this.applyQuality(); this.log(`전송 품질 자동 조절: ${next}`); }
      }
    } finally { this.collectingStats = false; }
  }
  resetPeer() {
    clearInterval(this.statsTimer); clearTimeout(this.iceRetryTimer);
    const pc = this.pc;
    this.pc = null; this.channel = null; this.peer = null; this.senders = null;
    this.remoteStatus = { video: false, audio: false, source: 'none', revision: 0 };
    if (pc) pc.close();
    for (const track of this.remoteStream.getTracks()) track.stop();
    this.remoteStream = new MediaStream();
    this.emit('data-state', false); this.emit('remote-media', this.remoteStatus);
  }
  leave() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'leave' }));
    this.room = null;
    this.resetPeer();
    this.ws?.close(); this.ws = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('세션이 종료되었습니다.')); }
    this.pending.clear();
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = new MediaStream();
    this.localStatus = { video: false, audio: false, source: 'none', revision: 0 };
    this.emit('local-media', this.localStatus);
    this.log('세션 종료');
  }
}
