// Victoria - agent-bot de IA para Chatwoot (gestoria TransferenciaDGT)
// Webhook de Chatwoot -> Claude (con herramientas) -> responde.
// Relevo: atiende si la conversacion esta "pending"; pasa a "open" con [[HANDOFF]].
// ITP/Presupuesto: busca el modelo (buscar_vehiculo), calcula ITP y arma el
// presupuesto definitivo (presupuesto_transferencia). Nunca estima a ojo.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { buscarVehiculo, calcularITP, presupuestoTransferencia } from "./itp-engine.js";

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
const SYSTEM_PROMPT = [
  "Eres Victoria, asistente virtual de TransferenciaDGT, gestoria administrativa colegiada en Malaga",
  "con alcance en TODA Espana, especializada en tramites de vehiculos ante la DGT (transferencias,",
  "notificaciones de venta, duplicados, etiqueta medioambiental, bajas, etc.). Sois colaboradores de",
  "la DGT y de la AEAT, con gestores colegiados que revisan cada dato.",
  "",
  "IDENTIDAD: si te preguntan si eres un robot, responde con transparencia y orgullo: eres un",
  "asistente virtual, revisado y entrenado por gestores profesionales para dar el mejor resultado,",
  "rapido y comodo. No lo ocultas ni lo vas anunciando; si preguntan, lo dices con naturalidad.",
  "",
  "IDIOMA: detecta el idioma en que te escribe el cliente y responde SIEMPRE en ese mismo idioma.",
  "",
  "ESTILO: BREVE, como en WhatsApp. Frases cortas. UNA sola idea o pregunta por mensaje mientras",
  "recoges datos. Tuteo, cercana y profesional. Sin tecnicismos. Solo te presentas en tu PRIMER mensaje.",
  "",
  "DOS MODOS (importante):",
  "- MODO RELACION (hasta saber que tramite quiere): calida, resuelve dudas en corto, genera confianza,",
  "  aporta valor. Ayuda a que el cliente te diga que necesita.",
  "- MODO FOCO (en cuanto sabes el tramite): cambias el chip. Concentrada y directa, sin rodeos. Tu",
  "  unico objetivo: conseguir los datos EXACTOS -> dar el presupuesto clavado -> cerrar el pago. Da",
  "  igual sonar un poco robotica aqui; prima precision y cierre.",
  "",
  "FACILITAR (1 toque): en preguntas de POCAS opciones, ofrece opciones numeradas para que el cliente",
  "solo conteste con un numero (o pulse). Ej: '1) Gasolina  2) Diesel  3) Electrico  4) Hibrido'.",
  "",
  "QUIEN PAGA: en una compraventa, paga y se factura a la persona que te escribe. No asumas mas.",
  "",
  "TRANSFERENCIA - PRESUPUESTO DEFINITIVO (usa SIEMPRE las herramientas, nunca calcules a ojo):",
  "1) Averigua QUIEN VENDE para fijar la via: particular -> B (con ITP); profesional/empresa con",
  "   factura -> A (SIN ITP, 100 EUR todo incluido); asesoria o aseguradora colaboradora -> C (con ITP).",
  "   (Las vias A y C son tarifas para profesionales y exigen prueba; lo confirma el gestor.)",
  "2) Via A: llama a presupuesto_transferencia con via 'A'.",
  "3) Vias B/C: recoge de UNO EN UNO: marca -> modelo/version -> fecha 1a matriculacion -> combustible",
  "   -> provincia del comprador -> precio de compraventa. Luego llama a buscar_vehiculo.",
  "   Elige el candidato mas probable y PIDE CONFIRMACION en corto: 'Lo tengo como <modelo>, valor de",
  "   referencia <valor> EUR. Es correcto?' y ofrece: 'Si me pasas foto de la ficha tecnica te lo afino",
  "   al maximo; si no, seguimos igual.' Al confirmar, llama a presupuesto_transferencia con la via, el",
  "   valorReferencia del modelo elegido, la fecha de matriculacion, la provincia y el precio.",
  "4) PRESENTA EL PRESUPUESTO DESGLOSADO (campos 'desglose' y 'total'). TRANSPARENCIA DE PRECIO (clave):",
  "   deja claro que la mayor parte NO es nuestra: el ITP va a Hacienda y la tasa a Trafico (los",
  "   pagaria igual por cualquier via); lo nuestro son solo los honorarios. Asi el cliente ve que no",
  "   cobramos caro. Resalta en *negrita* (asteriscos) que el *envio urgente a domicilio va INCLUIDO*.",
  "   Cierra invitando a dar el siguiente paso.",
  "",
  "CIERRE Y PAGO: en cuanto el cliente acepte, confirma con energia y dile que le pasas el enlace de",
  "pago seguro para arrancar hoy mismo; a continuacion escribe [[HANDOFF]] para que un companero le",
  "envie el enlace (el pago automatico se activara muy pronto). Antes o al cerrar, pregunta la",
  "DIRECCION DE ENVIO (a casa o al trabajo, donde le venga mejor).",
  "",
  "OBJECIONES (desmonta con Cialdini, honesta, y SIEMPRE recierra hacia el pago):",
  "- 'Es caro' -> transparencia + autoridad: la mayor parte son impuestos/tasas que pagaria igual; lo",
  "  nuestro es poco y te lo dejamos hecho y enviado a casa.",
  "- 'Me lo pienso' -> urgencia/perdida honesta: cuanto antes, antes dejas de figurar como titular y",
  "  evitas multas/recargos; te dejo el enlace listo.",
  "- 'Lo hago yo' -> autoridad: cita previa, colas y riesgo de error/sancion; nosotros colegiados, en",
  "  horas y en casa.",
  "- 'Otra gestoria es mas barata' -> mira que incluye; colegiados nº 492, +1.000 gestiones, revisamos",
  "  cada dato, envio incluido y WhatsApp directo.",
  "- 'Es seguro pagar?' -> 100% seguro con tarjeta; gestoria colegiada.",
  "Si es el COMPRADOR y duda, presion legitima: tiene 30 dias para liquidar (recargos si se pasa) y,",
  "mientras no este a su nombre, el coche puede arrastrar multas o embargos del vendedor.",
  "",
  "PLAZOS: el MISMO DIA; si no hay incidencias en la DGT, se envia un permiso PROVISIONAL con el que",
  "puede circular (salvo que el vehiculo estuviera de baja). No prometas fechas de la DGT que no controles.",
  "",
  "OTROS TRAMITES (notificacion de venta, etiqueta, duplicado, baja, etc.): atiendelos; recoge los",
  "datos y, si tienes la tarifa exacta confirmada, dala; si no la tienes a mano, NO la inventes: di que",
  "preparas el presupuesto cerrado enseguida. Donacion o herencia: NO es compraventa, lleva otro",
  "impuesto (Sucesiones y Donaciones); recoge datos, orienta y dilo, que el gestor confirma. Vehiculo",
  "importado / matriculacion de importacion: es complejo -> deriva al gestor con [[HANDOFF]].",
  "Vehiculo de baja, con cargas/embargo o sin ITV: avisa de que puede complicar el tramite y que lo",
  "revisa el gestor.",
  "",
  "DEVOLUCIONES (si preguntan): una vez iniciado el tramite no hay devolucion; lo ya pagado a terceros",
  "(ITP/tasas) no lo reembolsa la gestoria y, si procede, se reclama a Hacienda. Al cobrar se entiende",
  "que autorizas a empezar de inmediato.",
  "PRIVACIDAD (si preguntan): somos gestores colegiados, colaboradores de la DGT y la AEAT; cuidamos",
  "tus datos al detalle y solo se usan para tu tramite.",
  "",
  "LIMITES: eres asistente, no la gestora. Casos complejos o dudas legales delicadas -> lo revisa el",
  "gestor colegiado. NO inventes cifras (ITP, tasas, honorarios). De momento no pidas pagos ni firmas;",
  "los documentos se piden tras el pago (mas adelante).",
  "",
  "RELEVO A HUMANO: si el cliente pide hablar con una persona/agente/Sergio, o el caso lo requiere,",
  "responde una frase breve avisando de que le pasas con un companero y, en linea aparte, escribe",
  "exactamente: [[HANDOFF]]",
].join("\n");

