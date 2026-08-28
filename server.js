// Harmony - servidor de sinalizacao + chat estilo Discord
// Node 18+, Express (arquivos estaticos) e ws (WebSocket).
// Estado fica em memoria + persistencia leve em data.json (mensagens/estrutura).

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_FILE = join(__dirname, "data.json");
const MSG_LIMIT = 200; // mensagens guardadas por canal

const app = express();
app.use(express.static(join(__dirname, "public")));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---------- Estado persistido ----------
const defaultState = () => ({
  serverName: "Meu Servidor",
  textChannels: [
    { id: "geral", name: "geral" },
    { id: "jogos", name: "jogos" },
    { id: "off-topic", name: "off-topic" },
  ],
  voiceChannels: [
    { id: "sala-1", name: "Sala 1" },
    { id: "sala-2", name: "Sala 2" },
  ],
  roles: [
    { id: "owner", name: "Dono", color: "#f04747", rank: 100 },
    { id: "admin", name: "Admin", color: "#faa61a", rank: 80 },
    { id: "membro", name: "Membro", color: "#43b581", rank: 10 },
  ],
  messages: {}, // channelId -> [{id, userId, name, color, text, ts}]
});

let state;
try {
  state = existsSync(DATA_FILE)
    ? { ...defaultState(), ...JSON.parse(readFileSync(DATA_FILE, "utf8")) }
    : defaultState();
} catch {
  state = defaultState();
}
// garante estrutura
state.messages = state.messages || {};

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(
        DATA_FILE,
        JSON.stringify(
          {
            serverName: state.serverName,
            textChannels: state.textChannels,
            voiceChannels: state.voiceChannels,
            roles: state.roles,
            messages: state.messages,
          },
          null,
          2
        )
      );
    } catch (e) {
      console.error("Falha ao salvar:", e.message);
    }
  }, 800);
}

// ---------- Usuarios conectados (em memoria) ----------
// userId -> { id, name, roleId, ws, voiceChannel, muted, deafened, sharing, camOn }
const users = new Map();

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    roleId: u.roleId,
    voiceChannel: u.voiceChannel,
    muted: u.muted,
    deafened: u.deafened,
    sharing: u.sharing,
    camOn: u.camOn,
  };
}

function userColor(u) {
  const r = state.roles.find((x) => x.id === u.roleId);
  return r ? r.color : "#b9bbbe";
}

function roleRank(roleId) {
  const r = state.roles.find((x) => x.id === roleId);
  return r ? r.rank : 0;
}
function isAdmin(u) {
  return roleRank(u.roleId) >= 80;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const u of users.values()) {
    if (u.id !== exceptId && u.ws.readyState === u.ws.OPEN) u.ws.send(msg);
  }
}

function broadcastPresence() {
  broadcast({ type: "presence", users: [...users.values()].map(publicUser) });
}

function sendState(ws) {
  send(ws, {
    type: "state",
    serverName: state.serverName,
    textChannels: state.textChannels,
    voiceChannels: state.voiceChannels,
    roles: state.roles,
  });
}

