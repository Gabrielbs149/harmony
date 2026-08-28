// Feap Avaré - cliente v2 (login + layout Discord + WebRTC mesh)
"use strict";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
];

const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const initial = (s) => (s || "?")[0].toUpperCase();

// Estado
let ws, me = null, token = null;
let serverState = { serverName: "", categories: [], channels: [], roles: [] };
let presence = [];
let activeChannel = null;
let inVoice = null;
const msgCache = {};
const collapsed = new Set(JSON.parse(localStorage.getItem("feap_collapsed") || "[]"));

// Midia
let localMic = null, localCam = null, localScreen = null;
let micEnabled = true, deafened = false;
const peers = new Map();
const pubMap = new Map();
const pendingTracks = new Map();
const cfg = { micId: "", camId: "", noise: true, echo: true, res: 1080, fps: 60, bitrate: 10, shareAudio: true };

// ==================== AUTH ====================
let authMode = "login";
function initAuth() {
  const savedTok = localStorage.getItem("feap_token");
  if (savedTok) {
    fetch("/api/me", { headers: { Authorization: "Bearer " + savedTok } })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { token = savedTok; me = d.user; startApp(); })
      .catch(() => localStorage.removeItem("feap_token"));
  }
  $("#authSwitch").onclick = (e) => { e.preventDefault(); toggleAuthMode(); };
  $("#authBtn").onclick = doAuth;
  $("#updateBtn").onclick = () => location.reload();
  $("#updateLater").onclick = () => $("#updateBar").classList.add("hidden");
  checkVersion(); // registra a versão atual já na tela de login
  setInterval(checkVersion, 60000); // checa a cada 1 min (login ou dentro do app)
  $("#authPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); });
  $("#authUser").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#authPass").focus(); });
}
function toggleAuthMode() {
  authMode = authMode === "login" ? "register" : "login";
  const reg = authMode === "register";
  $("#authSub").textContent = reg ? "Crie sua conta no Feap Avaré" : "Que bom te ver de novo!";
  $("#authBtn").textContent = reg ? "Registrar" : "Entrar";
  $("#authSwitchText").textContent = reg ? "Já tem conta?" : "Precisa de uma conta?";
  $("#authSwitch").textContent = reg ? "Entrar" : "Registrar";
  $("#authPass").autocomplete = reg ? "new-password" : "current-password";
  $("#authError").classList.add("hidden");
}
async function doAuth() {
  const username = $("#authUser").value.trim();
  const password = $("#authPass").value;
  if (!username || !password) return;
  const errBox = $("#authError");
  errBox.classList.add("hidden");
  try {
    const r = await fetch("/api/" + authMode, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (!r.ok) { errBox.textContent = d.error || "Erro"; errBox.classList.remove("hidden"); return; }
    token = d.token; me = d.user;
    localStorage.setItem("feap_token", token);
    startApp();
  } catch { errBox.textContent = "Falha de conexão"; errBox.classList.remove("hidden"); }
}
function logout() {
  localStorage.removeItem("feap_token");
  if (ws) ws.close();
  location.reload();
}

// ==================== ATUALIZAÇÃO AUTOMÁTICA ====================
let myVersion = null;
async function checkVersion() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    const { version } = await r.json();
    if (myVersion === null) myVersion = version;
    else if (version && version !== myVersion) showUpdateBar();
  } catch {}
}
function showUpdateBar() { $("#updateBar").classList.remove("hidden"); }

