// ============================================================================
// MOTOR DE CÁLCULO DE ITP — Victoria / TransferenciaDGT
// ----------------------------------------------------------------------------
// Base legal: Orden HAC/1501/2025 (precios medios 2026) + Anexo IV (depreciación,
// inalterado desde la Orden de 15/12/1998). ITP autonómico (Modelo 620).
//
// Fórmula:  base imponible = MAX(valor fiscal, precio declarado de venta)
//           ITP = base imponible × tipo de la CCAA del COMPRADOR
//   donde:  valor fiscal = precio medio "a nuevo" (Anexo I) × % depreciación (Anexo IV)
//
// FASE 1 (ahora): si no hay precio medio del modelo (Anexo I), la base = precio
//                 de venta. Cubre la mayoría de ventas reales (declarado ≥ fiscal).
// FASE 2 (después): se añade la tabla completa de precios medios → valor fiscal
//                   exacto y caso "declarado < fiscal".
//
// IMPORTANTE: cero invención. Cifras no confirmadas → las revisa el gestor.
// Revisión de tipos: anual (cuando cambie la Orden y/o normativa autonómica).
// ============================================================================

// --- Anexo IV: % sobre el valor a nuevo según años de utilización -----------
// Índice = años completos transcurridos desde la 1ª matriculación.
const DEPRECIACION = [
  100, // 0: hasta 1 año
  84,  // 1: de 1 a 2
  67,  // 2: de 2 a 3
  56,  // 3: de 3 a 4
  47,  // 4: de 4 a 5
  39,  // 5: de 5 a 6
  34,  // 6: de 6 a 7
  28,  // 7: de 7 a 8
  24,  // 8: de 8 a 9
  19,  // 9: de 9 a 10
  17,  // 10: de 10 a 11
  13,  // 11: de 11 a 12
  10,  // 12+: más de 12 años
];

// --- Tipos de ITP por CCAA (vehículos usados entre particulares), 2026 ------
// Fuente: tipos verificados con haciendas autonómicas (marzo 2026).
// 'general' = tipo por defecto. 'notas' = casos especiales que confirma el gestor.
// REVISAR CADA AÑO. provincia→CCAA en MAPA_PROVINCIAS.
const ITP_CCAA = {
  galicia:            { general: 3, notas: "0% cero emisiones; cuota fija en turismos ≥15 años" },
  madrid:             { general: 4, notas: "tipo único, sin recargo por potencia" },
  andalucia:          { general: 4, notas: "1% cero emisiones; 8% turismos/todoterreno >15 CVf" },
  aragon:             { general: 4, notas: "exento si >10 años o cilindrada ≤1.000 cm³" },
  asturias:           { general: 4, notas: "8% turismos/4x4 >15 CVf" },
  baleares:           { general: 4, notas: "8% >15 CVf; 0% cero emisiones; 2% ECO" },
  murcia:             { general: 4, notas: "" },
  pais_vasco:         { general: 4, notas: "régimen foral; deducciones cero emisiones/achatarramiento" },
  la_rioja:           { general: 4, notas: "" },
  cataluna:           { general: 5, notas: "exención si >10 años y valor <40.000 €" },
  castilla_y_leon:    { general: 5, notas: "8% turismos/4x4 >15 CVf" },
  cantabria:          { general: 6, notas: "" },
  castilla_la_mancha: { general: 6, notas: "" },
  valenciana:         { general: 6, notas: "" },
  extremadura:        { general: 6, notas: "" },
  navarra:            { general: 6, notas: "régimen foral" },
  canarias:           { general: 6.5, notas: "NO es ITP: tributa por IGIC (6,5% particulares)" },
};

// --- Provincia → CCAA (las 50 provincias + Ceuta/Melilla) -------------------
const MAPA_PROVINCIAS = {
  // Andalucía
  almeria:"andalucia", cadiz:"andalucia", cordoba:"andalucia", granada:"andalucia",
  huelva:"andalucia", jaen:"andalucia", malaga:"andalucia", sevilla:"andalucia",
  // Aragón
  huesca:"aragon", teruel:"aragon", zaragoza:"aragon",
  // Asturias
  asturias:"asturias",
  // Baleares
  baleares:"baleares", illes_balears:"baleares",
  // Canarias
  las_palmas:"canarias", santa_cruz_de_tenerife:"canarias",
  // Cantabria
  cantabria:"cantabria",
  // Castilla y León
  avila:"castilla_y_leon", burgos:"castilla_y_leon", leon:"castilla_y_leon",
  palencia:"castilla_y_leon", salamanca:"castilla_y_leon", segovia:"castilla_y_leon",
  soria:"castilla_y_leon", valladolid:"castilla_y_leon", zamora:"castilla_y_leon",
  // Castilla-La Mancha
  albacete:"castilla_la_mancha", ciudad_real:"castilla_la_mancha", cuenca:"castilla_la_mancha",
  guadalajara:"castilla_la_mancha", toledo:"castilla_la_mancha",
  // Cataluña
  barcelona:"cataluna", girona:"cataluna", lleida:"cataluna", tarragona:"cataluna",
  // Comunidad Valenciana
  alicante:"valenciana", castellon:"valenciana", valencia:"valenciana",
  // Extremadura
  badajoz:"extremadura", caceres:"extremadura",
  // Galicia
  a_coruna:"galicia", lugo:"galicia", ourense:"galicia", pontevedra:"galicia",
  // Madrid
  madrid:"madrid",
  // Murcia
  murcia:"murcia",
  // Navarra
  navarra:"navarra",
  // País Vasco
  alava:"pais_vasco", araba:"pais_vasco", guipuzcoa:"pais_vasco", gipuzkoa:"pais_vasco",
  vizcaya:"pais_vasco", bizkaia:"pais_vasco",
  // La Rioja
  la_rioja:"la_rioja", rioja:"la_rioja",
  // Ceuta y Melilla
  ceuta:"ceuta_melilla", melilla:"ceuta_melilla",
};

