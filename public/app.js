import { SupportSession } from './rtc.js';
import { createId } from './id.js';

const $ = id => document.getElementById(id);
let receiveOnly = !window.isSecureContext || new URL(location.href).searchParams.get('view') === '1';
let role = receiveOnly ? 'expert' : 'field', busy = false, inSession = false, mediaBusy = false, startedAt = null;
let soundEnabled = !receiveOnly;
let view = 'remote', tool = 'pointer', unread = 0, pointerTimer, toastTimer;
const annotations = new Map();
let drawing = null, lastPointerAt = 0, currentTarget = null;
let fit = { x: 0, y: 0, w: 0, h: 0 };
let config;
try {
  const response = await fetch('/config');
  if (!response.ok) throw new Error();
  config = await response.json();
} catch {
  $('environment-alert').textContent = '설정을 불러오지 못했습니다. 서버 실행 상태를 확인하고 새로고침해 주세요.';
  $('environment-alert').hidden = false;
  $('create-room').disabled = true; $('join-room').disabled = true;
  throw new Error('Configuration unavailable');
}
export const session = new SupportSession(config);
const mainVideo = $('main-video'), preview = $('preview-video'), canvas = $('annotation-canvas');
const context = canvas.getContext('2d');

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}
function mediaError(error) {
  const messages = {
    NotAllowedError: '공유가 취소되었거나 권한이 허용되지 않았습니다. 브라우저의 카메라·마이크 권한을 확인해 주세요.',
    NotFoundError: '사용 가능한 장치가 없습니다. 카메라가 없으면 화면 공유를 사용해 주세요.',
    NotReadableError: '장치가 다른 프로그램에서 사용 중이거나 읽을 수 없습니다.',
    OverconstrainedError: '선택한 장치를 사용할 수 없습니다. 기본 장치를 선택해 주세요.',
    InvalidStateError: '브라우저 화면에서 화면 공유 버튼을 직접 눌러 주세요.',
    TypeError: '미디어 기능을 사용할 수 없습니다. localhost 또는 신뢰할 수 있는 HTTPS로 접속해 주세요.'
  };
  toast(messages[error.name] || error.message || '미디어를 시작할 수 없습니다.', true);
}
function browserSupported() {
  const okay = window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection;
  if (!okay) {
    $('environment-alert').textContent = !window.RTCPeerConnection
      ? '이 브라우저에서는 실시간 연결을 사용할 수 없습니다. 최신 브라우저에서 접속해 주세요.'
      : '이 기기의 카메라·마이크를 시작하려면 localhost 또는 신뢰할 수 있는 HTTPS로 접속해 주세요.';
    $('environment-alert').hidden = false;
  }
  return okay;
}
function updateMediaMode() {
  const viewer = receiveOnly && !!window.RTCPeerConnection;
  $('capture-controls').hidden = viewer;
  $('viewer-controls').hidden = !viewer;
  $('empty-share').hidden = viewer;
  $('viewer-help').hidden = !viewer;
  $('switch-to-send').hidden = !viewer || !window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia;
  $('desktop-access').hidden = !viewer || window.isSecureContext;
  const desktopUrl = new URL('/', location.origin);
  desktopUrl.hostname = 'localhost';
  if (session.room) desktopUrl.searchParams.set('room', session.room);
  $('desktop-send-link').href = desktopUrl.href;
  $('quality-select').disabled = receiveOnly;
  $('quality-hint').textContent = receiveOnly ? '보기 모드에서는 데스크톱에서 영상 전송 품질을 조절합니다.' : '대역폭은 상한값이며 실제 전송률은 환경에 따라 달라집니다.';
  $('environment-alert').classList.toggle('info', viewer);
  $('environment-alert').classList.toggle('error', !viewer);
  $('environment-alert').hidden = !viewer;
  if (viewer) {
    $('environment-alert').textContent = window.isSecureContext
      ? '화면 보기 모드입니다. 이 데스크톱의 화면을 보내려면 입장 후 아래 내 화면 공유 버튼을 누르세요.'
      : '화면 보기 모드입니다. 화면을 보내는 서버 PC에서는 아래 localhost 링크로 접속하세요. 스마트폰·노트북에서는 같은 방 코드로 입장해 영상을 볼 수 있습니다.';
  } else browserSupported();
}
updateMediaMode();
$('remote-audio').muted = !soundEnabled;
try { $('display-name').value = localStorage.getItem('fieldlink-name') || ''; } catch { /* Storage may be blocked. */ }
const inviteRoom = new URL(location.href).searchParams.get('room');
if (inviteRoom) { $('room-input').value = inviteRoom.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 10); role = 'expert'; }
function selectRole(value) {
  role = value;
  document.querySelectorAll('[data-role]').forEach(button => {
    const selected = button.dataset.role === role;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', selected);
  });
}
selectRole(role);
document.querySelectorAll('[data-role]').forEach(button => button.addEventListener('click', () => selectRole(button.dataset.role)));
async function enter(type) {
  if (busy) return;
  const name = $('display-name').value.trim();
  if (!name) { $('join-error').textContent = '먼저 내 이름을 입력해 주세요.'; $('join-error').hidden = false; $('display-name').focus(); return; }
  const room = $('room-input').value.toUpperCase().replace(/[\s-]/g, '');
  if (type === 'join' && !/^[A-Z2-9]{10}$/.test(room)) { $('join-error').textContent = '영문·숫자 10자리 방 코드를 입력해 주세요.'; $('join-error').hidden = false; $('room-input').focus(); return; }
  busy = true; $('create-room').disabled = true; $('join-room').disabled = true; $('join-error').hidden = true;
  try {
    try { localStorage.setItem('fieldlink-name', name); } catch { /* Optional preference. */ }
    await session.start(type, { name, role }, room);
  } catch (error) { $('join-error').textContent = error.message; $('join-error').hidden = false; }
  finally { busy = false; $('create-room').disabled = false; $('join-room').disabled = false; }
}
$('create-room').addEventListener('click', () => void enter('create'));
$('join-form').addEventListener('submit', event => { event.preventDefault(); void enter('join'); });
$('display-name').addEventListener('keydown', event => { if (event.key === 'Enter') void enter(inviteRoom ? 'join' : 'create'); });

