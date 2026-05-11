const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Utilidad: leer body de la petición ───────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// ─── Validar y parsear dimensiones ────────────────────────────────────────────
function validarDimensiones({ largo, ancho, prof }) {
  const l = parseFloat(largo);
  const a = parseFloat(ancho);
  const p = parseFloat(prof);

  if (isNaN(l) || l <= 0 || l > 100)
    throw new Error("Largo inválido (debe ser entre 0.1 y 100 metros).");
  if (isNaN(a) || a <= 0 || a > 100)
    throw new Error("Ancho inválido (debe ser entre 0.1 y 100 metros).");
  if (isNaN(p) || p <= 0 || p > 100)
    throw new Error("Profundidad inválida (debe ser entre 1 y 100 cm).");

  return { l, a, p };
}

// ─── Extraer el primer objeto JSON válido de un string ────────────────────────
function extraerJSON(texto) {
  // Limpiar bloques markdown si el modelo los usa
  texto = texto.replace(/```(?:json)?/gi, "").trim();

  // Buscar inicio del objeto: tolera {"opciones", { "opciones", espacios varios
  let inicio = -1;
  const patterns = ['{"opciones"', '{ "opciones"'];
  for (const p of patterns) {
    const idx = texto.indexOf(p);
    if (idx !== -1) { inicio = idx; break; }
  }
  // Fallback: cualquier { que contenga "opciones" cerca
  if (inicio === -1) {
    const m = texto.match(/\{[\s\S]{0,20}"opciones"/);
    if (m) inicio = texto.indexOf(m[0]);
  }

  if (inicio === -1) {
    console.error("[extraerJSON] Respuesta sin JSON:\n", texto.slice(0, 600));
    throw new Error("La IA no devolvió el JSON esperado.");
  }

  // Busca el cierre balanceando llaves
  let depth = 0;
  let fin = -1;
  for (let i = inicio; i < texto.length; i++) {
    if (texto[i] === "{") depth++;
    else if (texto[i] === "}") {
      depth--;
      if (depth === 0) { fin = i; break; }
    }
  }

  if (fin === -1) throw new Error("JSON incompleto en la respuesta de la IA.");

  const jsonStr = texto.slice(inicio, fin + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("[extraerJSON] Parse error:", e.message, "\nJSON:", jsonStr.slice(0, 300));
    throw new Error("No se pudo parsear el JSON: " + e.message);
  }
}

// ─── Llamada a la API de Anthropic ────────────────────────────────────────────
function llamarAnthropic(system, messages) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      system,
      messages,
    };

    const body = JSON.stringify(payload);

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || "Error de Anthropic API"));
          else resolve(parsed);
        } catch (e) {
          reject(new Error("Respuesta inválida de Anthropic: " + e.message));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Generar presupuesto ──────────────────────────────────────────────────────
async function generarPresupuesto({ l, a, p, zona, calle, condicion }) {
  const area = (l * a).toFixed(2);
  const vol  = (l * a * p / 100).toFixed(3);

  const system = `Eres un ingeniero civil con 20 años de experiencia en infraestructura vial en Oaxaca de Juárez, México.
Tu especialidad es la reparación de baches con conocimiento actualizado (2025-2026) de precios de materiales y mano de obra locales.
Respondes ÚNICAMENTE con objetos JSON válidos, sin texto adicional, sin markdown, sin bloques de código, sin backticks.
Todos los valores numéricos en el JSON son números, nunca strings.`;

  const user = `Un inspector reporta un bache con estas características:
- Ubicación: ${calle || "No especificada"}, ${zona || "Oaxaca de Juárez"}
- Dimensiones: ${l}m × ${a}m × ${p}cm de profundidad
- Área: ${area} m²  |  Volumen: ${vol} m³
- Tipo de zona: ${(condicion || "vialidad_principal").replace(/_/g, " ")}

Genera EXACTAMENTE 3 opciones de reparación con diferente relación costo/durabilidad.
Usa precios realistas de materiales de construcción vial en Oaxaca, México para 2025-2026.

IMPORTANTE: Tu respuesta debe comenzar DIRECTAMENTE con el carácter { sin ningún texto previo, sin explicaciones, sin backticks, sin markdown. Solo el JSON puro:

{"opciones":[
  {
    "id":1,
    "nombre":"Nombre del método",
    "badge":"recomendado",
    "descripcion":"Descripción breve en 1-2 oraciones.",
    "duracion_estimada":"Ej. 2-3 años",
    "tiempo_ejecucion":"Ej. 2-4 horas",
    "materiales":[
      {"nombre":"Material","cantidad":"X kg","precio_unitario":0,"precio_total":0}
    ],
    "mano_obra":0,
    "maquinaria":0,
    "señalamiento":0,
    "subtotal_materiales":0,
    "imprevistos_15":0,
    "total":0,
    "ventajas":["ventaja 1","ventaja 2"],
    "desventajas":["desventaja 1"]
  }
]}

Reglas:
- Las 3 opciones deben ser métodos distintos (ej: bacheo en frío, mezcla asfáltica en caliente, concreto hidráulico).
- badge debe ser exactamente uno de: "recomendado", "economico" o "durable" (sin acento en económico).
- Todos los valores numéricos son números enteros o decimales, nunca strings.
- imprevistos_15 = 15% del (subtotal_materiales + mano_obra + maquinaria + señalamiento).
- total = subtotal_materiales + mano_obra + maquinaria + señalamiento + imprevistos_15.`;

  const data = await llamarAnthropic(system, [{ role: "user", content: user }]);

  const texto = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return extraerJSON(texto);
}

// ─── Servidor HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Ruta: POST /presupuesto ────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/presupuesto") {
    if (!ANTHROPIC_API_KEY) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada en el servidor." }));
      return;
    }

    try {
      const body = await readBody(req);
      const { zona, calle, condicion } = body;

      // Validar dimensiones antes de llamar a la IA
      const { l, a, p } = validarDimensiones(body);

      const resultado = await generarPresupuesto({ l, a, p, zona, calle, condicion });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resultado));
    } catch (err) {
      const status = err.message.includes("inválido") ? 400 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Health check ────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // ── Ruta no encontrada ─────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Ruta no encontrada" }));
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
