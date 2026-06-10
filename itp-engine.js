// ============================================================================
// MOTOR DE CÁLCULO DE ITP — Victoria / TransferenciaDGT  (v2, con catálogo)
// ----------------------------------------------------------------------------
// Base legal: Orden HAC/1501/2025 (precios medios 2026) + Anexo IV (depreciación).
// Catálogo de precios medios extraído del BOE → catalogo_min.json
//   filas: [marca, modelo, inicio, fin, tipo, kW, cv, valor]
//
// Flujo: buscarVehiculo() localiza el modelo exacto en el catálogo y devuelve su
// valor "a nuevo"; calcularITP() aplica depreciación y % de la CCAA.
//   valor fiscal = valor catálogo × % depreciación (Anexo IV)
//   base imponible = MAX(valor fiscal, precio declarado)
//   ITP = base × tipo CCAA del comprador
// Cero invención: si no hay match claro, se pide confirmación / lo ve el gestor.
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let CATALOGO = [];
try {
  CATALOGO = JSON.parse(fs.readFileSync(path.join(__dirname, "catalogo_min.json"), "utf8"));
  console.log(`Catálogo ITP cargado: ${CATALOGO.length} modelos.`);
} catch (e) {
  console.error("AVISO: no se pudo cargar catalogo_min.json:", e.message);
}

// --- Anexo IV: % sobre valor a nuevo según años de utilización --------------
const DEPRECIACION = [100, 84, 67, 56, 47, 39, 34, 28, 24, 19, 17, 13, 10];

// --- Tipos de ITP por CCAA (vehículos usados entre particulares), 2026 ------
const ITP_CCAA = {
  galicia: { general: 3, notas: "0% cero emisiones; cuota fija en turismos ≥15 años" },
  madrid: { general: 4, notas: "tipo único, sin recargo por potencia" },
  andalucia: { general: 4, notas: "1% cero emisiones; 8% turismos/todoterreno >15 CVf" },
  aragon: { general: 4, notas: "exento si >10 años o cilindrada ≤1.000 cm³" },
  asturias: { general: 4, notas: "8% turismos/4x4 >15 CVf" },
  baleares: { general: 4, notas: "8% >15 CVf; 0% cero emisiones; 2% ECO" },
  murcia: { general: 4, notas: "" },
  pais_vasco: { general: 4, notas: "régimen foral; deducciones cero emisiones" },
  la_rioja: { general: 4, notas: "" },
  cataluna: { general: 5, notas: "exención si >10 años y valor <40.000 €" },
  castilla_y_leon: { general: 5, notas: "8% turismos/4x4 >15 CVf" },
  cantabria: { general: 6, notas: "" },
  castilla_la_mancha: { general: 6, notas: "" },
  valenciana: { general: 6, notas: "" },
  extremadura: { general: 6, notas: "" },
  navarra: { general: 6, notas: "régimen foral" },
  canarias: { general: 6.5, notas: "NO es ITP: tributa por IGIC (6,5% particulares)" },
};