session.addEventListener('joined', ({ detail }) => {
  if (!inSession) {
    inSession = true; startedAt = Date.now(); annotations.clear(); view = 'remote';
    $('messages').replaceChildren(); unread = 0; updateUnread();
    $('event-log').replaceChildren();
    $('lobby').hidden = true; $('session').hidden = false;
    $('room-code').textContent = detail.room.slice(0, 5) + ' ' + detail.room.slice(5);
    $('room-code').dataset.code = detail.room;
    history.replaceState(null, '', `?room=${detail.room}${receiveOnly ? '&view=1' : ''}`);
    systemMessage('세션이 열렸습니다. 상대방에게 방 코드를 전달해 주세요.');
    window.scrollTo({ top: 0 });
  }
  updateMediaMode();
  setState('waiting'); renderMedia();
});
session.addEventListener('peer', ({ detail }) => {
  $('peer-name').textContent = `${detail.name} · ${detail.role === 'expert' ? '전문가' : '현장'}`;
  $('remote-pointer').querySelector('small').textContent = detail.name;
  annotations.clear();
  systemMessage(`${detail.name} 님이 입장했습니다.`);
});
session.addEventListener('peer-left', ({ detail }) => {
  $('peer-name').textContent = ''; resetStats(); annotations.clear();
  systemMessage(`${detail} 님이 세션을 나갔습니다. 다시 입장할 수 있습니다.`);
  renderMedia();
});
function setState(state) {
  const labels = { waiting: '상대방 대기 중', new: '연결 준비 중', connecting: 'P2P 연결 중', connected: 'P2P 직접 연결', disconnected: '연결 복구 중', failed: '직접 연결 실패', closed: '연결 종료' };
  $('connection-label').textContent = labels[state] || state;
  $('connection-dot').className = 'status-dot ' + (state === 'connected' ? 'connected' : ['connecting', 'disconnected'].includes(state) ? 'connecting' : state === 'failed' ? 'error' : '');
  if (state === 'failed') {
    $('quality-label').textContent = '직접 연결 실패';
    toast('직접 연결할 수 없습니다. 같은 네트워크에서 시험하거나 네트워크·방화벽 설정을 확인해 주세요. 연결 정보에서 다시 시도할 수 있습니다.', true);
  }
  if (['waiting', 'failed', 'disconnected', 'closed'].includes(state)) {
    $('quality-dot').className = 'status-dot ' + (state === 'failed' ? 'error' : '');
    $('quality-label').textContent = labels[state] || state;
  }
}
session.addEventListener('state', ({ detail }) => setState(detail));
session.addEventListener('signal-state', ({ detail }) => {
  $('stat-signal').textContent = detail ? '연결됨 · SDP/ICE 전용' : '연결 끊김 · 복구 중';
  if (!detail && session.connected) $('connection-label').textContent = 'P2P 유지 · 신호 복구 중';
});
session.addEventListener('ice-state', ({ detail }) => { $('stat-ice').textContent = detail; });
session.addEventListener('error', ({ detail }) => toast(detail, true));
session.addEventListener('log', ({ detail }) => {
  const li = document.createElement('li'), time = document.createElement('time'), label = document.createElement('span');
  time.textContent = new Date(detail.at).toLocaleTimeString('ko-KR', { hour12: false }); label.textContent = detail.text;
  li.append(time, label); $('event-log').prepend(li);
  while ($('event-log').children.length > 25) $('event-log').lastChild.remove();
});
session.addEventListener('data-state', ({ detail }) => {
  $('chat-input').disabled = !detail; $('send-chat').disabled = !detail;
  $('chat-input').placeholder = detail ? '메시지를 입력하세요 (Enter 전송)' : '상대방 연결 후 메시지를 입력하세요';
  $('data-status').textContent = detail ? 'P2P 데이터 채널 연결됨' : '데이터 채널 대기 중';
  document.querySelectorAll('[data-message]').forEach(button => { button.disabled = !detail; });
});
document.querySelectorAll('[data-message]').forEach(button => { button.disabled = true; });
session.addEventListener('local-media', renderMedia);
session.addEventListener('remote-media', renderMedia);

