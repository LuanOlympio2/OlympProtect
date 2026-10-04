let qrcode = null;
try {
    qrcode = require('qrcode-terminal');
} catch (_) {}
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    getContentType
} = require('baileys');
const pino = require('pino');
const readline = require("readline");
const fs = require('fs-extra');
const NodeCache = require('node-cache');
const path = require('path');
const config = require('./config.json');
const mensagensHandler = require('./dados/eventos/mensagens');
const gruposHandler = require('./dados/eventos/grupos');
const groupCache = require('./dados/funções/groupCache');
const groupMetadataManager = require('./dados/funções/groupMetadataManager');
const lidCache = require('./dados/funções/lidCache');
const { createInspectorLogger, attachTrafficInspector, inspectUpsert } = require('./dados/funções/trafficInspector');
const inspectorLogPath = path.join(__dirname, 'dados/logs/traffic_inspector.log');
const inspectorLogger = createInspectorLogger(inspectorLogPath);
const Grupo = require('./dados/modelos/grupos');
const undecryptedBurstMap = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, list] of undecryptedBurstMap.entries()) {
        const active = list.filter(t => now - t < 5000);
        if (active.length === 0) undecryptedBurstMap.delete(k);
        else undecryptedBurstMap.set(k, active);
    }
}, 30000);
const SESSION_DIR = "./auth_info_baileys";
const msgRetryCounterCache = new NodeCache();
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
try {
    store?.readFromFile('./baileys_store_multi.json');
} catch (_) {}
setInterval(() => {
    try {
        if (store?.messages) {
            for (const [jid, msgList] of Object.entries(store.messages)) {
                if (Array.isArray(msgList?.array) && msgList.array.length > 50) {
                    msgList.array = msgList.array.slice(-50);
                } else if (Array.isArray(msgList) && msgList.length > 50) {
                    store.messages[jid] = msgList.slice(-50);
                }
            }
        }
        store?.writeToFile('./baileys_store_multi.json');
    } catch (_) {}
}, 120_000);
const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(text, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};
let selectedMethod = null;
let savedPhoneNumber = null;