const MAPA_PROVINCIAS = {
  almeria:"andalucia",cadiz:"andalucia",cordoba:"andalucia",granada:"andalucia",huelva:"andalucia",jaen:"andalucia",malaga:"andalucia",sevilla:"andalucia",
  huesca:"aragon",teruel:"aragon",zaragoza:"aragon",asturias:"asturias",baleares:"baleares",illes_balears:"baleares",
  las_palmas:"canarias",santa_cruz_de_tenerife:"canarias",cantabria:"cantabria",
  avila:"castilla_y_leon",burgos:"castilla_y_leon",leon:"castilla_y_leon",palencia:"castilla_y_leon",salamanca:"castilla_y_leon",segovia:"castilla_y_leon",soria:"castilla_y_leon",valladolid:"castilla_y_leon",zamora:"castilla_y_leon",
  albacete:"castilla_la_mancha",ciudad_real:"castilla_la_mancha",cuenca:"castilla_la_mancha",guadalajara:"castilla_la_mancha",toledo:"castilla_la_mancha",
  barcelona:"cataluna",girona:"cataluna",lleida:"cataluna",tarragona:"cataluna",
  alicante:"valenciana",castellon:"valenciana",valencia:"valenciana",
  badajoz:"extremadura",caceres:"extremadura",
  a_coruna:"galicia",coruna:"galicia",lugo:"galicia",ourense:"galicia",pontevedra:"galicia",
  madrid:"madrid",murcia:"murcia",navarra:"navarra",
  alava:"pais_vasco",araba:"pais_vasco",guipuzcoa:"pais_vasco",gipuzkoa:"pais_vasco",vizcaya:"pais_vasco",bizkaia:"pais_vasco",
  la_rioja:"la_rioja",rioja:"la_rioja",ceuta:"ceuta_melilla",melilla:"ceuta_melilla",
};

// combustible (lo que dice el cliente) -> código del catálogo
const FUEL = {
  gasolina:"G", gas:"G", benzina:"G",
  diesel:"D", "diésel":"D", gasoil:"D", gasoleo:"D", "gasóleo":"D",
  electrico:"Elc", "eléctrico":"Elc", electrica:"Elc", bev:"Elc",
  glp:"S", gnc:"S",
  // híbrido: no forzamos código (hay GyE/DyE/PHEV/SyE) -> null = no filtrar
  hibrido:null, "híbrido":null, hev:null, phev:"PHEV", enchufable:"PHEV",
};

// --- utilidades -------------------------------------------------------------
function normaliza(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim().replace(/[\s\-]+/g, "_");
}
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function aniosUtilizacion(fechaPrimeraMatriculacion, fechaTransmision = new Date()) {
  if (!fechaPrimeraMatriculacion) return null;
  const f1 = new Date(fechaPrimeraMatriculacion), f2 = new Date(fechaTransmision);
  if (isNaN(f1) || isNaN(f2)) return null;
  let a = f2.getFullYear() - f1.getFullYear();
  const m = f2.getMonth() - f1.getMonth();
  if (m < 0 || (m === 0 && f2.getDate() < f1.getDate())) a--;
  return Math.max(0, a);
}
function porcentajeDepreciacion(anios) { return anios == null ? null : DEPRECIACION[Math.min(anios, 12)]; }

// ============================================================================
// BÚSQUEDA EN EL CATÁLOGO
// ============================================================================
// Devuelve los candidatos más probables para que Victoria los confirme.
// Parámetros: { marca, modelo, anio, combustible, potencia }
function buscarVehiculo({ marca, modelo, anio, combustible, potencia } = {}) {
  if (!CATALOGO.length) return { ok: false, error: "Catálogo no disponible." };
  const nmarca = normaliza(marca);
  const toks = norm(modelo).split(" ").filter(Boolean);
  const fcode = combustible != null ? FUEL[norm(combustible).replace(/ /g, "")] : undefined;
  const pot = potencia ? parseInt(String(potencia).replace(/[^0-9]/g, ""), 10) : null;
  const y = anio ? parseInt(String(anio).match(/\d{4}/)?.[0] || anio, 10) : null;

  let pool = CATALOGO.filter((r) => normaliza(r[0]) === nmarca);
  if (!pool.length) pool = CATALOGO.filter((r) => normaliza(r[0]).includes(nmarca) || nmarca.includes(normaliza(r[0])));

  const scored = [];
  for (const r of pool) {
    const [mk, mod, ini, fin, tipo, kw, cv, valor] = r;
    if (y) {
      if (ini && y < ini) continue;
      if (fin && y > fin + 1) continue;
    }
    if (fcode && tipo !== fcode) continue;
    const rt = new Set(norm(mod).split(" ").filter(Boolean));
    let score = toks.filter((t) => rt.has(t)).length;
    score -= Math.abs(rt.size - toks.length) * 0.05; // ligera penalización por longitud
    if (pot) {
      if (Math.abs(cv - pot) <= 3 || Math.abs(kw - pot) <= 3) score += 3;
      else if (Math.abs(cv - pot) <= 10 || Math.abs(kw - pot) <= 8) score += 1;
    }
    scored.push({ score, modelo: mod, inicio: ini, fin, tipo, kw, cv, valor });
  }
  if (!scored.length) return { ok: false, error: `Sin coincidencias para ${marca} ${modelo}${y ? " (" + y + ")" : ""}.`, candidatos: [] };
  scored.sort((a, b) => b.score - a.score || a.valor - b.valor);
  const candidatos = scored.slice(0, 6).map(({ score, ...c }) => c);
  const valores = scored.filter((s) => s.score === scored[0].score).map((s) => s.valor);
  return {
    ok: true,
    total: scored.length,
    candidatos,
    valorMin: Math.min(...valores),
    valorMax: Math.max(...valores),
    multiple: candidatos.length > 1 && new Set(candidatos.map((c) => c.valor)).size > 1,
  };
}

