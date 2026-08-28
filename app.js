// Harmony - cliente WebRTC (mesh) + chat
"use strict";

// ==== Servidores ICE (STUN + TURN de reserva) ====
// TURN e necessario para redes com NAT restrito. O openrelay e gratuito e
// serve pra testes; para uso serio troque por um TURN seu (veja README).
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// ==== Estado global ====
let ws;
let me = null; // {id, name, roleId, ...}
let serverState = { textChannels: [], voiceChannels: [], roles: [], serverName: "" };
let presence = []; // lista publica de usuarios
let activeText = "geral";
let inVoice = null; // id do canal de voz atual

// Midia local
let localMic = null; // MediaStream (audio)
let localCam = null; // MediaStream (video webcam)
let localScreen = null; // MediaStream (video/audio da tela)
let micEnabled = true;
let deafened = false;

// Conexoes por peer: id -> { pc, makingOffer, ignoreOffer, polite }
const peers = new Map();
// Mapeamento de streamId -> {userId, kind: 'cam'|'screen'} (para rotular remotos)
const pubMap = new Map();
const pendingTracks = new Map(); // streamId -> [tracks] aguardando meta

// Config A/V
const cfg = {
  micId: "",
  camId: "",
  noise: true,
  echo: true,
  res: 1080,
  fps: 60,
  bitrate: 10,
  shareAudio: true,
};

// ==== Atalhos DOM ====
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

// ==== Conexao WebSocket ====
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const name = me._pendingName;
    ws.send(JSON.stringify({ type: "join", name }));
  };
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    if (me && me.id) {
      systemLine("Conexão perdida. Recarregue a página.");
    }
  };
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ==== Roteamento de mensagens do servidor ====
function handleMessage(msg) {
  switch (msg.type) {
    case "welcome":
      me = { ...me, ...msg.you };
      $("#login").classList.add("hidden");
      $("#app").classList.remove("hidden");
      updateMeBar();
      break;
    case "state":
      serverState = msg;
      renderChannels();
      $("#serverName").textContent = msg.serverName;
      $("#srvNameInput").value = msg.serverName;
      applyAdminVisibility();
      break;
    case "history":
      renderHistory(msg.channel, msg.messages);
      break;
    case "chat":
      appendMessage(msg.channel, msg.message);
      break;
    case "system":
      if (!msg.channel || msg.channel === activeText) systemLine(msg.text);
      break;
    case "presence":
      presence = msg.users;
      if (me) {
        const meNow = presence.find((u) => u.id === me.id);
        if (meNow) {
          me.roleId = meNow.roleId;
          updateMeBar();
        }
      }
      renderMembers();
      renderVoiceMembers();
      break;
    case "voice-peers":
      // eu sou o novato: inicio conexao com quem ja esta na sala
      for (const pid of msg.peers) getPeer(pid, true);
      break;
    case "voice-left":
      if (msg.userId !== me.id) closePeer(msg.userId);
      break;
    case "peer-gone":
      closePeer(msg.userId);
      break;
    case "signal":
      handleSignal(msg.from, msg.data);
      break;
    case "kicked":
      alert("Você foi removido do servidor por um administrador.");
      location.reload();
      break;
    case "state-changed":
      break;
  }
}

// ==== WebRTC: perfect negotiation ====
function getPeer(peerId, initiator) {
  let p = peers.get(peerId);
  if (p) return p;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  p = { pc, makingOffer: false, ignoreOffer: false, polite: me.id > peerId };
  peers.set(peerId, p);

  // adiciona minhas trilhas atuais
  addLocalTracksTo(p);

  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      sendWS({ type: "signal", to: peerId, data: { description: pc.localDescription } });
    } catch (e) {
      console.error("negotiation", e);
    } finally {
      p.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendWS({ type: "signal", to: peerId, data: { candidate } });
  };

  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    if (ev.track.kind === "audio") {
      attachRemoteAudio(peerId, stream, ev.track);
      return;
    }
    // video: descobrir se e cam ou screen via pubMap
    const info = pubMap.get(stream.id);
    if (info) {
      addVideoTile(peerId, stream, info.kind);
    } else {
      const arr = pendingTracks.get(stream.id) || [];
      arr.push({ peerId, stream });
      pendingTracks.set(stream.id, arr);
    }
    ev.track.onended = () => removeVideoTile(stream.id);
    stream.onremovetrack = () => removeVideoTile(stream.id);
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      // deixa o servidor cuidar de saidas; nao fecha em 'disconnected' transitorio
    }
  };

  // manda meu estado de publicacoes assim que possivel
  announcePubsTo(peerId);
  return p;
}