// ==================== WEBSOCKET ====================
function startApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  updateUserbar();
  connect();
}
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => sendWS({ type: "auth", token });
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => { if (me) systemLine("Conexão perdida. Recarregue a página."); };
}
function sendWS(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function handle(msg) {
  switch (msg.type) {
    case "auth-fail": localStorage.removeItem("feap_token"); location.reload(); break;
    case "welcome": me = { ...me, ...msg.you }; updateUserbar(); break;
    case "state":
      serverState = msg;
      $("#serverName").textContent = msg.serverName;
      $("#srvNameInput").value = msg.serverName;
      renderChannels(); applyAdmin();
      if (!activeChannel || !msg.channels.find((c) => c.id === activeChannel && c.type === "text"))
        selectChannel((msg.channels.find((c) => c.type === "text") || {}).id);
      break;
    case "history": msgCache[msg.channel] = msg.messages; if (msg.channel === activeChannel) renderMessages(); break;
    case "chat": (msgCache[msg.channel] ||= []).push(msg.message); if (msg.channel === activeChannel) appendMessage(msg.message); break;
    case "presence":
      presence = msg.users;
      const meNow = presence.find((u) => u.username === me.username);
      if (meNow) { me.roleId = meNow.roleId; updateUserbar(); }
      renderMembers(); renderChannels();
      break;
    case "accounts": renderAccounts(msg.list); break;
    case "voice-peers": for (const p of msg.peers) getPeer(p); break;
    case "voice-left": if (msg.userId !== me.username) closePeer(msg.userId); break;
    case "peer-gone": closePeer(msg.userId); break;
    case "signal": handleSignal(msg.from, msg.data); break;
    case "kicked": alert("Você foi removido do servidor por um administrador."); logout(); break;
  }
}

// ==================== RENDER: CANAIS ====================
function selectChannel(id) {
  if (!id) return;
  activeChannel = id;
  const ch = serverState.channels.find((c) => c.id === id);
  $("#mhIcon").textContent = "#";
  $("#channelTitle").textContent = ch ? ch.name : id;
  $("#msgInput").placeholder = "Conversar em #" + (ch ? ch.name : id);
  document.querySelectorAll(".chan").forEach((c) => c.classList.toggle("active", c.dataset.id === id));
  renderMessages();
}
function renderChannels() {
  const box = $("#channels");
  box.innerHTML = "";
  for (const cat of serverState.categories) {
    const chans = serverState.channels.filter((c) => c.categoryId === cat.id);
    const wrap = el("div", "cat");
    const head = el("div", "cat-head" + (collapsed.has(cat.id) ? " collapsed" : ""));
    head.append(el("span", "arrow", "⌄"), el("span", "cat-name", cat.name));
    if (isAdmin()) {
      const add = el("span", "cat-add", "＋");
      add.title = "Novo canal aqui";
      add.onclick = (e) => { e.stopPropagation(); quickAddChannel(cat.id); };
      head.append(add);
    }
    head.onclick = () => {
      if (collapsed.has(cat.id)) collapsed.delete(cat.id); else collapsed.add(cat.id);
      localStorage.setItem("feap_collapsed", JSON.stringify([...collapsed]));
      renderChannels();
    };
    wrap.append(head);
    if (!collapsed.has(cat.id)) {
      for (const ch of chans) wrap.append(renderChannel(ch));
    }
    box.append(wrap);
  }
}
function renderChannel(ch) {
  const row = el("div", "chan" + (ch.id === activeChannel ? " active" : ""));
  row.dataset.id = ch.id;
  row.append(el("span", "ic", ch.type === "voice" ? "🔊" : "#"), el("span", "nm", ch.name));
  if (isAdmin()) {
    const del = el("span", "del", "✕");
    del.title = "Excluir";
    del.onclick = (e) => { e.stopPropagation(); if (confirm("Excluir canal " + ch.name + "?")) sendWS({ type: "admin", action: "del-channel", id: ch.id }); };
    row.append(del);
  }
  row.onclick = () => (ch.type === "voice" ? joinVoice(ch.id) : selectChannel(ch.id));
  if (ch.type === "voice") {
    row.classList.add("voice-chan");
    const users = presence.filter((p) => p.voiceChannel === ch.id);
    if (users.length) {
      const vu = el("div", "voice-users");
      for (const u of users) {
        const line = el("div", "vu");
        line.append(el("span", null, "🔊"), el("span", null, u.username),
          el("span", null, (u.muted ? " 🔇" : "") + (u.sharing ? " 🖥️" : "") + (u.camOn ? " 📷" : "")));
        vu.append(line);
      }
      row.append(vu);
    }
  }
  return row;
}
function quickAddChannel(categoryId) {
  const name = prompt("Nome do novo canal:");
  if (!name || !name.trim()) return;
  const voice = confirm("É um canal de VOZ?\n\nOK = Voz | Cancelar = Texto");
  sendWS({ type: "admin", action: "add-channel", name: name.trim(), channelType: voice ? "voice" : "text", categoryId });
}

// ==================== RENDER: MENSAGENS ====================
function renderMessages() { const box = $("#messages"); box.innerHTML = ""; for (const m of msgCache[activeChannel] || []) appendMessage(m, true); scrollMsg(); }
function appendMessage(m, noScroll) {
  const box = $("#messages");
  const row = el("div", "msg");
  const av = el("div", "m-av", initial(m.name)); av.style.background = m.color || "#5865f2";
  const body = el("div", "m-body");
  const head = el("div", "m-head");
  const nm = el("span", "m-name", m.name); nm.style.color = m.color || "#fff";
  head.append(nm, el("span", "m-time", new Date(m.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })));
  body.append(head, el("div", "m-text", m.text));
  row.append(av, body); box.append(row);
  if (!noScroll) scrollMsg();
}
function systemLine(t) { const b = $("#messages"); b.append(el("div", "msg system", t)); scrollMsg(); }
function scrollMsg() { const b = $("#messages"); b.scrollTop = b.scrollHeight; }