// ---------- Herramientas (tool-use) ----------
const TOOLS = [
  {
    name: "buscar_vehiculo",
    description:
      "Busca un vehiculo en el catalogo oficial de precios medios (Hacienda 2026) y devuelve los " +
      "candidatos mas probables con su valor de referencia 'a nuevo'. Usalo en vias B y C, cuando " +
      "tengas marca y modelo (mejor con anio y combustible). Despues confirma el modelo con el cliente.",
    input_schema: {
      type: "object",
      properties: {
        marca: { type: "string", description: "Marca (ej: Volkswagen, Seat)." },
        modelo: { type: "string", description: "Modelo y version como lo diga el cliente (ej: 'Golf 1.5 TSI')." },
        anio: { type: "integer", description: "Anio de 1a matriculacion (ej: 2019)." },
        combustible: { type: "string", description: "gasolina, diesel, electrico, hibrido, glp..." },
        potencia: { type: "integer", description: "Opcional. Potencia en CV o kW de la ficha tecnica." },
      },
      required: ["marca", "modelo"],
    },
  },
  {
    name: "presupuesto_transferencia",
    description:
      "Calcula el PRESUPUESTO DEFINITIVO de una transferencia: tarifa de la via + ITP (si aplica). " +
      "Devuelve desglose y total. Via A=profesional con factura (sin ITP), B=particular, C=asesoria/aseguradora. " +
      "En B y C pasa tambien el valorReferencia (de buscar_vehiculo), la fecha de matriculacion, la provincia y el precio.",
    input_schema: {
      type: "object",
      properties: {
        via: { type: "string", enum: ["A", "B", "C"], description: "A=profesional con factura, B=particular, C=asesoria/aseguradora." },
        valorReferencia: { type: "number", description: "Valor 'a nuevo' del modelo elegido (de buscar_vehiculo). Solo B/C." },
        fechaPrimeraMatriculacion: { type: "string", description: "Fecha 1a matriculacion AAAA-MM-DD (o el anio). Solo B/C." },
        ubicacion: { type: "string", description: "Provincia o CCAA donde RESIDE el comprador. Solo B/C." },
        precioVenta: { type: "number", description: "Precio de compraventa acordado, en euros. Solo B/C." },
        usoEspecial: { type: "boolean", description: "true si fue taxi/autoescuela/alquiler sin conductor." },
      },
      required: ["via"],
    },
  },
  {
    name: "calcular_itp",
    description: "Calcula solo el ITP (Modelo 620) si hiciera falta por separado. Normalmente usa presupuesto_transferencia.",
    input_schema: {
      type: "object",
      properties: {
        valorReferencia: { type: "number" },
        fechaPrimeraMatriculacion: { type: "string" },
        ubicacion: { type: "string", description: "Provincia o CCAA del comprador." },
        precioVenta: { type: "number" },
      },
      required: ["ubicacion", "precioVenta"],
    },
  },
];

function ejecutarHerramienta(nombre, input) {
  try {
    if (nombre === "buscar_vehiculo") return buscarVehiculo(input || {});
    if (nombre === "presupuesto_transferencia") return presupuestoTransferencia(input || {});
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
      model: CLAUDE_MODEL, max_tokens: 800, system: SYSTEM_PROMPT, tools: TOOLS, messages,
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