async function handleSignal(peerId, data) {
  // meta de publicacoes (cam/screen)
  if (data.pubs) {
    for (const [sid, info] of Object.entries(data.pubs)) {
      pubMap.set(sid, info);
      // resolve trilhas que chegaram antes da meta
      const pend = pendingTracks.get(sid);
      if (pend) {
        for (const { peerId: pid, stream } of pend) addVideoTile(pid, stream, info.kind);
        pendingTracks.delete(sid);
      }
    }
    return;
  }
  if (data.unpub) {
    pubMap.delete(data.unpub);
    removeVideoTile(data.unpub);
    return;
  }

  const p = getPeer(peerId, false);
  const pc = p.pc;
  try {
    if (data.description) {
      const offerCollision =
        data.description.type === "offer" &&
        (p.makingOffer || pc.signalingState !== "stable");
      p.ignoreOffer = !p.polite && offerCollision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        sendWS({ type: "signal", to: peerId, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (e) {
        if (!p.ignoreOffer) throw e;
      }
    }
  } catch (e) {
    console.error("signal error", e);
  }
}

function addLocalTracksTo(p) {
  const streams = [
    [localMic, "mic"],
    [localCam, "cam"],
    [localScreen, "screen"],
  ];
  for (const [s] of streams) {
    if (!s) continue;
    for (const track of s.getTracks()) {
      const already = p.pc.getSenders().some((snd) => snd.track === track);
      if (!already) {
        const sender = p.pc.addTrack(track, s);
        if (track.kind === "video") tuneVideoSender(sender);
      }
    }
  }
}

function addTrackToAllPeers() {
  for (const p of peers.values()) addLocalTracksTo(p);
}

// Configura bitrate alto e prioriza qualidade
async function tuneVideoSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = cfg.bitrate * 1_000_000;
    params.encodings[0].maxFramerate = cfg.fps;
    params.degradationPreference = "maintain-framerate";
    await sender.setParameters(params);
  } catch (e) {
    /* alguns navegadores nao suportam antes de negociar */
  }
}

function closePeer(peerId) {
  const p = peers.get(peerId);
  if (p) {
    try { p.pc.close(); } catch {}
    peers.delete(peerId);
  }
  // remove audios/tiles do peer
  document.querySelectorAll(`[data-peer="${peerId}"]`).forEach((n) => n.remove());
}

// ==== Publicacoes (rotular cam vs screen no remoto) ====
function myPubs() {
  const out = {};
  if (localCam) out[localCam.id] = { userId: me.id, kind: "cam" };
  if (localScreen) out[localScreen.id] = { userId: me.id, kind: "screen" };
  return out;
}
function announcePubsTo(peerId) {
  sendWS({ type: "signal", to: peerId, data: { pubs: myPubs() } });
}
function announcePubsAll() {
  for (const pid of peers.keys()) announcePubsTo(pid);
}

// ==== Audio remoto ====
function attachRemoteAudio(peerId, stream, track) {
  let audio = document.querySelector(`audio[data-peer="${peerId}"][data-stream="${stream.id}"]`);
  if (!audio) {
    audio = el("audio");
    audio.autoplay = true;
    audio.dataset.peer = peerId;
    audio.dataset.stream = stream.id;
    document.body.appendChild(audio);
  }
  audio.srcObject = stream;
  audio.muted = deafened;
}