// ==================== RENDER: MEMBROS POR CARGO ====================
function renderMembers() {
  const list = $("#memberList"); list.innerHTML = "";
  const roles = [...serverState.roles].sort((a, b) => b.rank - a.rank);
  const shown = new Set();
  for (const role of roles) {
    const members = presence.filter((u) => u.roleId === role.id);
    if (!members.length) continue;
    list.append(roleHeader(role.name + " — " + members.length));
    for (const u of members) { list.append(memberRow(u, role)); shown.add(u.username); }
  }
  // qualquer online sem cargo listado (fallback)
  const rest = presence.filter((u) => !shown.has(u.username));
  if (rest.length) { list.append(roleHeader("Online — " + rest.length)); for (const u of rest) list.append(memberRow(u, null)); }
}
function roleHeader(t) { return el("li", "role-group-head", t); }
function memberRow(u, role) {
  const li = el("li", "member");
  li.dataset.id = u.username;
  const av = el("div", "m-av2", initial(u.username));
  if (role) av.style.background = role.color;
  av.append(el("span", "dot"));
  const nm = el("span", "m-nm2", u.username); if (role) nm.style.color = role.color;
  const badges = el("span", "m-badges", (u.voiceChannel ? "🔊" : "") + (u.sharing ? "🖥️" : ""));
  li.append(av, nm, badges);
  li.oncontextmenu = (e) => { e.preventDefault(); openCtx(e, u); };
  return li;
}

// ==================== MENU CONTEXTO ====================
function openCtx(e, u) {
  const menu = $("#ctxMenu"); menu.innerHTML = "";
  menu.append(el("div", "ctx-title", u.username));
  if (isAdmin() && u.username !== me.username) {
    menu.append(el("div", "ctx-sub", "Dar cargo"));
    for (const r of serverState.roles) {
      const b = el("button", null, r.name);
      b.onclick = () => { sendWS({ type: "admin", action: "set-role", userId: u.username, roleId: r.id }); closeCtx(); };
      menu.append(b);
    }
    menu.append(el("hr"));
    const k = el("button", "danger", "Expulsar"); k.onclick = () => { sendWS({ type: "admin", action: "kick", userId: u.username }); closeCtx(); };
    menu.append(k);
  } else { menu.append(el("div", "ctx-title", "Sem ações")); }
  menu.style.left = Math.min(e.clientX, innerWidth - 220) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - 260) + "px";
  menu.classList.remove("hidden");
}
function closeCtx() { $("#ctxMenu").classList.add("hidden"); }
document.addEventListener("click", closeCtx);

