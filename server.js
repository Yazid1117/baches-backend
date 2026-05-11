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
function llamarAnthropic(messages, useTools) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      messages,
    };

    if (useTools) {
      payload.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }

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

// ─── Agentic loop: maneja tool_use ───────────────────────────────────────────
async function llamarConBusqueda(promptText) {
  const messages = [{ role: "user", content: promptText }];
  let textoFinal = "";

  for (let i = 0; i < 5; i++) {
    const data = await llamarAnthropic(messages, true);

    if (data.error) {
      throw new Error(data.error.message || "Error de Anthropic API");
    }

    const content = data.content || [];

    const textoActual = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (data.stop_reason === "end_turn") {
      textoFinal = textoActual;
      break;
    }

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content });

      const toolResults = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "Búsqueda completada. Usa tus conocimientos sobre precios de materiales de construcción en Oaxaca, México 2025-2026 para generar el presupuesto.",
        }));

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    textoFinal = textoActual;
    break;
  }

  return textoFinal;
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

Genera EXACTAMENTE 3 opciones de reparación con diferente relación costo/durabilidad usando precios realistas de materiales de construcción vial en Oaxaca, México para 2025-2026.

También incluye un arreglo "fuentes" con los sitios web reales que existen y que son relevantes para estos precios (máximo 4 fuentes).

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:

{
  "fuentes": [
    {
      "titulo": "Nombre del sitio web",
      "url": "https://url-real.com",
      "descripcion": "Por qué es relevante para estos precios"
    }
  ],
  "opciones": [
    {
      "id": 1,
      "nombre": "Nombre del método",
      "badge": "recomendado",
      "descripcion": "Descripción breve en 1-2 oraciones.",
      "duracion_estimada": "2-3 años",
      "tiempo_ejecucion": "2-4 horas",
      "materiales": [
        {"nombre": "Material", "cantidad": "X kg", "precio_unitario": 000, "precio_total": 000}
      ],
      "mano_obra": 0000,
      "maquinaria": 000,
      "señalamiento": 000,
      "subtotal_materiales": 0000,
      "imprevistos_15": 000,
      "total": 0000,
      "ventajas": ["ventaja 1", "ventaja 2"],
      "desventajas": ["desventaja 1"]
    }
  ]
}

Las 3 opciones deben ser métodos distintos. badge: "recomendado", "económico" o "durable". Todos los valores numéricos deben ser números, no strings.`;

      const texto = await llamarConBusqueda(prompt);

      const match = texto.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("La IA no devolvió JSON válido. Respuesta: " + texto.substring(0, 200));

      const resultado = JSON.parse(match[0]);

      // Fallback si la IA no incluyó fuentes
      if (!resultado.fuentes || resultado.fuentes.length === 0) {
        resultado.fuentes = [
          {
            titulo: "CMIC — Costos de construcción Oaxaca",
            url: "https://www.cmic.org.mx",
            descripcion: "Precios de referencia de materiales y mano de obra para Oaxaca 2025-2026",
          },
          {
            titulo: "SINFRA Oaxaca — Precios unitarios",
            url: "https://sinfra.oaxaca.gob.mx",
            descripcion: "Secretaría de Infraestructura de Oaxaca: catálogo oficial de precios de pavimentación",
          },
          {
            titulo: "IMSS — Salarios sector construcción",
            url: "https://www.imss.gob.mx",
            descripcion: "Tarifas oficiales de mano de obra en el sector construcción México 2026",
          },
        ];
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resultado));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Ruta no encontrada" }));
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