// ==== Tiles de video ====
function addVideoTile(peerId, stream, kind) {
  const id = stream.id;
  if (document.getElementById("tile-" + id)) return;
  const stage = $("#stage");
  stage.classList.remove("hidden");
  const tile = el("div", "tile");
  tile.id = "tile-" + id;
  tile.dataset.peer = peerId;
  const video = el("video");
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  if (peerId === me.id) video.muted = true;
  const who = presence.find((u) => u.id === peerId);
  const label = el("div", "label", (who ? who.name : "?") + (kind === "screen" ? " • tela" : " • câmera"));
  tile.append(video, label);
  stage.appendChild(tile);
}

function removeVideoTile(streamId) {
  const t = document.getElementById("tile-" + streamId);
  if (t) t.remove();
  if (!$("#stage").children.length) $("#stage").classList.add("hidden");
}

// ==== Voz: entrar / sair ====
async function joinVoice(channelId) {
  if (inVoice === channelId) return;
  if (inVoice) leaveVoice(false);
  try {
    localMic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: cfg.micId ? { exact: cfg.micId } : undefined,
        noiseSuppression: cfg.noise,
        echoCancellation: cfg.echo,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (e) {
    alert("Não consegui acessar o microfone: " + e.message);
    return;
  }
  micEnabled = true;
  localMic.getAudioTracks().forEach((t) => (t.enabled = true));
  inVoice = channelId;
  sendWS({ type: "voice-join", channel: channelId });
  showVoiceBar();
  updateMeBar();
  renderVoiceMembers();
}

function leaveVoice(notify = true) {
  if (!inVoice) return;
  stopScreen(true);
  stopCam(true);
  if (localMic) {
    localMic.getTracks().forEach((t) => t.stop());
    localMic = null;
  }
  for (const pid of [...peers.keys()]) closePeer(pid);
  document.querySelectorAll("audio[data-peer]").forEach((a) => a.remove());
  $("#stage").innerHTML = "";
  $("#stage").classList.add("hidden");
  const old = inVoice;
  inVoice = null;
  if (notify) sendWS({ type: "voice-leave", channel: old });
  hideVoiceBar();
  updateMeBar();
  renderVoiceMembers();
}

// ==== Compartilhar tela ====
async function startScreen() {
  try {
    localScreen = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: cfg.res === 1440 ? 2560 : cfg.res === 720 ? 1280 : 1920 },
        height: { ideal: cfg.res === 1440 ? 1440 : cfg.res === 720 ? 720 : 1080 },
        frameRate: { ideal: cfg.fps, max: cfg.fps },
      },
      audio: cfg.shareAudio,
    });
  } catch (e) {
    return; // usuario cancelou
  }
  const vt = localScreen.getVideoTracks()[0];
  if (vt) vt.contentHint = "motion"; // prioriza fluidez (jogos/video)
  vt.onended = () => stopScreen(true);

  addTrackToAllPeers();
  announcePubsAll();
  addVideoTile(me.id, localScreen, "screen");
  sendWS({ type: "voice-state", sharing: true });
  $("#shareBtn").classList.add("active");
  // ajusta bitrate dos senders de tela
  for (const p of peers.values())
    for (const s of p.pc.getSenders())
      if (s.track && localScreen.getTracks().includes(s.track)) tuneVideoSender(s);
}

function stopScreen(silent) {
  if (!localScreen) return;
  const sid = localScreen.id;
  for (const p of peers.values()) {
    for (const s of p.pc.getSenders()) {
      if (s.track && localScreen.getTracks().includes(s.track)) {
        try { p.pc.removeTrack(s); } catch {}
      }
    }
  }
  localScreen.getTracks().forEach((t) => t.stop());
  localScreen = null;
  removeVideoTile(sid);
  if (!silent) announceUnpub(sid);
  else announceUnpub(sid);
  sendWS({ type: "voice-state", sharing: false });
  $("#shareBtn").classList.remove("active");
}