function setVideoSource(video, stream, muted) {
  video.muted = muted;
  if (video.srcObject !== stream) video.srcObject = stream;
  if (stream?.getVideoTracks().length) void video.play().catch(() => {});
}
function renderMedia() {
  const local = session.localStatus.video && session.stream.getVideoTracks().some(t => t.readyState === 'live');
  const remote = session.remoteStatus.video && session.remoteStream.getVideoTracks().some(t => t.readyState === 'live');
  const useLocal = view === 'local' ? local || !remote : !remote && local;
  const available = useLocal ? local : remote;
  const status = useLocal ? session.localStatus : session.remoteStatus;
  const stream = useLocal ? session.stream : session.remoteStream;
  // Audio has its own sink: selecting the local preview must not mute the peer.
  mainVideo.muted = true;
  setVideoSource(mainVideo, available ? stream : null, true);
  $('remote-audio').srcObject = session.remoteStream;
  void $('remote-audio').play().catch(() => {});
  const target = available ? `${useLocal ? session.selfId : session.peer?.id}:${status.revision}` : null;
  if (target !== currentTarget) { drawing = null; $('remote-pointer').hidden = true; currentTarget = target; }
  $('video-empty').hidden = !!available;
  canvas.hidden = !available; $('stage-source').hidden = !available; $('stage-hint').hidden = !available;
  $('source-label').textContent = `${useLocal ? '내 화면' : (session.peer?.name || '상대방')} · ${status.source === 'screen' ? '화면 공유' : '카메라'}`;
  $('video-stage').dataset.view = useLocal ? 'local' : 'remote';
  $('preview-toggle').hidden = !(local && remote);
  if (local && remote) {
    setVideoSource(preview, useLocal ? session.remoteStream : session.stream, true);
    $('preview-label').textContent = `${useLocal ? '상대 화면' : '내 화면'} · 클릭하여 전환`;
  } else preview.srcObject = null;
  $('empty-title').textContent = receiveOnly ? '데스크톱 화면을 기다리고 있습니다' : session.peer ? '연결되었습니다. 영상을 공유해 주세요' : '현장 연결을 기다리고 있습니다';
  $('empty-description').textContent = receiveOnly ? '데스크톱에서 화면 공유를 시작하면 여기에 표시됩니다.\n영상이 멈춰 있으면 아래 영상 재생 버튼을 눌러 주세요.' : session.peer ? '카메라 또는 화면 공유를 켜면 영상이 표시됩니다.\n카메라가 없어도 화면 공유로 지원할 수 있습니다.' : '상대방에게 세션 코드를 전달해 주세요.\n카메라나 화면 공유를 시작하면 여기에 표시됩니다.';
  const audio = session.localStatus.audio;
  $('mic-btn').setAttribute('aria-pressed', audio); $('mic-btn').querySelector('strong').textContent = audio ? '마이크 끄기' : '마이크 켜기';
  const camera = local && session.localStatus.source === 'camera', screen = local && session.localStatus.source === 'screen';
  $('camera-btn').setAttribute('aria-pressed', camera); $('camera-btn').querySelector('strong').textContent = camera ? '카메라 끄기' : '카메라 켜기';
  $('screen-btn').setAttribute('aria-pressed', screen); $('screen-btn').querySelector('strong').textContent = screen ? '공유 중지' : '화면 공유';
  $('media-summary').textContent = receiveOnly ? '화면 보기 · 채팅 · 포인터' : [camera ? '카메라 공유 중' : screen ? '화면 공유 중' : '', audio ? '마이크 켜짐' : '마이크 꺼짐'].filter(Boolean).join(' · ');
  $('play-video').disabled = !remote;
  $('play-video').querySelector('strong').textContent = remote ? '영상 재생' : '영상 대기 중';
  $('play-video').title = remote ? '받은 영상 재생' : '상대방이 화면을 공유하면 재생할 수 있습니다.';
  $('listen-btn').disabled = !session.remoteStatus.audio;
  $('listen-btn').setAttribute('aria-pressed', soundEnabled);
  $('listen-btn').querySelector('strong').textContent = soundEnabled ? '소리 끄기' : '소리 켜기';
  $('stat-peer-media').textContent = session.peer ? `${session.remoteStatus.video ? (session.remoteStatus.source === 'screen' ? '화면' : '카메라') : '영상 꺼짐'} · ${session.remoteStatus.audio ? '음성 켜짐' : '음성 꺼짐'}` : '—';
  fitCanvas();
}
mainVideo.addEventListener('loadedmetadata', fitCanvas); mainVideo.addEventListener('resize', fitCanvas);
new ResizeObserver(fitCanvas).observe($('video-stage'));
function fitCanvas() {
  const rect = $('video-stage').getBoundingClientRect();
  const vw = mainVideo.videoWidth || 16, vh = mainVideo.videoHeight || 9;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  fit = { w: vw * scale, h: vh * scale, x: (rect.width - vw * scale) / 2, y: (rect.height - vh * scale) / 2 };
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.style.left = `${fit.x}px`; canvas.style.top = `${fit.y}px`; canvas.style.width = `${fit.w}px`; canvas.style.height = `${fit.h}px`;
  canvas.width = Math.round(fit.w * dpr); canvas.height = Math.round(fit.h * dpr);
  drawAnnotations();
}
$('preview-toggle').addEventListener('click', () => { view = $('video-stage').dataset.view === 'local' ? 'remote' : 'local'; renderMedia(); });
$('switch-to-send').addEventListener('click', () => {
  receiveOnly = false;
  const url = new URL(location.href);
  url.searchParams.delete('view');
  history.replaceState(null, '', url.pathname + url.search);
  updateMediaMode();
  renderMedia();
  void shareScreen();
});
$('play-video').addEventListener('click', () => {
  void mainVideo.play().catch(() => toast('영상을 재생할 수 없습니다. 데스크톱의 공유 상태를 확인해 주세요.', true));
});
$('listen-btn').addEventListener('click', () => {
  const audio = $('remote-audio');
  soundEnabled = !soundEnabled;
  audio.muted = !soundEnabled;
  if (soundEnabled) void audio.play().catch(() => {
    soundEnabled = false; audio.muted = true; renderMedia();
    toast('소리 켜기 버튼을 다시 눌러 주세요.', true);
  });
  renderMedia();
});
async function withMedia(action) {
  if (mediaBusy || !inSession || receiveOnly) return;
  if (!browserSupported()) {
    toast('이 기기에서 카메라·마이크·화면 공유를 시작하려면 신뢰할 수 있는 HTTPS 주소가 필요합니다.', true);
    return;
  }
  mediaBusy = true;
  try { await action(); await enumerateDevices(); }
  catch (error) { mediaError(error); }
  finally { mediaBusy = false; renderMedia(); }
}
function watchTrack(track, kind, source) {
  track.addEventListener('ended', () => {
    if (session.stream.getTracks().includes(track)) {
      void session.setTrack(kind, null).catch(mediaError);
      if (source === 'screen') toast('화면 공유가 종료되었습니다.');
    }
  }, { once: true });
}
async function captureVideo(source, deviceId) {
  const stream = source === 'screen'
    ? await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } }, audio: false })
    : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'environment', ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false });
  const track = stream.getVideoTracks()[0];
  if (!inSession) { stream.getTracks().forEach(t => t.stop()); return; }
  try { await session.setTrack('video', track, source); watchTrack(track, 'video', source); }
  catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
  toast(source === 'screen' ? '선택한 화면을 공유합니다. 소리는 마이크를 켜서 전달하세요.' : '카메라 영상을 공유합니다.');
}
$('camera-btn').addEventListener('click', () => void withMedia(async () => {
  if (session.localStatus.source === 'camera' && session.localStatus.video) await session.setTrack('video', null);
  else await captureVideo('camera', $('camera-select').value);
}));
function shareScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('이 환경에서는 화면 공유를 시작할 수 없습니다. 서버 PC의 Chrome 또는 Edge에서 localhost 주소로 접속해 주세요.', true);
    return;
  }
  return withMedia(async () => {
    if (session.localStatus.source === 'screen' && session.localStatus.video) await session.setTrack('video', null);
    else await captureVideo('screen');
  });
}
$('screen-btn').addEventListener('click', () => void shareScreen()); $('empty-share').addEventListener('click', () => void shareScreen());
async function captureAudio(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
  if (!inSession) { stream.getTracks().forEach(t => t.stop()); return; }
  const track = stream.getAudioTracks()[0];
  try { await session.setTrack('audio', track); watchTrack(track, 'audio'); }
  catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
}
$('mic-btn').addEventListener('click', () => void withMedia(async () => { if (!session.toggleAudio()) await captureAudio($('mic-select').value); }));
async function enumerateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id, kind, label] of [['camera-select', 'videoinput', '카메라'], ['mic-select', 'audioinput', '마이크']]) {
    const select = $(id), selected = select.value;
    select.replaceChildren(new Option(`기본 ${label}`, ''));
    devices.filter(d => d.kind === kind).forEach((device, index) => select.add(new Option(device.label || `${label} ${index + 1}`, device.deviceId)));
    if ([...select.options].some(o => o.value === selected)) select.value = selected;
  }
}
$('devices-btn').addEventListener('click', () => { $('devices-dialog').showModal(); void enumerateDevices().catch(mediaError); });
$('refresh-devices').addEventListener('click', () => void enumerateDevices().catch(mediaError));
$('camera-select').addEventListener('change', () => { if (session.localStatus.source === 'camera') void withMedia(() => captureVideo('camera', $('camera-select').value)); });
$('mic-select').addEventListener('change', () => { if (session.stream.getAudioTracks().length) void withMedia(() => captureAudio($('mic-select').value)); });
navigator.mediaDevices?.addEventListener('devicechange', () => void enumerateDevices().catch(() => {}));