// ============================================================================
// CÁLCULO DEL ITP
// ============================================================================
function resolverCCAA(entrada) {
  const k = normaliza(entrada);
  if (ITP_CCAA[k]) return k;
  if (MAPA_PROVINCIAS[k]) return MAPA_PROVINCIAS[k];
  return null;
}
function calcularValorFiscal({ valorReferencia, fechaPrimeraMatriculacion, usoEspecial = false }) {
  if (!valorReferencia || valorReferencia <= 0) return null;
  const anios = aniosUtilizacion(fechaPrimeraMatriculacion);
  const pct = porcentajeDepreciacion(anios);
  if (pct == null) return null;
  let v = valorReferencia * (pct / 100);
  if (usoEspecial) v *= 0.7;
  return { valorFiscal: Math.round(v), anios, pctDepreciacion: pct };
}

// Parámetros: { precioVenta, ubicacion, valorReferencia?, fechaPrimeraMatriculacion?, usoEspecial? }
function calcularITP({ precioVenta, ubicacion, valorReferencia = null, precioMedioNuevo = null, fechaPrimeraMatriculacion = null, usoEspecial = false } = {}) {
  const avisos = [];
  const refNuevo = valorReferencia || precioMedioNuevo; // alias
  const ccaa = resolverCCAA(ubicacion);
  if (!ccaa) return { ok: false, error: `No reconozco la provincia/CCAA: "${ubicacion}".` };
  if (ccaa === "ceuta_melilla") return { ok: false, ccaa, error: "Ceuta/Melilla: régimen específico, lo confirma el gestor." };

  const tipoInfo = ITP_CCAA[ccaa];
  const tipo = tipoInfo.general;

  let vf = null;
  if (refNuevo && fechaPrimeraMatriculacion) vf = calcularValorFiscal({ valorReferencia: refNuevo, fechaPrimeraMatriculacion, usoEspecial });

  let base, origenBase;
  if (vf && vf.valorFiscal != null) {
    base = Math.max(vf.valorFiscal, precioVenta || 0);
    origenBase = base === vf.valorFiscal && base !== precioVenta ? "valor_fiscal" : "precio_venta";
  } else {
    if (!precioVenta || precioVenta <= 0) return { ok: false, ccaa, error: "Necesito el valor de referencia del modelo o el precio de venta." };
    base = precioVenta;
    origenBase = "precio_venta";
    avisos.push("Cálculo sobre el precio de venta (sin valor fiscal del modelo). El gestor confirma el importe exacto.");
  }
  const importe = Math.round(base * (tipo / 100) * 100) / 100;
  if (tipoInfo.notas) avisos.push(`Casos especiales en ${ccaa.replace(/_/g, " ")}: ${tipoInfo.notas} (lo confirma el gestor si aplica).`);

  return {
    ok: true, ccaa, tipo, base, origenBase,
    valorReferenciaNuevo: refNuevo || null,
    valorFiscal: vf ? vf.valorFiscal : null,
    aniosUso: vf ? vf.anios : aniosUtilizacion(fechaPrimeraMatriculacion),
    pctDepreciacion: vf ? vf.pctDepreciacion : null,
    importeITP: importe, avisos,
  };
}