// --- utilidades -------------------------------------------------------------
function normaliza(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quita tildes
    .trim()
    .replace(/[\s\-]+/g, "_");
}

function aniosUtilizacion(fechaPrimeraMatriculacion, fechaTransmision = new Date()) {
  if (!fechaPrimeraMatriculacion) return null;
  const f1 = new Date(fechaPrimeraMatriculacion);
  const f2 = new Date(fechaTransmision);
  if (isNaN(f1) || isNaN(f2)) return null;
  let anios = f2.getFullYear() - f1.getFullYear();
  const m = f2.getMonth() - f1.getMonth();
  if (m < 0 || (m === 0 && f2.getDate() < f1.getDate())) anios--; // años completos
  return Math.max(0, anios);
}

function porcentajeDepreciacion(anios) {
  if (anios == null) return null;
  return DEPRECIACION[Math.min(anios, 12)];
}

// --- cálculo del valor fiscal (necesita precio medio del Anexo I) -----------
// usoEspecial: true si taxi/autoescuela/alquiler sin conductor (>6 meses) → ×0,70
function calcularValorFiscal({ precioMedioNuevo, fechaPrimeraMatriculacion, usoEspecial = false }) {
  if (!precioMedioNuevo || precioMedioNuevo <= 0) return null; // sin Anexo I (Fase 2)
  const anios = aniosUtilizacion(fechaPrimeraMatriculacion);
  const pct = porcentajeDepreciacion(anios);
  if (pct == null) return null;
  let valor = precioMedioNuevo * (pct / 100);
  if (usoEspecial) valor *= 0.70;
  return { valorFiscal: Math.round(valor), anios, pctDepreciacion: pct };
}

// --- resolución de CCAA y tipo ----------------------------------------------
function resolverCCAA(entrada) {
  const key = normaliza(entrada);
  if (ITP_CCAA[key]) return key;            // han dado la CCAA directamente
  if (MAPA_PROVINCIAS[key]) return MAPA_PROVINCIAS[key]; // han dado la provincia
  return null;
}

// ============================================================================
// FUNCIÓN PRINCIPAL
// ============================================================================
// Parámetros:
//   precioVenta                 (núm) precio declarado de la compraventa  [obligatorio]
//   ubicacion                   (str) provincia o CCAA del COMPRADOR      [obligatorio]
//   precioMedioNuevo            (núm) valor "a nuevo" del Anexo I          [opcional → Fase 2]
//   fechaPrimeraMatriculacion   (str) p.ej. "2021-03-04"                  [opcional]
//   usoEspecial                 (bool) taxi/autoescuela/alquiler           [opcional]
// Devuelve un objeto con el desglose y avisos. NO inventa nada que falte.
function calcularITP({
  precioVenta,
  ubicacion,
  precioMedioNuevo = null,
  fechaPrimeraMatriculacion = null,
  usoEspecial = false,
} = {}) {
  const avisos = [];

  const ccaa = resolverCCAA(ubicacion);
  if (!ccaa) {
    return { ok: false, error: `No reconozco la provincia/CCAA: "${ubicacion}". Necesito la del comprador.` };
  }
  if (ccaa === "ceuta_melilla") {
    return { ok: false, ccaa, error: "Ceuta/Melilla tienen régimen específico: lo confirma el gestor." };
  }

  const tipoInfo = ITP_CCAA[ccaa];
  const tipo = tipoInfo.general;

  // valor fiscal (solo si tenemos el precio medio del Anexo I)
  let vf = null;
  if (precioMedioNuevo && fechaPrimeraMatriculacion) {
    vf = calcularValorFiscal({ precioMedioNuevo, fechaPrimeraMatriculacion, usoEspecial });
  }

  // base imponible
  let base, origenBase;
  if (vf && vf.valorFiscal != null) {
    base = Math.max(vf.valorFiscal, precioVenta || 0);
    origenBase = base === vf.valorFiscal && base !== precioVenta ? "valor_fiscal" : "precio_venta";
  } else {
    if (!precioVenta || precioVenta <= 0) {
      return { ok: false, ccaa, error: "Necesito el precio de venta para calcular el ITP." };
    }
    base = precioVenta;
    origenBase = "precio_venta";
    avisos.push(
      "Cálculo sobre el precio de venta. Si el valor oficial de Hacienda (según modelo) " +
      "fuese mayor, el ITP podría subir; el gestor lo confirma."
    );
  }

  const importe = Math.round(base * (tipo / 100) * 100) / 100;

  if (tipoInfo.notas) {
    avisos.push(`Casos especiales en ${ccaa.replace(/_/g, " ")}: ${tipoInfo.notas} (lo confirma el gestor si aplica).`);
  }

  return {
    ok: true,
    ccaa,
    tipo,
    base,
    origenBase,                       // "valor_fiscal" | "precio_venta"
    valorFiscal: vf ? vf.valorFiscal : null,
    aniosUso: vf ? vf.anios : aniosUtilizacion(fechaPrimeraMatriculacion),
    pctDepreciacion: vf ? vf.pctDepreciacion : null,
    importeITP: importe,
    avisos,
  };
}

export { calcularITP, calcularValorFiscal, aniosUtilizacion, porcentajeDepreciacion, resolverCCAA, ITP_CCAA, DEPRECIACION };