function systemMessage(text) {
  const node = document.createElement('div'); node.className = 'system-message'; node.textContent = text;
  $('messages').append(node); scrollChat();
}
function scrollChat() { $('messages').scrollTop = $('messages').scrollHeight; }
function appendMessage(text, mine) {
  $('chat-empty')?.remove();
  const message = document.createElement('div'), meta = document.createElement('div'), name = document.createElement('strong'), time = document.createElement('time'), bubble = document.createElement('div');
  message.className = 'message' + (mine ? ' mine' : ''); meta.className = 'message-meta'; bubble.className = 'bubble';
  name.textContent = mine ? `${session.metadata.name} (나)` : session.peer?.name || '상대방';
  time.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  bubble.textContent = text; meta.append(name, time); message.append(meta, bubble); $('messages').append(message);
  while ($('messages').children.length > 200) $('messages').firstChild.remove();
  if (!mine && $('chat-panel').hidden) { unread++; updateUnread(); }
  scrollChat();
}
function sendChat(text) {
  text = text.trim().slice(0, 2000);
  if (!text) return;
  if (!session.sendData({ type: 'chat', text })) { toast('데이터 채널이 아직 연결되지 않았습니다.', true); return; }
  appendMessage(text, true); $('chat-input').value = '';
}
$('chat-form').addEventListener('submit', event => { event.preventDefault(); sendChat($('chat-input').value); });
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat($('chat-input').value); } });
document.querySelectorAll('[data-message]').forEach(button => button.addEventListener('click', () => sendChat(button.dataset.message)));
function updateUnread() { $('unread-count').textContent = String(unread); $('unread-count').hidden = !unread; }
function selectTab(id) {
  const chat = id === 'chat-tab';
  $('chat-panel').hidden = !chat; $('stats-panel').hidden = chat;
  $('chat-tab').classList.toggle('selected', chat); $('stats-tab').classList.toggle('selected', !chat);
  $('chat-tab').setAttribute('aria-selected', chat); $('stats-tab').setAttribute('aria-selected', !chat);
  if (chat) { unread = 0; updateUnread(); }
}
for (const id of ['chat-tab', 'stats-tab']) {
  $(id).addEventListener('click', () => selectTab(id));
  $(id).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 'chat-tab' : event.key === 'End' ? 'stats-tab' : id === 'chat-tab' ? 'stats-tab' : 'chat-tab'; selectTab(next); $(next).focus();
    }
  });
}