async function connectToWhatsApp() {
    console.log("🔄 Iniciando módulo de conexão...");
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 Usando baileys v${version.join('.')}`);
    const isRegistered = Boolean(state.creds.registered || state.creds.me?.id);
    let useQR = selectedMethod === '1';
    let phoneNumber = savedPhoneNumber || (config.phoneNumber || config.pairingNumber || '').replace(/[^0-9]/g, '');

    if (!isRegistered && !selectedMethod && !phoneNumber) {
        const choice = await question("Como deseja conectar?\n1. QR Code\n2. Código de Pareamento\n> ");
        selectedMethod = choice.trim();
        if (selectedMethod === '1') {
            useQR = true;
        } else {
            const num = await question("Digite o número com DDD (ex: 551199999999): ");
            savedPhoneNumber = num.replace(/[^0-9]/g, '');
            phoneNumber = savedPhoneNumber;
        }
    } else if (phoneNumber && !selectedMethod) {
        selectedMethod = '2';
        useQR = false;
    }
    const conn = makeWASocket({
        version,
        logger: inspectorLogger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }).child({ level: "fatal" })),
        },
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        msgRetryCounterCache,
        maxMsgRetryCount: 1,
        retryRequestDelayMs: 2500,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        cachedGroupMetadata: async (jid) => {
            return await groupMetadataManager.getCachedGroupMetadata(jid, conn);
        },
        getMessage: async (key) => {
            if (key.remoteJid?.endsWith('@g.us')) {
                return undefined;
            }
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
            return undefined;
        }
    });
    store.bind(conn.ev);
    conn.store = store;
    global.botConn = conn;
    attachTrafficInspector(conn, inspectorLogPath);
    let pairingCodeRequested = false;
    const requestPairing = async () => {
        if (pairingCodeRequested || !phoneNumber || isRegistered) return;
        pairingCodeRequested = true;
        try {
            console.log("🚀 Solicitando código de pareamento para:", phoneNumber);
            const code = await conn.requestPairingCode(phoneNumber);
            if (code) {
                const formatted = code.match(/.{1,4}/g)?.join("-") || code;
                console.log("\n========================================");
                console.log("🔑 CÓDIGO DE PAREAMENTO: " + formatted);
                console.log("========================================\n");
                console.log("📲 Insira este código no WhatsApp para autenticar o bot.\n");
            } else {
                console.error("❌ Erro: O código retornado foi vazio.");
                pairingCodeRequested = false;
            }
        } catch (error) {
            console.error("❌ Falha ao solicitar código de pareamento:", error?.message || error);
            pairingCodeRequested = false;
        }
    };

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !isRegistered) {
            if (useQR) {
                if (qrcode) {
                    console.log("\n📲 Escaneie o QR Code abaixo para conectar:");
                    qrcode.generate(qr, { small: true });
                } else {
                    console.log("\n📲 QR Code disponível no socket.");
                    console.log("ℹ️ Para renderizar o QR gráfico no terminal, instale: npm install qrcode-terminal");
                }
            } else if (phoneNumber && !pairingCodeRequested) {
                setTimeout(requestPairing, 1000);
            }
        }
        if (connection === 'open') {
            console.log(`✅ [CONECTADO] ${config.botName || 'Bot'} está online!`);
            global.botOnline = true;
            if (state.creds.me?.id && state.creds.me?.lid) {
                lidCache.set(state.creds.me.id, state.creds.me.lid);
            }
            if (!state.creds.registered && state.creds.me?.id) {
                state.creds.registered = true;
                await saveCreds();
            }
            groupMetadataManager.syncAllGroups(conn).catch(() => {});
            try {
                const { startGroupScheduler } = require('./dados/funções/agendamentoGrupos');
                startGroupScheduler(conn);
            } catch (errSched) {
                console.error('Erro ao iniciar agendamento de grupos:', errSched);
            }
            try {
                const lembreteManager = require('./dados/funções/lembreteManager');
                lembreteManager.init(conn);
            } catch (errLemb) {
                console.error('Erro ao inicializar gerenciador de lembretes:', errLemb);
            }
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Conexão caiu. Motivo:`, lastDisconnect?.error?.message || lastDisconnect?.error);
            console.log(`❌ Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                console.log("⛔ Desconectado permanentemente. Apague a pasta 'auth_info_baileys' e reinicie.");
                process.exit(1);
            }
        }
    });
    conn.ev.on('creds.update', saveCreds);

    if (!isRegistered && !useQR && phoneNumber) {
        setTimeout(() => {
            if (!pairingCodeRequested) {
                requestPairing();
            }
        }, 5000);
    }

    conn.ev.on('groups.update', async (updates) => {
        for (const update of updates) {
            if (update && update.id) {
                const current = groupMetadataManager.get(update.id) || {};
                groupMetadataManager.set(update.id, { ...current, ...update });
            }
        }
    });
    conn.ev.on('group-participants.update', async (event) => {
        try {
            if (event && event.id && event.participants && event.action) {
                groupMetadataManager.updateParticipants(event.id, event.participants, event.action);
            }
            await gruposHandler(conn, event, config);
        } catch (e) {
            console.error("❌ Erro no handler de grupos:", e);
        }
    });
    conn.ev.on('messages.upsert', async (m) => {
        inspectUpsert(m, inspectorLogPath);
        const { messages, type } = m;
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.messageStubType === 2) {
                const from = msg.key?.remoteJid;
                if (from && from.endsWith('@g.us') && !msg.key?.fromMe) {
                    const participant = msg.key?.participant || msg.participant;
                    if (participant) {
                        try {
                            const cached = groupCache.get(from);
                            const grupoConfig = cached?.config || await Grupo.findOne({ groupId: from }).catch(() => null);
                            if (grupoConfig && (grupoConfig.antipg || grupoConfig.antispam || grupoConfig.antiflood?.enabled)) {
                                conn.sendMessage(from, {
                                    delete: {
                                        remoteJid: from,
                                        fromMe: false,
                                        id: msg.key.id,
                                        participant: participant
                                    }
                                }).catch(() => {});
                                const burstKey = `${from}:${participant}`;
                                let burst = undecryptedBurstMap.get(burstKey) || [];
                                const now = Date.now();
                                burst = burst.filter(t => now - t < 5000);
                                burst.push(now);
                                undecryptedBurstMap.set(burstKey, burst);
                                if (burst.length >= 3) {
                                    undecryptedBurstMap.delete(burstKey);
                                    await conn.groupParticipantsUpdate(from, [participant], 'remove').catch(() => {});
                                    const rawId = String(participant).split('@')[0].split(':')[0];
                                    await conn.sendMessage(from, {
                                        text: `🚫 *Proteção:* @${rawId} foi banido por enviar mensagens invisíveis / pacotes criptografados em rajada.`,
                                        mentions: [participant]
                                    }).catch(() => {});
                                }
                            }
                        } catch (_) {}
                    }
                }
                continue;
            }
            await mensagensHandler(conn, { messages: [msg], type: 'notify' }, config);
        }
    });
    return conn;
}
module.exports = connectToWhatsApp;