// ==================== ADMIN / USERBAR ====================
function isAdmin() { const r = serverState.roles.find((x) => x.id === me?.roleId); return r ? r.rank >= 80 : false; }
function applyAdmin() { document.querySelectorAll(".admin-only").forEach((n) => n.classList.toggle("hidden", !isAdmin())); }
function updateUserbar() {
  if (!me) return;
  $("#ubName").textContent = me.username;
  const r = serverState.roles.find((x) => x.id === me.roleId);
  $("#ubStatus").textContent = r ? r.name : "Online";
  $("#ubStatus").style.color = r ? r.color : "";
  const av = $("#ubAvatar"); av.textContent = initial(me.username); if (r) av.style.background = r.color;
}

// ==================== VOZ / WEBRTC ====================
function getPeer(peerId) {
  let p = peers.get(peerId); if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  p = { pc, makingOffer: false, ignoreOffer: false, polite: me.username > peerId };
  peers.set(peerId, p);
  addLocalTracksTo(p);
  pc.onnegotiationneeded = async () => {
    try { p.makingOffer = true; await pc.setLocalDescription(); sendWS({ type: "signal", to: peerId, data: { description: pc.localDescription } }); }
    catch (e) { console.error(e); } finally { p.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) sendWS({ type: "signal", to: peerId, data: { candidate } }); };
  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    if (ev.track.kind === "audio") { attachAudio(peerId, stream); return; }
    const info = pubMap.get(stream.id);
    if (info) addTile(peerId, stream, info.kind);
    else { const a = pendingTracks.get(stream.id) || []; a.push({ peerId, stream }); pendingTracks.set(stream.id, a); }
    ev.track.onended = () => removeTile(stream.id);
  };
  announcePubsTo(peerId);
  return p;
}
async function handleSignal(peerId, data) {
  if (data.pubs) {
    for (const [sid, info] of Object.entries(data.pubs)) {
      pubMap.set(sid, info);
      const pend = pendingTracks.get(sid);
      if (pend) { for (const { peerId: pid, stream } of pend) addTile(pid, stream, info.kind); pendingTracks.delete(sid); }
    }
    return;
  }
  if (data.unpub) { pubMap.delete(data.unpub); removeTile(data.unpub); return; }
  const p = getPeer(peerId), pc = p.pc;
  try {
    if (data.description) {
      const collision = data.description.type === "offer" && (p.makingOffer || pc.signalingState !== "stable");
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") { await pc.setLocalDescription(); sendWS({ type: "signal", to: peerId, data: { description: pc.localDescription } }); }
    } else if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) throw e; } }
  } catch (e) { console.error("signal", e); }
}
function addLocalTracksTo(p) {
  for (const s of [localMic, localCam, localScreen]) {
    if (!s) continue;
    for (const track of s.getTracks()) {
      if (!p.pc.getSenders().some((snd) => snd.track === track)) {
        const sender = p.pc.addTrack(track, s);
        if (track.kind === "video") tuneVideo(sender);
      }
    }
  }
}
function addTrackToAll() { for (const p of peers.values()) addLocalTracksTo(p); }
async function tuneVideo(sender) {
  try { const pr = sender.getParameters(); if (!pr.encodings) pr.encodings = [{}];
    pr.encodings[0].maxBitrate = cfg.bitrate * 1e6; pr.encodings[0].maxFramerate = cfg.fps;
    pr.degradationPreference = "maintain-framerate"; await sender.setParameters(pr); } catch {}
}
function closePeer(id) { const p = peers.get(id); if (p) { try { p.pc.close(); } catch {} peers.delete(id); }
  document.querySelectorAll(`[data-peer="${cssEsc(id)}"]`).forEach((n) => n.remove()); }
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }

function myPubs() { const o = {}; if (localCam) o[localCam.id] = { userId: me.username, kind: "cam" }; if (localScreen) o[localScreen.id] = { userId: me.username, kind: "screen" }; return o; }
function announcePubsTo(id) { sendWS({ type: "signal", to: id, data: { pubs: myPubs() } }); }
function announcePubsAll() { for (const id of peers.keys()) announcePubsTo(id); }
function announceUnpub(sid) { for (const id of peers.keys()) sendWS({ type: "signal", to: id, data: { unpub: sid } }); }

function attachAudio(peerId, stream) {
  let a = document.querySelector(`audio[data-peer="${cssEsc(peerId)}"][data-stream="${cssEsc(stream.id)}"]`);
  if (!a) { a = el("audio"); a.autoplay = true; a.dataset.peer = peerId; a.dataset.stream = stream.id; document.body.append(a); }
  a.srcObject = stream; a.muted = deafened;
}
function addTile(peerId, stream, kind) {
  if (document.getElementById("tile-" + stream.id)) return;
  const stage = $("#stage"); stage.classList.remove("hidden");
  const tile = el("div", "tile"); tile.id = "tile-" + stream.id; tile.dataset.peer = peerId;
  const v = el("video"); v.autoplay = true; v.playsInline = true; v.srcObject = stream; if (peerId === me.username) v.muted = true;
  const who = presence.find((u) => u.username === peerId);
  tile.append(v, el("div", "label", (who ? who.username : peerId) + (kind === "screen" ? " • tela" : " • câmera")));
  stage.append(tile);
}
function removeTile(sid) { const t = document.getElementById("tile-" + sid); if (t) t.remove(); if (!$("#stage").children.length) $("#stage").classList.add("hidden"); }

