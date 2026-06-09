// Victoria - agent-bot de IA para Chatwoot (gestoria TransferenciaDGT)
// Recibe eventos de Chatwoot por webhook, llama a Claude y responde.
// Relevo: Victoria atiende mientras la conversacion esta "pending".
// Si el cliente pide una persona (o el caso lo requiere), pasa a "open"
// (entra el humano). Al volver a "pending", Victoria retoma con su memoria.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const {
  PORT = 3000,
  CHATWOOT_BASE_URL,
  CHATWOOT_BOT_TOKEN,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = "claude-sonnet-4-6",
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- Personalidad e instrucciones de Victoria ----------
const SYSTEM_PROMPT = `Eres Victoria, la asistente virtual de TransferenciaDGT, una gestoria administrativa
colegiada en Malaga con alcance en toda Espana, especializada en tramites de vehiculos y
conductores ante la DGT (transferencias / cambios de titularidad, duplicados, permisos, etc.).

TONO Y ESTILO
- Hablas siempre de tu (tuteo), con cercania, calidez y profesionalidad.
- Mensajes breves y claros, como en un chat de WhatsApp. Nada de parrafos largos ni tecnicismos.
- Explicas las cosas de forma sencilla, como a alguien sin conocimientos.
- Transmites seguridad y confianza.
- IMPORTANTE: solo te presentas ("Soy Victoria...") en tu PRIMER mensaje de la conversacion.
  Despues NO vuelvas a presentarte; continua la conversacion de forma natural.

OBJETIVO
- Recibir al cliente, entender que tramite necesita y resolver sus dudas.
- Aportar valor y guiar hacia la contratacion, persuadiendo con los principios de Cialdini
  (reciprocidad, prueba social, autoridad como gestoria colegiada, escasez/urgencia real,
  coherencia y simpatia) de forma natural y honesta, nunca agresiva.
- Recoger los datos necesarios para preparar un presupuesto.

PRESUPUESTO
- El precio se compone de: tasas DGT + honorarios + ITP (si aplica) + 21% IVA solo sobre honorarios.
- NO te inventes cifras de tasas, honorarios ni ITP. Si no tienes el dato exacto, dilo con
  naturalidad y explica que preparas el presupuesto cerrado y se lo confirmas enseguida.
- Para una transferencia, pide: tipo de vehiculo, matricula o marca/modelo y ano, si comprador
  y vendedor son particulares o empresa, y la provincia.

LIMITES
- Eres asistente, no la gestora. Para precios exactos, casos complejos o dudas legales delicadas,
  indica que lo revisa el gestor colegiado.
- No prometas plazos concretos de la DGT si no los tienes; habla de plazos orientativos.
- De momento NO pidas documentos, pagos ni firmas (eso llega en una fase posterior). Tu papel
  ahora es atender, informar y recoger datos para el presupuesto.

RELEVO A HUMANO (IMPORTANTE)
- Si el cliente pide expresamente hablar con una persona / un agente / Sergio, o el caso necesita
  intervencion humana, responde SOLO con una frase breve avisando de que le pasas con un companero,
  y a continuacion, en una linea aparte, escribe exactamente: [[HANDOFF]]
- No escribas [[HANDOFF]] en ningun otro caso.`;

// ---------- Memoria de conversacion (en RAM, por conversation_id) ----------
// Los bots de Chatwoot NO pueden leer el historial por API (401), asi que
// Victoria lleva su propia memoria de cada conversacion.
const HISTORY = new Map();        // conversationId -> [{role, content}]
const MAX_TURNS = 24;

function normalizeType(t) {
  if (t === 0 || t === "incoming" || t === "0") return "user";
  if (t === 1 || t === "outgoing" || t === "1") return "assistant";
  return null; // notas, actividades, plantillas...
}

function getMem(conversationId) {
  if (!HISTORY.has(conversationId)) HISTORY.set(conversationId, []);
  return HISTORY.get(conversationId);
}

function pushMem(conversationId, role, content) {
  const h = getMem(conversationId);
  const last = h[h.length - 1];
  if (last && last.role === role && last.content === content) return; // evita duplicados
  h.push({ role, content });
  while (h.length > MAX_TURNS) h.shift();
}

function seedFromPayload(conversationId, conversation) {
  const h = getMem(conversationId);
  if (h.length > 0) return;
  const msgs = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
  for (const m of msgs) {
    const role = normalizeType(m.message_type);
    if (role && m.content && !m.private) pushMem(conversationId, role, String(m.content));
  }
}

// ---------- Utilidades Chatwoot ----------
function cwHeaders() {
  return { "Content-Type": "application/json", api_access_token: CHATWOOT_BOT_TOKEN };
}

async function sendReply(accountId, conversationId, content) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: cwHeaders(),
    body: JSON.stringify({ content, message_type: "outgoing" }),
  });
  if (!res.ok) console.error("Error enviando respuesta:", res.status, await res.text());
}

async function handoffToHuman(accountId, conversationId) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;
  const res = await fetch(url, {
    method: "POST",
    headers: cwHeaders(),
    body: JSON.stringify({ status: "open" }),
  });
  if (!res.ok) console.error("Error en handoff:", res.status, await res.text());
}

// ---------- Cerebro: Claude ----------
async function askClaude(history) {
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: history.length ? history : [{ role: "user", content: "Hola" }],
  });
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------- Webhook de Chatwoot ----------
app.post("/", (req, res) => {
  res.sendStatus(200);
  handleEvent(req.body).catch((e) => console.error("Error en handleEvent:", e));
});
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  handleEvent(req.body).catch((e) => console.error("Error en handleEvent:", e));
});

async function handleEvent(body = {}) {
  if (body.event !== "message_created") return;       // solo mensajes nuevos
  if (body.message_type !== "incoming") return;        // solo lo que escribe el cliente

  const accountId = body.account?.id;
  const conversation = body.conversation || {};
  const conversationId = conversation.id;
  const status = conversation.status; // 'pending' = Victoria al mando; 'open' = humano
  if (!accountId || !conversationId) return;

  const text = body.content;
  if (!text) return;

  // Victoria solo responde si la conversacion esta en manos del bot (pending).
  if (status && status !== "pending") {
    console.log(`Conversacion ${conversationId} en estado '${status}': Victoria calla (humano al mando).`);
    seedFromPayload(conversationId, conversation);
    pushMem(conversationId, "user", text); // guarda contexto para cuando retome
    return;
  }

  seedFromPayload(conversationId, conversation);
  pushMem(conversationId, "user", text);
  const history = getMem(conversationId);

  let reply = await askClaude(history);
  if (!reply) reply = "Perdona, no te he entendido bien. Me lo cuentas otra vez?";

  if (reply.includes("[[HANDOFF]]")) {
    reply = reply.replace(/\[\[HANDOFF\]\]/g, "").trim() ||
      "Te paso ahora mismo con un companero del equipo. Un momento, por favor.";
    pushMem(conversationId, "assistant", reply);
    await sendReply(accountId, conversationId, reply);
    await handoffToHuman(accountId, conversationId);
    console.log(`Conversacion ${conversationId}: relevo a humano.`);
    return;
  }

  pushMem(conversationId, "assistant", reply);
  await sendReply(accountId, conversationId, reply);
}

app.get("/", (_req, res) => res.send("Victoria bot OK"));
app.listen(PORT, () => console.log(`Victoria (agent-bot) escuchando en el puerto ${PORT}`));
