// Harmony / Feap Avaré - servidor v2
// Login por conta (senha com hash), cargos persistentes, categorias de canais,
// e sinalizacao WebRTC. Armazenamento: Upstash Redis (se configurado) ou arquivo.
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  randomUUID,
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MSG_LIMIT = 200;
const SECRET = process.env.AUTH_SECRET || "feap-avare-troque-este-segredo-em-producao";

// ---------- Armazenamento (Redis Upstash OU arquivo) ----------
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = !!(R_URL && R_TOKEN);
const DATA_FILE = join(__dirname, "data.json");
const ACC_FILE = join(__dirname, "accounts.json");

async function redis(cmd) {
  const res = await fetch(`${R_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${R_TOKEN}` },
  });
  const j = await res.json();
  return j.result;
}
async function redisSetJSON(key, value) {
  // usa POST com body pra valores grandes
  await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}` },
    body: JSON.stringify(value),
  });
}
async function redisGetJSON(key) {
  const r = await redis(["get", key]);
  if (r == null) return null;
  try { return JSON.parse(r); } catch { return null; }
}

// ---------- Estado padrao ----------
const defaultState = () => ({
  serverName: "Feap Avaré",
  categories: [
    { id: "boas-vindas", name: "boas-vindas" },
    { id: "textos", name: "Canais de Texto" },
    { id: "vozes", name: "Canais de Voz" },
  ],
  channels: [
    { id: "regras", name: "regras", type: "text", categoryId: "boas-vindas" },
    { id: "avisos", name: "avisos", type: "text", categoryId: "boas-vindas" },
    { id: "geral", name: "geral", type: "text", categoryId: "textos" },
    { id: "off-topic", name: "off-topic", type: "text", categoryId: "textos" },
    { id: "memes", name: "memes", type: "text", categoryId: "textos" },
    { id: "sala-1", name: "Sala 1", type: "voice", categoryId: "vozes" },
    { id: "sala-2", name: "Sala 2", type: "voice", categoryId: "vozes" },
  ],
  roles: [
    { id: "owner", name: "Dono", color: "#f04747", rank: 100, hoist: true },
    { id: "admin", name: "Admin", color: "#faa61a", rank: 80, hoist: true },
    { id: "membro", name: "Membro", color: "#43b581", rank: 10, hoist: true },
  ],
  messages: {},
});

let state;
let accounts; // { usernameLower: {username, salt, hash, roleId, createdAt} }

async function loadAll() {
  if (useRedis) {
    state = (await redisGetJSON("feap:state")) || defaultState();
    accounts = (await redisGetJSON("feap:accounts")) || {};
  } else {
    try {
      state = existsSync(DATA_FILE)
        ? { ...defaultState(), ...JSON.parse(readFileSync(DATA_FILE, "utf8")) }
        : defaultState();
    } catch { state = defaultState(); }
    try {
      accounts = existsSync(ACC_FILE) ? JSON.parse(readFileSync(ACC_FILE, "utf8")) : {};
    } catch { accounts = {}; }
  }
  state.messages = state.messages || {};
  console.log(`Armazenamento: ${useRedis ? "Upstash Redis (persistente)" : "arquivo local"}`);
  console.log(`Contas carregadas: ${Object.keys(accounts).length}`);
}

let stateTimer = null, accTimer = null;
function persistState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(async () => {
    const payload = {
      serverName: state.serverName,
      categories: state.categories,
      channels: state.channels,
      roles: state.roles,
      messages: state.messages,
    };
    if (useRedis) await redisSetJSON("feap:state", payload).catch((e) => console.error("redis state", e.message));
    else try { writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2)); } catch (e) { console.error(e.message); }
  }, 700);
}
function persistAccounts() {
  clearTimeout(accTimer);
  accTimer = setTimeout(async () => {
    if (useRedis) await redisSetJSON("feap:accounts", accounts).catch((e) => console.error("redis acc", e.message));
    else try { writeFileSync(ACC_FILE, JSON.stringify(accounts, null, 2)); } catch (e) { console.error(e.message); }
  }, 400);
}

// ---------- Auth ----------
function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  const h = scryptSync(pw, salt, 64).toString("hex");
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
function makeToken(username) {
  const p = Buffer.from(username).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(p).digest("base64url");
  return `${p}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const exp = createHmac("sha256", SECRET).update(p).digest("base64url");
  if (exp.length !== sig.length || !timingSafeEqual(Buffer.from(exp), Buffer.from(sig))) return null;
  const username = Buffer.from(p, "base64url").toString();
  return accounts[username.toLowerCase()] ? username : null;
}
const validName = (s) => /^[a-zA-Z0-9_]{3,20}$/.test(s);

// ---------- App HTTP ----------
const app = express();
app.use(express.json());
const publicDir = existsSync(join(__dirname, "public")) ? join(__dirname, "public") : __dirname;
app.use(express.static(publicDir));