// ==== Camera ====
async function startCam() {
  try {
    localCam = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: cfg.camId ? { exact: cfg.camId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (e) {
    alert("Não consegui acessar a câmera: " + e.message);
    return;
  }
  addTrackToAllPeers();
  announcePubsAll();
  addVideoTile(me.id, localCam, "cam");
  sendWS({ type: "voice-state", camOn: true });
  $("#camBtn").classList.add("active");
}

function stopCam(silent) {
  if (!localCam) return;
  const sid = localCam.id;
  for (const p of peers.values()) {
    for (const s of p.pc.getSenders()) {
      if (s.track && localCam.getTracks().includes(s.track)) {
        try { p.pc.removeTrack(s); } catch {}
      }
    }
  }
  localCam.getTracks().forEach((t) => t.stop());
  localCam = null;
  removeVideoTile(sid);
  announceUnpub(sid);
  sendWS({ type: "voice-state", camOn: false });
  $("#camBtn").classList.remove("active");
}

function announceUnpub(streamId) {
  for (const pid of peers.keys())
    sendWS({ type: "signal", to: pid, data: { unpub: streamId } });
}

// ==== Controles: mic / deafen ====
function toggleMic() {
  micEnabled = !micEnabled;
  if (localMic) localMic.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  sendWS({ type: "voice-state", muted: !micEnabled });
  $("#micBtn").classList.toggle("off", !micEnabled);
}
function toggleDeafen() {
  deafened = !deafened;
  document.querySelectorAll("audio[data-peer]").forEach((a) => (a.muted = deafened));
  if (deafened && micEnabled) toggleMic();
  sendWS({ type: "voice-state", deafened });
  $("#deafBtn").classList.toggle("off", deafened);
}

// ==== Render: canais ====
function renderChannels() {
  const tc = $("#textChannels");
  tc.innerHTML = "";
  for (const ch of serverState.textChannels) {
    const li = el("li");
    li.dataset.id = ch.id;
    if (ch.id === activeText) li.classList.add("active");
    const hash = el("span", "hash", "#");
    li.append(hash, document.createTextNode(ch.name));
    if (isAdmin()) {
      const del = el("span", "del", "✕");
      del.title = "Excluir canal";
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Excluir #${ch.name}?`))
          sendWS({ type: "admin", action: "del-text-channel", id: ch.id });
      };
      li.append(del);
    }
    li.onclick = () => selectText(ch.id);
    tc.appendChild(li);
  }

  const vc = $("#voiceChannels");
  vc.innerHTML = "";
  for (const ch of serverState.voiceChannels) {
    const li = el("li");
    li.dataset.id = ch.id;
    const ic = el("span", "hash", "🔊");
    li.append(ic, document.createTextNode(ch.name));
    if (isAdmin()) {
      const del = el("span", "del", "✕");
      del.onclick = (e) => {
        e.stopPropagation();
        sendWS({ type: "admin", action: "del-voice-channel", id: ch.id });
      };
      li.append(del);
    }
    li.onclick = () => joinVoice(ch.id);
    const members = el("div", "voice-members");
    members.dataset.for = ch.id;
    li.append(members);
    vc.appendChild(li);
  }
  renderVoiceMembers();
  applyAdminVisibility();
}

function renderVoiceMembers() {
  document.querySelectorAll(".voice-members").forEach((box) => {
    const chId = box.dataset.for;
    box.innerHTML = "";
    for (const u of presence.filter((x) => x.voiceChannel === chId)) {
      const vm = el("div", "vm");
      const nm = el("span", null, u.name);
      const badges = el("span", "badge", (u.muted ? "🔇" : "") + (u.sharing ? "🖥️" : "") + (u.camOn ? "📷" : ""));
      vm.append(nm, badges);
      box.appendChild(vm);
    }
  });
}

function selectText(id) {
  activeText = id;
  document.querySelectorAll("#textChannels li").forEach((li) =>
    li.classList.toggle("active", li.dataset.id === id)
  );
  const ch = serverState.textChannels.find((c) => c.id === id);
  $("#channelTitle").textContent = "# " + (ch ? ch.name : id);
  $("#msgInput").placeholder = "Conversar em #" + (ch ? ch.name : id);
  const box = $("#messages");
  box.innerHTML = "";
  const cached = msgCache[id] || [];
  for (const m of cached) appendMessage(id, m, true);
  scrollMessages();
}

// ==== Render: mensagens ====
const msgCache = {}; // channelId -> [messages]
function renderHistory(channel, messages) {
  msgCache[channel] = messages;
  if (channel === activeText) selectText(channel);
}
function appendMessage(channel, m, skipCache) {
  if (!skipCache) (msgCache[channel] ||= []).push(m);
  if (channel !== activeText) return;
  const box = $("#messages");
  const row = el("div", "msg");
  const av = el("div", "m-avatar", (m.name || "?")[0].toUpperCase());
  av.style.background = m.color || "#5865f2";
  const body = el("div", "m-body");
  const head = el("div", "m-head");
  const nm = el("span", "m-name", m.name);
  nm.style.color = m.color || "#fff";
  const tm = el("span", "m-time", new Date(m.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
  head.append(nm, tm);
  const txt = el("div", "m-text", m.text);
  body.append(head, txt);
  row.append(av, body);
  box.appendChild(row);
  scrollMessages();
}
function systemLine(text) {
  const box = $("#messages");
  const row = el("div", "msg system", text);
  box.appendChild(row);
  scrollMessages();
}
function scrollMessages() {
  const box = $("#messages");
  box.scrollTop = box.scrollHeight;
}

// ==== Render: membros ====
function renderMembers() {
  const list = $("#memberList");
  list.innerHTML = "";
  $("#memberCount").textContent = presence.length;
  const roleOf = (id) => serverState.roles.find((r) => r.id === id);
  const sorted = [...presence].sort(
    (a, b) => (roleOf(b.roleId)?.rank || 0) - (roleOf(a.roleId)?.rank || 0)
  );
  for (const u of sorted) {
    const li = el("li");
    li.dataset.id = u.id;
    const dot = el("span", "m-dot");
    const r = roleOf(u.roleId);
    const nm = el("span", "m-nm", u.name);
    if (r) nm.style.color = r.color;
    const badges = el("span", "m-badges", (u.voiceChannel ? "🔊" : "") + (u.sharing ? "🖥️" : ""));
    li.append(dot, nm, badges);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      openCtxMenu(e, u);
    };
    list.appendChild(li);
  }
}

// ==== Menu de contexto (admin) ====
function openCtxMenu(e, u) {
  const menu = $("#ctxMenu");
  menu.innerHTML = "";
  const title = el("div", "ctx-title", u.name);
  menu.appendChild(title);
  if (isAdmin() && u.id !== me.id) {
    for (const r of serverState.roles) {
      const b = el("button", null, "Cargo: " + r.name);
      b.onclick = () => {
        sendWS({ type: "admin", action: "set-role", userId: u.id, roleId: r.id });
        closeCtx();
      };
      menu.appendChild(b);
    }
    menu.appendChild(el("hr"));
    const kick = el("button", "danger", "Expulsar");
    kick.onclick = () => {
      sendWS({ type: "admin", action: "kick", userId: u.id });
      closeCtx();
    };
    menu.appendChild(kick);
  } else {
    menu.appendChild(el("div", "ctx-title", "Sem ações disponíveis"));
  }
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + "px";
  menu.classList.remove("hidden");
}
function closeCtx() { $("#ctxMenu").classList.add("hidden"); }
document.addEventListener("click", closeCtx);

// ==== Helpers de papel/admin ====
function isAdmin() {
  const r = serverState.roles.find((x) => x.id === me?.roleId);
  return r ? r.rank >= 80 : false;
}
function applyAdminVisibility() {
  document.querySelectorAll(".admin-only").forEach((n) =>
    n.classList.toggle("hidden-role", !isAdmin())
  );
}
function updateMeBar() {
  if (!me) return;
  $("#meName").textContent = me.name;
  const r = serverState.roles.find((x) => x.id === me.roleId);
  $("#meRole").textContent = r ? r.name : "";
  $("#meRole").style.color = r ? r.color : "";
  const av = $("#meAvatar");
  av.textContent = (me.name || "?")[0].toUpperCase();
  if (r) av.style.background = r.color;
}

// ==== Voice bar ====
function showVoiceBar() {
  const ch = serverState.voiceChannels.find((c) => c.id === inVoice);
  $("#voiceBarName").textContent = "🔊 " + (ch ? ch.name : "");
  $("#voiceBar").classList.remove("hidden");
}
function hideVoiceBar() {
  $("#voiceBar").classList.add("hidden");
  $("#shareBtn").classList.remove("active");
  $("#camBtn").classList.remove("active");
}

// ==== Dispositivos (config A/V) ====
async function loadDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const micSel = $("#micSelect");
    const camSel = $("#camSelect");
    micSel.innerHTML = "";
    camSel.innerHTML = "";
    devices.filter((d) => d.kind === "audioinput").forEach((d) => {
      const o = el("option", null, d.label || "Microfone");
      o.value = d.deviceId;
      micSel.appendChild(o);
    });
    devices.filter((d) => d.kind === "videoinput").forEach((d) => {
      const o = el("option", null, d.label || "Câmera");
      o.value = d.deviceId;
      camSel.appendChild(o);
    });
  } catch {}
}

