// Victoria - agent-bot de IA para Chatwoot (gestoria TransferenciaDGT)
// Webhook de Chatwoot -> Claude (con herramientas) -> responde.
// Relevo: atiende si la conversacion esta "pending"; pasa a "open" con [[HANDOFF]].
// ITP: busca el modelo en el catalogo oficial (buscar_vehiculo) y calcula con
// calcular_itp. Nunca estima a ojo.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { buscarVehiculo, calcularITP } from "./itp-engine.js";

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
const SYSTEM_PROMPT = `Eres Victoria, asistente de TransferenciaDGT, gestoria administrativa colegiada en Malaga
con alcance en toda Espana, especializada en tramites de vehiculos ante la DGT (transferencias,
notificaciones de venta, duplicados, etiqueta, etc.). Sois colaboradores de la DGT y la AEAT.

ESTILO (MUY IMPORTANTE): BREVE. Hablas como en WhatsApp: frases cortas, directas, sin parrafos.
- UNA sola idea o pregunta por mensaje. Nada de discursos ni listas largas.
- Tuteo, cercana y profesional. Sin tecnicismos. Maximo 2-3 frases por mensaje.
- Solo te presentas en tu PRIMER mensaje. Despues, al grano.
- Persuades con honestidad y sin agobiar: recuerdas en una linea el riesgo real (multas, seguir
  como titular) y que lo dejais resuelto rapido. Sin exagerar.

OBJETIVO: identificar rapido el tramite, resolver dudas en corto, dar el presupuesto y cerrar (que
contrate y pague). No te enrolles.

CALCULO DEL ITP (transferencia entre particulares) — usa SIEMPRE las herramientas, nunca calcules a ojo:
1) Recoge los datos de UNO EN UNO (una pregunta por mensaje, en este orden):
   marca -> modelo/version -> fecha 1a matriculacion -> combustible -> provincia del comprador -> precio de compraventa.
2) Con marca+modelo+anio+combustible (y potencia si la dice), llama a "buscar_vehiculo".
3) Elige el candidato mas probable y PIDE CONFIRMACION al cliente en corto:
   "Lo tengo como <modelo>, valor de referencia <valor> €. ¿Es correcto?"
   Y ofrece: "Si me pasas foto de la ficha tecnica te lo afino al maximo; si no, seguimos igual."
4) Cuando confirme (o corrija), llama a "calcular_itp" con el valor de referencia del modelo elegido,
   la fecha de 1a matriculacion, la provincia y el precio.
5) Da el ITP en corto e incluye los avisos que devuelva la herramienta. El gestor confirma el importe final.
Si "buscar_vehiculo" no encuentra el modelo o hay dudas, pide el dato que falte o di que lo concreta el gestor.
Recuerda que ademas del ITP van las tasas de la DGT y los honorarios (esas cifras las da el presupuesto/gestor).

NO inventes cifras (ITP, tasas, honorarios). Si no tienes el dato, dilo y ofrece el presupuesto cerrado.

LIMITES: eres asistente, no la gestora. Casos complejos o dudas legales -> lo revisa el gestor colegiado.
No pidas documentos, pagos ni firmas todavia (fase posterior). Plazos: orientativos, no prometas fechas.

RELEVO A HUMANO: si el cliente pide hablar con una persona/agente/Sergio, responde una frase breve
avisando de que le pasas con un companero y, en linea aparte, escribe exactamente: [[HANDOFF]]
No escribas [[HANDOFF]] en ningun otro caso.`;

// ---------- Herramientas (tool-use) ----------
const TOOLS = [
  {
    name: "buscar_vehiculo",
    description:
      "Busca un vehiculo en el catalogo oficial de precios medios (Hacienda 2026) y devuelve los " +
      "candidatos mas probables con su valor de referencia 'a nuevo'. Usalo cuando tengas marca, " +
      "modelo y, a ser posible, anio y combustible. Despues confirma el modelo con el cliente.",
    input_schema: {
      type: "object",
      properties: {
        marca: { type: "string", description: "Marca del vehiculo (ej: Volkswagen, Seat)." },
        modelo: { type: "string", description: "Modelo y version tal como lo diga el cliente (ej: 'Golf 1.5 TSI')." },
        anio: { type: "integer", description: "Anio de 1a matriculacion (ej: 2019)." },
        combustible: { type: "string", description: "gasolina, diesel, electrico, hibrido, glp..." },
        potencia: { type: "integer", description: "Opcional. Potencia en CV o kW de la ficha tecnica." },
      },
      required: ["marca", "modelo"],
    },
  },
  {
    name: "calcular_itp",
    description:
      "Calcula el ITP (Modelo 620) de una compraventa entre particulares. Usalo tras confirmar el " +
      "modelo con el cliente. Pasa el valor de referencia del modelo elegido (de buscar_vehiculo).",
    input_schema: {
      type: "object",
      properties: {
        valorReferencia: { type: "number", description: "Valor 'a nuevo' del modelo elegido (de buscar_vehiculo)." },
        fechaPrimeraMatriculacion: { type: "string", description: "Fecha 1a matriculacion AAAA-MM-DD (o el anio)." },
        ubicacion: { type: "string", description: "Provincia o CCAA donde RESIDE el comprador." },
        precioVenta: { type: "number", description: "Precio de compraventa acordado, en euros." },
        usoEspecial: { type: "boolean", description: "true si fue taxi/autoescuela/alquiler sin conductor." },
      },
      required: ["ubicacion", "precioVenta"],
    },
  },
];