app.post("/api/register", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!validName(username)) return res.status(400).json({ error: "Usuário: 3-20 letras/números/_" });
  if (password.length < 4) return res.status(400).json({ error: "Senha muito curta (min. 4)" });
  const key = username.toLowerCase();
  if (accounts[key]) return res.status(409).json({ error: "Esse usuário já existe" });
  const { salt, hash } = hashPassword(password);
  const roleId = Object.keys(accounts).length === 0 ? "owner" : "membro";
  accounts[key] = { username, salt, hash, roleId, createdAt: Date.now() };
  persistAccounts();
  res.json({ token: makeToken(username), user: { username, roleId } });
});

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const acc = accounts[username.toLowerCase()];
  if (!acc || !verifyPassword(password, acc.salt, acc.hash))
    return res.status(401).json({ error: "Usuário ou senha inválidos" });
  res.json({ token: makeToken(acc.username), user: { username: acc.username, roleId: acc.roleId } });
});

app.get("/api/me", (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const username = verifyToken(token);
  if (!username) return res.status(401).json({ error: "token inválido" });
  const acc = accounts[username.toLowerCase()];
  res.json({ user: { username: acc.username, roleId: acc.roleId } });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---------- Usuarios online ----------
// userId(=username) -> { username, roleId, ws, voiceChannel, muted, deafened, sharing, camOn }
const online = new Map();

const roleById = (id) => state.roles.find((r) => r.id === id);
const roleRank = (id) => (roleById(id)?.rank || 0);
const roleColor = (id) => (roleById(id)?.color || "#b9bbbe");
const isAdmin = (u) => roleRank(u.roleId) >= 80;

function publicUser(u) {
  return {
    id: u.username, username: u.username, roleId: u.roleId,
    voiceChannel: u.voiceChannel, muted: u.muted, deafened: u.deafened,
    sharing: u.sharing, camOn: u.camOn,
  };
}
function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId = null) {
  const m = JSON.stringify(obj);
  for (const u of online.values()) if (u.username !== exceptId && u.ws.readyState === u.ws.OPEN) u.ws.send(m);
}
function broadcastPresence() {
  broadcast({ type: "presence", users: [...online.values()].map(publicUser) });
}
function stateForClient() {
  return {
    type: "state", serverName: state.serverName,
    categories: state.categories, channels: state.channels, roles: state.roles,
  };
}
function broadcastState() { for (const u of online.values()) send(u.ws, stateForClient()); }

const slug = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

// ---------- WebSocket ----------
wss.on("connection", (ws) => {
  let me = null;

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "auth") {
      const username = verifyToken(msg.token);
      if (!username) { send(ws, { type: "auth-fail" }); return; }
      const acc = accounts[username.toLowerCase()];
      // se ja estava online em outra aba, derruba a antiga
      const prev = online.get(acc.username);
      if (prev && prev.ws !== ws) { try { prev.ws.close(); } catch {} }
      me = {
        username: acc.username, roleId: acc.roleId, ws,
        voiceChannel: null, muted: false, deafened: false, sharing: false, camOn: false,
      };
      online.set(me.username, me);
      send(ws, { type: "welcome", you: publicUser(me) });
      send(ws, stateForClient());
      for (const ch of state.channels.filter((c) => c.type === "text"))
        send(ws, { type: "history", channel: ch.id, messages: state.messages[ch.id] || [] });
      broadcastPresence();
      return;
    }

    if (!me) return; // precisa autenticar primeiro

    switch (msg.type) {
      case "chat": {
        const channel = String(msg.channel || "");
        const ch = state.channels.find((c) => c.id === channel && c.type === "text");
        if (!ch) return;
        const text = String(msg.text || "").slice(0, 2000);
        if (!text.trim()) return;
        const entry = {
          id: randomUUID(), userId: me.username, name: me.username,
          color: roleColor(me.roleId), text, ts: Date.now(),
        };
        (state.messages[channel] ||= []).push(entry);
        if (state.messages[channel].length > MSG_LIMIT)
          state.messages[channel] = state.messages[channel].slice(-MSG_LIMIT);
        persistState();
        broadcast({ type: "chat", channel, message: entry });
        break;
      }
      case "voice-join": {
        const ch = state.channels.find((c) => c.id === msg.channel && c.type === "voice");
        if (!ch) return;
        me.voiceChannel = ch.id; me.sharing = false; me.camOn = false;
        const peers = [...online.values()].filter((u) => u.username !== me.username && u.voiceChannel === ch.id).map((u) => u.username);
        send(ws, { type: "voice-peers", channel: ch.id, peers });
        broadcastPresence();
        break;
      }
      case "voice-leave": {
        const old = me.voiceChannel;
        me.voiceChannel = null; me.sharing = false; me.camOn = false;
        broadcast({ type: "voice-left", userId: me.username, channel: old });
        broadcastPresence();
        break;
      }
      case "voice-state": {
        for (const k of ["muted", "deafened", "sharing", "camOn"])
          if (typeof msg[k] === "boolean") me[k] = msg[k];
        broadcastPresence();
        break;
      }
      case "signal": {
        const target = online.get(msg.to);
        if (target) send(target.ws, { type: "signal", from: me.username, data: msg.data });
        break;
      }
      case "admin": {
        if (!isAdmin(me)) return;
        handleAdmin(me, msg);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (me && online.get(me.username)?.ws === ws) {
      const old = me.voiceChannel;
      online.delete(me.username);
      if (old) broadcast({ type: "voice-left", userId: me.username, channel: old });
      broadcast({ type: "peer-gone", userId: me.username });
      broadcastPresence();
    }
  });
});