// ==== Wiring da UI ====
function initUI() {
  // login
  $("#joinBtn").onclick = doJoin;
  $("#nickInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doJoin();
  });

  // composer
  const sendCurrent = () => {
    const input = $("#msgInput");
    const text = input.value.trim();
    if (!text) return;
    sendWS({ type: "chat", channel: activeText, text });
    input.value = "";
  };
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendCurrent();
  });
  // Enter envia (Shift+Enter reservado para futuras quebras de linha)
  $("#msgInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });

  // controles de voz
  $("#micBtn").onclick = toggleMic;
  $("#deafBtn").onclick = toggleDeafen;
  $("#shareBtn").onclick = () => (localScreen ? stopScreen(false) : startScreen());
  $("#camBtn").onclick = () => (localCam ? stopCam(false) : startCam());
  $("#leaveVoiceBtn").onclick = () => leaveVoice(true);

  // adicionar canais (admin)
  document.querySelectorAll(".add-ch").forEach((btn) => {
    btn.onclick = () => {
      const kind = btn.dataset.kind;
      const name = prompt(kind === "text" ? "Nome do canal de texto:" : "Nome do canal de voz:");
      if (name && name.trim())
        sendWS({
          type: "admin",
          action: kind === "text" ? "add-text-channel" : "add-voice-channel",
          name: name.trim(),
        });
    };
  });

  // modal A/V
  $("#settingsBtn").onclick = async () => {
    await loadDevices();
    $("#avModal").classList.remove("hidden");
  };
  $("#avCloseBtn").onclick = () => $("#avModal").classList.add("hidden");
  $("#micSelect").onchange = (e) => (cfg.micId = e.target.value);
  $("#camSelect").onchange = (e) => (cfg.camId = e.target.value);
  $("#noiseChk").onchange = (e) => (cfg.noise = e.target.checked);
  $("#echoChk").onchange = (e) => (cfg.echo = e.target.checked);
  $("#resSelect").onchange = (e) => (cfg.res = +e.target.value);
  $("#fpsSelect").onchange = (e) => (cfg.fps = +e.target.value);
  $("#shareAudioChk").onchange = (e) => (cfg.shareAudio = e.target.checked);
  $("#brRange").oninput = (e) => {
    cfg.bitrate = +e.target.value;
    $("#brLabel").textContent = e.target.value;
    for (const p of peers.values())
      for (const s of p.pc.getSenders())
        if (s.track && s.track.kind === "video") tuneVideoSender(s);
  };

  // modal servidor
  $("#serverSettingsBtn").onclick = () => $("#srvModal").classList.remove("hidden");
  $("#srvCloseBtn").onclick = () => $("#srvModal").classList.add("hidden");
  $("#srvRenameBtn").onclick = () => {
    const nm = $("#srvNameInput").value.trim();
    if (nm) sendWS({ type: "admin", action: "rename-server", name: nm });
  };
}

function doJoin() {
  const name = $("#nickInput").value.trim();
  if (!name) {
    $("#nickInput").focus();
    return;
  }
  me = { _pendingName: name };
  connect();
}

// start
initUI();