async function joinVoice(id) {
  if (inVoice === id) return;
  if (inVoice) leaveVoice(false);
  try { localMic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: cfg.micId ? { exact: cfg.micId } : undefined, noiseSuppression: cfg.noise, echoCancellation: cfg.echo, autoGainControl: true }, video: false }); }
  catch (e) { alert("Sem acesso ao microfone: " + e.message); return; }
  micEnabled = true; inVoice = id;
  sendWS({ type: "voice-join", channel: id });
  const ch = serverState.channels.find((c) => c.id === id);
  $("#voiceBarName").textContent = "🔊 " + (ch ? ch.name : "");
  $("#voiceBar").classList.remove("hidden");
}
function leaveVoice(notify = true) {
  if (!inVoice) return;
  stopScreen(true); stopCam(true);
  if (localMic) { localMic.getTracks().forEach((t) => t.stop()); localMic = null; }
  for (const id of [...peers.keys()]) closePeer(id);
  document.querySelectorAll("audio[data-peer]").forEach((a) => a.remove());
  $("#stage").innerHTML = ""; $("#stage").classList.add("hidden");
  const old = inVoice; inVoice = null;
  if (notify) sendWS({ type: "voice-leave", channel: old });
  $("#voiceBar").classList.add("hidden"); $("#shareBtn").classList.remove("active"); $("#camBtn").classList.remove("active");
}
async function startScreen() {
  try { localScreen = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: cfg.res === 1440 ? 2560 : cfg.res === 720 ? 1280 : 1920 }, height: { ideal: cfg.res === 1440 ? 1440 : cfg.res === 720 ? 720 : 1080 }, frameRate: { ideal: cfg.fps, max: cfg.fps } },
    audio: cfg.shareAudio }); }
  catch { return; }
  const vt = localScreen.getVideoTracks()[0]; if (vt) vt.contentHint = "motion"; vt.onended = () => stopScreen(false);
  addTrackToAll(); announcePubsAll(); addTile(me.username, localScreen, "screen");
  sendWS({ type: "voice-state", sharing: true }); $("#shareBtn").classList.add("active");
  for (const p of peers.values()) for (const s of p.pc.getSenders()) if (s.track && localScreen.getTracks().includes(s.track)) tuneVideo(s);
}
function stopScreen(silent) {
  if (!localScreen) return; const sid = localScreen.id;
  for (const p of peers.values()) for (const s of p.pc.getSenders()) if (s.track && localScreen.getTracks().includes(s.track)) { try { p.pc.removeTrack(s); } catch {} }
  localScreen.getTracks().forEach((t) => t.stop()); localScreen = null;
  removeTile(sid); announceUnpub(sid); sendWS({ type: "voice-state", sharing: false }); $("#shareBtn").classList.remove("active");
}
async function startCam() {
  try { localCam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: cfg.camId ? { exact: cfg.camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
  catch (e) { alert("Sem acesso à câmera: " + e.message); return; }
  addTrackToAll(); announcePubsAll(); addTile(me.username, localCam, "cam");
  sendWS({ type: "voice-state", camOn: true }); $("#camBtn").classList.add("active");
}
function stopCam() {
  if (!localCam) return; const sid = localCam.id;
  for (const p of peers.values()) for (const s of p.pc.getSenders()) if (s.track && localCam.getTracks().includes(s.track)) { try { p.pc.removeTrack(s); } catch {} }
  localCam.getTracks().forEach((t) => t.stop()); localCam = null;
  removeTile(sid); announceUnpub(sid); sendWS({ type: "voice-state", camOn: false }); $("#camBtn").classList.remove("active");
}
function toggleMic() { micEnabled = !micEnabled; if (localMic) localMic.getAudioTracks().forEach((t) => (t.enabled = micEnabled)); sendWS({ type: "voice-state", muted: !micEnabled }); $("#micBtn").classList.toggle("off", !micEnabled); }
function toggleDeafen() { deafened = !deafened; document.querySelectorAll("audio[data-peer]").forEach((a) => (a.muted = deafened)); if (deafened && micEnabled) toggleMic(); sendWS({ type: "voice-state", deafened }); $("#deafBtn").classList.toggle("off", deafened); }

// ==================== ADMIN MODAL ====================
function renderAccounts(list) {
  const box = $("#accountList"); box.innerHTML = "";
  for (const acc of list.sort((a, b) => a.username.localeCompare(b.username))) {
    const row = el("div", "acc-row");
    row.append(el("span", "an", acc.username));
    const sel = document.createElement("select");
    for (const r of serverState.roles) { const o = el("option", null, r.name); o.value = r.id; if (r.id === acc.roleId) o.selected = true; sel.append(o); }
    sel.onchange = () => sendWS({ type: "admin", action: "set-role", userId: acc.username, roleId: sel.value });
    row.append(sel); box.append(row);
  }
}
function renderRolesAdmin() {
  const box = $("#roleList"); box.innerHTML = "";
  for (const r of [...serverState.roles].sort((a, b) => b.rank - a.rank)) {
    const row = el("div", "role-row");
    const sw = el("span", "swatch"); sw.style.background = r.color;
    row.append(sw, el("span", "rn", r.name), el("span", "rrank", "prio " + r.rank));
    if (!["owner", "admin", "membro"].includes(r.id)) {
      const d = el("button", "rdel", "🗑️"); d.onclick = () => sendWS({ type: "admin", action: "del-role", id: r.id }); row.append(d);
    }
    box.append(row);
  }
  const catSel = $("#newChCat"); catSel.innerHTML = "";
  for (const c of serverState.categories) { const o = el("option", null, c.name); o.value = c.id; catSel.append(o); }
}

// ==================== DISPOSITIVOS ====================
async function loadDevices() {
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    const m = $("#micSelect"), c = $("#camSelect"); m.innerHTML = ""; c.innerHTML = "";
    ds.filter((d) => d.kind === "audioinput").forEach((d) => { const o = el("option", null, d.label || "Microfone"); o.value = d.deviceId; m.append(o); });
    ds.filter((d) => d.kind === "videoinput").forEach((d) => { const o = el("option", null, d.label || "Câmera"); o.value = d.deviceId; c.append(o); });
  } catch {}
}

// ==================== WIRING ====================
function initUI() {
  // composer
  const sendCur = () => { const i = $("#msgInput"); const t = i.value.trim(); if (!t) return; sendWS({ type: "chat", channel: activeChannel, text: t }); i.value = ""; };
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); sendCur(); });
  $("#msgInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCur(); } });

  // userbar
  $("#micBtn").onclick = toggleMic;
  $("#deafBtn").onclick = toggleDeafen;
  $("#avBtn").onclick = openAV;
  $("#shareBtn").onclick = () => (localScreen ? stopScreen(false) : startScreen());
  $("#camBtn").onclick = () => (localCam ? stopCam() : startCam());
  $("#leaveVoiceBtn").onclick = () => leaveVoice(true);
  $("#toggleMembers").onclick = () => $("#members").classList.toggle("hidden");

  // menu servidor
  $("#srvHead").onclick = (e) => { e.stopPropagation(); $("#srvMenu").classList.toggle("hidden"); };
  document.addEventListener("click", () => $("#srvMenu").classList.add("hidden"));
  $("#srvMenu").addEventListener("click", (e) => e.stopPropagation());
  $("#menuLogout").onclick = () => { if (confirm("Sair da conta?")) logout(); };
  $("#menuInvite").onclick = () => { navigator.clipboard.writeText(location.origin).then(() => alert("Link copiado!\n" + location.origin)); };
  $("#openServerSettings").onclick = () => openServerSettings();

  // AV modal
  $("#avClose").onclick = () => $("#avModal").classList.add("hidden");
  $("#micSelect").onchange = (e) => (cfg.micId = e.target.value);
  $("#camSelect").onchange = (e) => (cfg.camId = e.target.value);
  $("#noiseChk").onchange = (e) => (cfg.noise = e.target.checked);
  $("#echoChk").onchange = (e) => (cfg.echo = e.target.checked);
  $("#resSelect").onchange = (e) => (cfg.res = +e.target.value);
  $("#fpsSelect").onchange = (e) => (cfg.fps = +e.target.value);
  $("#shareAudioChk").onchange = (e) => (cfg.shareAudio = e.target.checked);
  $("#brRange").oninput = (e) => { cfg.bitrate = +e.target.value; $("#brLabel").textContent = e.target.value; for (const p of peers.values()) for (const s of p.pc.getSenders()) if (s.track && s.track.kind === "video") tuneVideo(s); };

  // server modal tabs
  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== t.dataset.tab));
    if (t.dataset.tab === "membros") sendWS({ type: "admin", action: "list-accounts" });
    if (t.dataset.tab === "cargos" || t.dataset.tab === "canais") renderRolesAdmin();
  });
  $("#srvClose").onclick = () => $("#srvModal").classList.add("hidden");
  $("#srvRename").onclick = () => { const n = $("#srvNameInput").value.trim(); if (n) sendWS({ type: "admin", action: "rename-server", name: n }); };
  $("#addRole").onclick = () => { const name = $("#newRoleName").value.trim(); if (!name) return; sendWS({ type: "admin", action: "add-role", name, color: $("#newRoleColor").value, rank: $("#newRoleRank").value }); $("#newRoleName").value = ""; };
  $("#addCat").onclick = () => { const n = $("#newCatName").value.trim(); if (!n) return; sendWS({ type: "admin", action: "add-category", name: n }); $("#newCatName").value = ""; };
  $("#addCh").onclick = () => { const n = $("#newChName").value.trim(); if (!n) return; sendWS({ type: "admin", action: "add-channel", name: n, channelType: $("#newChType").value, categoryId: $("#newChCat").value }); $("#newChName").value = ""; };
}
async function openAV() { await loadDevices(); $("#avModal").classList.remove("hidden"); }
function openServerSettings() {
  $("#srvMenu").classList.add("hidden");
  renderRolesAdmin();
  sendWS({ type: "admin", action: "list-accounts" });
  $("#srvModal").classList.remove("hidden");
}

initAuth();
initUI();