function handleAdmin(me, msg) {
  const a = msg.action;
  if (a === "list-accounts") {
    const list = Object.values(accounts).map((ac) => ({ username: ac.username, roleId: ac.roleId }));
    send(me.ws, { type: "accounts", list });
    return;
  }
  if (a === "add-channel") {
    const type = msg.channelType === "voice" ? "voice" : "text";
    const name = String(msg.name || "").slice(0, 40).trim();
    const categoryId = state.categories.find((c) => c.id === msg.categoryId)?.id
      || state.categories[0]?.id || "textos";
    if (!name) return;
    const id = slug(name) + "-" + Math.random().toString(36).slice(2, 5);
    state.channels.push({ id, name: type === "text" ? slug(name) || name : name, type, categoryId });
    if (type === "text") state.messages[id] = [];
    persistState(); broadcastState();
  } else if (a === "del-channel") {
    state.channels = state.channels.filter((c) => c.id !== msg.id);
    delete state.messages[msg.id];
    for (const u of online.values()) if (u.voiceChannel === msg.id) u.voiceChannel = null;
    persistState(); broadcastState(); broadcastPresence();
  } else if (a === "add-category") {
    const name = String(msg.name || "").slice(0, 40).trim();
    if (!name) return;
    state.categories.push({ id: slug(name) + "-" + Math.random().toString(36).slice(2, 5), name });
    persistState(); broadcastState();
  } else if (a === "del-category") {
    state.categories = state.categories.filter((c) => c.id !== msg.id);
    state.channels = state.channels.filter((c) => c.categoryId !== msg.id);
    persistState(); broadcastState();
  } else if (a === "add-role") {
    const name = String(msg.name || "").slice(0, 30).trim();
    if (!name) return;
    const color = /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : "#99aab5";
    const rank = Math.max(1, Math.min(79, parseInt(msg.rank) || 20));
    state.roles.push({ id: slug(name) + "-" + Math.random().toString(36).slice(2, 5), name, color, rank, hoist: true });
    state.roles.sort((x, y) => y.rank - x.rank);
    persistState(); broadcastState(); broadcastPresence();
  } else if (a === "del-role") {
    if (["owner", "admin", "membro"].includes(msg.id)) return; // nao apaga base
    state.roles = state.roles.filter((r) => r.id !== msg.id);
    for (const key in accounts) if (accounts[key].roleId === msg.id) accounts[key].roleId = "membro";
    for (const u of online.values()) if (u.roleId === msg.id) u.roleId = "membro";
    persistState(); persistAccounts(); broadcastState(); broadcastPresence();
  } else if (a === "set-role") {
    const targetKey = String(msg.userId || "").toLowerCase();
    const acc = accounts[targetKey];
    if (!acc || !roleById(msg.roleId)) return;
    // nao mexe em quem tem rank >= o seu (nem promove acima de si)
    if (roleRank(acc.roleId) >= roleRank(me.roleId)) return;
    if (roleRank(msg.roleId) >= roleRank(me.roleId)) return;
    acc.roleId = msg.roleId;
    const onl = online.get(acc.username);
    if (onl) onl.roleId = msg.roleId;
    persistAccounts(); broadcastPresence();
  } else if (a === "kick") {
    const acc = accounts[String(msg.userId || "").toLowerCase()];
    const onl = acc && online.get(acc.username);
    if (onl && roleRank(onl.roleId) < roleRank(me.roleId)) {
      send(onl.ws, { type: "kicked" });
      try { onl.ws.close(); } catch {}
    }
  } else if (a === "rename-server") {
    const name = String(msg.name || "").slice(0, 40).trim();
    if (name) { state.serverName = name; persistState(); broadcastState(); }
  }
}

loadAll().then(() => {
  httpServer.listen(PORT, () => console.log(`Feap Avaré rodando em http://localhost:${PORT}`));
});