// ============================================================================
// PRESUPUESTO DEFINITIVO DE TRANSFERENCIA  (tarifas confirmadas, Manual V4.4)
// ----------------------------------------------------------------------------
// La via depende de QUIEN VENDE:
//   A = vendedor profesional con factura (lleva IVA en factura -> SIN ITP)
//   B = particular a particular (con ITP)
//   C = asesoria / aseguradora colaboradora (con ITP)
// Vias A y C exigen prueba de la condicion (factura / acuerdo de colaboracion).
// Importes con IVA incluido. Cero invencion: si falta un dato, se pide o lo ve el gestor.
const TARIFA_TRANSFERENCIA = {
  A: {
    base: 100, llevaITP: false,
    etiqueta: "Vía A · vendedor profesional con factura",
    desglose: ["Servicio completo: 100 € (honorarios + IVA + tasas DGT, todo incluido)",
               "Sin ITP: al comprar a un profesional, el IVA va en su factura"],
  },
  B: {
    base: 146.45, llevaITP: true,
    etiqueta: "Vía B · particular a particular",
    desglose: ["Honorarios: 75 € + IVA (21%) 15,75 € = 90,75 €",
               "Tasa DGT (tasa oficial de Tráfico): 55,70 €"],
  },
  C: {
    base: 105, llevaITP: true,
    etiqueta: "Vía C · asesoría o aseguradora colaboradora",
    desglose: ["Servicio: 105 € (honorarios + IVA + tasa DGT, todo incluido)"],
  },
};

// Calcula el presupuesto definitivo de la transferencia: base de la via + ITP.
// Para B y C calcula el ITP internamente (necesita valorReferencia/fecha/ubicacion/precioVenta).
function presupuestoTransferencia({ via, valorReferencia = null, fechaPrimeraMatriculacion = null, ubicacion = null, precioVenta = null, usoEspecial = false } = {}) {
  const key = String(via || "").trim().toUpperCase();
  const t = TARIFA_TRANSFERENCIA[key];
  if (!t) return { ok: false, error: `Vía no válida: "${via}". Debe ser A (profesional con factura), B (particular) o C (asesoría/aseguradora).` };

  const desglose = [...t.desglose];
  let importeITP = 0;
  const avisos = [];
  let itpDetalle = null;

  if (t.llevaITP) {
    const r = calcularITP({ valorReferencia, fechaPrimeraMatriculacion, ubicacion, precioVenta, usoEspecial });
    if (!r.ok) return r; // falta provincia o precio, o CCAA no válida -> Victoria pide el dato
    importeITP = r.importeITP;
    itpDetalle = r;
    (r.avisos || []).forEach((a) => avisos.push(a));
    desglose.push(`ITP (impuesto autonómico que paga el comprador): ${importeITP} €`);
  }

  const total = Math.round((t.base + importeITP) * 100) / 100;
  return {
    ok: true,
    via: key,
    etiqueta: t.etiqueta,
    baseServicio: t.base,
    importeITP,
    total,
    desglose,
    itp: itpDetalle,
    avisos,
    nota: "Honorarios = nuestro trabajo; tasa DGT = tasa oficial de Tráfico; ITP = impuesto que pagas como comprador. El gestor confirma el importe final.",
  };
}

export { buscarVehiculo, calcularITP, presupuestoTransferencia, calcularValorFiscal, aniosUtilizacion, porcentajeDepreciacion, resolverCCAA, ITP_CCAA, DEPRECIACION, TARIFA_TRANSFERENCIA };
