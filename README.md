# 🎧 Harmony — seu "Discord" caseiro

Um servidor de chat estilo Discord com **texto, voz, vídeo (webcam) e compartilhamento de tela em até 1080p/60fps**, feito pra você e seus amigos. Voz/vídeo usam **WebRTC** (conexão direta entre os participantes — "mesh"), ideal para grupos de amigos (até ~6-8 pessoas na mesma call).

## Recursos

- 💬 **Canais de texto** com histórico salvo
- 🔊 **Canais de voz** estilo Discord (entra e sai da call)
- 🖥️ **Compartilhamento de tela** com qualidade configurável (720p/1080p/1440p, 30 ou 60 fps, bitrate até 25 Mbps)
- 📷 **Câmera (webcam)**
- 🎚️ **Configs de áudio/vídeo**: escolher microfone, câmera, redução de ruído, cancelamento de eco
- 👑 **Cargos**: Dono, Admin e Membro — o **primeiro a entrar vira Dono**
- 🛠️ **Admin** pode: criar/apagar canais, dar cargos (botão direito no membro), expulsar, renomear o servidor
- 🔇 Mutar microfone, ensurdecer (mute geral)

---

## 🚀 Como colocar no ar de graça (deploy no Render)

O jeito mais fácil de deixar sempre online pros amigos entrarem de qualquer lugar.

### 1. Crie uma conta no GitHub e suba o código
1. Crie uma conta em https://github.com (grátis).
2. Crie um repositório novo (ex: `harmony`), **privado ou público**.
3. Suba esta pasta `discord-clone` pra esse repositório. Sem saber Git? Dá pra arrastar os arquivos direto no site do GitHub em **"Add file → Upload files"**. Suba **tudo, menos a pasta `node_modules`**.

### 2. Deploy no Render
1. Crie conta grátis em https://render.com (pode entrar com o GitHub).
2. Clique em **New → Web Service** e conecte seu repositório.
3. O Render lê o arquivo `render.yaml` automaticamente. Se pedir manual, use:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
4. Clique em **Create Web Service**. Em 1-2 minutos ele te dá um link tipo
   `https://harmony-xyz.onrender.com` — **é esse link que você manda pros amigos.** 🎉

> ⚠️ **Plano free do Render dorme** depois de 15 min sem uso e demora ~30s pra acordar no primeiro acesso. Normal. Se quiser sempre-ligado, o plano pago é barato, ou use Railway/Fly.io.

### Alternativas de host grátis
- **Railway** (railway.app): New Project → Deploy from GitHub. Detecta Node sozinho.
- **Fly.io**: precisa do `flyctl`, um pouco mais técnico.

---

## 💻 Rodar no seu PC (pra testar antes)

Você já tem o Node.js instalado. No PowerShell, dentro desta pasta:

```bash
npm install
npm start
```

Abra http://localhost:3000. Pra um amigo entrar pela sua máquina sem deploy, use um túnel:

```bash
npx localtunnel --port 3000
```

Isso te dá um link público temporário. (Alternativas: `cloudflared tunnel --url http://localhost:3000` ou `ngrok http 3000`.)

---

## ⚙️ Sobre qualidade e conexão (leia isto!)

### 1080p / 60fps
O app **pede** 1080p60 e configura bitrate alto (padrão 10 Mbps, ajustável até 25 nas ⚙️ configs de áudio/vídeo). A qualidade final depende da **internet de quem transmite e de quem assiste** — igual no Discord. Pra jogos, deixe no 60fps; pra apresentação/tela parada, 30fps já basta e gasta menos banda.

### TURN (importante pra conexão funcionar sempre)
Algumas redes (NAT restrito, internet de celular, alguns provedores) **não conseguem conexão direta** e precisam de um servidor **TURN** que faz a ponte. O app já vem com um TURN público gratuito de teste (`openrelay.metered.ca`), mas ele **não é confiável pra uso sério** e pode sair do ar.

