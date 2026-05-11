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

// ─── Llamada a la API de Anthropic ────────────────────────────────────────────
function llamarAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

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
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Respuesta inválida de Anthropic"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Servidor HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS — permite peticiones desde cualquier origen (ajusta en producción)
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
      const { largo, ancho, prof, zona, calle, condicion } = await readBody(req);

      const area = (parseFloat(largo) * parseFloat(ancho)).toFixed(2);
      const vol = (parseFloat(largo) * parseFloat(ancho) * parseFloat(prof) / 100).toFixed(3);

      const prompt = `Eres un ingeniero civil especialista en infraestructura vial en México con experiencia en Oaxaca de Juárez.

Un usuario reporta un bache con estas características:
- Ubicación: ${calle || "No especificada"}, ${zona || "Oaxaca de Juárez"}
- Dimensiones: ${largo}m × ${ancho}m × ${prof}cm de profundidad
- Área: ${area} m²  |  Volumen: ${vol} m³
- Tipo de zona: ${(condicion || "vialidad_principal").replace(/_/g, " ")}

Tu tarea: Busca precios actuales 2025-2026 de materiales de construcción vial en México (especialmente Oaxaca) y genera EXACTAMENTE 3 opciones de reparación con diferente relación costo/durabilidad.

Responde ÚNICAMENTE en JSON válido, sin texto adicional, sin markdown, sin backticks. El formato exacto es:

{"opciones":[
  {
    "id":1,
    "nombre":"Nombre del método",
    "badge":"recomendado",
    "descripcion":"Descripción breve en 1-2 oraciones.",
    "duracion_estimada":"Ej. 2-3 años",
    "tiempo_ejecucion":"Ej. 2-4 horas",
    "materiales":[
      {"nombre":"Material","cantidad":"X kg","precio_unitario":000,"precio_total":000}
    ],
    "mano_obra":0000,
    "maquinaria":000,
    "señalamiento":000,
    "subtotal_materiales":0000,
    "imprevistos_15":000,
    "total":0000,
    "ventajas":["ventaja 1","ventaja 2"],
    "desventajas":["desventaja 1"]
  }
]}

Las 3 opciones deben ser métodos distintos. badge debe ser "recomendado", "económico" o "durable". Usa precios realistas en pesos mexicanos MXN para Oaxaca 2025-2026.`;

      const data = await llamarAnthropic(prompt);

      // Extraer el texto de la respuesta
      const textos = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const match = textos.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("La IA no devolvió JSON válido");

      const resultado = JSON.parse(match[0]);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resultado));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Ruta no encontrada ─────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Ruta no encontrada" }));
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