function validPoint(point) { return Array.isArray(point) && point.length === 2 && point.every(n => Number.isFinite(n) && n >= 0 && n <= 1); }
function allowedTarget(target) {
  if (typeof target !== 'string' || target.length > 70 || !session.peer) return false;
  return target === `${session.selfId}:${session.localStatus.revision}` || target === `${session.peer.id}:${session.remoteStatus.revision}`;
}
function strokesFor(target) {
  if (!annotations.has(target)) {
    if (annotations.size >= 4) annotations.delete(annotations.keys().next().value);
    annotations.set(target, new Map());
  }
  return annotations.get(target);
}
function storeStroke(message) {
  if (!allowedTarget(message.target) || typeof message.id !== 'string' || message.id.length > 80 || !/^#[a-f0-9]{6}$/i.test(message.color) || !Array.isArray(message.points) || message.points.length > 25 || !message.points.every(validPoint)) return;
  const strokes = strokesFor(message.target);
  if (!strokes.has(message.id)) {
    if (strokes.size >= 150) strokes.delete(strokes.keys().next().value);
    strokes.set(message.id, { color: message.color, points: [] });
  }
  const stroke = strokes.get(message.id);
  // A tap ends at its starting point. Keep one point so it renders as a dot.
  for (const point of message.points) {
    if (stroke.points.length >= 1500) break;
    const last = stroke.points[stroke.points.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) stroke.points.push(point);
  }
  drawAnnotations();
}
function drawAnnotations(ctx = context, width = canvas.width, height = canvas.height, target = currentTarget) {
  if (ctx === context) ctx.clearRect(0, 0, width, height);
  const strokes = annotations.get(target);
  if (!strokes) return;
  for (const stroke of strokes.values()) {
    if (!stroke.points.length) continue;
    ctx.beginPath(); ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color; ctx.lineWidth = Math.max(3, width / 350); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (stroke.points.length === 1) { const [x, y] = stroke.points[0]; ctx.arc(x * width, y * height, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
    else { stroke.points.forEach(([x, y], index) => index ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height)); ctx.stroke(); }
  }
}
session.addEventListener('data', ({ detail: message }) => {
  if (message.type === 'chat' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 2000) appendMessage(message.text, false);
  else if (message.type === 'pointer' && message.target === currentTarget && validPoint(message.point)) {
    clearTimeout(pointerTimer);
    $('remote-pointer').style.left = `${fit.x + message.point[0] * fit.w}px`;
    $('remote-pointer').style.top = `${fit.y + message.point[1] * fit.h}px`;
    $('remote-pointer').hidden = false;
    pointerTimer = setTimeout(() => { $('remote-pointer').hidden = true; }, 1700);
  } else if (message.type === 'stroke') storeStroke(message);
  else if (message.type === 'clear' && allowedTarget(message.target)) { annotations.delete(message.target); drawAnnotations(); }
});
document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
  tool = button.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', b === button); });
}));
function pointFor(event) {
  const rect = canvas.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
}
canvas.addEventListener('pointerdown', event => {
  if (!currentTarget || event.button !== 0) return;
  event.preventDefault(); canvas.setPointerCapture(event.pointerId);
  const point = pointFor(event);
  if (tool === 'pen') {
    drawing = { id: createId(), target: currentTarget, color: $('pen-color').value, last: point };
    const message = { type: 'stroke', id: drawing.id, target: drawing.target, color: drawing.color, points: [point] };
    storeStroke(message); session.sendData(message);
  } else { session.sendData({ type: 'pointer', target: currentTarget, point }); lastPointerAt = performance.now(); }
});
canvas.addEventListener('pointermove', event => {
  if (!currentTarget) return;
  const point = pointFor(event), now = performance.now();
  if (now - lastPointerAt < 30) return;
  lastPointerAt = now;
  if (tool === 'pen' && drawing) {
    const message = { type: 'stroke', id: drawing.id, target: drawing.target, color: drawing.color, points: [point] };
    storeStroke(message); session.sendData(message); drawing.last = point;
  } else if (tool === 'pointer') session.sendData({ type: 'pointer', target: currentTarget, point });
});
function finishDrawing(event) {
  if (drawing && event.type === 'pointerup') {
    const message = { type: 'stroke', id: drawing.id, target: drawing.target, color: drawing.color, points: [pointFor(event)] };
    storeStroke(message); session.sendData(message);
  }
  drawing = null;
}
canvas.addEventListener('pointerup', finishDrawing); canvas.addEventListener('pointercancel', finishDrawing); canvas.addEventListener('lostpointercapture', () => { drawing = null; });
$('clear-annotations').addEventListener('click', () => {
  if (!currentTarget) return;
  annotations.delete(currentTarget); drawAnnotations(); session.sendData({ type: 'clear', target: currentTarget });
});
function download(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$('snapshot').addEventListener('click', () => {
  if (!currentTarget || !mainVideo.videoWidth || mainVideo.readyState < 2) { toast('먼저 카메라 또는 화면 공유를 시작해 주세요.'); return; }
  const image = document.createElement('canvas'); image.width = mainVideo.videoWidth; image.height = mainVideo.videoHeight;
  const ctx = image.getContext('2d'); ctx.drawImage(mainVideo, 0, 0); drawAnnotations(ctx, image.width, image.height);
  image.toBlob(blob => { if (blob) download(blob, `FieldLink-capture-${Date.now()}.png`); }, 'image/png');
});
function resetStats() {
  for (const id of ['rtt', 'bitrate', 'fps', 'loss', 'resolution', 'jitter', 'establish', 'peer-media']) $(`stat-${id}`).textContent = '—';
  $('stat-ice').textContent = 'new'; $('path-label').textContent = 'P2P 경로 확인 전';
}
session.addEventListener('stats', ({ detail: stats }) => {
  const format = (value, unit, digits = 0) => Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : '—';
  $('stat-rtt').textContent = format(stats.rtt, 'ms');
  $('stat-bitrate').textContent = stats.bitrate >= 1000 ? format(stats.bitrate / 1000, 'Mbps', 2) : format(stats.bitrate, 'kbps');
  $('stat-bitrate').title = `${stats.direction} 영상 전송률`;
  $('stat-fps').textContent = format(stats.fps, 'fps'); $('stat-loss').textContent = format(stats.loss, '%', 1);
  $('stat-resolution').textContent = stats.width && stats.height ? `${stats.width} × ${stats.height} (${stats.direction})` : '—';
  $('stat-jitter').textContent = format(stats.jitter, 'ms', 1); $('stat-establish').textContent = format(stats.establish / 1000, '초', 2);
  $('stat-ice').textContent = stats.ice;
  $('path-label').textContent = stats.path ? `${stats.relay ? '중계 경로' : '직접 경로'} · ${stats.path}` : 'P2P 연결됨';
  const weak = stats.rtt > 350 || stats.loss > 8, fair = stats.rtt > 180 || stats.loss > 3;
  $('quality-label').textContent = weak ? '연결 품질 낮음' : fair ? '연결 품질 보통' : '연결 상태 양호';
  $('quality-dot').className = `status-dot ${weak ? 'error' : fair ? 'connecting' : 'connected'}`;
});
$('quality-select').addEventListener('change', async () => {
  session.quality = $('quality-select').value;
  try { await session.applyQuality(); toast('영상 전송 품질을 적용했습니다.'); } catch { toast('품질 설정을 적용하지 못했습니다. 연결 후 다시 시도해 주세요.', true); }
});
$('reconnect-btn').addEventListener('click', () => session.reconnect());
$('export-diagnostics').addEventListener('click', () => {
  const data = { app: 'FieldLink', mode: 'P2P/STUN only', exportedAt: new Date().toISOString(), browser: navigator.userAgent, state: session.pc?.connectionState || 'waiting', media: { local: session.localStatus, remote: session.remoteStatus }, events: session.logs, stats: session.statsHistory, note: 'SDP, ICE IP addresses, chat contents and media are excluded.' };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `FieldLink-diagnostics-${Date.now()}.json`);
});
async function copy(text, success) {
  try { await navigator.clipboard.writeText(text); toast(success); }
  catch { toast(`복사할 내용: ${text}`, true); }
}
$('copy-code').addEventListener('click', () => void copy(session.room, '방 코드를 복사했습니다.'));
$('copy-link').addEventListener('click', () => void copy(`${location.origin}/?room=${session.room}${receiveOnly ? '&view=1' : ''}`, '초대 링크를 복사했습니다. 다른 기기에서는 localhost 대신 서버 PC의 내부 IP를 사용하세요.'));
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('video-stage').requestFullscreen(); }
  catch { toast('이 환경에서는 전체 화면으로 전환할 수 없습니다.', true); }
});
$('help-btn').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
$('leave-btn').addEventListener('click', () => {
  session.leave(); inSession = false; startedAt = null; view = 'remote'; annotations.clear(); currentTarget = null;
  $('session').hidden = true; $('lobby').hidden = false; history.replaceState(null, '', receiveOnly ? '/?view=1' : '/');
  mainVideo.srcObject = null; preview.srcObject = null; $('remote-audio').srcObject = null;
  resetStats(); $('peer-name').textContent = ''; toast('지원 세션을 종료했습니다.');
});
setInterval(() => {
  if (!startedAt) return;
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  $('timer').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}, 1000);
window.addEventListener('pagehide', () => session.leave());