// ---------- WebSocket ----------
wss.on("connection", (ws) => {
  let me = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "join": {
        const name = String(msg.name || "Anon").slice(0, 32).trim() || "Anon";
        // primeiro a entrar vira Dono; demais entram como Membro
        const roleId = users.size === 0 ? "owner" : "membro";
        me = {
          id: randomUUID(),
          name,
          roleId,
          ws,
          voiceChannel: null,
          muted: false,
          deafened: false,
          sharing: false,
          camOn: false,
        };
        users.set(me.id, me);
        send(ws, { type: "welcome", you: publicUser(me) });
        sendState(ws);
        // historico de cada canal de texto
        for (const ch of state.textChannels) {
          send(ws, {
            type: "history",
            channel: ch.id,
            messages: state.messages[ch.id] || [],
          });
        }
        broadcastPresence();
        broadcast(
          { type: "system", channel: null, text: `${me.name} entrou.` },
          null
        );
        break;
      }

      case "chat": {
        if (!me) return;
        const channel = String(msg.channel || "");
        if (!state.textChannels.find((c) => c.id === channel)) return;
        const text = String(msg.text || "").slice(0, 2000);
        if (!text.trim()) return;
        const entry = {
          id: randomUUID(),
          userId: me.id,
          name: me.name,
          color: userColor(me),
          text,
          ts: Date.now(),
        };
        (state.messages[channel] ||= []).push(entry);
        if (state.messages[channel].length > MSG_LIMIT)
          state.messages[channel] = state.messages[channel].slice(-MSG_LIMIT);
        persist();
        broadcast({ type: "chat", channel, message: entry });
        break;
      }

      case "voice-join": {
        if (!me) return;
        const ch = String(msg.channel || "");
        if (!state.voiceChannels.find((c) => c.id === ch)) return;
        me.voiceChannel = ch;
        me.sharing = false;
        me.camOn = false;
        // informa quem ja esta nesse canal (para o novo iniciar as conexoes)
        const peers = [...users.values()]
          .filter((u) => u.id !== me.id && u.voiceChannel === ch)
          .map((u) => u.id);
        send(ws, { type: "voice-peers", channel: ch, peers });
        broadcastPresence();
        break;
      }

      case "voice-leave": {
        if (!me) return;
        const old = me.voiceChannel;
        me.voiceChannel = null;
        me.sharing = false;
        me.camOn = false;
        broadcast({ type: "voice-left", userId: me.id, channel: old });
        broadcastPresence();
        break;
      }

      case "voice-state": {
        if (!me) return;
        if (typeof msg.muted === "boolean") me.muted = msg.muted;
        if (typeof msg.deafened === "boolean") me.deafened = msg.deafened;
        if (typeof msg.sharing === "boolean") me.sharing = msg.sharing;
        if (typeof msg.camOn === "boolean") me.camOn = msg.camOn;
        broadcastPresence();
        break;
      }

      // Relay de sinalizacao WebRTC (offer/answer/ice) ponto a ponto
      case "signal": {
        if (!me) return;
        const target = users.get(msg.to);
        if (target) {
          send(target.ws, {
            type: "signal",
            from: me.id,
            data: msg.data,
          });
        }
        break;
      }

      // ----- Admin: gerenciar servidor -----
      case "admin": {
        if (!me || !isAdmin(me)) return;
        const a = msg.action;
        if (a === "add-text-channel") {
          const nm = slug(msg.name);
          if (nm && !state.textChannels.find((c) => c.id === nm)) {
            state.textChannels.push({ id: nm, name: nm });
            state.messages[nm] = [];
            persist();
            broadcast({ type: "state-changed" });
            broadcastState();
          }
        } else if (a === "add-voice-channel") {
          const nm = String(msg.name || "").slice(0, 32).trim();
          if (nm) {
            const id = slug(nm) + "-" + Math.random().toString(36).slice(2, 6);
            state.voiceChannels.push({ id, name: nm });
            persist();
            broadcastState();
          }
        } else if (a === "del-text-channel") {
          state.textChannels = state.textChannels.filter((c) => c.id !== msg.id);
          delete state.messages[msg.id];
          persist();
          broadcastState();
        } else if (a === "del-voice-channel") {
          state.voiceChannels = state.voiceChannels.filter((c) => c.id !== msg.id);
          // tira todo mundo desse canal
          for (const u of users.values())
            if (u.voiceChannel === msg.id) u.voiceChannel = null;
          persist();
          broadcastState();
          broadcastPresence();
        } else if (a === "set-role") {
          const target = users.get(msg.userId);
          if (target && state.roles.find((r) => r.id === msg.roleId)) {
            // nao deixa rebaixar alguem de rank maior que o seu
            if (roleRank(target.roleId) <= roleRank(me.roleId)) {
              target.roleId = msg.roleId;
              broadcastPresence();
            }
          }
        } else if (a === "kick") {
          const target = users.get(msg.userId);
          if (target && roleRank(target.roleId) < roleRank(me.roleId)) {
            send(target.ws, { type: "kicked" });
            target.ws.close();
          }
        } else if (a === "rename-server") {
          const nm = String(msg.name || "").slice(0, 40).trim();
          if (nm) {
            state.serverName = nm;
            persist();
            broadcastState();
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (me) {
      const old = me.voiceChannel;
      users.delete(me.id);
      if (old) broadcast({ type: "voice-left", userId: me.id, channel: old });
      broadcast({ type: "peer-gone", userId: me.id });
      broadcastPresence();
    }
  });
});

function broadcastState() {
  for (const u of users.values()) sendState(u.ws);
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

httpServer.listen(PORT, () => {
  console.log(`Harmony rodando em http://localhost:${PORT}`);
});