function ejecutarHerramienta(nombre, input) {
  try {
    if (nombre === "buscar_vehiculo") return buscarVehiculo(input || {});
    if (nombre === "calcular_itp") return calcularITP(input || {});
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  return { ok: false, error: `Herramienta desconocida: ${nombre}` };
}

// ---------- Memoria de conversacion (en RAM, por conversation_id) ----------
const HISTORY = new Map();
const MAX_TURNS = 24;
function normalizeType(t) {
  if (t === 0 || t === "incoming" || t === "0") return "user";
  if (t === 1 || t === "outgoing" || t === "1") return "assistant";
  return null;
}
function getMem(id) { if (!HISTORY.has(id)) HISTORY.set(id, []); return HISTORY.get(id); }
function pushMem(id, role, content) {
  const h = getMem(id); const last = h[h.length - 1];
  if (last && last.role === role && last.content === content) return;
  h.push({ role, content }); while (h.length > MAX_TURNS) h.shift();
}
function seedFromPayload(id, conversation) {
  const h = getMem(id); if (h.length > 0) return;
  const msgs = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
  for (const m of msgs) {
    const role = normalizeType(m.message_type);
    if (role && m.content && !m.private) pushMem(id, role, String(m.content));
  }
}

// ---------- Utilidades Chatwoot ----------
function cwHeaders() { return { "Content-Type": "application/json", api_access_token: CHATWOOT_BOT_TOKEN }; }
async function sendReply(accountId, conversationId, content) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const res = await fetch(url, { method: "POST", headers: cwHeaders(), body: JSON.stringify({ content, message_type: "outgoing" }) });
  if (!res.ok) console.error("Error enviando respuesta:", res.status, await res.text());
}
async function handoffToHuman(accountId, conversationId) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;
  const res = await fetch(url, { method: "POST", headers: cwHeaders(), body: JSON.stringify({ status: "open" }) });
  if (!res.ok) console.error("Error en handoff:", res.status, await res.text());
}

// ---------- Cerebro: Claude (con herramientas) ----------
async function askClaude(history) {
  const messages = (history.length ? history : [{ role: "user", content: "Hola" }]).map((m) => ({ role: m.role, content: m.content }));
  for (let paso = 0; paso < 6; paso++) {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 700, system: SYSTEM_PROMPT, tools: TOOLS, messages,
    });
    if (msg.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: msg.content });
      const toolResults = [];
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const resultado = ejecutarHerramienta(block.name, block.input);
          console.log(`Herramienta ${block.name}(${JSON.stringify(block.input)})`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(resultado) });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }
  return "";
}

// ---------- Webhook de Chatwoot ----------
app.post("/", (req, res) => { res.sendStatus(200); handleEvent(req.body).catch((e) => console.error("Error en handleEvent:", e)); });
app.post("/webhook", (req, res) => { res.sendStatus(200); handleEvent(req.body).catch((e) => console.error("Error en handleEvent:", e)); });

async function handleEvent(body = {}) {
  if (body.event !== "message_created") return;
  if (body.message_type !== "incoming") return;
  const accountId = body.account?.id;
  const conversation = body.conversation || {};
  const conversationId = conversation.id;
  const status = conversation.status;
  if (!accountId || !conversationId) return;
  const text = body.content;
  if (!text) return;

  if (status && status !== "pending") {
    console.log(`Conversacion ${conversationId} en '${status}': Victoria calla.`);
    seedFromPayload(conversationId, conversation);
    pushMem(conversationId, "user", text);
    return;
  }
  seedFromPayload(conversationId, conversation);
  pushMem(conversationId, "user", text);
  const history = getMem(conversationId);

  let reply = await askClaude(history);
  if (!reply) reply = "Perdona, no te he entendido bien. Me lo cuentas otra vez?";

  if (reply.includes("[[HANDOFF]]")) {
    reply = reply.replace(/\[\[HANDOFF\]\]/g, "").trim() || "Te paso ahora mismo con un companero del equipo. Un momento, por favor.";
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
