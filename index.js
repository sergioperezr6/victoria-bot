// Victoria - agent-bot de IA para Chatwoot (gestoria TransferenciaDGT)
// Recibe eventos de Chatwoot por webhook, llama a Claude y responde.
// Relevo: Victoria atiende mientras la conversacion esta "pending".
// Si el cliente pide hablar con una persona (o el caso lo requiere),
// pasa la conversacion a "open" (entra Sergio). Cuando Sergio la deja
// otra vez en "pending", Victoria retoma con todo el historial.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const {
  PORT = 3000,
  CHATWOOT_BASE_URL,          // p.ej. https://victoria-chatwoot.veddzh.easypanel.host
  CHATWOOT_BOT_TOKEN,         // access token del Agent Bot (lo da Chatwoot al crearlo)
  ANTHROPIC_API_KEY,          // clave de Claude
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

// ---------- Utilidades Chatwoot ----------
function cwHeaders() {
  return { "Content-Type": "application/json", api_access_token: CHATWOOT_BOT_TOKEN };
}

async function getHistory(accountId, conversationId) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const res = await fetch(url, { headers: cwHeaders() });
  if (!res.ok) {
    console.error("Error leyendo historial:", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  const payload = data.payload || data.data?.payload || [];
  // message_type: 0=incoming(cliente), 1=outgoing(victoria/agente). Ignoramos notas/actividades.
  const msgs = payload
    .filter((m) => (m.message_type === 0 || m.message_type === 1) && m.content && !m.private)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
    .slice(-20)
    .map((m) => ({ role: m.message_type === 0 ? "user" : "assistant", content: String(m.content) }));
  return msgs;
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
  res.sendStatus(200); // responder rapido; procesamos en segundo plano
  handleEvent(req.body).catch((e) => console.error("Error en handleEvent:", e));
});
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  handleEvent(req.body).catch((e) => console.error("Error en handleEvent:", e));
});

async function handleEvent(body = {}) {
  const event = body.event;
  if (event !== "message_created") return;            // solo mensajes nuevos
  if (body.message_type !== "incoming") return;        // solo lo que escribe el cliente

  const accountId = body.account?.id;
  const conversation = body.conversation || {};
  const conversationId = conversation.id;
  const status = conversation.status; // 'pending' = Victoria al mando; 'open' = humano
  if (!accountId || !conversationId) return;

  // Victoria solo responde si la conversacion esta en manos del bot (pending).
  if (status && status !== "pending") {
    console.log(`Conversacion ${conversationId} en estado '${status}': Victoria no responde (humano al mando).`);
    return;
  }

  const history = await getHistory(accountId, conversationId);
  let reply = await askClaude(history);
  if (!reply) reply = "Perdona, no te he entendido bien. Me lo cuentas otra vez?";

  if (reply.includes("[[HANDOFF]]")) {
    reply = reply.replace(/\[\[HANDOFF\]\]/g, "").trim() ||
      "Te paso ahora mismo con un companero del equipo. Un momento, por favor.";
    await sendReply(accountId, conversationId, reply);
    await handoffToHuman(accountId, conversationId);
    console.log(`Conversacion ${conversationId}: relevo a humano.`);
    return;
  }

  await sendReply(accountId, conversationId, reply);
}

app.get("/", (_req, res) => res.send("Victoria bot OK"));
app.listen(PORT, () => console.log(`Victoria (agent-bot) escuchando en el puerto ${PORT}`));