**Recomendado:** pegue um TURN grátis próprio (leva 2 min):
1. Crie conta em https://www.metered.ca/tools/openrelay/ (tem plano free com 50GB/mês).
2. Eles te dão uma lista de servidores com `username` e `credential`.
3. Cole no topo do arquivo `public/app.js`, na constante `ICE_SERVERS`, substituindo os `turn:` que já estão lá.

Sem um TURN bom, se dois amigos **não conseguirem se ver/ouvir**, quase sempre é isso.

---

## 🖥️ App de PC (Windows)

Tem também um **app instalável de verdade** (com Electron), na pasta `desktop/`. Ele é só a "casca" — abre em janela própria, com ícone, e conecta no seu servidor hospedado (Render). O compartilhamento de tela usa um **seletor próprio** de tela/janela (o Discord faz igual).

### Instalador pronto
Já gerei o instalador aqui:

```
desktop/dist/Harmony Setup 1.0.0.exe
```

**É esse arquivo que você e seus amigos instalam.** Ao abrir pela 1ª vez:
1. O Windows SmartScreen pode avisar que é de "editor desconhecido" (normal — o app não é assinado com certificado pago). Clique em **"Mais informações → Executar assim mesmo"**.
2. O app pergunta o **endereço do servidor** — cole seu link do Render (ex: `https://harmony-xyz.onrender.com`) e clique em Conectar.
3. Pronto. Dá pra trocar o servidor depois no menu **Harmony → Trocar servidor**.

> Pra testar antes do deploy, na tela inicial clique em **"Usar servidor local"** com o `npm start` rodando neste PC.

### Recompilar o app (se mudar algo)
Dentro de `desktop/`:

```bash
npm install
npm run dist
```

O instalador sai em `desktop/dist/`. 

**Obs. técnica (bug do Windows):** se `npm run dist` falhar num erro de *"Cannot create symbolic link"* ao extrair o `winCodeSign`, é porque o Windows bloqueia symlinks sem o **Modo de Desenvolvedor** ligado. Duas saídas: (a) ligue o Modo de Desenvolvedor em *Configurações → Privacidade e segurança → Para desenvolvedores*; ou (b) rode `npm run pack` no lugar, que gera a versão **portátil** em `desktop/dist/win-unpacked/` (pasta com `Harmony.exe` que roda direto, sem instalar — é só zipar e mandar pros amigos).

## 📁 Estrutura

```
discord-clone/
├── server.js          # Servidor: chat, presença, cargos, relay de sinalização WebRTC
├── package.json
├── render.yaml        # Config de deploy no Render
├── Procfile           # Config de deploy alternativo
├── data.json          # (gerado) canais + histórico de mensagens
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js         # Cliente: WebRTC mesh, UI, voz/vídeo/tela
└── desktop/           # App de PC (Electron)
    ├── main.js        # Janela + seletor de tela + config do servidor
    ├── connect.html   # Tela pra digitar o endereço do servidor
    ├── picker.html    # Seletor de tela/janela pro compartilhamento
    └── dist/          # (gerado) Harmony Setup 1.0.0.exe
```

## 🔧 Notas técnicas

- **Sem banco de dados**: canais e histórico ficam em `data.json` (últimas 200 msgs por canal). No Render free o disco é efêmero — o histórico reseta em cada deploy. Pra histórico permanente, dá pra plugar um banco depois.
- **Cargos são por sessão de conexão**, não por login (não tem senha). Quem entra primeiro é Dono enquanto estiver conectado.
- **Mesh P2P**: cada pessoa se conecta a cada outra. Ótimo até ~6-8. Pra dezenas de pessoas seria preciso um servidor de mídia (SFU) tipo mediasoup/LiveKit — outro nível de projeto.
- Precisa de **HTTPS** pra câmera/microfone/tela funcionarem (o Render já dá HTTPS de graça; no localhost também funciona).
